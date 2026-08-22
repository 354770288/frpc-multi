"""probe 模块测试：引擎回环、配置生成、frpc 日志判定、存储与 API。"""

import importlib
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

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
        server = self.store.create_server(ip="10.0.0.1", label="节点A", server_group="国内")
        self.assertEqual(server.ip, "10.0.0.1")
        with self.assertRaises(ValueError):
            self.store.create_server(ip="10.0.0.1")
        updated = self.store.update_server(server.id, label="节点B", server_group="海外")
        self.assertEqual(updated.label, "节点B")
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

    def test_rename_group_cascades_all_tables(self):
        from app.lb.store import LbStore

        lb = LbStore(Path(self.tmpdir) / "probe.db")
        self.store.create_group("旧组")
        self.store.create_group("别的组")
        self.store.import_servers([{"ip": "10.0.0.1", "group": "旧组"}])
        self.store.upsert_discover_result("10.0.0.2", 7000, 3.2)
        self.store.update_discover_batch(
            [row["id"] for row in self.store.list_discover_results()], group="旧组", label=None)
        lb.create_domain(name="frps.example.com", zone_id="z", zone_name="example.com",
                         group_name="旧组")

        self.store.rename_group("旧组", "新组")
        self.assertIn("新组", self.store.list_groups())
        self.assertNotIn("旧组", self.store.list_groups())
        self.assertEqual(self.store.list_servers()[0].server_group, "新组")
        self.assertEqual(self.store.list_discover_results()[0]["server_group"], "新组")
        self.assertEqual(lb.list_domains()[0].group_name, "新组")

        with self.assertRaises(ValueError):
            self.store.rename_group("新组", "别的组")  # 重名拒绝
        with self.assertRaises(ValueError):
            self.store.rename_group("新组", "  ")  # 空名拒绝

    def test_discover_results_upsert_and_library_flag(self):
        self.store.upsert_discover_result("10.0.0.9", 7000, 8.0)
        self.store.update_discover_batch(
            [row["id"] for row in self.store.list_discover_results()],
            group="池A", label="快",
        )
        # 重复命中：更新延迟与时间，保留分组/标签
        self.store.upsert_discover_result("10.0.0.9", 7000, 1.5)
        rows = self.store.list_discover_results()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["server_group"], "池A")
        self.assertEqual(rows[0]["label"], "快")
        self.assertEqual(rows[0]["latency_ms"], 1.5)
        self.assertFalse(rows[0]["in_library"])

        # 同 IP 导入服务器库后在库标记翻真
        self.store.import_servers([{"ip": "10.0.0.9", "group": "池A"}])
        self.assertTrue(self.store.list_discover_results()[0]["in_library"])

    def test_discover_batch_label_semantics(self):
        self.store.upsert_discover_result("10.0.0.1", 7000, 1.0)
        self.store.upsert_discover_result("10.0.0.2", 7000, 2.0)
        ids = [row["id"] for row in self.store.list_discover_results()]
        self.store.update_discover_batch(ids, group="G", label="L1")
        # 只改分组（label=None 保留）
        self.store.update_discover_batch(ids[:1], group="G2", label=None)
        rows = {row["ip"]: row for row in self.store.list_discover_results()}
        self.assertEqual((rows["10.0.0.1"]["server_group"], rows["10.0.0.1"]["label"]), ("G2", "L1"))
        # 空串清除标签
        self.store.update_discover_batch(ids[1:], group=None, label="")
        rows = {row["ip"]: row for row in self.store.list_discover_results()}
        self.assertEqual(rows["10.0.0.2"]["label"], "")

    def test_discover_delete_and_labels(self):
        self.store.upsert_discover_result("10.0.0.1", 7000, 1.0)
        self.store.upsert_discover_result("10.0.0.2", 7000, 2.0)
        self.store.import_servers([{"ip": "10.0.0.3", "label": "共用"}])
        self.store.update_discover_batch(
            [row["id"] for row in self.store.list_discover_results() if row["ip"] == "10.0.0.1"],
            group=None, label="共用")
        labels = {item["label"]: item["count"] for item in self.store.list_labels()}
        self.assertEqual(labels, {"共用": 2})  # 服务器 + 发现结果合并计数

        rows = self.store.list_discover_results()
        self.assertEqual(self.store.delete_discover_results([rows[0]["id"]]), 1)
        self.assertEqual(len(self.store.list_discover_results()), 1)
        self.assertEqual(self.store.delete_discover_results(), 1)  # 清空
        self.assertEqual(self.store.list_discover_results(), [])

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
        # 最新一条连通性记录（firewall_open=False 那条）应胜出
        self.assertEqual(by_ip["10.0.0.1"]["c_firewall_open"], 0)
        self.assertEqual(by_ip["10.0.0.1"]["s_dl_speed_mbps"], 8.0)
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
        self.assertEqual(stats["connectivity"]["reachable"], 2)
        self.assertEqual(stats["speed"]["avgDownloadMbps"], 16.0)
        self.assertEqual(stats["speed"]["avgUploadMbps"], 8.0)

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
        updated = self.store.update_servers_batch(ids, group="b", label=None)
        self.assertEqual(updated, 2)
        rows = {s.ip: s for s in self.store.list_servers()}
        self.assertEqual(rows["10.1.1.1"].server_group, "b")
        self.assertEqual(rows["10.1.1.2"].server_group, "b")
        self.assertEqual(rows["10.1.1.3"].server_group, "")
        # 批量改标签（含清除）
        self.store.update_servers_batch(ids, group=None, label="重点")
        rows = {s.ip: s for s in self.store.list_servers()}
        self.assertEqual(rows["10.1.1.1"].label, "重点")
        self.store.update_servers_batch(ids, group=None, label="")
        rows = {s.ip: s for s in self.store.list_servers()}
        self.assertEqual(rows["10.1.1.1"].label, "")
        # 空分组拒绝
        with self.assertRaises(ValueError):
            self.store.update_servers_batch(ids, group="  ", label=None)
        with self.assertRaises(ValueError):
            self.store.update_servers_batch(ids, group=None, label=None)


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
        response = client.post("/api/auth/login", json={"username": "admin", "password": "password"})
        token = response.json()["token"]
        return client, {"Authorization": f"Bearer {token}"}

    def test_missing_frpc_bin_rejected(self):
        client, headers = self.make_client(PROBE_FRPC_BIN="/nonexistent/frpc")
        response = client.post("/api/probe/servers/batch", json={"text": "127.0.0.1"}, headers=headers)
        self.assertEqual(response.status_code, 200)
        response = client.post("/api/probe/test", json={"mode": "connectivity"}, headers=headers)
        self.assertEqual(response.status_code, 400)
        self.assertIn("PROBE_FRPC_BIN", response.json()["detail"])

    def test_connectivity_flow_and_audit(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        dead_port = server.getsockname()[1]
        server.close()
        client, headers = self.make_client(
            PROBE_FRPC_BIN="/bin/echo",
            PROBE_FRPS_PORT=str(dead_port),
            PROBE_TCPING_TIMEOUT="1",
            PROBE_TCPING_RETRIES="1",
        )
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
        self.assertEqual(len(servers), 3)
        groups = client.get("/api/probe/servers/groups", headers=headers).json()
        self.assertEqual(groups, ["g"])
        # 启动测试（frps 不可达 → 每个 IP 快速失败）
        response = client.post(
            "/api/probe/test", json={"mode": "connectivity", "ips": ["127.0.0.1"]}, headers=headers,
        )
        self.assertEqual(response.status_code, 200)
        status = {}
        for _ in range(100):
            status = client.get("/api/probe/test/status", headers=headers).json()
            if not status["running"]:
                break
            time.sleep(0.2)
        self.assertFalse(status["running"])
        self.assertEqual(status["done"], 1)
        self.assertEqual(len(status["recent"]), 1)
        self.assertFalse(status["recent"][0]["ok"])
        # 结果落历史
        history = client.get("/api/probe/history/connectivity", headers=headers).json()
        self.assertEqual(len(history), 1)
        self.assertFalse(history[0]["frpsReachable"])
        # 统计
        stats = client.get("/api/probe/dashboard", headers=headers).json()
        self.assertEqual(stats["servers"], 3)
        self.assertEqual(stats["connectivity"]["tested"], 1)
        # with-status 列表带最新结果
        servers = client.get("/api/probe/servers", headers=headers).json()
        by_ip = {row["ip"]: row for row in servers}
        self.assertIsNotNone(by_ip["127.0.0.1"]["latestConnectivity"])
        self.assertIsNone(by_ip["127.0.0.1"]["latestSpeed"])
        # 审计
        logs = client.get("/api/audit-logs?limit=50", headers=headers).json()
        actions = {log["action"] for log in logs}
        self.assertIn("probe_create_server", actions)
        self.assertIn("probe_import_servers", actions)
        self.assertIn("probe_start_test", actions)
        # 清空历史
        response = client.delete("/api/probe/history/connectivity", headers=headers)
        self.assertEqual(response.json()["deleted"], 1)
        self.assertEqual(client.get("/api/probe/history/connectivity", headers=headers).json(), [])

    def test_server_update_delete_and_not_found(self):
        client, headers = self.make_client()
        created = client.post("/api/probe/servers", json={"ip": "10.2.2.2"}, headers=headers).json()
        response = client.patch(f"/api/probe/servers/{created['id']}", json={"label": "改名"}, headers=headers)
        self.assertEqual(response.json()["label"], "改名")
        response = client.delete(f"/api/probe/servers/{created['id']}", headers=headers)
        self.assertTrue(response.json()["ok"])
        response = client.patch("/api/probe/servers/99999", json={"label": "x"}, headers=headers)
        self.assertEqual(response.status_code, 404)

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

        def fake_start(mode, ips, options):
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


class FakeFrpsListener(threading.Thread):
    """按 frp 帧协议应答 LoginResp 的假 frps（8 字节大端长度 + JSON），供发现链路测试。"""

    def __init__(self, version: str = "0.68.1"):
        super().__init__(daemon=True)
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(16)
        self.port = self.server.getsockname()[1]
        self.version = version

    def run(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn: socket.socket):
        try:
            header = conn.recv(8, socket.MSG_WAITALL)
            if len(header) != 8:
                return
            body = conn.recv(int.from_bytes(header, "big"), socket.MSG_WAITALL)
            if json.loads(body).get("type") != "Login":
                return
            resp = json.dumps({"type": "LoginResp", "version": self.version, "run_id": "",
                               "error": "token mismatch"}).encode() + b"\n"
            conn.sendall(len(resp).to_bytes(8, "big") + resp)
        except OSError:
            pass
        finally:
            conn.close()

    def close(self):
        self.server.close()


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
        token = client.post("/api/auth/login", json={"username": "admin", "password": "password"}).json()["token"]
        return client, {"Authorization": f"Bearer {token}"}

    def test_discover_lifecycle_and_import(self):
        client, headers = self.make_client()

        server = FakeFrpsListener(version="0.68.1")
        server.start()
        port = server.port
        try:
            # 空目标 / 非法端口拒绝
            self.assertEqual(client.post("/api/probe/discover/start",
                                         json={"targets": "  "}, headers=headers).status_code, 400)
            self.assertEqual(client.post("/api/probe/discover/start",
                                         json={"targets": "10.0.0.0/8"}, headers=headers).status_code, 400)

            started = client.post("/api/probe/discover/start", json={
                "targets": "127.0.0.1", "port": port, "concurrency": 4, "timeout": 1.0,
            }, headers=headers)
            self.assertEqual(started.status_code, 200)
            body = started.json()
            self.assertEqual(body["total"], 1)

            # 单 IP 扫描可能瞬间完成（响应返回前），轮询到终态再校验
            for _ in range(100):
                status = client.get("/api/probe/discover/status", headers=headers).json()
                if not status["running"]:
                    break
                time.sleep(0.05)
            self.assertFalse(status["running"])
            self.assertEqual(status["total"], 1)
            self.assertEqual(status["scanned"], 1)
            self.assertEqual(status["others"], 0)
            self.assertEqual([(hit["ip"], hit["frpsVersion"]) for hit in status["found"]],
                             [("127.0.0.1", "0.68.1")])

            # 导入：按结果行 id；重复导入去重
            results = client.get("/api/probe/discover/results", headers=headers).json()
            self.assertEqual(len(results["items"]), 1)
            row = results["items"][0]
            self.assertEqual(row["ip"], "127.0.0.1")
            self.assertEqual(row["frpsVersion"], "0.68.1")
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
            from app.probe.store import ProbeStore
            servers = ProbeStore(self.db_path).list_servers()
            self.assertEqual([(s.ip, s.server_group) for s in servers], [("127.0.0.1", "发现")])
            actions = {log["action"] for log in client.get("/api/audit-logs?limit=50", headers=headers).json()}
            self.assertIn("probe_discover_start", actions)
            self.assertIn("probe_discover_import", actions)
            self.assertIn("probe_update_discover", actions)
            self.assertIn("probe_delete_discover", actions)
        finally:
            server.close()

        # 停止端点：无运行任务时返回 False
        stopped = client.post("/api/probe/discover/stop", headers=headers).json()
        self.assertFalse(stopped["stopped"])

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


if __name__ == "__main__":
    unittest.main()
