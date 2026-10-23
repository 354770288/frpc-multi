"""probe 模块测试：引擎回环、配置生成、frpc 日志判定、存储与 API。"""

import importlib
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

os.environ.setdefault("PROJECT_DIR", tempfile.mkdtemp(prefix="frpc-multi-tests-"))

from app.probe import engine
from app.probe.engine import (
    FrpcProcess,
    LocalDataSink,
    LocalEchoServer,
    LocalStreamSource,
    ProbeOptions,
    _TempConfig,
    download_speed_test,
    render_connectivity_config,
    render_speed_config,
    run_connectivity_probe,
    tcping,
    upload_speed_test,
)

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - py3.14 自带
    tomllib = None


def discover_rows(store):
    from app.probe.store import DiscoverPageQuery

    rows = store.query_discover_results(DiscoverPageQuery(page_size=200))["items"]
    rows.sort(key=lambda row: row["ip"])
    rows.sort(key=lambda row: row["discovered_at"], reverse=True)
    return rows


def free_port() -> int:
    """拿一个当前空闲的 TCP 端口（监听后立即释放）。"""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def busy_port() -> int:
    """拿一个已监听（外部不可连）的端口：起服务后只 close 一半。"""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    # 不 close，进程内持有；测试结束由 GC 回收
    return port


class EngineHelperTests(unittest.TestCase):
    def test_tcping_ok_against_local_listener(self):
        port = free_port()
        server = socket.socket()
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.1", port))
        server.listen(1)
        try:
            ok, info = tcping("127.0.0.1", port, timeout=2)
            self.assertTrue(ok)
            self.assertIn("ms", info)
        finally:
            server.close()

    def test_tcping_refused(self):
        port = busy_port()
        # 监听队列存在但由本进程持有 → 连接可建立，因此用未监听端口验证拒绝路径
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        port = server.getsockname()[1]
        server.close()  # 关闭后立刻连接，绝大多数场景收到拒绝/不可达
        ok, info = tcping("127.0.0.1", port, timeout=2)
        self.assertFalse(ok)

    def test_format_helpers(self):
        self.assertAlmostEqual(engine.speed_mbps(1024 * 1024), 8.0)
        self.assertAlmostEqual(engine.speed_mbs(1024 * 1024), 1.0)
        self.assertIn("Mbps", engine.format_speed(1024 * 1024))
        self.assertEqual(engine.format_size(2048), "2.00 KB")


class LocalServiceTests(unittest.TestCase):
    def test_echo_server_roundtrip(self):
        port = free_port()
        srv = LocalEchoServer(port)
        ok, err = srv.start()
        self.assertTrue(ok, err)
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
                sock.sendall(b"hello-probe")
                self.assertEqual(sock.recv(1024), b"hello-probe")
        finally:
            srv.stop()

    def test_stream_source_sends_payload(self):
        port = free_port()
        srv = LocalStreamSource(port, hard_limit=5)
        ok, err = srv.start()
        self.assertTrue(ok, err)
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
                sock.settimeout(2)
                # TCP 是字节流，单次 recv 不保证收满一个块，累计到一块大小
                chunks = bytearray()
                while len(chunks) < 65536:
                    data = sock.recv(65536 - len(chunks))
                    if not data:
                        break
                    chunks.extend(data)
                self.assertEqual(len(chunks), 65536)
        finally:
            srv.stop()

    def test_data_sink_counts_bytes(self):
        port = free_port()
        srv = LocalDataSink(port)
        ok, err = srv.start()
        self.assertTrue(ok, err)
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
                sock.sendall(b"x" * 5000)
                sock.shutdown(socket.SHUT_WR)
                deadline = time.monotonic() + 2
                while not srv.receive_done.is_set() and time.monotonic() < deadline:
                    time.sleep(0.05)
            self.assertTrue(srv.receive_done.is_set())
            self.assertEqual(srv.total_received, 5000)
        finally:
            srv.stop()


class ConfigRenderTests(unittest.TestCase):
    def setUp(self):
        self.options = ProbeOptions(
            frps_port=7000, local_base_port=11561, remote_base_port=11561
        )

    @unittest.skipIf(tomllib is None, "需要 tomllib")
    def test_connectivity_config_is_valid_toml(self):
        text = render_connectivity_config("1.2.3.4", self.options)
        data = tomllib.loads(text)
        self.assertEqual(data["serverAddr"], "1.2.3.4")
        self.assertEqual(data["serverPort"], 7000)
        self.assertFalse(data["loginFailExit"])
        proxy = data["proxies"][0]
        self.assertEqual(proxy["type"], "tcp")
        self.assertEqual(proxy["localPort"], 11561)
        self.assertEqual(proxy["remotePort"], 11561)

    @unittest.skipIf(tomllib is None, "需要 tomllib")
    def test_speed_config_has_two_proxies(self):
        text = render_speed_config("frps.example.com", self.options)
        data = tomllib.loads(text)
        self.assertEqual(len(data["proxies"]), 2)
        self.assertEqual([p["localPort"] for p in data["proxies"]], [11562, 11563])
        self.assertEqual([p["remotePort"] for p in data["proxies"]], [11562, 11563])

    def test_temp_config_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            with _TempConfig("x = 1", Path(tmp)) as path:
                self.assertTrue(path.exists())
                self.assertEqual(path.read_text(), "x = 1")
            self.assertFalse(path.exists())


def make_fake_frpc(directory: Path, lines: list[str], *, sleep: float = 10) -> Path:
    """生成模拟 frpc 的可执行脚本：打印指定日志行后睡眠，供日志判定测试。"""
    script = directory / "fake-frpc.sh"
    body = "\n".join(f"echo {line!r}" for line in lines)
    script.write_text(f"#!/bin/sh\n{body}\nsleep {sleep}\n")
    script.chmod(0o755)
    return script


class FrpcProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="frpc-probe-test-"))

    def test_wait_proxies_success(self):
        options = ProbeOptions(
            frpc_bin=str(make_fake_frpc(self.tmp, [
                "login to server success",
                "start proxy success",
            ]))
        )
        with _TempConfig("x = 1", self.tmp) as cfg:
            frpc = FrpcProcess(cfg, options)
            ok, err = frpc.start()
            self.assertTrue(ok, err)
            try:
                ok, err = frpc.wait_proxies(1, timeout=3)
                self.assertTrue(ok, err)
            finally:
                frpc.stop()

    def test_wait_proxies_detects_login_failure(self):
        options = ProbeOptions(
            frpc_bin=str(make_fake_frpc(self.tmp, ["login to server failed"]))
        )
        with _TempConfig("x = 1", self.tmp) as cfg:
            frpc = FrpcProcess(cfg, options)
            ok, err = frpc.start()
            self.assertTrue(ok, err)
            try:
                ok, err = frpc.wait_proxies(1, timeout=3)
                self.assertFalse(ok)
                self.assertIn("登录 frps 失败", err)
            finally:
                frpc.stop()

    def test_wait_proxies_detects_process_exit(self):
        options = ProbeOptions(frpc_bin="/usr/bin/false")
        with _TempConfig("x = 1", self.tmp) as cfg:
            frpc = FrpcProcess(cfg, options)
            ok, err = frpc.start()
            self.assertTrue(ok, err)
            ok, err = frpc.wait_proxies(1, timeout=3)
            self.assertFalse(ok)
            self.assertIn("异常退出", err)

    def test_start_missing_binary(self):
        options = ProbeOptions(frpc_bin=str(self.tmp / "not-exist"))
        with _TempConfig("x = 1", self.tmp) as cfg:
            frpc = FrpcProcess(cfg, options)
            ok, err = frpc.start()
            self.assertFalse(ok)
            self.assertIn("启动失败", err)


class SpeedLoopbackTests(unittest.TestCase):
    """本地直连（不经隧道）验证限时测速的结算与取消。"""

    def test_download_against_local_source(self):
        port = free_port()
        srv = LocalStreamSource(port, hard_limit=5)
        ok, err = srv.start()
        self.assertTrue(ok, err)
        try:
            options = ProbeOptions(speed_duration=0.6, speed_socket_timeout=5)
            result = download_speed_test("127.0.0.1", port, options)
            self.assertTrue(result["success"], result["error"])
            self.assertGreater(result["total_bytes"], 0)
            self.assertTrue(result["cutoff"])
        finally:
            srv.stop()

    def test_upload_against_local_sink(self):
        port = free_port()
        srv = LocalDataSink(port)
        ok, err = srv.start()
        self.assertTrue(ok, err)
        try:
            options = ProbeOptions(speed_duration=0.6, speed_socket_timeout=5)
            result = upload_speed_test("127.0.0.1", port, options)
            self.assertTrue(result["success"], result["error"])
            self.assertGreater(result["total_bytes"], 0)
        finally:
            srv.stop()

    def test_download_cancel_sets_error(self):
        port = free_port()
        srv = LocalStreamSource(port, hard_limit=5)
        ok, err = srv.start()
        self.assertTrue(ok, err)
        try:
            options = ProbeOptions(speed_duration=5, speed_socket_timeout=5)
            result = download_speed_test("127.0.0.1", port, options, cancel=lambda: True)
            self.assertFalse(result["success"])
            self.assertEqual(result["error"], "已取消")
        finally:
            srv.stop()

    def test_download_refused(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        port = server.getsockname()[1]
        server.close()
        options = ProbeOptions(speed_duration=1, speed_socket_timeout=1)
        result = download_speed_test("127.0.0.1", port, options)
        self.assertFalse(result["success"])


class ConnectivityProbeTests(unittest.TestCase):
    def test_unreachable_frps_fails_fast(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        port = server.getsockname()[1]
        server.close()
        options = ProbeOptions(
            frps_port=port, tcping_retries=1, tcping_timeout=1,
            local_base_port=free_port(), remote_base_port=11561,
        )
        result = engine.run_connectivity_probe("127.0.0.1", options)
        self.assertFalse(result["frps_reachable"])
        self.assertIn("frps 不可达", result["detail"])

    def test_cancel_aborts_ping_retry(self):
        # 未监听端口首连失败后，重试前的取消检查点应中断探测
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        port = server.getsockname()[1]
        server.close()
        options = ProbeOptions(frps_port=port, tcping_retries=2, tcping_timeout=1)
        result = run_connectivity_probe("127.0.0.1", options, cancel=lambda: True)
        self.assertFalse(result["frps_reachable"])
        self.assertIn("不可达", result["detail"])


def _ipv4_int(ip: str) -> int:
    import ipaddress as _ipa
    return int(_ipa.ip_address(ip))


class ProbeStoreTests(unittest.TestCase):
    def setUp(self):
        import tempfile as _tf
        from app.probe.store import ProbeStore, validate_probe_addr

        self.tmpdir = _tf.mkdtemp(prefix="frpc-probe-store-")
        self.store = ProbeStore(Path(self.tmpdir) / "probe.db")
        self.validate_probe_addr = validate_probe_addr

    def test_validate_addr(self):
        self.assertEqual(self.validate_probe_addr(" 1.2.3.4 "), "1.2.3.4")
        self.assertEqual(self.validate_probe_addr("frps.example.com"), "frps.example.com")
        with self.assertRaises(ValueError):
            self.validate_probe_addr('')
        with self.assertRaises(ValueError):
            self.validate_probe_addr('1.2.3.4" # injection')

    def test_server_crud(self):
        server = self.store.create_server(ip="10.0.0.1", labels=["节点A"], server_group="国内")
        self.assertEqual(server.ip, "10.0.0.1")
        with self.assertRaises(ValueError):
            self.store.create_server(ip="10.0.0.1")
        updated = self.store.update_server(server.id, labels=["节点B"], server_group="海外")
        self.assertEqual(updated.labels, ["节点B"])
        self.assertEqual(updated.server_group, "海外")
        self.store.delete_server(server.id)
        self.assertEqual(self.store.list_servers(), [])

    def test_import_servers_skips_duplicates(self):
        self.store.create_server(ip="10.0.0.1")
        inserted, skipped = self.store.import_servers([
            {"ip": "10.0.0.1", "label": "旧"},
            {"ip": "10.0.0.2", "label": "新", "group": "g1"},
            {"ip": "10.0.0.3"},
        ])
        self.assertEqual((inserted, skipped), (2, 1))
        self.assertEqual(self.store.list_groups(), ["g1"])

    def test_import_servers_processes_bounded_batches(self):
        from app.probe import store as store_module
        items = [
            {"ip": f"10.50.0.{index}", "label": f"tag-{index % 2}", "group": f"g-{index % 2}"}
            for index in range(1, 9)
        ]
        items.extend([{"ip": "10.50.0.1", "label": "ignored"},
                      {"ip": "10.50.0.8", "label": "ignored"}])
        real_sync = store_module._sync_server_tags_many
        chunk_sizes = []

        def record_sync(connection, entries, *, preserve_existing=True):
            chunk_sizes.append(len(entries))
            return real_sync(connection, entries, preserve_existing=preserve_existing)

        with mock.patch.object(store_module, "SERVER_IMPORT_BATCH_SIZE", 3), \
                mock.patch.object(store_module, "_sync_server_tags_many", side_effect=record_sync):
            inserted, skipped = self.store.import_servers(items)
        self.assertEqual((inserted, skipped), (8, 2))
        self.assertTrue(chunk_sizes)
        self.assertLessEqual(max(chunk_sizes), 3)
        self.assertEqual(len(self.store.list_servers()), 8)

    def test_import_servers_rejects_over_limit_before_writing(self):
        from app.probe.store import MAX_SERVER_IMPORT_ITEMS, ServerImportLimitError
        items = [{"ip": "10.53.0.1"}] * (MAX_SERVER_IMPORT_ITEMS + 1)
        with self.assertRaises(ServerImportLimitError):
            self.store.import_servers(items)
        self.assertEqual(self.store.list_servers(), [])

    def test_category_tag_crud_assignment_merge_delete_and_projection(self):
        categories = {row["name"]: row for row in self.store.list_tag_categories()}
        region = categories["region"]
        carrier = self.store.create_tag_category("carrier-custom")
        renamed = self.store.rename_tag_category(carrier["id"], "carrier-renamed")
        self.assertEqual(renamed["id"], carrier["id"])

        region_tag = self.store.create_tag(region["id"], "Premium")
        carrier_tag = self.store.create_tag(renamed["id"], "Premium")
        other = categories["other"]
        other_tag = self.store.create_tag(other["id"], "Premium")
        self.assertEqual(len({region_tag["id"], carrier_tag["id"], other_tag["id"]}), 3)
        with self.assertRaises(ValueError):
            self.store.create_tag(region["id"], "Premium")
        with self.assertRaises(ValueError):
            self.store.create_tag(region["id"], "comma,tag")
        with self.assertRaises(ValueError):
            self.store.update_tag(region_tag["id"], name="comma,tag")

        first = self.store.create_server(
            ip="10.51.0.1", labels=["legacy"], tag_ids=[region_tag["id"], other_tag["id"]]
        )
        second = self.store.create_server(ip="10.51.0.2", tag_ids=[carrier_tag["id"]])
        self.assertEqual(set(first.labels), {"legacy", "Premium"})
        self.assertEqual(second.labels, ["Premium"])

        # Name-based replacement retains all matching category identities.
        self.store.update_server(first.id, labels=["Premium", "Keep"])
        connection = __import__("app.control.database", fromlist=["connect_database"]).connect_database(
            self.store.database_path
        )
        try:
            retained_ids = {row[0] for row in connection.execute(
                "SELECT tag_id FROM probe_server_tags WHERE server_id=?", (first.id,)
            )}
        finally:
            connection.close()
        self.assertTrue({region_tag["id"], other_tag["id"]}.issubset(retained_ids))

        self.store.update_servers_batch(
            [second.id], add_tag_ids=[other_tag["id"]], remove_tag_ids=[carrier_tag["id"]]
        )
        self.assertEqual(self.store.get_server(second.id).labels, ["Premium"])

        # Rename/move keep the tag ID and update the compatibility projection.
        moved = self.store.update_tag(region_tag["id"], name="Priority", category_id=renamed["id"])
        self.assertEqual(moved["id"], region_tag["id"])
        self.assertEqual(moved["categoryId"], renamed["id"])
        self.assertIn("Priority", self.store.get_server(first.id).labels)

        merged = self.store.merge_tags(other_tag["id"], region_tag["id"])
        self.assertEqual(merged["tagId"], region_tag["id"])
        self.assertIn("Priority", self.store.get_server(second.id).labels)
        self.assertNotIn("Premium", self.store.get_server(second.id).labels)

        keep_tag = next(row for row in self.store.list_tags(other["id"])
                        if row["name"] == "Keep")
        self.assertEqual(self.store.delete_tag(keep_tag["id"]), 1)
        self.assertNotIn("Keep", self.store.get_server(first.id).labels)
        self.store.delete_tag(carrier_tag["id"])
        self.assertNotIn("Premium", self.store.get_server(first.id).labels)
        remaining = {row["id"] for row in self.store.list_tags()}
        self.assertNotIn(other_tag["id"], remaining)
        self.assertNotIn(carrier_tag["id"], remaining)

    def test_legacy_other_category_uses_stable_id_after_rename(self):
        from app.control.database import connect_database

        other = next(row for row in self.store.list_tag_categories() if row["name"] == "other")
        renamed = self.store.rename_tag_category(other["id"], "miscellaneous")
        server = self.store.create_server(ip="10.52.0.1", labels=["legacy-one"])
        self.store.update_servers_batch([server.id], add_labels=["legacy-two"])
        self.assertEqual(set(self.store.get_server(server.id).labels), {"legacy-one", "legacy-two"})
        connection = connect_database(self.store.database_path)
        try:
            assigned_categories = {row[0] for row in connection.execute(
                "SELECT DISTINCT t.category_id FROM probe_server_tags st "
                "JOIN probe_tags t ON t.id=st.tag_id WHERE st.server_id=?", (server.id,)
            )}
        finally:
            connection.close()
        self.assertEqual(renamed["id"], other["id"])
        self.assertEqual(assigned_categories, {other["id"]})

    def test_same_name_categories_project_to_one_legacy_label(self):
        region = next(row for row in self.store.list_tag_categories() if row["name"] == "region")
        carrier = next(row for row in self.store.list_tag_categories() if row["name"] == "carrier")
        region_tag = self.store.create_tag(region["id"], "Shared")
        carrier_tag = self.store.create_tag(carrier["id"], "Shared")
        server = self.store.create_server(
            ip="10.52.0.2", tag_ids=[region_tag["id"], carrier_tag["id"]]
        )
        self.assertEqual(server.label, ",Shared,")
        refreshed = self.store.update_server(server.id, server_group="g")
        self.assertEqual(refreshed.label, ",Shared,")

    def _seed_servers_for_paging(self):
        # ip 从大到小插入，验证数值排序；两台有连通结果，覆盖 conn 分级
        rows = [
            ("10.0.0.9", "gB", ""),
            ("10.0.0.10", "gA", "香港"),
            ("10.0.0.2", "gA", ""),
            ("192.168.1.5", "", "美国"),
        ]
        for ip, group, label in rows:
            self.store.create_server(ip=ip, labels=[label] if label else [], server_group=group)
        self.store.add_connectivity_result({
            "server_ip": "10.0.0.9", "frps_reachable": True,
            "tunnel_established": True, "firewall_open": True,
        })
        self.store.add_connectivity_result({
            "server_ip": "10.0.0.10", "frps_reachable": True,
            "tunnel_established": False, "firewall_open": False,
        })

    def test_query_servers_paging_and_numeric_ip_sort(self):
        self._seed_servers_for_paging()
        from app.probe.store import ProbeStore, ServerPageQuery
        page = self.store.query_servers(ServerPageQuery(page=1, page_size=2, sort="ip", order="asc"))
        self.assertEqual(page["total"], 4)
        self.assertEqual([row["ip"] for row in page["items"]], ["10.0.0.2", "10.0.0.9"])  # 数值序，非点分字符串序
        last = self.store.query_servers(ServerPageQuery(page=2, page_size=2, sort="ip", order="asc"))
        self.assertEqual([row["ip"] for row in last["items"]], ["10.0.0.10", "192.168.1.5"])
        desc = self.store.query_servers(ServerPageQuery(page=1, page_size=1, sort="ip", order="desc"))
        self.assertEqual(desc["items"][0]["ip"], "192.168.1.5")

    def test_server_cursor_filters_binding_and_insert_boundary(self):
        from app.probe.store import ServerPageQuery
        ips = ["198.18.0.1", "198.18.0.2", "198.18.0.3", "198.18.0.4"]
        self.store.create_server(ip=ips[0], labels=["red"], server_group="one")
        self.store.create_server(ip=ips[1], labels=["red", "blue"], server_group="one")
        self.store.create_server(ip=ips[2], labels=["blue"], server_group="two")
        self.store.create_server(ip=ips[3], labels=["green"], server_group="two")
        from app.control.database import connect_database
        with closing(connect_database(self.store.database_path)) as connection:
            tag_ids = {row["name"]: row["id"] for row in connection.execute("SELECT id,name FROM probe_tags")}
            group_ids = {row["name"]: row["id"] for row in connection.execute("SELECT id,name FROM probe_groups")}

        page_query = ServerPageQuery(page_size=2, sort="ip", order="asc")
        first = self.store.query_servers_cursor(page_query)
        self.assertEqual([row["ip"] for row in first["items"]], ips[:2])
        self.assertTrue(first["hasMore"])
        # Inserts before the boundary do not shift the next page or duplicate prior rows.
        self.store.create_server(ip="198.17.255.255")
        second = self.store.query_servers_cursor(page_query, first["nextCursor"])
        self.assertEqual([row["ip"] for row in second["items"]], ips[2:])
        self.assertFalse(second["hasMore"])
        with self.assertRaisesRegex(ValueError, "cursor"):
            self.store.query_servers_cursor(ServerPageQuery(page_size=2, sort="ip", q="changed"), first["nextCursor"])

        any_tags = self.store.query_servers_cursor(ServerPageQuery(
            include_tag_ids=(tag_ids["red"], tag_ids["blue"]), tag_mode="any", sort="ip"))
        all_tags = self.store.query_servers_cursor(ServerPageQuery(
            include_tag_ids=(tag_ids["red"], tag_ids["blue"]), tag_mode="all", sort="ip"))
        excluded = self.store.query_servers_cursor(ServerPageQuery(
            include_tag_ids=(tag_ids["red"],), exclude_tag_ids=(tag_ids["blue"],), sort="ip"))
        by_groups = self.store.query_servers_cursor(ServerPageQuery(group_ids=tuple(group_ids.values()), sort="ip"))
        self.assertEqual(len(any_tags["items"]), 3)
        self.assertEqual([r["ip"] for r in all_tags["items"]], [ips[1]])
        self.assertEqual([r["ip"] for r in excluded["items"]], [ips[0]])
        self.assertEqual(len(by_groups["items"]), 4)
        self.assertEqual(self.store.count_servers(ServerPageQuery(group_ids=tuple(group_ids.values()))), 4)

    def test_server_cursor_query_shape_uses_indexes_and_direct_source_views(self):
        from app.probe.store import ProbeStore, ServerPageQuery
        for i in range(1, 8):
            self.store.create_server(ip=f"198.19.0.{i}")
        query = ServerPageQuery(page_size=2, sort="ip", order="asc")
        first = self.store.query_servers_cursor(query)
        self.assertEqual(len(first["items"]), 2)
        from app.control.database import connect_database
        with closing(connect_database(self.store.database_path)) as connection:
            source = ProbeStore(self.store.database_path, node_id="fixture")
            source._source_views(connection)
            for direction, operator in (("ASC", ">"), ("DESC", "<")):
                plan = " ".join(str(tuple(row)) for row in connection.execute(
                    "EXPLAIN QUERY PLAN SELECT s.id " + source._server_from_sql("idx_probe_servers_ip_sort_id") + " "
                    f"WHERE s.ip_sort IS NOT NULL AND (s.ip_sort,s.id){operator}(?,?) "
                    f"ORDER BY s.ip_sort {direction},s.id {direction} LIMIT ?",
                    (int(_ipv4_int("198.19.0.2")), 2, 3)))
                self.assertIn("SEARCH s USING INDEX idx_probe_servers_ip_sort_id", plan)
                self.assertIn("ip_sort", plan)
                self.assertNotIn("SCAN s USING", plan)
                self.assertNotIn("TEMP B-TREE", plan.upper())
            for direction in ("ASC", "DESC"):
                tail_plan = " ".join(str(tuple(row)) for row in connection.execute(
                    "EXPLAIN QUERY PLAN SELECT s.id " + source._server_from_sql("idx_probe_servers_ip_sort_id") + " "
                    f"WHERE s.ip_sort IS NULL ORDER BY s.id {direction} LIMIT ?", (3,)))
                self.assertIn("SEARCH s USING INDEX idx_probe_servers_ip_sort_id (ip_sort=?)", tail_plan)
                self.assertNotIn("TEMP B-TREE", tail_plan.upper())
        source = ProbeStore(self.store.database_path, node_id="fixture")
        from app.control.database import connect_database
        with closing(connect_database(self.store.database_path)) as connection:
            source._source_views(connection)
            objects = {row["name"]: row["type"] for row in connection.execute(
                "SELECT name,type FROM sqlite_temp_master WHERE name LIKE 'probe_%_results' OR name LIKE '_source_%' "
                "OR name='_probe_endpoint_assets'")}
            self.assertEqual(objects["probe_connectivity_results"], "view")
            self.assertEqual(objects["probe_speed_results"], "view")
            self.assertNotIn("_probe_endpoint_assets", objects)
            view_sql = connection.execute(
                "SELECT sql FROM sqlite_temp_master WHERE name='probe_connectivity_results'").fetchone()[0]
            self.assertIn("main.probe_current_results", view_sql)
            self.assertNotIn("CREATE TEMP TABLE", view_sql.upper())

    def test_server_cursor_rejects_bad_mac_payload_and_non_ip_sort(self):
        import base64
        from app.control.database import connect_database
        from app.probe.store import ProbeStore, ServerPageQuery
        with self.assertRaisesRegex(ValueError, "sort=ip"):
            self.store.query_servers_cursor(ServerPageQuery(sort="group"))
        for raw in (b"[]", b"null", b"{", b"\"text\""):
            cursor = base64.urlsafe_b64encode(raw).decode().rstrip("=")
            with self.assertRaisesRegex(ValueError, "cursor"):
                self.store.query_servers_cursor(ServerPageQuery(sort="ip"), cursor)
        self.store.create_server(ip="198.21.0.1")
        self.store.create_server(ip="198.21.0.2")
        page = self.store.query_servers_cursor(ServerPageQuery(sort="ip", page_size=1))
        with self.assertRaisesRegex(ValueError, "cursor"):
            self.store.query_servers_cursor(ServerPageQuery(sort="ip", page_size=1), page["nextCursor"][:-1] + "x")
        with closing(connect_database(self.store.database_path)) as connection:
            secret = connection.execute(
                "SELECT value FROM probe_settings WHERE key='probe_server_cursor_secret'").fetchone()[0]
        self.assertGreaterEqual(len(secret), 40)
        next_page = ProbeStore(self.store.database_path).query_servers_cursor(
            ServerPageQuery(sort="ip", page_size=1), page["nextCursor"])
        self.assertEqual(next_page["items"][0]["ip"], "198.21.0.2")

    def test_server_count_avoids_result_joins_unless_connectivity_filtered(self):
        from app.control.database import connect_database
        from app.probe.store import ProbeStore, ServerPageQuery
        statements = []

        class TraceStore(ProbeStore):
            def _with_connection(inner, callback, *args):
                connection = connect_database(inner.database_path)
                connection.set_trace_callback(statements.append)
                try:
                    return callback(connection, *args)
                finally:
                    connection.close()

        traced = TraceStore(self.store.database_path)
        traced.count_servers(ServerPageQuery())
        count_sql = [sql for sql in statements if sql.lstrip().upper().startswith("SELECT COUNT(*)")][-1]
        self.assertNotIn("probe_current_results", count_sql)
        statements.clear()
        traced.count_servers(ServerPageQuery(conn="pass"))
        count_sql = [sql for sql in statements if sql.lstrip().upper().startswith("SELECT COUNT(*)")][-1]
        self.assertIn("kind='connectivity'", count_sql)
        self.assertNotIn("kind='speed'", count_sql)

    def test_server_facets_are_sql_aggregates(self):
        self.store.create_server(ip="198.20.0.1", labels=["facet-a"])
        self.store.create_server(ip="198.20.0.2", labels=["facet-a", "facet-b"])
        from app.control.database import connect_database
        from app.probe.store import ProbeStore
        facets = self.store.server_facets()
        self.assertEqual({row["label"]: row["count"] for row in facets["labels"]},
                         {"facet-a": 2, "facet-b": 1})
        statements = []

        class TraceStore(ProbeStore):
            def _with_connection(inner, callback, *args):
                connection = connect_database(inner.database_path)
                connection.set_trace_callback(statements.append)
                try:
                    return callback(connection, *args)
                finally:
                    connection.close()

        TraceStore(self.store.database_path).server_facets()
        self.assertTrue(any("GROUP BY t.name" in statement for statement in statements))
        self.assertFalse(any("SELECT label FROM probe_servers" in statement for statement in statements))

    def test_query_servers_filters(self):
        self._seed_servers_for_paging()
        from app.probe.store import ServerPageQuery
        # 显式空串分组 = 筛无分组；undefined 不筛
        empty_group = self.store.query_servers(ServerPageQuery(group=""))
        self.assertEqual({r["ip"] for r in empty_group["items"]}, {"192.168.1.5"})
        by_label = self.store.query_servers(ServerPageQuery(label="香港"))
        self.assertEqual([r["ip"] for r in by_label["items"]], ["10.0.0.10"])
        keyword = self.store.query_servers(ServerPageQuery(q="香港"))
        self.assertEqual(keyword["total"], 1)
        by_group = self.store.query_servers(ServerPageQuery(group="gA"))
        self.assertEqual(by_group["total"], 2)

    def test_query_servers_conn_buckets(self):
        self._seed_servers_for_paging()
        from app.probe.store import ServerPageQuery
        from app.probe.jobs import ProbeJobStore
        jobs = ProbeJobStore(self.store.database_path)
        node = jobs.create_node('bucket-primary')['id']
        jobs.set_execution_policy(node, [])
        jobs.heartbeat(node, 'test', ['discover', 'route', 'connectivity', 'speed'], [])
        jobs.create_primary_job('connectivity', ips=['10.0.0.9', '10.0.0.10'])
        jobs.report(node, (task := jobs.claim(node))['taskId'], task['attemptId'], result={
            'frps_reachable': True, 'tunnel_established': True, 'firewall_open': True,
        })
        jobs.report(node, (task := jobs.claim(node))['taskId'], task['attemptId'], result={
            'frps_reachable': True, 'tunnel_established': False, 'firewall_open': False,
        })
        passed = {r["ip"] for r in self.store.query_servers(ServerPageQuery(conn="pass"))["items"]}
        partial = {r["ip"] for r in self.store.query_servers(ServerPageQuery(conn="partial"))["items"]}
        failed = {r["ip"] for r in self.store.query_servers(ServerPageQuery(conn="fail"))["items"]}
        untested = {r["ip"] for r in self.store.query_servers(ServerPageQuery(conn="untested"))["items"]}
        self.assertEqual(passed, {"10.0.0.9"})
        self.assertEqual(partial, {"10.0.0.10"})
        self.assertEqual(untested, {"10.0.0.2", "192.168.1.5"})  # 未测=0
        self.assertEqual(failed, {"10.0.0.10"})  # 测过未全过（含部分通过）

    def test_domain_servers_get_null_ip_sort(self):
        # 域名服务器可正常创建/导入（回归：曾因 _ipv4_sort_key 崩溃）；数值序 null-last
        from app.probe.store import ServerPageQuery
        self.store.create_server(ip="frps.example.com", labels=["域名节点"])
        inserted, _ = self.store.import_servers([
            {"ip": "1.2.3.4"}, {"ip": "2001:db8::1"}, {"ip": "cdn.example.net"}])
        self.assertEqual(inserted, 3)
        rows = self.store.query_servers(ServerPageQuery(sort="ip", order="asc", page_size=200))
        ips = [r["ip"] for r in rows["items"]]
        self.assertEqual(ips[0], "1.2.3.4")  # IPv4 数值序在前
        self.assertEqual(set(ips[1:]), {"frps.example.com", "2001:db8::1", "cdn.example.net"})  # null-last

    def test_update_server_recomputes_ip_sort(self):
        from app.probe.store import ServerPageQuery
        server = self.store.create_server(ip="frps.example.com")
        changed = self.store.update_server(server.id, ip="9.9.9.9")
        self.assertEqual(changed.ip, "9.9.9.9")
        rows = self.store.query_servers(ServerPageQuery(sort="ip", order="asc", page_size=200))
        numeric = [r["ip"] for r in rows["items"] if r["ip"].startswith("9.")]
        self.assertIn("9.9.9.9", numeric)  # 改 IP 后 ip_sort 已重算（非 NULL 尾段）

    def test_server_facets(self):
        self._seed_servers_for_paging()
        facets = self.store.server_facets()
        labels = {row["label"]: row["count"] for row in facets["labels"]}
        self.assertEqual(labels["香港"], 1)
        groups = {row["group"]: row["count"] for row in facets["groups"]}
        self.assertEqual(groups, {"gA": 2, "gB": 1})

    def test_categorized_tag_migration_is_idempotent_and_asset_only(self):
        from app.control.database import connect_database, _migrate_probe_tags

        connection = connect_database(self.store.database_path)
        try:
            connection.execute("DELETE FROM probe_settings WHERE key='probe_categorized_tags_migrated'")
            connection.execute(
                "INSERT INTO probe_servers(ip,ip_sort,label,server_group,created_at) "
                "VALUES('10.44.0.1',NULL,',北京,CN2,非CN2,未路由测试,', '', '2026-01-01')"
            )
            server_id = connection.execute(
                "SELECT id FROM probe_servers WHERE ip='10.44.0.1'"
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO probe_discover_results(ip,port,label,discovered_at) "
                "VALUES('10.44.0.2',7000,',发现标签,CN2,','2026-01-01')"
            )
            connection.commit()
            _migrate_probe_tags(connection)
            _migrate_probe_tags(connection)
            connection.commit()
            labels = connection.execute(
                "SELECT t.name FROM probe_server_tags st JOIN probe_tags t ON t.id=st.tag_id "
                "WHERE st.server_id=? ORDER BY t.name", (server_id,)
            ).fetchall()
            self.assertEqual({row[0] for row in labels}, {"北京", "CN2", "非CN2", "未路由测试"})
            self.assertEqual(connection.execute(
                "SELECT label FROM probe_servers WHERE id=?", (server_id,)
            ).fetchone()[0], ",北京,CN2,非CN2,未路由测试,")
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM probe_tags WHERE name='发现标签'"
            ).fetchone()[0], 0)
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM probe_server_tags WHERE server_id=?", (server_id,)
            ).fetchone()[0], 4)
            categories = {row[0] for row in connection.execute(
                "SELECT name FROM probe_tag_categories"
            )}
            self.assertTrue({"region", "carrier", "purpose", "other"}.issubset(categories))
        finally:
            connection.close()

    def test_categorized_tag_migration_rolls_back_and_retries(self):
        import sqlite3
        from app.control.database import connect_database, _migrate_probe_tags

        connection = connect_database(self.store.database_path)
        try:
            connection.execute("DELETE FROM probe_settings WHERE key='probe_categorized_tags_migrated'")
            connection.execute(
                "INSERT INTO probe_servers(ip,ip_sort,label,server_group,created_at) "
                "VALUES('10.44.0.3',NULL,',重试标签,CN2,', '', '2026-01-01')"
            )
            connection.execute(
                "CREATE TRIGGER fail_tag_backfill BEFORE INSERT ON probe_tags "
                "BEGIN SELECT RAISE(ABORT, 'forced tag migration failure'); END"
            )
            connection.commit()
            with self.assertRaises(sqlite3.IntegrityError):
                _migrate_probe_tags(connection)
            self.assertIsNone(connection.execute(
                "SELECT value FROM probe_settings WHERE key='probe_categorized_tags_migrated'"
            ).fetchone())
            self.assertEqual(connection.execute(
                "SELECT label FROM probe_servers WHERE ip='10.44.0.3'"
            ).fetchone()[0], ",重试标签,CN2,")
            connection.execute("DROP TRIGGER fail_tag_backfill")
            connection.commit()
            _migrate_probe_tags(connection)
            self.assertEqual(connection.execute(
                "SELECT value FROM probe_settings WHERE key='probe_categorized_tags_migrated'"
            ).fetchone()[0], "1")
            self.assertEqual(connection.execute(
                "SELECT label FROM probe_servers WHERE ip='10.44.0.3'"
            ).fetchone()[0], ",重试标签,CN2,")
        finally:
            connection.close()

    def test_asset_tag_writes_keep_projection_and_sql_facets_aligned(self):
        from app.probe.store import ServerPageQuery
        first = self.store.create_server(ip="10.45.0.1", labels=["A", "CN2"])
        self.assertEqual(first.label, ",A,CN2,")
        second_inserted, _ = self.store.import_servers([
            {"ip": "10.45.0.2", "label": "A,B,非CN2"},
        ])
        self.assertEqual(second_inserted, 1)
        second = next(server for server in self.store.list_servers() if server.ip == "10.45.0.2")
        self.store.update_servers_batch([first.id, second.id], add_labels=["C"])
        self.store.update_servers_batch([second.id], remove_labels=["B"])
        self.assertEqual(set(self.store.get_server(first.id).labels), {"A", "C", "CN2"})
        self.assertEqual(set(self.store.get_server(second.id).labels), {"A", "C", "非CN2"})

        # Normalized data is authoritative for exact filters and facets.
        from app.control.database import connect_database
        connection = connect_database(self.store.database_path)
        try:
            connection.execute("UPDATE probe_servers SET label='' WHERE id=?", (first.id,))
            connection.commit()
        finally:
            connection.close()
        updated = self.store.update_server(first.id, server_group="g")
        self.assertEqual(set(updated.labels), {"A", "C", "CN2"})
        connection = connect_database(self.store.database_path)
        try:
            connection.execute("UPDATE probe_servers SET label='' WHERE id=?", (second.id,))
            connection.commit()
        finally:
            connection.close()
        self.store.update_servers_batch([second.id], add_labels=["D"])
        self.assertEqual(set(self.store.get_server(second.id).labels), {"A", "C", "D", "非CN2"})
        self.store.update_servers_batch([second.id], remove_labels=["D"])
        labels = {row["label"]: row["count"] for row in self.store.server_facets()["labels"]}
        self.assertEqual(labels, {"A": 2, "C": 2, "CN2": 1, "非CN2": 1})
        self.assertEqual(self.store.query_servers(ServerPageQuery(label="A"))["total"], 2)

    def test_category_aware_facets_and_tag_id_filter_keep_legacy_name_filter(self):
        from app.control.database import connect_database
        from app.probe.store import ServerPageQuery

        first = self.store.create_server(ip="10.47.0.1", labels=["Shared"])
        second = self.store.create_server(ip="10.47.0.2", labels=["Shared"])
        connection = connect_database(self.store.database_path)
        try:
            other_tag_id = connection.execute(
                "SELECT st.tag_id FROM probe_server_tags st WHERE st.server_id=?", (second.id,)
            ).fetchone()[0]
            connection.execute("DELETE FROM probe_server_tags WHERE server_id=?", (second.id,))
            region_id = connection.execute(
                "SELECT id FROM probe_tag_categories WHERE name='region'"
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO probe_tags(id,category_id,name,created_at) VALUES('region-shared',?,'Shared','2026-01-01')",
                (region_id,),
            )
            connection.execute(
                "INSERT INTO probe_server_tags(server_id,tag_id) VALUES(?, 'region-shared')", (second.id,)
            )
            connection.commit()
            other_name = connection.execute(
                "SELECT name FROM probe_tags WHERE id=?", (other_tag_id,)
            ).fetchone()[0]
            self.assertEqual(other_name, "Shared")
        finally:
            connection.close()

        facets = self.store.server_facets()
        self.assertEqual({row["label"]: row["count"] for row in facets["labels"]}["Shared"], 2)
        shared_items = [row for row in facets["tagItems"] if row["name"] == "Shared"]
        self.assertEqual({(row["category"], row["count"]) for row in shared_items},
                         {("other", 1), ("region", 1)})
        region_tag_id = next(row["tagId"] for row in shared_items if row["category"] == "region")
        self.store.update_servers_batch([second.id], add_labels=["New"])
        self.store.update_server(second.id, labels=["Shared", "Changed"])
        connection = connect_database(self.store.database_path)
        try:
            retained = connection.execute(
                "SELECT t.id, c.name FROM probe_server_tags st "
                "JOIN probe_tags t ON t.id=st.tag_id "
                "JOIN probe_tag_categories c ON c.id=t.category_id "
                "WHERE st.server_id=? AND t.name='Shared'", (second.id,)
            ).fetchall()
            changed = connection.execute(
                "SELECT c.name FROM probe_server_tags st "
                "JOIN probe_tags t ON t.id=st.tag_id "
                "JOIN probe_tag_categories c ON c.id=t.category_id "
                "WHERE st.server_id=? AND t.name='Changed'", (second.id,)
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertIn((region_tag_id, "region"), {(row["id"], row["name"]) for row in retained})
        self.assertEqual(changed, "other")
        by_tag = self.store.query_servers(ServerPageQuery(tag_id=region_tag_id))
        self.assertEqual([row["ip"] for row in by_tag["items"]], ["10.47.0.2"])
        self.assertEqual(self.store.query_servers(ServerPageQuery(label="Shared"))["total"], 2)

    def test_discovery_import_preserves_route_like_labels_with_ambiguous_provenance(self):
        self.store.upsert_discover_results_batch([("10.46.0.1", 7000, 1.0)])
        row = discover_rows(self.store)[0]
        self.store.update_discover_batch([row["id"]], add_labels=["家宽"])
        self.store.set_route_label("10.46.0.1", "CN2")
        result = self.store.import_discover_results([row["id"]])
        self.assertEqual(result.inserted, 1)
        server = self.store.list_servers()[0]
        self.assertEqual(server.label, ",家宽,CN2,")
        labels = {row["label"] for row in self.store.server_facets()["labels"]}
        self.assertEqual(labels, {"家宽", "CN2"})

    def test_label_mutations_lock_before_reading_normalized_relations(self):
        from app.probe import store as store_module
        server = self.store.create_server(ip="10.48.0.1", labels=["Existing"])
        real_connect = store_module.connect_database

        def traced_connect(path):
            connection = real_connect(path)
            connection.set_trace_callback(self.sql_trace.append)
            return connection

        self.sql_trace = []
        with mock.patch.object(store_module, "connect_database", side_effect=traced_connect):
            self.store.update_server(server.id, labels=["Existing", "Updated"])
            lock_index = next(i for i, sql in enumerate(self.sql_trace)
                              if sql.upper().startswith("BEGIN IMMEDIATE"))
            relation_index = next(i for i, sql in enumerate(self.sql_trace)
                                  if "SELECT st.server_id, st.tag_id, t.name" in sql)
            self.assertLess(lock_index, relation_index)

            self.sql_trace.clear()
            self.store.update_servers_batch([server.id], add_labels=["Batch"])
            lock_index = next(i for i, sql in enumerate(self.sql_trace)
                              if sql.upper().startswith("BEGIN IMMEDIATE"))
            relation_index = next(i for i, sql in enumerate(self.sql_trace)
                                  if "SELECT st.server_id, t.name" in sql)
            self.assertLess(lock_index, relation_index)

    def test_probe_servers_migration_backfills_ip_sort(self):
        # 旧结构库（无 ip_sort 列）→ initialize_database 回填；无效 IP 永驻 NULL
        import sqlite3 as _sq
        import tempfile as _tf
        from pathlib import Path as _Path
        from app.control import database as _database
        with _tf.TemporaryDirectory() as tmp:
            path = _Path(tmp) / "legacy.db"
            connection = _sq.connect(path)
            try:
                connection.executescript(
                    """
                    CREATE TABLE probe_servers (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        ip TEXT NOT NULL UNIQUE,
                        label TEXT NOT NULL DEFAULT '',
                        server_group TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL
                    );
                    INSERT INTO probe_servers (ip, label, created_at)
                    VALUES ('8.8.8.8', 'x', '2026-01-01T00:00:00'),
                           ('8.8.8.9:07000', '', '2026-01-01T00:00:00'),
                           ('speed.example.test', '', '2026-01-01T00:00:00'),
                           ('2001:db8::9', '', '2026-01-01T00:00:00'),
                           ('not-an-ip', '', '2026-01-01T00:00:00');
                    CREATE TABLE probe_current_results (
                        server_ip TEXT NOT NULL, kind TEXT NOT NULL, port INTEGER NOT NULL CHECK(port=7000),
                        source_result_id INTEGER NOT NULL, node_id TEXT NOT NULL, job_id TEXT NOT NULL,
                        task_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
                        test_time TEXT NOT NULL, data TEXT NOT NULL,
                        PRIMARY KEY(server_ip,kind,port)
                    );
                    INSERT INTO probe_current_results VALUES
                        ('8.8.8.8','speed',7000,1,'node','job','task',0,
                         '2026-10-21T00:00:00+00:00','{"dl_speed_bps":1048576}'),
                        ('8.8.8.9','speed',7000,2,'node','job','task',0,
                         '2026-10-22T00:00:00+00:00','{"dl_speed_bps":2097152}'),
                        ('speed.example.test','speed',7000,3,'node','job','task',0,
                         '2026-10-23T00:00:00+00:00','{"dl_speed_bps":3145728}'),
                        ('2001:db8::9','speed',7000,4,'node','job','task',0,
                         '2026-10-24T00:00:00+00:00','{"dl_speed_bps":4194304}');
                    """
                )
                connection.commit()
            finally:
                connection.close()
            _database._initialized_paths.discard(path.resolve())
            _database.initialize_database(path)
            connection = _database.connect_database(path)
            try:
                values = {row["ip"]: row["ip_sort"] for row in
                          connection.execute("SELECT ip, ip_sort FROM probe_servers")}
            finally:
                connection.close()
            self.assertEqual(values["8.8.8.8"], int(_ipv4_int("8.8.8.8")))
            self.assertIsNone(values["not-an-ip"])
            self.assertIsNone(values["8.8.8.9:07000"])
            connection = _database.connect_database(path)
            try:
                rows = {row["ip"]: (row["speed_sort"], row["time_sort"]) for row in
                        connection.execute("SELECT ip,speed_sort,time_sort FROM probe_servers")}
                indexes = {row["name"] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='index'")}
                self.assertEqual(rows["8.8.8.8"], (8.0, "2026-10-21T00:00:00+00:00"))
                self.assertEqual(rows["8.8.8.9:07000"], (16.0, "2026-10-22T00:00:00+00:00"))
                self.assertEqual(rows["speed.example.test"], (24.0, "2026-10-23T00:00:00+00:00"))
                self.assertEqual(rows["2001:db8::9"], (32.0, "2026-10-24T00:00:00+00:00"))
                self.assertIn("idx_probe_servers_speed_sort_id", indexes)
                self.assertIn("idx_probe_servers_time_sort_asc", indexes)
                self.assertIn("idx_probe_servers_time_sort_desc", indexes)
            finally:
                connection.close()

    def test_group_color(self):
        # 预创建分组带色 / 改色 / 清色；非法颜色拒绝
        self.store.create_group("红组", "red")
        with self.assertRaises(ValueError):
            self.store.create_group("坏组", "pink")
        colors = {item["name"]: item["color"] for item in self.store.list_groups_with_colors()}
        self.assertEqual(colors["红组"], "red")
        self.store.set_group_color("红组", "green")
        self.assertEqual(
            {item["name"]: item["color"] for item in self.store.list_groups_with_colors()}["红组"],
            "green")
        # 仅服务器在用（未预创建）的分组设色 → 自动补预创建记录
        self.store.import_servers([{"ip": "10.9.9.9", "group": "虚拟组"}])
        self.store.set_group_color("虚拟组", "blue")
        self.assertEqual(
            {item["name"]: item["color"] for item in self.store.list_groups_with_colors()}["虚拟组"],
            "blue")
        self.store.set_group_color("虚拟组", "")  # 清色
        self.assertEqual(
            {item["name"]: item["color"] for item in self.store.list_groups_with_colors()}["虚拟组"],
            "")
        # 重命名保留颜色
        self.store.rename_group("红组", "绿组")
        self.assertEqual(
            {item["name"]: item["color"] for item in self.store.list_groups_with_colors()}["绿组"],
            "green")

    def test_rename_group_cascades_all_tables(self):
        from app.lb.store import LbStore

        lb = LbStore(Path(self.tmpdir) / "probe.db")
        self.store.create_group("旧组")
        self.store.create_group("别的组")
        self.store.import_servers([{"ip": "10.0.0.1", "group": "旧组"}])
        self.store.upsert_discover_results_batch([("10.0.0.2", 7000, 3.2)])
        self.store.update_discover_batch(
            [row["id"] for row in discover_rows(self.store)], group="旧组")
        lb.create_domain(name="frps.example.com", zone_id="z", zone_name="example.com",
                         group_name="旧组")

        self.store.rename_group("旧组", "新组")
        self.assertIn("新组", self.store.list_groups())
        self.assertNotIn("旧组", self.store.list_groups())
        self.assertEqual(self.store.list_servers()[0].server_group, "新组")
        self.assertEqual(discover_rows(self.store)[0]["server_group"], "新组")
        self.assertEqual(lb.list_domains()[0].group_name, "新组")

        with self.assertRaises(ValueError):
            self.store.rename_group("新组", "别的组")  # 重名拒绝
        with self.assertRaises(ValueError):
            self.store.rename_group("新组", "  ")  # 空名拒绝

    def test_stable_group_ids_cover_assignments_rename_migration_and_delete_guard(self):
        import sqlite3
        from app.control.database import connect_database, _migrate_stable_group_ids
        from app.lb.store import LbStore
        from app.probe.store import DiscoverPageQuery, ServerPageQuery

        self.store.create_group("稳定组")
        group = next(row for row in self.store.list_groups_with_colors() if row["name"] == "稳定组")
        group_id = group["id"]
        # New callers may assign by ID; the legacy/API name remains the projection.
        server = self.store.create_server(ip="10.22.0.1", server_group=group_id)
        self.assertEqual(server.server_group, "稳定组")
        self.store.update_servers_batch([server.id], group=group_id)
        self.assertEqual(self.store.get_server(server.id).server_group, "稳定组")
        self.assertEqual(self.store.query_servers(ServerPageQuery(group=group_id))["total"], 1)
        self.store.upsert_discover_results_batch([("10.22.0.2", 7000, 12.0)])
        discover = self.store.query_discover_results(DiscoverPageQuery())
        self.store.update_discover_batch([discover["items"][0]["id"]], group=group_id)
        self.assertEqual(
            self.store.query_discover_results(DiscoverPageQuery(group=group_id))["total"], 1
        )
        lb = LbStore(self.store.database_path)
        domain = lb.create_domain(name="stable.example.com", zone_id="z", zone_name="example.com",
                                  group_name=group_id)
        self.assertEqual(domain.group_name, "稳定组")
        self.assertEqual(domain.group_id, group_id)

        self.store.rename_group("稳定组", "改名组")
        renamed = next(row for row in self.store.list_groups_with_colors() if row["name"] == "改名组")
        self.assertEqual(renamed["id"], group_id)
        self.assertEqual(self.store.get_server(server.id).server_group, "改名组")
        self.assertEqual(lb.list_domains()[0].group_name, "改名组")
        with self.assertRaises(ValueError):
            self.store.delete_group("改名组")

        # A completed migration short-circuits before scanning consumer names again.
        connection = connect_database(self.store.database_path)
        try:
            connection.set_authorizer(
                lambda action, arg1, arg2, db_name, trigger: (
                    sqlite3.SQLITE_DENY
                    if action == sqlite3.SQLITE_READ and arg2 in {"server_group", "group_name"}
                    else sqlite3.SQLITE_OK
                )
            )
            _migrate_stable_group_ids(connection)
            values = [connection.execute(f"SELECT group_id FROM {table} LIMIT 1").fetchone()[0]
                      for table in ("probe_servers", "probe_discover_results", "lb_domains")]
        finally:
            connection.close()
        self.assertEqual(values, [group_id, group_id, group_id])

    def test_stable_group_migration_failure_leaves_marker_clear_for_retry(self):
        import sqlite3
        from app.control.database import connect_database, _migrate_stable_group_ids

        connection = connect_database(self.store.database_path)
        try:
            connection.execute("DELETE FROM probe_settings WHERE key = 'probe_stable_group_ids_migrated'")
            connection.execute(
                "INSERT INTO probe_servers(ip,ip_sort,label,server_group,group_id,created_at) "
                "VALUES('10.23.0.1',NULL,'','legacy-retry',NULL,'2026-01-01T00:00:00')"
            )
            connection.execute(
                "CREATE TRIGGER fail_group_backfill BEFORE INSERT ON probe_groups "
                "WHEN NEW.name = 'legacy-retry' BEGIN SELECT RAISE(ABORT, 'forced backfill failure'); END"
            )
            connection.commit()
            connection.execute("BEGIN IMMEDIATE")
            with self.assertRaises(sqlite3.IntegrityError):
                _migrate_stable_group_ids(connection)
            connection.rollback()
            self.assertIsNone(connection.execute(
                "SELECT value FROM probe_settings WHERE key = 'probe_stable_group_ids_migrated'"
            ).fetchone())
            connection.execute("DROP TRIGGER fail_group_backfill")
            connection.execute("BEGIN IMMEDIATE")
            _migrate_stable_group_ids(connection)
            connection.commit()
            self.assertEqual(connection.execute(
                "SELECT value FROM probe_settings WHERE key = 'probe_stable_group_ids_migrated'"
            ).fetchone()[0], "1")
            self.assertIsNotNone(connection.execute(
                "SELECT group_id FROM probe_servers WHERE ip = '10.23.0.1'"
            ).fetchone()[0])
        finally:
            connection.close()

    def test_discover_results_upsert_and_library_flag(self):
        self.store.upsert_discover_results_batch([("10.0.0.9", 7000, 8.0)])
        self.store.update_discover_batch(
            [row["id"] for row in discover_rows(self.store)],
            group="池A", add_labels=["快"],
        )
        # 重复命中：更新延迟与时间，保留分组/标签
        self.store.upsert_discover_results_batch([("10.0.0.9", 7000, 1.5)])
        rows = discover_rows(self.store)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["server_group"], "池A")
        self.assertEqual(rows[0]["label"], ",未路由测试,快,")
        self.assertEqual(rows[0]["latency_ms"], 1.5)
        self.assertFalse(rows[0]["in_library"])

        # 同 IP 导入服务器库后在库标记翻真
        self.store.import_servers([{"ip": "10.0.0.9", "group": "池A"}])
        self.assertTrue(discover_rows(self.store)[0]["in_library"])

    def test_multi_label_flows(self):
        # 多标签：单 IP 可挂多个标签；路由结论剥旧加新；needs_route 判定
        from app.probe.store import ServerPageQuery
        self.store.upsert_discover_results_batch([("10.0.0.1", 7000, 1.0)])
        row = discover_rows(self.store)[0]
        self.store.update_discover_batch([row["id"]], add_labels=["家宽", "优选"])
        self.assertEqual(discover_rows(self.store)[0]["label"], ",未路由测试,家宽,优选,")
        self.assertTrue(self.store.discover_row_needs_route("10.0.0.1"))
        # 结论写回：剥掉未路由测试，保留用户标签
        self.store.set_route_label("10.0.0.1", "CN2")
        self.assertEqual(discover_rows(self.store)[0]["label"], ",家宽,优选,CN2,")
        self.assertFalse(self.store.discover_row_needs_route("10.0.0.1"))
        # 失败回退：结论变未路由测试（结论标签被剥后追加）
        self.store.set_route_label("10.0.0.1", "未路由测试")
        self.assertTrue(self.store.discover_row_needs_route("10.0.0.1"))
        # 服务器侧：q 搜索 + label 筛选在哨兵格式下工作
        self.store.import_discover_results([row["id"]])
        page = self.store.query_servers(ServerPageQuery(label="家宽"))
        self.assertEqual(page["total"], 1)

    def test_discover_batch_label_semantics(self):
        self.store.upsert_discover_results_batch([
            ("10.0.0.1", 7000, 1.0),
            ("10.0.0.2", 7000, 2.0),
        ])
        ids = [row["id"] for row in discover_rows(self.store)]
        self.store.update_discover_batch(ids, group="G", add_labels=["L1", "重点"])
        # 只改分组（不传标签参数 = 标签保留）
        self.store.update_discover_batch(ids[:1], group="G2")
        rows = {row["ip"]: row for row in discover_rows(self.store)}
        self.assertEqual(rows["10.0.0.1"]["server_group"], "G2")
        self.assertEqual(rows["10.0.0.1"]["label"], ",未路由测试,L1,重点,")
        # 去标签 + 加标签共存；重复添加幂等
        self.store.update_discover_batch(ids[1:], add_labels=["L1"], remove_labels=["重点"])
        self.store.update_discover_batch(ids[1:], add_labels=["L1"])
        rows = {row["ip"]: row for row in discover_rows(self.store)}
        self.assertEqual(rows["10.0.0.2"]["label"], ",未路由测试,L1,")

    def test_discover_delete_and_labels(self):
        self.store.upsert_discover_results_batch([
            ("10.0.0.1", 7000, 1.0),
            ("10.0.0.2", 7000, 2.0),
        ])
        self.store.import_servers([{"ip": "10.0.0.3", "label": "共用"}])
        self.store.update_discover_batch(
            [row["id"] for row in discover_rows(self.store) if row["ip"] == "10.0.0.1"],
            add_labels=["共用"])
        facets = {item["label"]: item["count"] for item in self.store.server_facets()["labels"]}
        self.assertEqual(facets, {"共用": 1})  # 仅服务器侧；发现行标签走 /discover/facets

        rows = discover_rows(self.store)
        # 发现 → 导入服务器的行必须带数值 ip_sort（数值排序的主入口路径）
        from app.probe.store import ServerPageQuery
        self.store.import_discover_results([rows[0]["id"]])
        imported = self.store.query_servers(ServerPageQuery(q="10.0.0.1", sort="ip", order="asc"))
        self.assertEqual(imported["total"], 1)
        self.assertIsNotNone(imported["items"][0]["ip_sort"])
        self.assertEqual(self.store.delete_discover_results([rows[0]["id"]]), 1)
        self.assertEqual(len(discover_rows(self.store)), 1)
        self.assertEqual(self.store.delete_discover_results(), 1)  # 清空
        self.assertEqual(discover_rows(self.store), [])

    def test_results_history_and_with_status(self):
        from app.control.database import connect_database  # noqa: F401 - 确保 SCHEMA 生效
        self.store.import_servers([{"ip": "10.0.0.1"}, {"ip": "10.0.0.2"}])
        self.store.add_connectivity_result({
            "server_ip": "10.0.0.1", "frps_reachable": True,
            "tunnel_established": True, "firewall_open": True, "detail": "",
        })
        self.store.add_connectivity_result({
            "server_ip": "10.0.0.1", "frps_reachable": True,
            "tunnel_established": True, "firewall_open": False, "detail": "旧记录",
        })
        self.store.add_speed_result({
            "server_ip": "10.0.0.1", "frps_reachable": True, "tunnel_ok": True,
            "dl_ok": True, "dl_speed_bps": 1024 * 1024, "dl_bytes": 100, "dl_sec": 1.0,
            "ul_ok": False, "ul_speed_bps": 0, "ul_bytes": 0, "ul_sec": 0.0,
            "detail": "上传失败",
        })
        rows = self.store.list_servers_with_status()
        by_ip = {row["ip"]: row for row in rows}
        # Legacy console writes remain in history but are not current projection rows.
        self.assertIsNone(by_ip["10.0.0.1"]["c_test_time"])
        self.assertIsNone(by_ip["10.0.0.1"]["s_test_time"])
        self.assertIsNone(by_ip["10.0.0.2"]["c_test_time"])

        history = self.store.list_connectivity_history(ip="10.0.0.1")
        self.assertEqual(len(history), 2)
        speed_history = self.store.list_speed_history()
        self.assertEqual(len(speed_history), 1)

        deleted = self.store.clear_history("connectivity")
        self.assertEqual(deleted, 2)
        self.assertEqual(self.store.list_connectivity_history(), [])
        with self.assertRaises(ValueError):
            self.store.clear_history("bogus")

    def test_dashboard(self):
        self.store.import_servers([{"ip": "10.0.0.1"}, {"ip": "10.0.0.2"}, {"ip": "10.0.0.3"}])
        for ip, ok in [("10.0.0.1", True), ("10.0.0.2", True), ("10.0.0.3", False)]:
            self.store.add_connectivity_result({
                "server_ip": ip, "frps_reachable": ok,
                "tunnel_established": ok, "firewall_open": ok, "detail": "",
            })
        self.store.add_speed_result({
            "server_ip": "10.0.0.1", "frps_reachable": True, "tunnel_ok": True,
            "dl_ok": True, "dl_speed_bps": 2 * 1024 * 1024, "dl_bytes": 1, "dl_sec": 1.0,
            "ul_ok": True, "ul_speed_bps": 1024 * 1024, "ul_bytes": 1, "ul_sec": 1.0,
            "detail": "",
        })
        stats = self.store.dashboard()
        self.assertEqual(stats["servers"], 3)
        self.assertEqual(stats["connectivity"]["tested"], 0)
        self.assertEqual(stats["connectivity"]["reachable"], 0)
        self.assertIsNone(stats["speed"]["avgDownloadMbps"])
        self.assertIsNone(stats["speed"]["avgUploadMbps"])

    def test_group_precreate_and_merge(self):
        # 预创建分组在没有任何服务器时就存在
        self.store.create_group("海外节点")
        self.assertEqual(self.store.list_groups(), ["海外节点"])
        # 重复创建幂等
        self.store.create_group("海外节点")
        # 服务器使用的分组与预创建分组合并去重
        self.store.import_servers([{"ip": "10.9.9.9", "group": "国内节点"}])
        self.assertEqual(self.store.list_groups(), ["国内节点", "海外节点"])
        # 删除预创建记录不影响服务器行
        self.assertTrue(self.store.delete_group("海外节点"))
        self.assertFalse(self.store.delete_group("海外节点"))  # 已不存在
        rows = self.store.list_servers()
        self.assertEqual(rows[0].server_group, "国内节点")

    def test_batch_update_servers(self):
        self.store.import_servers([
            {"ip": "10.1.1.1", "group": "a"}, {"ip": "10.1.1.2", "group": "a"}, {"ip": "10.1.1.3"},
        ])
        ids = [s.id for s in self.store.list_servers() if s.ip in ("10.1.1.1", "10.1.1.2")]
        updated = self.store.update_servers_batch(ids, group="b")
        self.assertEqual(updated, 2)
        rows = {s.ip: s for s in self.store.list_servers()}
        self.assertEqual(rows["10.1.1.1"].server_group, "b")
        self.assertEqual(rows["10.1.1.2"].server_group, "b")
        self.assertEqual(rows["10.1.1.3"].server_group, "")
        # 批量改标签（含清除）
        self.store.update_servers_batch(ids, group=None, add_labels=["重点"])
        rows = {s.ip: s for s in self.store.list_servers()}
        self.assertEqual(rows["10.1.1.1"].label, ",重点,")
        self.store.update_servers_batch(ids, group=None, remove_labels=["重点"])
        rows = {s.ip: s for s in self.store.list_servers()}
        self.assertEqual(rows["10.1.1.1"].label, "")  # remove 后无标签
        # 空分组拒绝
        with self.assertRaises(ValueError):
            self.store.update_servers_batch(ids, group="  ")
        with self.assertRaises(ValueError):
            self.store.update_servers_batch(ids, group=None)


    def test_discover_page_filters_facets_and_stable_sorts(self):
        from app.control.database import connect_database
        from app.probe.store import DiscoverPageQuery

        self.store.upsert_discover_results_batch([
            ("10.0.0.10", 7000, 5.0),
            ("10.0.0.2", 7000, 5.0),
            ("10.0.0.3", 7000, 1.0),
        ])
        rows = {row["ip"]: row for row in discover_rows(self.store)}
        self.store.update_discover_batch(
            [rows["10.0.0.10"]["id"]], group="east", add_labels=["fast"]
        )
        self.store.update_discover_batch(
            [rows["10.0.0.2"]["id"]], group="west", add_labels=["slow"]
        )
        self.store.import_servers([{"ip": "10.0.0.2"}])

        connection = connect_database(Path(self.tmpdir) / "probe.db")
        try:
            connection.execute(
                "INSERT INTO probe_discover_results "
                "(ip, ip_sort, port, latency_ms, server_group, label, discovered_at) "
                "VALUES (?, NULL, ?, ?, ?, ?, ?)",
                ("legacy.invalid", 7000, 9.0, "east", "legacy", "2026-01-01T00:00:00"),
            )
            connection.execute(
                "UPDATE probe_discover_results SET discovered_at = ?",
                ("2026-01-01T00:00:00",),
            )
            connection.commit()
        finally:
            connection.close()

        page = self.store.query_discover_results(
            DiscoverPageQuery(page=2, page_size=2, sort="ip", order="asc")
        )
        self.assertEqual(
            {key: page[key] for key in ("page", "pageSize", "total", "sort", "order")},
            {"page": 2, "pageSize": 2, "total": 4, "sort": "ip", "order": "asc"},
        )
        self.assertEqual([row["ip"] for row in page["items"]], ["10.0.0.10", "legacy.invalid"])
        descending = self.store.query_discover_results(
            DiscoverPageQuery(page_size=10, sort="ip", order="desc")
        )
        self.assertEqual(
            [row["ip"] for row in descending["items"]],
            ["10.0.0.10", "10.0.0.3", "10.0.0.2", "legacy.invalid"],
        )
        for sort in ("time", "latency"):
            for order in ("asc", "desc"):
                result = self.store.query_discover_results(
                    DiscoverPageQuery(page_size=10, sort=sort, order=order)
                )
                ids = [row["id"] for row in result["items"]]
                self.assertEqual(ids, sorted(ids, reverse=order == "desc") if sort == "time" else ids)
        latency_tie = self.store.query_discover_results(
            DiscoverPageQuery(page_size=10, sort="latency", order="asc")
        )["items"]
        tied_ids = [row["id"] for row in latency_tie if row["latency_ms"] == 5.0]
        self.assertEqual(tied_ids, sorted(tied_ids))

        self.assertEqual(
            self.store.query_discover_results(
                DiscoverPageQuery(page_size=10, q="east", group="east")
            )["total"],
            2,
        )
        self.assertEqual(
            self.store.query_discover_results(
                DiscoverPageQuery(page_size=10, label="fast")
            )["total"],
            1,
        )
        self.assertEqual(
            self.store.query_discover_results(
                DiscoverPageQuery(page_size=10, library="imported")
            )["total"],
            1,
        )
        self.assertEqual(
            self.store.query_discover_results(
                DiscoverPageQuery(page_size=10, library="new")
            )["total"],
            3,
        )
        facets = self.store.discover_facets()
        self.assertEqual((facets["imported"], facets["new"]), (1, 3))
        self.assertIn({"group": "east", "count": 2}, facets["groups"])
        self.assertIn({"label": "fast", "count": 1}, facets["labels"])
        with self.assertRaises(ValueError):
            DiscoverPageQuery(page_size=201)

    def test_selected_lookup_import_and_batch_upsert_contracts(self):
        eligible = self.store.upsert_discover_results_batch([
            ("10.0.0.1", 7000, 4.0),
            ("10.0.0.1", 7000, 2.0),
            ("10.0.0.1", 7001, 3.0),
            ("10.0.0.2", 7000, 5.0),
        ])
        self.assertEqual(eligible, ["10.0.0.1", "10.0.0.2"])
        rows = discover_rows(self.store)
        by_key = {(row["ip"], row["port"]): row for row in rows}
        self.assertEqual(by_key[("10.0.0.1", 7000)]["latency_ms"], 2.0)
        self.store.update_discover_batch(
            [by_key[("10.0.0.1", 7000)]["id"]], group="G", add_labels=["custom"]
        )
        selected_ids = [
            by_key[("10.0.0.2", 7000)]["id"],
            999999,
            by_key[("10.0.0.1", 7000)]["id"],
            by_key[("10.0.0.2", 7000)]["id"],
        ]
        selected = self.store.get_discover_results_by_ids(selected_ids)
        self.assertEqual(
            [row["id"] for row in selected],
            [selected_ids[0], selected_ids[2]],
        )
        first_import = self.store.import_discover_results(selected_ids, group="override")
        self.assertEqual(first_import, (2, 2, 0))
        second_import = self.store.import_discover_results(selected_ids)
        self.assertEqual(second_import, (2, 0, 2))
        self.assertEqual({server.server_group for server in self.store.list_servers()}, {"override"})

        self.store.set_route_label("10.0.0.1", "CN2")
        self.assertEqual(
            self.store.upsert_discover_results_batch([("10.0.0.1", 7000, 1.0)]), []
        )
        row = self.store.get_discover_results_by_ids([by_key[("10.0.0.1", 7000)]["id"]])[0]
        # 多标签语义：旧结论/未路由测试被剥掉，只留结论
        self.assertEqual((row["label"], row["server_group"]), (",custom,CN2,", "G"))

    def test_import_discovery_empty_and_missing_ids_return_zero_selected(self):
        empty = self.store.import_discover_results([])
        missing = self.store.import_discover_results([999999])

        self.assertEqual(empty, (0, 0, 0))
        self.assertEqual(missing, (0, 0, 0))
        self.assertEqual(self.store.list_servers(), [])

    def test_import_discovery_counts_selected_same_ip_rows_and_uses_first_metadata(self):
        self.store.upsert_discover_results_batch([
            ("10.0.2.1", 7000, 1.0),
            ("10.0.2.1", 7001, 2.0),
        ])
        rows = {
            row["port"]: row
            for row in discover_rows(self.store)
            if row["ip"] == "10.0.2.1"
        }
        self.store.update_discover_batch(
            [rows[7000]["id"]], group="first-group", add_labels=["first-label"]
        )
        self.store.update_discover_batch(
            [rows[7001]["id"]], group="second-group", add_labels=["second-label"]
        )

        result = self.store.import_discover_results(
            [rows[7001]["id"], rows[7000]["id"], rows[7001]["id"]]
        )

        self.assertEqual(result, (2, 1, 1))
        server = next(server for server in self.store.list_servers() if server.ip == "10.0.2.1")
        self.assertEqual((server.label, server.server_group),
                         (",未路由测试,second-label,", "second-group"))

    def test_batch_operations_chunk_at_lower_sqlite_limit(self):
        from app.probe import store as store_module

        self.store.upsert_discover_results_batch(
            [(f"10.0.0.{index}", 7000, float(index)) for index in range(1, 13)]
        )
        ids = [row["id"] for row in discover_rows(self.store)]
        real_connect = store_module.connect_database

        def limited_connect(path):
            connection = real_connect(path)
            connection.setlimit(store_module.sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 12)
            return connection

        with mock.patch.object(store_module, "connect_database", side_effect=limited_connect):
            self.assertEqual(
                self.store.update_discover_batch(ids + ids[:2] + [999999], group="chunked"),
                12,
            )
            selected = self.store.get_discover_results_by_ids(ids + ids[:2] + [999999])
            self.assertEqual(len(selected), 12)
            self.assertEqual(self.store.delete_discover_results([]), 0)
            self.assertEqual(self.store.delete_discover_results(ids[:7] + ids[:2]), 7)
        self.assertEqual(len(discover_rows(self.store)), 5)
        self.assertEqual(self.store.delete_discover_results(None), 5)

    def test_batch_update_rolls_back_when_later_chunk_fails(self):
        from app.control.database import connect_database
        from app.probe import store as store_module

        self.store.upsert_discover_results_batch(
            [(f"10.0.1.{index}", 7000, 1.0) for index in range(1, 8)]
        )
        ids = [row["id"] for row in discover_rows(self.store)]
        connection = connect_database(Path(self.tmpdir) / "probe.db")
        try:
            connection.execute(
                "CREATE TRIGGER fail_late_update BEFORE UPDATE ON probe_discover_results "
                f"WHEN OLD.id = {ids[-1]} AND NEW.server_group = 'boom' "
                "BEGIN SELECT RAISE(ABORT, 'later chunk failed'); END"
            )
            connection.commit()
        finally:
            connection.close()

        def tiny_chunks(connection, items, *, headroom=0):
            for start in range(0, len(items), 3):
                yield items[start:start + 3]

        with mock.patch.object(store_module, "_chunks", side_effect=tiny_chunks):
            with self.assertRaisesRegex(Exception, "later chunk failed"):
                self.store.update_discover_batch(ids, group="boom")
        self.assertEqual(
            {row["server_group"] for row in discover_rows(self.store)}, {""}
        )


class ProbeApiTests(unittest.TestCase):
    """probe API 全链路：库管理 → 启动测试 → 状态轮询 → 历史/统计/审计。"""

    @staticmethod
    def load_probe_app(**env: str):
        import sys

        previous = {key: os.environ.get(key) for key in env}
        os.environ.update(env)
        for module_name in [
            "app.main",
            "app.probe.router",
        "app.probe.route",
            "app.probe.runner",
            "app.probe.discover",
            "app.control.router",
            "app.control.hub",
            "app.settings",
            "app.auth",
        ]:
            sys.modules.pop(module_name, None)
        try:
            return importlib.import_module("app.main").app
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def make_client(self, **extra_env):
        from fastapi.testclient import TestClient

        self.db_path = Path(tempfile.mkdtemp(prefix="frpc-probe-api-")) / "console.db"
        env = dict(
            WEBUI_USERNAME="admin",
            WEBUI_PASSWORD="password",
            DATABASE_PATH=str(self.db_path),
        )
        env.update(extra_env)
        app = self.load_probe_app(**env)
        client = TestClient(app)
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        response = client.post("/api/auth/login", json={"username": "admin", "password": "password"})
        token = response.json()["token"]
        return client, {"Authorization": f"Bearer {token}"}

    def test_server_cursor_and_separate_count_endpoints(self):
        client, headers = self.make_client()
        from app.probe.store import ProbeStore
        store = ProbeStore(self.db_path)
        for ip in ("192.0.2.11", "192.0.2.12", "192.0.2.13"):
            store.create_server(ip=ip)
        first = client.get("/api/probe/servers/cursor?pageSize=2&sort=ip&order=asc", headers=headers)
        self.assertEqual(first.status_code, 200)
        payload = first.json()
        self.assertEqual(set(payload), {"items", "nextCursor", "hasMore"})
        self.assertEqual([item["ip"] for item in payload["items"]], ["192.0.2.11", "192.0.2.12"])
        self.assertTrue(payload["hasMore"])
        second = client.get("/api/probe/servers/cursor?pageSize=2&sort=ip&order=asc&cursor=" + payload["nextCursor"], headers=headers)
        self.assertEqual([item["ip"] for item in second.json()["items"]], ["192.0.2.13"])
        self.assertFalse(second.json()["hasMore"])
        self.assertEqual(client.get("/api/probe/servers/count", headers=headers).json(), {"total": 3})
        mismatch = client.get("/api/probe/servers/cursor?pageSize=2&sort=ip&order=asc&q=other&cursor=" + payload["nextCursor"], headers=headers)
        self.assertEqual(mismatch.status_code, 400)
        unsupported = client.get("/api/probe/servers/cursor?sort=group", headers=headers)
        self.assertEqual(unsupported.status_code, 400)
        malformed = client.get("/api/probe/servers/cursor?cursor=W10", headers=headers)
        self.assertEqual(malformed.status_code, 400)
        too_many_tags = ",".join(f"tag-{i}" for i in range(101))
        capped = client.get("/api/probe/servers/count?includeTagIds=" + too_many_tags, headers=headers)
        self.assertEqual(capped.status_code, 400)

    def test_missing_frpc_bin_rejected(self):
        client, headers = self.make_client(PROBE_FRPC_BIN="/nonexistent/frpc")
        response = client.post("/api/probe/servers/batch", json={"text": "127.0.0.1"}, headers=headers)
        self.assertEqual(response.status_code, 200)
        response = client.post("/api/probe/test", json={"mode": "connectivity"}, headers=headers)
        self.assertEqual(response.status_code, 400)
        self.assertIn("配置测试节点", response.json()["detail"])

    def test_connectivity_flow_and_audit(self):
        tcping = mock.patch("app.probe.engine.tcping", return_value=(False, "mock unreachable"))
        tcping.start()
        self.addCleanup(tcping.stop)
        client, headers = self.make_client(
            PROBE_FRPC_BIN="/bin/echo",
            PROBE_FRPS_PORT="7000",
            PROBE_TCPING_TIMEOUT="1",
            PROBE_TCPING_RETRIES="1",
        )
        primary = client.post("/api/probe/nodes", json={"name": "primary-api"}, headers=headers).json()
        configured = client.put("/api/probe/nodes/execution-policy", json={
            "primaryNodeId": primary["id"], "backupNodeIds": [],
        }, headers=headers)
        self.assertEqual(configured.status_code, 200)
        # 库管理
        response = client.post("/api/probe/servers", json={"ip": "127.0.0.1", "label": "本机"}, headers=headers)
        self.assertEqual(response.status_code, 200)
        response = client.post("/api/probe/servers", json={"ip": "127.0.0.1"}, headers=headers)
        self.assertEqual(response.status_code, 400)
        response = client.post("/api/probe/servers", json={"ip": 'bad"ip'}, headers=headers)
        self.assertEqual(response.status_code, 400)
        # JSON 批量导入
        response = client.post(
            "/api/probe/servers/batch",
            json={"text": json.dumps([{"ip": "10.1.1.1", "label": "A", "group": "g"}, "10.1.1.2"])},
            headers=headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["inserted"], 2)
        servers = client.get("/api/probe/servers", headers=headers).json()
        self.assertEqual(servers["total"], 3)
        groups = client.get("/api/probe/servers/groups", headers=headers).json()
        self.assertEqual(groups[0]["name"], "g")
        self.assertEqual(groups[0]["color"], "")
        self.assertTrue(groups[0]["id"])
        # 启动测试（frps 不可达 → 每个 IP 快速失败）
        response = client.post(
            "/api/probe/test", json={"mode": "connectivity", "ips": ["127.0.0.1"]}, headers=headers,
        )
        self.assertEqual(response.status_code, 200)
        status = client.get("/api/probe/test/status", headers=headers).json()
        self.assertTrue(status["running"])
        self.assertEqual(status["done"], 0)
        self.assertEqual(status["total"], 1)
        queued = client.get(f"/api/probe/jobs/{status['jobId']}", headers=headers).json()
        self.assertEqual(queued["nodeIds"], [primary["id"]])
        # 结果只进入历史 after the primary worker executes the queued task.
        history = client.get("/api/probe/history/connectivity", headers=headers).json()
        self.assertEqual(len(history), 0)
        # 统计
        stats = client.get("/api/probe/dashboard", headers=headers).json()
        self.assertEqual(stats["servers"], 3)
        self.assertEqual(stats["connectivity"]["tested"], 0)
        # with-status 列表带最新结果（分页 envelope）
        servers = client.get("/api/probe/servers?pageSize=200", headers=headers).json()
        self.assertEqual(servers["total"], 3)
        by_ip = {row["ip"]: row for row in servers["items"]}
        self.assertIsNone(by_ip["127.0.0.1"]["latestConnectivity"])
        self.assertIsNone(by_ip["127.0.0.1"]["latestSpeed"])
        # 审计
        logs = client.get("/api/audit-logs?limit=50", headers=headers).json()
        actions = {log["action"] for log in logs}
        self.assertIn("probe_create_server", actions)
        self.assertIn("probe_import_servers", actions)
        self.assertIn("probe_start_test", actions)
        # 清空历史
        response = client.delete("/api/probe/history/connectivity", headers=headers)
        self.assertEqual(response.json()["deleted"], 0)
        self.assertEqual(client.get("/api/probe/history/connectivity", headers=headers).json(), [])

    def test_failover_history_api_filters_pages_and_orders_ties_stably(self):
        client, headers = self.make_client(PROBE_FRPC_BIN="/bin/echo")
        primary = client.post('/api/probe/nodes', json={'name': 'failover-primary'}, headers=headers).json()
        backup = client.post('/api/probe/nodes', json={'name': 'failover-backup'}, headers=headers).json()
        self.assertEqual(client.put('/api/probe/nodes/execution-policy', json={
            'primaryNodeId': primary['id'], 'backupNodeIds': [backup['id']],
        }, headers=headers).status_code, 200)

        from app.probe.jobs import ProbeJobStore
        store = ProbeJobStore(self.db_path)
        job = store.create_primary_job('connectivity', ips=['192.0.2.41', '192.0.2.42'])
        with store._db() as c:
            c.execute('UPDATE probe_nodes SET last_seen=0 WHERE id=?', (primary['id'],))
        store.heartbeat(backup['id'], 'test', ['discover', 'route', 'connectivity', 'speed'], [], ['task-generation-v1'])
        self.assertIsNotNone(store.claim(backup['id']))
        self.assertIsNotNone(store.claim(backup['id']))

        all_rows = client.get('/api/probe/nodes/failovers?page=1&pageSize=10', headers=headers)
        self.assertEqual(all_rows.status_code, 200)
        items = all_rows.json()['items']
        self.assertEqual(len(items), 2)
        self.assertEqual([item['id'] for item in items], sorted([item['id'] for item in items], reverse=True))
        self.assertTrue(all(item['jobId'] == job['id'] for item in items))
        from urllib.parse import urlencode
        filtered = client.get('/api/probe/nodes/failovers?' + urlencode({
            'nodeId': backup['id'], 'fromTime': items[-1]['transferredAt'], 'toTime': items[0]['transferredAt'],
        }), headers=headers).json()
        self.assertEqual(filtered['total'], 2)
        first_page = client.get('/api/probe/nodes/failovers?page=1&pageSize=1', headers=headers).json()
        second_page = client.get('/api/probe/nodes/failovers?page=2&pageSize=1', headers=headers).json()
        self.assertEqual(first_page['items'][0]['id'], items[0]['id'])
        self.assertEqual(second_page['items'][0]['id'], items[1]['id'])

    def test_server_update_delete_and_not_found(self):
        client, headers = self.make_client()
        created = client.post("/api/probe/servers", json={"ip": "10.2.2.2"}, headers=headers).json()
        response = client.patch(f"/api/probe/servers/{created['id']}", json={"labels": ["改名"]}, headers=headers)
        self.assertEqual(response.json()["labels"], ["改名"])
        response = client.delete(f"/api/probe/servers/{created['id']}", headers=headers)
        self.assertTrue(response.json()["ok"])
        response = client.patch("/api/probe/servers/99999", json={"label": "x"}, headers=headers)
        self.assertEqual(response.status_code, 404)

    def test_tag_management_and_server_tag_id_api(self):
        client, headers = self.make_client()
        category = client.post(
            "/api/probe/tags/categories", json={"name": "api-region"}, headers=headers
        ).json()
        tag = client.post(
            "/api/probe/tags", json={"categoryId": category["id"], "name": "West"}, headers=headers
        ).json()
        created = client.post(
            "/api/probe/servers",
            json={"ip": "10.2.4.1", "labels": ["manual"], "tagIds": [tag["id"]]},
            headers=headers,
        ).json()
        self.assertEqual(set(created["labels"]), {"manual", "West"})
        updated = client.patch(
            f"/api/probe/servers/{created['id']}", json={"tagIds": [tag["id"]]}, headers=headers
        ).json()
        self.assertEqual(updated["labels"], ["West"])

        second_tag = client.post(
            "/api/probe/tags", json={"categoryId": category["id"], "name": "East"}, headers=headers
        ).json()
        result = client.post(
            "/api/probe/servers/batch-update",
            json={"ids": [created["id"]], "addTagIds": [second_tag["id"]]}, headers=headers,
        )
        self.assertEqual(result.json()["updated"], 1)
        labels = client.get("/api/probe/servers/facets", headers=headers).json()["labels"]
        self.assertEqual({row["label"] for row in labels}, {"East", "West"})
        items = client.get(f"/api/probe/tags?categoryId={category['id']}", headers=headers).json()["items"]
        self.assertEqual({row["id"] for row in items}, {tag["id"], second_tag["id"]})
        renamed = client.patch(
            f"/api/probe/tags/categories/{category['id']}",
            json={"name": "api-region-renamed"}, headers=headers,
        ).json()
        self.assertEqual(renamed["id"], category["id"])

    def test_server_batch_import_limits_return_413_without_writes(self):
        from app.probe.store import (
            MAX_SERVER_IMPORT_ITEMS, MAX_SERVER_IMPORT_TEXT_BYTES, ProbeStore,
        )
        client, headers = self.make_client()
        oversized_text = "x" * (MAX_SERVER_IMPORT_TEXT_BYTES + 1)
        response = client.post(
            "/api/probe/servers/batch", json={"text": oversized_text}, headers=headers
        )
        self.assertEqual(response.status_code, 413)
        self.assertIn("拆分", response.json()["detail"])
        self.assertEqual(ProbeStore(self.db_path).list_servers(), [])

        entries = json.dumps(["10.53.0.1"] * (MAX_SERVER_IMPORT_ITEMS + 1))
        response = client.post(
            "/api/probe/servers/batch", json={"text": entries}, headers=headers
        )
        self.assertEqual(response.status_code, 413)
        self.assertIn("5000", response.json()["detail"])
        self.assertEqual(ProbeStore(self.db_path).list_servers(), [])

    def test_server_api_accepts_tag_id_and_returns_category_aware_facets(self):
        client, headers = self.make_client()
        from app.control.database import connect_database
        from app.probe.store import ProbeStore

        store = ProbeStore(self.db_path)
        first = store.create_server(ip="10.2.3.1", labels=["Shared"])
        second = store.create_server(ip="10.2.3.2", labels=["Shared"])
        connection = connect_database(self.db_path)
        try:
            connection.execute("DELETE FROM probe_server_tags WHERE server_id=?", (second.id,))
            region_id = connection.execute(
                "SELECT id FROM probe_tag_categories WHERE name='region'"
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO probe_tags(id,category_id,name,created_at) "
                "VALUES('api-region-shared',?,'Shared','2026-01-01')", (region_id,)
            )
            connection.execute(
                "INSERT INTO probe_server_tags(server_id,tag_id) VALUES(?, 'api-region-shared')",
                (second.id,),
            )
            connection.commit()
        finally:
            connection.close()

        filtered = client.get(
            "/api/probe/servers?tagId=api-region-shared", headers=headers
        ).json()
        self.assertEqual([item["ip"] for item in filtered["items"]], ["10.2.3.2"])
        facets = client.get("/api/probe/servers/facets", headers=headers).json()
        self.assertEqual({item["label"]: item["count"] for item in facets["labels"]}["Shared"], 2)
        self.assertEqual({item["category"] for item in facets["tagItems"]
                          if item["name"] == "Shared"}, {"other", "region"})

    def test_primary_route_enriches_server_and_discovery_for_console_source(self):
        client, headers = self.make_client()
        from app.probe.jobs import ProbeJobStore
        from app.probe.store import ProbeStore

        ip = '192.0.2.92'
        assets = ProbeStore(self.db_path)
        assets.create_server(ip=ip)
        assets.create_server(ip=ip + ':7001')
        assets.upsert_discover_results_batch([(ip, 7000, 4.0), (ip, 7001, 5.0)])
        jobs = ProbeJobStore(self.db_path)
        primary = jobs.create_node('route-current-primary')['id']
        jobs.set_execution_policy(primary, [])
        jobs.heartbeat(primary, 'test', ['discover', 'route', 'connectivity', 'speed'], [])
        jobs.create_primary_job('route', ips=[ip])
        task = jobs.claim(primary)
        jobs.report(primary, task['taskId'], task['attemptId'], result={'ok': True, 'isCn2': True})

        servers = client.get('/api/probe/servers?nodeId=console', headers=headers).json()
        server_items = {item['ip']: item for item in servers['items']}
        latest_route = server_items[ip]['latestRoute']
        self.assertEqual(latest_route['node_id'], primary)
        self.assertTrue(latest_route['ok'])
        self.assertEqual(server_items[ip]['nodeId'], 'console')
        self.assertIsNone(server_items[ip + ':7001']['latestRoute'])

        discovered = client.get('/api/probe/discover/results?nodeId=console', headers=headers).json()
        discovered_items = {(item['ip'], item['port']): item for item in discovered['items']}
        discovered_item = discovered_items[(ip, 7000)]
        self.assertEqual(discovered_item['latestRoute']['node_id'], primary)
        self.assertTrue(discovered_item['latestRoute']['isCn2'])
        self.assertIn('CN2', discovered_item['labels'])
        self.assertIsNone(discovered_items[(ip, 7001)]['latestRoute'])

    def test_start_test_rejects_bad_requests(self):
        client, headers = self.make_client(PROBE_FRPC_BIN="/bin/echo")
        response = client.post("/api/probe/test", json={"mode": "bogus"}, headers=headers)
        self.assertEqual(response.status_code, 400)
        response = client.post("/api/probe/test", json={"mode": "connectivity"}, headers=headers)
        self.assertEqual(response.status_code, 400)  # 没有服务器
        response = client.post(
            "/api/probe/test", json={"mode": "connectivity", "ips": ['x"y']}, headers=headers,
        )
        self.assertEqual(response.status_code, 400)


    def test_remote_full_history_without_imported_asset(self):
        client, headers = self.make_client(PROBE_FRPC_BIN='/missing/frpc')
        from app.control.database import connect_database
        from app.probe.jobs import ProbeJobStore

        node=ProbeJobStore(self.db_path).create_node('remote')
        connection=connect_database(self.db_path)
        try:
            connection.execute(
                'INSERT INTO probe_results(task_id,attempt_id,job_id,node_id,kind,server_ip,port,test_time,data) '
                'VALUES(?,?,?,?,?,?,?,?,?)',
                ('legacy-connectivity-7001','', 'legacy-job',node['id'],'connectivity','192.0.2.1',7001,
                 '2026-10-22T00:00:00+00:00',json.dumps({'frps_reachable':False})),
            )
            connection.commit()
        finally:
            connection.close()
        history=client.get('/api/probe/history/connectivity?nodeId='+node['id'],headers=headers).json()
        self.assertEqual(len(history),1);self.assertEqual(history[0]['port'],7001)
        self.assertEqual(history[0]['serverIp'],'192.0.2.1');self.assertEqual(history[0]['nodeId'],node['id'])
        self.assertEqual(client.get('/api/probe/servers',headers=headers).json()['total'],0)


class ProbeConfigApiTests(unittest.TestCase):
    """面板可调配置：读取默认值、保存覆盖、校验拒绝、启动测试时生效。"""

    @staticmethod
    def load_probe_app(**env: str):
        import importlib
        import sys

        previous = {key: os.environ.get(key) for key in env}
        os.environ.update(env)
        for module_name in [
            "app.main", "app.probe.router", "app.probe.runner",
            "app.control.router", "app.control.hub", "app.settings", "app.auth",
        ]:
            sys.modules.pop(module_name, None)
        try:
            return importlib.import_module("app.main").app
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def make_client(self, **extra_env):
        from fastapi.testclient import TestClient

        self.db_path = Path(tempfile.mkdtemp(prefix="frpc-probe-cfg-")) / "console.db"
        env = dict(WEBUI_USERNAME="admin", WEBUI_PASSWORD="password", DATABASE_PATH=str(self.db_path))
        env.update(extra_env)
        app = self.load_probe_app(**env)
        client = TestClient(app)
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        response = client.post("/api/auth/login", json={"username": "admin", "password": "password"})
        token = response.json()["token"]
        return client, {"Authorization": f"Bearer {token}"}

    def test_config_roundtrip_and_validation(self):
        client, headers = self.make_client(PROBE_FRPS_PORT="7000")
        current = client.get("/api/probe/config", headers=headers).json()
        self.assertEqual(current["frpsPort"], 7000)
        self.assertFalse(current["hasOverride"])

        saved = client.post("/api/probe/config", json={"values": {
            "frpsPort": 7500, "basePort": 21000, "tcpingTimeout": 3,
            "speedConcurrency": 1,
        }}, headers=headers).json()
        self.assertEqual(saved["frpsPort"], 7500)
        self.assertEqual(saved["basePort"], 21000)
        self.assertTrue(saved["hasOverride"])

        # 非法值拒绝且不落库
        bad = client.post("/api/probe/config", json={"values": {"frpsPort": 99999}}, headers=headers)
        self.assertEqual(bad.status_code, 400)
        bad = client.post("/api/probe/config", json={"values": {"bogus": 1}}, headers=headers)
        self.assertEqual(bad.status_code, 400)
        reread = client.get("/api/probe/config", headers=headers).json()
        self.assertEqual(reread["frpsPort"], 7500)

        # 审计
        logs = client.get("/api/audit-logs?limit=10", headers=headers).json()
        actions = {log["action"] for log in logs}
        self.assertIn("probe_update_config", actions)

    def test_saved_config_used_by_start(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        dead_port = server.getsockname()[1]
        server.close()
        client, headers = self.make_client(
            PROBE_FRPC_BIN="/bin/echo", PROBE_TCPING_TIMEOUT="1", PROBE_TCPING_RETRIES="1",
        )
        # 注意：make_client 会重载 app.probe.router，引用必须在它之后取
        from app.probe import router as probe_router

        saved = client.post("/api/probe/config", json={"values": {"frpsPort": dead_port}}, headers=headers).json()
        self.assertEqual(saved["frpsPort"], dead_port)
        client.post("/api/probe/servers/batch", json={"text": "127.0.0.1"}, headers=headers)

        captured = {}
        original_start = probe_router.runner.start

        def fake_start(mode, ips, options, requested_node_ids=None):
            captured["options"] = options
            return True, ""

        probe_router.runner.start = fake_start
        try:
            response = client.post("/api/probe/test", json={"mode": "connectivity"}, headers=headers)
            self.assertEqual(response.status_code, 200)
        finally:
            probe_router.runner.start = original_start
        self.assertEqual(captured["options"].frps_port, dead_port)


class ParseBatchTextTests(unittest.TestCase):
    def test_plain_lines_with_optional_label(self):
        from app.probe.router import parse_batch_text

        items = parse_batch_text("1.2.3.4\n5.6.7.8 香港VPS\n\n", "g")
        self.assertEqual(items, [
            {"ip": "1.2.3.4", "label": "", "group": "g"},
            {"ip": "5.6.7.8", "label": "香港VPS", "group": "g"},
        ])

    def test_whole_json_array(self):
        from app.probe.router import parse_batch_text

        items = parse_batch_text('[{"ip":"1.1.1.1","label":"A","group":"x"},"2.2.2.2"]')
        self.assertEqual(items[0]["group"], "x")
        self.assertEqual(items[1], {"ip": "2.2.2.2", "label": "", "group": ""})

    def test_mixed_lines_with_inline_json(self):
        from app.probe.router import parse_batch_text

        # 普通行 + 单行 JSON 混合粘贴（原项目导出片段拼进清单的场景）
        items = parse_batch_text('127.0.0.30 本机\n{"ip":"127.0.0.32","label":"J","group":"JG"}', "默认组")
        self.assertEqual(items, [
            {"ip": "127.0.0.30", "label": "本机", "group": "默认组"},
            {"ip": "127.0.0.32", "label": "J", "group": "JG"},
        ])

    def test_broken_json_falls_back_to_line_parsing(self):
        from app.probe.router import parse_batch_text

        # 整体不是合法 JSON（混合多行），逐行也不该把坏行当合法地址吞掉
        items = parse_batch_text('{"ip":"1.1.1.1"\n2.2.2.2')
        self.assertEqual(len(items), 2)  # 非法行按普通行保留，交给地址校验报错


class RunnerParallelTests(unittest.TestCase):
    """runner 并行模型：端口槽分配、并发提速、跳过/停止语义。"""

    def setUp(self):
        import tempfile as _tf
        from app.probe.runner import ProbeRunner
        from app.probe.store import ProbeStore

        self.store = ProbeStore(Path(_tf.mkdtemp(prefix="frpc-runner-")) / "probe.db")
        self.runner = ProbeRunner(lambda: self.store)

    @staticmethod
    def _fake_probe(store_results):
        """构造假探测函数：记录 (ip, options.local_base_port)，短暂睡眠后返回连通性通过。"""
        def probe(ip, options, on_step=None, on_progress=None, cancel=None):
            store_results.append((ip, options.local_base_port))
            on_step and on_step(f"测试 {ip}")
            deadline = time.monotonic() + 0.4
            while time.monotonic() < deadline:
                if cancel and cancel():
                    return {"server_ip": ip, "frps_reachable": True, "tunnel_established": True,
                            "firewall_open": True, "detail": "", "skipped": True}
                time.sleep(0.02)
            return {"server_ip": ip, "frps_reachable": True, "tunnel_established": True,
                    "firewall_open": True, "detail": ""}
        return probe

    def test_parallel_slots_and_speedup(self):
        from app.probe.engine import ProbeOptions

        seen_ports: list[tuple[str, int]] = []
        options = ProbeOptions(local_base_port=20000, conn_concurrency=4, speed_concurrency=2)
        started = time.monotonic()
        passed = self.runner._run_batch(
            self.store, [f"10.1.0.{i}" for i in range(1, 9)], options,
            phase="connectivity", runner=self._fake_probe(seen_ports),
        )
        elapsed = time.monotonic() - started
        # 8 台 × 0.4s，4 并发 → 应明显快于串行的 3.2s
        self.assertLess(elapsed, 2.0)
        self.assertEqual(len(passed), 8)
        # 端口只应出现 4 个槽位：base + slot*3（20000/20003/20006/20009）
        ports = {port for _ip, port in seen_ports}
        self.assertEqual(ports, {20000, 20003, 20006, 20009})
        # 全部结果入库 + recent
        self.assertEqual(len(self.store.list_connectivity_history()), 8)
        self.assertEqual(self.runner.status()["done"], 8)

    def test_skip_drops_inflight_only(self):
        from app.probe.engine import ProbeOptions

        seen_ports: list[tuple[str, int]] = []
        options = ProbeOptions(local_base_port=20000, conn_concurrency=1, speed_concurrency=1)
        probe = self._fake_probe(seen_ports)

        original_probe = probe

        def slow_first_then_fast(ip, opts, on_step=None, on_progress=None, cancel=None):
            if ip == "10.2.0.1":
                deadline = time.monotonic() + 3.0
                while time.monotonic() < deadline:
                    if cancel and cancel():
                        return {"server_ip": ip, "frps_reachable": False, "tunnel_established": False,
                                "firewall_open": False, "detail": "被跳过"}
                    time.sleep(0.02)
                raise AssertionError("应当被 skip 取消")
            return original_probe(ip, opts, on_step, on_progress, cancel)

        import threading

        def do_skip():
            # 单测直接调 _run_batch（未走 start），绕过 running 守卫直接改内部状态
            with self.runner._lock:
                self.runner._skip_generation += 1

        skip_timer = threading.Timer(0.5, do_skip)
        skip_timer.start()
        passed = self.runner._run_batch(
            self.store, ["10.2.0.1", "10.2.0.2"], options,
            phase="connectivity", runner=slow_first_then_fast,
        )
        skip_timer.cancel()
        # 第一台被跳过丢弃，第二台正常完成
        self.assertEqual(passed, ["10.2.0.2"])
        recent = self.runner.status()["recent"]
        by_ip = {entry["ip"]: entry for entry in recent}
        self.assertTrue(by_ip["10.2.0.1"]["skipped"])
        self.assertFalse(by_ip["10.2.0.2"]["skipped"])

    def test_stop_aborts_batch(self):
        from app.probe.engine import ProbeOptions

        def never_finish(ip, opts, on_step=None, on_progress=None, cancel=None):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if cancel and cancel():
                    return {"server_ip": ip, "frps_reachable": False, "tunnel_established": False,
                            "firewall_open": False, "detail": "stopped"}
                time.sleep(0.02)
            raise AssertionError("应当被 stop 取消")

        import threading
        options = ProbeOptions(conn_concurrency=2, speed_concurrency=1)
        stop_timer = threading.Timer(0.3, self.runner._stop.set)
        stop_timer.start()
        started = time.monotonic()
        self.runner._run_batch(
            self.store, [f"10.3.0.{i}" for i in range(1, 21)], options,
            phase="connectivity", runner=never_finish,
        )
        stop_timer.cancel()
        self.assertLess(time.monotonic() - started, 3.0)
        # 停止后不产生任何入库结果
        self.assertEqual(self.store.list_connectivity_history(), [])


class DiscoverApiTests(unittest.TestCase):
    """网段发现 API：start → status → import 生命周期 + 校验/审计。"""

    def make_client(self):
        import sys

        from fastapi.testclient import TestClient

        previous = {
            key: os.environ.get(key)
            for key in ("WEBUI_USERNAME", "WEBUI_PASSWORD", "DATABASE_PATH")
        }
        self.db_path = Path(tempfile.mkdtemp(prefix="frpc-discover-api-")) / "console.db"
        os.environ.update(
            WEBUI_USERNAME="admin", WEBUI_PASSWORD="password", DATABASE_PATH=str(self.db_path),
        )
        for module_name in [
            "app.main", "app.probe.router", "app.probe.runner", "app.probe.discover",
            "app.control.router", "app.control.hub", "app.settings", "app.auth",
        ]:
            sys.modules.pop(module_name, None)
        try:
            app = importlib.import_module("app.main").app
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        client = TestClient(app)
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        token = client.post("/api/auth/login", json={"username": "admin", "password": "password"}).json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        primary = client.post("/api/probe/nodes", json={"name": "primary-discover"}, headers=headers).json()
        self.primary = primary
        configured = client.put("/api/probe/nodes/execution-policy", json={
            "primaryNodeId": primary["id"], "backupNodeIds": [],
        }, headers=headers)
        self.assertEqual(configured.status_code, 200)
        return client, headers

    def wait_discover_terminal(self, client, headers, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = client.get("/api/probe/discover/status", headers=headers).json()
            if not status["running"]:
                return status
            time.sleep(0.01)
        self.fail("discovery scan did not reach terminal status")

    def test_discover_import_uses_atomic_store_result_without_preflight(self):
        from app.probe.store import DiscoverImportResult

        client, headers = self.make_client()
        import sys
        probe_router = sys.modules["app.probe.router"]
        store = mock.Mock()
        store.get_discover_results_by_ids.side_effect = AssertionError("preflight must not run")
        store.import_discover_results.return_value = DiscoverImportResult(2, 1, 1)

        with mock.patch.object(probe_router, "probe_store", return_value=store):
            response = client.post(
                "/api/probe/discover/import",
                json={"ids": [7, 8], "group": "atomic"}, headers=headers,
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"inserted": 1, "skipped": 1})
        store.import_discover_results.assert_called_once_with([7, 8], group="atomic")
        store.get_discover_results_by_ids.assert_not_called()

    def test_discover_import_empty_ids_preserves_validation_without_store_call(self):
        client, headers = self.make_client()
        import app.probe.router as probe_router
        store = mock.Mock()

        with mock.patch.object(probe_router, "probe_store", return_value=store):
            response = client.post(
                "/api/probe/discover/import", json={"ids": []}, headers=headers,
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "请勾选要导入的记录")
        store.import_discover_results.assert_not_called()

    def test_discover_import_atomic_zero_selected_maps_to_400(self):
        from app.probe.store import DiscoverImportResult

        client, headers = self.make_client()
        import sys
        probe_router = sys.modules["app.probe.router"]
        store = mock.Mock()
        store.get_discover_results_by_ids.side_effect = AssertionError("preflight must not run")
        store.import_discover_results.return_value = DiscoverImportResult(0, 0, 0)

        with mock.patch.object(probe_router, "probe_store", return_value=store):
            response = client.post(
                "/api/probe/discover/import",
                json={"ids": [999999]}, headers=headers,
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "所选记录不存在")
        store.import_discover_results.assert_called_once_with([999999], group="")
        store.get_discover_results_by_ids.assert_not_called()

    def test_discover_lifecycle_and_import(self):
        client, headers = self.make_client()
        # 空目标 / 非法端口拒绝
        self.assertEqual(client.post("/api/probe/discover/start",
                                     json={"targets": "  "}, headers=headers).status_code, 400)
        self.assertEqual(client.post("/api/probe/discover/start",
                                     json={"targets": "10.0.0.0/8"}, headers=headers).status_code, 400)
        self.assertEqual(client.post("/api/probe/discover/start",
                                     json={"targets": "127.0.0.1", "port": 7001}, headers=headers).status_code, 400)

        started = client.post("/api/probe/discover/start", json={
            "targets": "127.0.0.1", "concurrency": 4, "timeout": 1.0,
        }, headers=headers)
        self.assertEqual(started.status_code, 200)
        status = started.json()
        self.assertTrue(status["running"])
        self.assertEqual(status["total"], 1)
        self.assertEqual(status["jobId"], client.get("/api/probe/discover/status", headers=headers).json()["jobId"])
        from app.probe.jobs import ProbeJobStore
        job = ProbeJobStore(self.db_path).get_job(status["jobId"])
        self.assertEqual({task["nodeId"] for task in job["tasks"]}, {self.primary["id"]})
        self.assertEqual(job["tasks"][0]["stage"], "discover")

        # 导入：按结果行 id；重复导入去重
        from app.probe.store import ProbeStore
        ProbeStore(self.db_path).upsert_discover_results_batch([("127.0.0.1", 7000, 1.0)])
        results = client.get("/api/probe/discover/results", headers=headers).json()
        self.assertEqual(len(results["items"]), 1)
        row = results["items"][0]
        self.assertEqual(row["ip"], "127.0.0.1")
        self.assertFalse(row["inLibrary"])

        self.assertEqual(client.post("/api/probe/discover/import",
                                     json={"ids": [99999], "group": "发现"},
                                     headers=headers).status_code, 400)
        imported = client.post("/api/probe/discover/import", json={
            "ids": [row["id"]], "group": "发现",
        }, headers=headers).json()
        self.assertEqual(imported, {"inserted": 1, "skipped": 0})

        # 再导一次：去重跳过；在库标记翻真
        again = client.post("/api/probe/discover/import", json={
            "ids": [row["id"]], "group": "发现",
        }, headers=headers).json()
        self.assertEqual(again, {"inserted": 0, "skipped": 1})
        results = client.get("/api/probe/discover/results", headers=headers).json()
        self.assertTrue(results["items"][0]["inLibrary"])

        # 批量改分组/标签 + 删除
        patched = client.patch("/api/probe/discover/results/batch", json={
            "ids": [row["id"]], "group": "发现2", "label": "低延迟",
        }, headers=headers).json()
        self.assertEqual(patched, {"updated": 1})
        deleted = client.request("DELETE", "/api/probe/discover/results",
                                 json={"ids": [row["id"]]}, headers=headers).json()
        self.assertEqual(deleted, {"deleted": 1})
        self.assertEqual(client.get("/api/probe/discover/results", headers=headers).json()["items"], [])

        # 服务器库能看到 + 审计
        servers = ProbeStore(self.db_path).list_servers()
        self.assertEqual([(s.ip, s.server_group) for s in servers], [("127.0.0.1", "发现")])
        actions = {log["action"] for log in client.get("/api/audit-logs?limit=50", headers=headers).json()}
        self.assertIn("probe_discover_start", actions)
        self.assertIn("probe_discover_import", actions)
        self.assertIn("probe_update_discover", actions)
        self.assertIn("probe_delete_discover", actions)

        # 持久发现任务尚未被 worker 领取，停止请求会结束该任务。
        stopped = client.post("/api/probe/discover/stop", headers=headers).json()
        self.assertTrue(stopped["stopped"])

    def test_discover_start_conflict_and_stop_use_persistent_worker_job(self):
        client, headers = self.make_client()
        started = client.post("/api/probe/discover/start", json={
            "targets": "10.0.0.1-10.0.0.20", "port": 7000,
        }, headers=headers)
        self.assertEqual(started.status_code, 200)
        self.assertEqual({task["nodeId"] for task in
                          __import__("app.probe.jobs", fromlist=["ProbeJobStore"]).ProbeJobStore(self.db_path).get_job(started.json()["jobId"])["tasks"]},
                         {self.primary["id"]})
        conflict = client.post("/api/probe/discover/start", json={
            "targets": "127.0.0.2", "port": 7000,
        }, headers=headers)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(client.post("/api/probe/discover/stop", headers=headers).json(),
                         {"stopped": True})

    def test_corrupt_discover_policy_maps_to_clear_http_400(self):
        client, headers = self.make_client()
        from app.probe.jobs import ProbeJobStore
        jobs = ProbeJobStore(self.db_path)
        with jobs._db() as connection:
            connection.execute("UPDATE probe_settings SET value='{' WHERE key='probe_execution_policy'")
        response = client.post("/api/probe/discover/start", json={
            "targets": "127.0.0.1", "port": 7000,
        }, headers=headers)
        self.assertEqual(response.status_code, 400)
        self.assertIn("重新配置测试节点", response.json()["detail"])

    def test_discover_results_contract_filters_facets_and_validation(self):
        from app.probe.store import ProbeStore

        client, headers = self.make_client()
        store = ProbeStore(self.db_path)
        store.upsert_discover_results_batch([
            ("10.0.0.2", 7000, 2.0),
            ("10.0.0.10", 7000, 10.0),
        ])
        rows = {row["ip"]: row for row in discover_rows(store)}
        store.update_discover_batch([rows["10.0.0.2"]["id"]], group="east", add_labels=["fast"])
        store.import_discover_results([rows["10.0.0.2"]["id"]])

        response = client.get(
            "/api/probe/discover/results?page=1&pageSize=1&group=east&label=fast"
            "&library=imported&sort=ip&order=asc",
            headers=headers,
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(set(body), {"items", "page", "pageSize", "total", "sort", "order"})
        self.assertEqual(
            {key: body[key] for key in ("page", "pageSize", "total", "sort", "order")},
            {"page": 1, "pageSize": 1, "total": 1, "sort": "ip", "order": "asc"},
        )
        self.assertEqual(
            set(body["items"][0]),
            {"id", "ip", "port", "latencyMs", "group", "labels", "inLibrary", "discoveredAt", "nodeId", "nodeName", "latestRoute"},
        )
        self.assertNotIn("labels", body)
        facets = client.get("/api/probe/discover/facets", headers=headers).json()
        self.assertEqual((facets["imported"], facets["new"]), (1, 1))
        self.assertIn({"group": "east", "count": 1}, facets["groups"])
        self.assertIn({"label": "fast", "count": 1}, facets["labels"])

        for query in ("page=0", "pageSize=0", "pageSize=201", "library=bad", "sort=time", "order=sideways"):
            with self.subTest(query=query):
                self.assertEqual(
                    client.get(f"/api/probe/discover/results?{query}", headers=headers).status_code,
                    422,
                )

    def test_discover_results_latency_sort_is_global_and_preserves_public_metadata(self):
        from app.probe.store import ProbeStore

        client, headers = self.make_client()
        ProbeStore(self.db_path).upsert_discover_results_batch([
            ("10.0.0.1", 7000, 30.0),
            ("10.0.0.2", 7000, 10.0),
            ("10.0.0.3", 7000, 20.0),
        ])

        for order, expected in (
            ("asc", [10.0, 20.0, 30.0]),
            ("desc", [30.0, 20.0, 10.0]),
        ):
            with self.subTest(order=order):
                pages = [
                    client.get(
                        f"/api/probe/discover/results?page={page}&pageSize=2&sort=latency&order={order}",
                        headers=headers,
                    ).json()
                    for page in (1, 2)
                ]
                self.assertEqual(
                    [{key: page[key] for key in ("page", "pageSize", "total", "sort", "order")}
                     for page in pages],
                    [
                        {"page": 1, "pageSize": 2, "total": 3, "sort": "latency", "order": order},
                        {"page": 2, "pageSize": 2, "total": 3, "sort": "latency", "order": order},
                    ],
                )
                self.assertEqual(
                    [item["latencyMs"] for page in pages for item in page["items"]],
                    expected,
                )

    def test_rename_group_endpoint_cascades(self):
        from app.lb.store import LbStore
        from app.probe.store import ProbeStore

        client, headers = self.make_client()
        client.post("/api/probe/servers/groups", json={"name": "旧组"}, headers=headers)
        client.post("/api/probe/servers/groups", json={"name": "占位组"}, headers=headers)
        client.post("/api/probe/servers/batch", json={
            "text": "10.0.0.1 旧组", "group": "旧组",
        }, headers=headers)
        LbStore(self.db_path).create_domain(
            name="frps.example.com", zone_id="z", zone_name="example.com", group_name="旧组")

        ok = client.patch("/api/probe/servers/groups/rename", json={
            "old": "旧组", "new": "新组",
        }, headers=headers)
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json(), {"renamed": "新组"})
        store = ProbeStore(self.db_path)
        self.assertIn("新组", store.list_groups())
        self.assertEqual(store.list_servers()[0].server_group, "新组")
        self.assertEqual(LbStore(self.db_path).list_domains()[0].group_name, "新组")

        conflict = client.patch("/api/probe/servers/groups/rename", json={
            "old": "新组", "new": "占位组",
        }, headers=headers)
        self.assertEqual(conflict.status_code, 400)

    def test_delete_referenced_group_returns_conflict_and_preserves_name_path(self):
        client, headers = self.make_client()
        created = client.post("/api/probe/servers/groups", json={"name": "绑定组"}, headers=headers)
        self.assertEqual(created.status_code, 200)
        self.assertTrue(created.json()["id"])
        client.post("/api/probe/servers/batch", json={
            "text": "10.0.0.8", "group": "绑定组",
        }, headers=headers)
        response = client.delete("/api/probe/servers/groups/绑定组", headers=headers)
        self.assertEqual(response.status_code, 409)


if __name__ == "__main__":
    unittest.main()


class RouteHubTests(unittest.TestCase):
    """CN2 路由队列状态机：入队去重 / 原子领取 / 超时重派 / 幂等回报。"""

    def setUp(self):
        from app.probe.route import RouteHub
        self.hub = RouteHub()

    def test_enqueue_dedup_and_claim_order(self):
        self.assertTrue(self.hub.enqueue("1.1.1.1"))
        self.assertFalse(self.hub.enqueue("1.1.1.1"))  # 待处理中不重复入队
        self.assertTrue(self.hub.enqueue("2.2.2.2"))
        first = self.hub.claim("节点A")
        self.assertEqual(first, {"taskId": 1, "ip": "1.1.1.1"})
        second = self.hub.claim("节点B")
        self.assertEqual(second, {"taskId": 2, "ip": "2.2.2.2"})
        self.assertIsNone(self.hub.claim("节点A"))  # 队列空

    def test_claim_timeout_requeues(self):
        self.hub.enqueue("3.3.3.3")
        task = self.hub.claim("节点A")
        # 模拟领取超时
        with self.hub._lock:
            for item in self.hub._tasks:
                if item.id == task["taskId"]:
                    item.claimed_at -= 999
        again = self.hub.claim("节点B")  # 掉线切换：节点B 接手
        self.assertEqual(again["taskId"], task["taskId"])

    def test_report_idempotent_and_states(self):
        self.hub.enqueue("4.4.4.4")
        task = self.hub.claim("节点A")
        found = self.hub.report(task["taskId"], ok=True, is_cn2=True)
        self.assertEqual((found.ip, found.state), ("4.4.4.4", "done"))
        self.assertIsNone(self.hub.report(task["taskId"], ok=True, is_cn2=True))  # 幂等
        # 失败回报
        self.hub.enqueue("5.5.5.5")
        task2 = self.hub.claim("节点A")
        failed = self.hub.report(task2["taskId"], ok=False, is_cn2=False)
        self.assertEqual(failed.state, "failed")

    def test_stop_clears_pending_only(self):
        self.hub.enqueue("6.6.6.6")
        self.hub.enqueue("7.7.7.7")
        self.hub.claim("节点A")  # 6.6.6.6 变 running
        cleared = self.hub.stop()
        self.assertEqual(cleared, 1)  # 只清 pending（7.7.7.7）
        status = self.hub.status()
        self.assertEqual(status["running"], 1)
        self.assertEqual(status["pending"], 0)


class RouteApiTests(unittest.TestCase):
    """CN2 路由 API：节点 Token 鉴权 / claim+report 回写标签 / 联动入队。"""

    def make_client(self):
        import sys

        from fastapi.testclient import TestClient

        previous = {
            key: os.environ.get(key)
            for key in ("WEBUI_USERNAME", "WEBUI_PASSWORD", "DATABASE_PATH")
        }
        self.db_path = Path(tempfile.mkdtemp(prefix="frpc-route-api-")) / "console.db"
        os.environ.update(
            WEBUI_USERNAME="admin", WEBUI_PASSWORD="password", DATABASE_PATH=str(self.db_path),
        )
        for module_name in [
            "app.main", "app.probe.router", "app.probe.route", "app.probe.runner",
            "app.probe.discover", "app.control.router", "app.control.hub",
            "app.settings", "app.auth",
        ]:
            sys.modules.pop(module_name, None)
        try:
            app = importlib.import_module("app.main").app
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        client = TestClient(app)
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        token = client.post("/api/auth/login", json={"username": "admin", "password": "password"}).json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        self.primary = client.post("/api/probe/nodes", json={"name": "primary-route"}, headers=headers).json()
        configured = client.put("/api/probe/nodes/execution-policy", json={
            "primaryNodeId": self.primary["id"], "backupNodeIds": [],
        }, headers=headers)
        self.assertEqual(configured.status_code, 200)
        return client, headers

    def test_route_full_flow(self):
        from app.probe.route import route_hub
        from app.probe.store import ProbeStore

        client, headers = self.make_client()
        store = ProbeStore(self.db_path)
        store.upsert_discover_results_batch([("10.0.0.1", 7000, 5.0)])
        row_id = discover_rows(store)[0]["id"]

        # 新发现行默认「未路由测试」（多标签哨兵格式）
        self.assertEqual(discover_rows(store)[0]["label"], ",未路由测试,")

        # 节点管理：创建（Token 只回一次）→ 列表（掩码、离线）
        created = client.post("/api/probe/route/nodes", json={"name": "杭州节点"}, headers=headers).json()
        self.assertEqual(created["name"], "杭州节点")
        self.assertEqual(len(created["token"]), 32)
        node_headers = {"X-Route-Token": self.primary["token"]}
        listed = client.get("/api/probe/route/nodes", headers=headers).json()
        legacy_listed = next(node for node in listed if node["name"] == "杭州节点")
        self.assertIn("…", legacy_listed["tokenMasked"])
        self.assertFalse(legacy_listed["online"])
        self.assertEqual(client.post("/api/probe/route/nodes",
                                     json={"name": "杭州节点"}, headers=headers).status_code, 400)

        # 鉴权：坏 Token 拒绝
        self.assertEqual(client.post("/api/probe/route/claim",
                                     headers={"X-Route-Token": "bad"}).status_code, 401)

        # Worker claim → task None（同时刷新心跳 → 在线）
        worker_headers = {"X-Probe-Token": self.primary["token"]}
        client.post("/api/probe/worker/heartbeat", json={
            "version": "test", "capabilities": ["discover", "route", "connectivity", "speed"],
            "protocolFeatures": ["task-generation-v1"], "attempts": [],
        }, headers=worker_headers)
        self.assertEqual(client.post("/api/probe/worker/claim", headers=worker_headers).json(),
                         {"task": None})
        self.assertTrue(next(node for node in client.get("/api/probe/route/nodes", headers=headers).json()
                             if node["id"] == self.primary["id"])["online"])
        self.assertEqual(next(node for node in client.get("/api/probe/nodes", headers=headers).json()["items"]
                              if node["id"] == self.primary["id"])["protocolFeatures"], ["task-generation-v1"])

        # 面板启动：勾选发现行入队
        started = client.post("/api/probe/route/start", json={"ids": [row_id]}, headers=headers).json()
        self.assertEqual(started, {"enqueued": 1})

        # 节点领取 → 回报 CN2 → 标签写入
        task = client.post("/api/probe/worker/claim", headers=worker_headers).json()["task"]
        self.assertEqual(task["ip"], "10.0.0.1")
        report = client.post("/api/probe/worker/report", json={
            "taskId": task["taskId"], "attemptId": task["attemptId"],
            "result": {"ok": True, "isCn2": True},
        }, headers=worker_headers).json()
        self.assertEqual(report["applied"], True)
        self.assertEqual(discover_rows(store)[0]["label"], ",未路由测试,")
        self.assertTrue(client.get("/api/probe/results/route?nodeId="+self.primary["id"],headers=headers).json()["items"][0]["isCn2"])

        # 重复回报幂等；状态端点
        self.assertEqual(client.post("/api/probe/worker/report", json={
            "taskId": task["taskId"], "attemptId": task["attemptId"],
            "result": {"ok": True, "isCn2": False},
        }, headers=worker_headers).json()["applied"], False)
        status = client.get("/api/probe/route/status", headers=headers).json()
        self.assertEqual((status["done"], status["pending"]), (1, 0))

        # 失败回报 → 回退「未路由测试」
        client.post("/api/probe/route/start", json={"ids": [row_id]}, headers=headers)
        task2 = client.post("/api/probe/worker/claim", headers=worker_headers).json()["task"]
        client.post("/api/probe/worker/report", json={
            "taskId": task2["taskId"], "attemptId": task2["attemptId"],
            "result": {"ok": False},
        }, headers=worker_headers)
        self.assertEqual(discover_rows(store)[0]["label"], ",未路由测试,")

        # 已测 CN2 的行不再需要路由（联动入队的过滤条件）
        store.set_route_label("10.0.0.1", "CN2")
        self.assertFalse(store.discover_row_needs_route("10.0.0.1"))

        # 审计
        actions = {log["action"] for log in client.get("/api/audit-logs?limit=50", headers=headers).json()}
        self.assertIn("probe_route_node_create", actions)
        self.assertIn("probe_route_start", actions)

    def test_scan_auto_route_enqueues(self):
        client, headers = self.make_client()
        started = client.post("/api/probe/discover/start", json={
            "targets": "127.0.0.1", "port": 7000, "concurrency": 4, "timeout": 1.0,
            "autoRoute": True,
        }, headers=headers)
        self.assertEqual(started.status_code, 200)
        from app.probe.jobs import ProbeJobStore
        jobs = ProbeJobStore(self.db_path)
        jobs.heartbeat(self.primary['id'], 'test', ['discover', 'route', 'connectivity', 'speed'], [])
        task = jobs.claim(self.primary["id"])
        self.assertEqual(task["stage"], "discover")
        jobs.progress(self.primary["id"], task["taskId"], task["attemptId"], 1,
                      hits=[{"ip": "127.0.0.1", "port": 7000, "latencyMs": 1.0}],
                      progress={"scanned": 1, "foundCount": 1})
        job = jobs.get_job(task["jobId"])
        route_tasks = [item for item in job["tasks"] if item["stage"] == "route"]
        self.assertEqual(len(route_tasks), 1)
        self.assertEqual(route_tasks[0]["nodeId"], self.primary["id"])
