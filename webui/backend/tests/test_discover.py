"""网段发现（discover）测试：目标解析、扫描引擎（本地监听端口）、API 生命周期。"""

import json
import os
import socket
import tempfile
import threading
import time
import unittest

os.environ.setdefault("PROJECT_DIR", tempfile.mkdtemp(prefix="frpc-multi-discover-tests-"))

from app.probe.discover import (  # noqa: E402
    DiscoverParams, DiscoverRunner, MAX_TARGET_IPS, parse_target_item, parse_targets,
)


class FakeFrpsServer(threading.Thread):
    """按 frp 帧协议应答 LoginResp 的假 frps：8 字节大端长度 + JSON。"""

    def __init__(self, version: str = "9.9.9"):
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
            threading.Thread(target=self.serve, args=(conn,), daemon=True).start()

    def serve(self, conn: socket.socket):
        try:
            header = conn.recv(8, socket.MSG_WAITALL)
            if len(header) != 8:
                return
            size = int.from_bytes(header, "big")
            body = conn.recv(size, socket.MSG_WAITALL)
            message = json.loads(body)
            if message.get("type") != "Login":
                return
            resp = json.dumps({
                "type": "LoginResp", "version": self.version,
                "run_id": "", "error": "token in login doesn't match token from configuration",
            }).encode() + b"\n"
            conn.sendall(len(resp).to_bytes(8, "big") + resp)
        except OSError:
            pass
        finally:
            conn.close()

    def close(self):
        self.server.close()


class ParseTests(unittest.TestCase):
    def test_single_and_cidr(self):
        self.assertEqual([str(ip) for ip in parse_target_item("10.0.0.5")], ["10.0.0.5"])
        # /31 特殊小网段直接给网络地址
        self.assertEqual([str(ip) for ip in parse_target_item("10.0.0.0/31")], ["10.0.0.0"])
        # /24 去掉网络地址与广播地址
        ips = [str(ip) for ip in parse_target_item("192.168.1.0/24")]
        self.assertEqual(len(ips), 254)
        self.assertEqual(ips[0], "192.168.1.1")
        self.assertEqual(ips[-1], "192.168.1.254")

    def test_ranges(self):
        full = [str(ip) for ip in parse_target_item("10.0.0.1-10.0.0.10")]
        self.assertEqual(full, [f"10.0.0.{i}" for i in range(1, 11)])
        tail = [str(ip) for ip in parse_target_item("10.0.0.240-254")]
        self.assertEqual(len(tail), 15)
        with self.assertRaises(ValueError):
            parse_target_item("10.0.0.10-10.0.0.1")
        with self.assertRaises(ValueError):
            parse_target_item("10.0.0.1-x")

    def test_parse_targets_mixed_and_exclude(self):
        ips, total = parse_targets("10.0.0.1, 10.0.0.2\n192.168.1.0/30", "10.0.0.1")
        # /30 有 2 个可用主机地址
        self.assertEqual(ips, ["10.0.0.2", "192.168.1.1", "192.168.1.2"])
        self.assertEqual(total, 4)
        with self.assertRaises(ValueError):
            parse_targets("")
        with self.assertRaises(ValueError):
            parse_targets("10.0.0.0/8")  # 超总量上限


class EngineTests(unittest.TestCase):
    def test_scan_confirms_frps_with_version(self):
        # 真 frps 特征：回 LoginResp → 命中并带版本；on_hit 收到版本参数
        fake = FakeFrpsServer(version="0.68.1")
        fake.start()
        hits: list[tuple] = []
        try:
            runner = DiscoverRunner()
            state = runner.start(DiscoverParams(
                targets=["127.0.0.1"], exclude=[], port=fake.port,
                concurrency=4, timeout=1.0,
            ), on_hit=lambda ip, port, latency, version="": hits.append((ip, port, version)))
            for _ in range(100):
                if not state.running:
                    break
                time.sleep(0.05)
            self.assertFalse(state.running)
            self.assertEqual([(hit.ip, hit.frps_version) for hit in state.found],
                             [("127.0.0.1", "0.68.1")])
            self.assertEqual(state.others, 0)
            self.assertEqual(hits, [("127.0.0.1", fake.port, "0.68.1")])
        finally:
            fake.close()

    def test_open_but_not_frps_excluded(self):
        # 端口开放但不会说 frp 协议（如 HTTP）→ 不命中，计入 others
        plain = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        plain.bind(("127.0.0.1", 0))
        plain.listen(8)
        port = plain.getsockname()[1]
        try:
            runner = DiscoverRunner()
            state = runner.start(DiscoverParams(
                targets=["127.0.0.1"], exclude=[], port=port,
                concurrency=4, timeout=1.0,
            ))
            for _ in range(100):
                if not state.running:
                    break
                time.sleep(0.05)
            self.assertEqual(state.found, [])
            self.assertEqual(state.others, 1)
        finally:
            plain.close()

    def test_closed_port_not_found_and_stop(self):
        # 占一个端口再立刻释放，拿到「几乎必然关闭」的本地端口
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(("127.0.0.1", 0))
        closed_port = probe.getsockname()[1]
        probe.close()

        runner = DiscoverRunner()
        state = runner.start(DiscoverParams(
            targets=["127.0.0.1"], exclude=[], port=closed_port,
            concurrency=4, timeout=0.2,
        ))
        for _ in range(100):
            if not state.running:
                break
            time.sleep(0.05)
        self.assertEqual(state.found, [])

        # stop：运行中可取消（连接被拒返回极快时可能先扫完，两种结果都接受）
        runner2 = DiscoverRunner()
        state2 = runner2.start(DiscoverParams(
            targets=["10.255.255.0/24"], exclude=[], port=closed_port,
            concurrency=8, timeout=0.5,
        ))
        time.sleep(0.2)
        runner2.stop()
        for _ in range(200):
            if not state2.running:
                break
            time.sleep(0.05)
        self.assertFalse(state2.running)
        self.assertLessEqual(state2.scanned, state2.total)


class RunnerGuardTests(unittest.TestCase):
    def test_duplicate_start_rejected(self):
        runner = DiscoverRunner()

        def hold():
            state = runner.start(DiscoverParams(
                targets=["10.255.254.0/24"], exclude=[], port=65001,
                concurrency=2, timeout=2.0,
            ))
            for _ in range(400):
                if not state.running:
                    break
                time.sleep(0.05)

        thread = threading.Thread(target=hold)
        thread.start()
        time.sleep(0.3)
        try:
            with self.assertRaises(RuntimeError):
                runner.start(DiscoverParams(targets=["10.0.0.1"], exclude=[], port=7000))
        finally:
            runner.stop()
            thread.join(timeout=10)


if __name__ == "__main__":
    unittest.main()
