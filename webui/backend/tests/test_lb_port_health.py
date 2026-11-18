from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

os.environ.setdefault("WEBUI_JWT_SECRET", "test-secret-lb-port-health")
os.environ.setdefault("PROJECT_DIR", tempfile.gettempdir())

from fastapi.testclient import TestClient

from app.auth import create_token
from app.config_validator import validate_config_text
from app.control.node_store import NodeStore
from app.lb.cloudflare import DnsRecord
from app.lb.health import PoolHealthMonitor
from app.lb.port_health import DomainPortHealthChecker
from app.lb.scheduler import run_due_syncs
from app.lb.store import LbStore, managed_comment
from app.main import app
from app.probe.ephemeral_tcping import EphemeralTcpingBroker
from app.probe.jobs import ProbeJobStore
from app.probe.store import ProbeStore
from app.settings import settings


class FakeCf:
    def __init__(self, initial_ips: list[str] | None = None):
        self.records: list[DnsRecord] = [
            DnsRecord(
                id=f"rec-{idx}",
                name="us1.example.com",
                content=ip,
                ttl=60,
                managed=True,
            )
            for idx, ip in enumerate(initial_ips or [], 1)
        ]
        self._seq = len(self.records)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def list_a_records(self, zone_id: str, fqdn: str) -> list[DnsRecord]:
        return list(self.records)

    def create_a_record(self, zone_id: str, fqdn: str, ip: str, ttl: int = 60) -> DnsRecord:
        self._seq += 1
        rec = DnsRecord(
            id=f"rec-{self._seq}",
            name=fqdn,
            content=ip,
            ttl=ttl,
            managed=True,
        )
        self.records.append(rec)
        return rec

    def delete_a_record(self, zone_id: str, record_id: str) -> None:
        self.records = [r for r in self.records if r.id != record_id]


class LbPortHealthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "console.db"
        self.prev_db = settings.database_path
        settings.database_path = self.db_path
        self.lb_store = LbStore(self.db_path)
        self.probe_store = ProbeStore(self.db_path)
        self.job_store = ProbeJobStore(self.db_path)
        self.deploy_node = NodeStore(self.db_path).create_node(name="hk-edge-node")

        # 注册国内主节点与海外外部备用节点并保持心跳在线
        self.primary = self.job_store.create_node("深圳电信主节点")
        self.backup = self.job_store.create_node("洛杉矶备用节点")
        self.job_store.heartbeat(
            self.primary["id"], "v1", ["discover", "route", "connectivity", "speed"], [], ["task-generation-v1"]
        )
        self.job_store.heartbeat(
            self.backup["id"], "v1", ["discover", "route", "connectivity", "speed"], [], ["task-generation-v1"]
        )
        self.job_store.set_execution_policy(self.primary["id"], [self.backup["id"]])

        # 创建两台候选服务器并加入优选域名 us1.example.com
        s1 = self.probe_store.create_server(ip="198.51.100.10")
        s2 = self.probe_store.create_server(ip="198.51.100.20")
        self.s1_id = s1.id
        self.s2_id = s2.id
        self.lb_store.set_cloudflare_token("cf-test-token-123456")
        self.domain = self.lb_store.create_domain(
            name="us1.example.com",
            zone_id="zone-1",
            zone_name="example.com",
            server_ids=[self.s1_id, self.s2_id],
            preferred_server_id=self.s1_id,
            sync_mode="scheduled",
            enabled=True,
        )
        self.lb_store.mark_sync_result(
            self.domain.id,
            ok=True,
            message="initial",
            added=["198.51.100.10"],
            removed=[],
            kept=1,
            current_ip="198.51.100.10",
            preferred_server_id=self.s1_id,
        )

    def tearDown(self) -> None:
        settings.database_path = self.prev_db
        self.tmp.cleanup()

    def _bind_ports(self, ports_tcp: list[int], *, running: bool = True, enabled: bool = True) -> None:
        self.lb_store.replace_node_instance_ports(
            self.deploy_node.id,
            self.deploy_node.name,
            [
                {
                    "name": "biz-proxy",
                    "displayName": "核心业务转发",
                    "enabled": enabled,
                    "runtime": {"state": "running" if running else "exited"},
                    "summary": {
                        "serverAddr": "US1.EXAMPLE.COM.",
                        "serverPort": 7000,
                        "remotePorts": [*ports_tcp, 53000],
                        "tcpRemotePorts": ports_tcp,
                    },
                }
            ],
        )

    def test_config_validator_extracts_tcp_remote_ports_only(self) -> None:
        toml_text = """
serverAddr = "us1.example.com"
serverPort = 7000

[[proxies]]
name = "ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 22022

[[proxies]]
name = "default-tcp"
localIP = "127.0.0.1"
localPort = 80
remotePort = 18080

[[proxies]]
name = "dns-udp"
type = "udp"
localIP = "127.0.0.1"
localPort = 53
remotePort = 53053
"""
        res = validate_config_text(toml_text)
        self.assertTrue(res.valid)
        self.assertEqual(res.summary["remotePorts"], [22022, 18080, 53053])
        self.assertEqual(res.summary["tcpRemotePorts"], [22022, 18080])

    def test_sequential_check_gfw_blocked_switches_ip_and_prevents_flap(self) -> None:
        # 乱序传入业务端口，验证检查严格按端口号升序 (10022 -> 20080 -> 30090) 且命中 GFW 后短路
        self._bind_ports([30090, 10022, 20080])
        calls: list[tuple[str, str, int]] = []
        cf = FakeCf(["198.51.100.10"])
        monitor = PoolHealthMonitor(prober=lambda host, port: (True, "ok"))

        def fake_prober(node_id: str, ip: str, port: int) -> tuple[bool | None, str]:
            calls.append((node_id, ip, port))
            if ip == "198.51.100.10":
                if port == 10022:
                    return True, "18ms"
                if port == 20080:
                    if node_id == self.primary["id"]:
                        return False, "timeout"
                    return True, "8ms"
            return True, "12ms"

        checker = DomainPortHealthChecker(check_interval=60)
        outcome = checker.run_checks(
            self.lb_store,
            self.probe_store,
            settings,
            force=True,
            monitor=monitor,
            cf_factory=lambda _token: cf,
            tcp_prober=fake_prober,
            refresh_agents=False,
        )
        self.assertEqual(outcome["switchedCount"], 1)
        # 验证顺序：先测 10022(主通) -> 再测 20080(主不通) -> 20080(备通) -> 短路不测 30090！
        self.assertEqual(
            calls,
            [
                (self.primary["id"], "198.51.100.10", 10022),
                (self.primary["id"], "198.51.100.10", 20080),
                (self.backup["id"], "198.51.100.10", 20080),
            ],
        )

        updated_domain = self.lb_store.get_domain(self.domain.id)
        self.assertEqual(updated_domain.current_ip, "198.51.100.20")
        # 原手动固定在 198.51.100.10 已因故障切换自动解除
        self.assertIsNone(updated_domain.preferred_server_id)
        self.assertEqual([r.content for r in cf.records], ["198.51.100.20"])
        self.assertIn("198.51.100.10", self.lb_store.gfw_blocked_ips())

        alerts = self.lb_store.list_port_alerts(status="active")
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["kind"], "gfw_blocked")
        self.assertTrue(alerts[0]["switched"])
        self.assertEqual(alerts[0]["switchedToIp"], "198.51.100.20")

        # 下一轮调度运行：即便海外 monitor 测 198.51.100.10:7000 仍健康，也绝不会切回被墙 IP
        run_due_syncs(
            self.lb_store,
            self.probe_store,
            settings,
            monitor=monitor,
            cf_factory=lambda _token: cf,
            port_checker=checker,
        )
        self.assertEqual(self.lb_store.get_domain(self.domain.id).current_ip, "198.51.100.20")

    def test_both_primary_and_backup_unreachable_raises_port_alert_without_switching(self) -> None:
        self._bind_ports([10022, 20080])
        cf = FakeCf(["198.51.100.10"])
        monitor = PoolHealthMonitor(prober=lambda host, port: (True, "ok"))
        port_alive = {10022: True, 20080: False}

        def fake_prober(node_id: str, ip: str, port: int) -> tuple[bool | None, str]:
            ok = port_alive.get(port, False)
            return (True, "10ms") if ok else (False, "connection refused")

        checker = DomainPortHealthChecker(check_interval=60)
        outcome = checker.run_checks(
            self.lb_store,
            self.probe_store,
            settings,
            force=True,
            monitor=monitor,
            cf_factory=lambda _token: cf,
            tcp_prober=fake_prober,
            refresh_agents=False,
        )
        self.assertEqual(outcome["switchedCount"], 0)
        self.assertEqual(self.lb_store.get_domain(self.domain.id).current_ip, "198.51.100.10")
        self.assertEqual(self.lb_store.gfw_blocked_ips(), set())

        alerts = self.lb_store.list_port_alerts(status="active")
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["kind"], "port_unreachable")
        self.assertEqual(alerts[0]["port"], 20080)
        self.assertEqual(alerts[0]["instances"][0]["instanceName"], "biz-proxy")

        # 业务服务恢复后重检：活跃异常自动解除
        port_alive[20080] = True
        checker.run_checks(
            self.lb_store,
            self.probe_store,
            settings,
            force=True,
            monitor=monitor,
            cf_factory=lambda _token: cf,
            tcp_prober=fake_prober,
            refresh_agents=False,
        )
        self.assertEqual(self.lb_store.list_port_alerts(status="active"), [])
        self.assertEqual(len(self.lb_store.list_port_alerts(status="resolved")), 1)

    def test_ephemeral_worker_tcping_has_zero_db_pollution_and_survives_heartbeat(self) -> None:
        broker = EphemeralTcpingBroker()
        # 替换 jobs 模块引用的 broker 进行端到端调度契约验证
        import app.probe.jobs as jobs_mod

        prev_broker = jobs_mod.ephemeral_tcping_broker
        jobs_mod.ephemeral_tcping_broker = broker
        try:
            result_holder: list[tuple[bool | None, str]] = []

            def caller():
                res = broker.probe_tcp(
                    self.job_store, self.primary["id"], "198.51.100.10", 22022,
                    timeout=1.5, retries=1, claim_timeout=5.0,
                )
                result_holder.append(res)

            t = threading.Thread(target=caller)
            t.start()
            deadline = time.monotonic() + 3.0
            claimed = None
            while time.monotonic() < deadline and claimed is None:
                claimed = self.job_store.claim(self.primary["id"])
                if claimed is None:
                    time.sleep(0.02)

            self.assertIsNotNone(claimed)
            assert claimed is not None
            self.assertEqual(claimed["port"], 22022)
            # Worker 心跳上报该任务时绝不能被判定为未知任务取消
            hb = self.job_store.heartbeat(
                self.primary["id"],
                "v1",
                ["discover", "route", "connectivity", "speed"],
                [{"taskId": claimed["taskId"], "attemptId": claimed["attemptId"], "generation": 0}],
                ["task-generation-v1"],
            )
            self.assertEqual(hb["cancelled"], [])

            prog = self.job_store.progress(
                self.primary["id"],
                claimed["taskId"],
                claimed["attemptId"],
                1,
                generation=0,
                hits=[{"ip": "198.51.100.10", "port": 22022, "latencyMs": 23.4}],
            )
            self.assertTrue(prog["accepted"])
            rep = self.job_store.report(
                self.primary["id"],
                claimed["taskId"],
                claimed["attemptId"],
                generation=0,
                result={"scanned": 1, "foundCount": 1},
            )
            self.assertTrue(rep["applied"])
            t.join(timeout=3.0)
            self.assertEqual(result_holder, [(True, "23ms")])

            # 核心断言：probe_jobs、probe_tasks、probe_discover_results、probe_results 全部零污染
            self.assertEqual(self.job_store.list_jobs(), [])
            with self.job_store._db() as c:
                self.assertEqual(c.execute("SELECT COUNT(*) FROM probe_tasks").fetchone()[0], 0)
                self.assertEqual(c.execute("SELECT COUNT(*) FROM probe_discover_results").fetchone()[0], 0)
                self.assertEqual(c.execute("SELECT COUNT(*) FROM probe_results").fetchone()[0], 0)
        finally:
            jobs_mod.ephemeral_tcping_broker = prev_broker

    def test_port_health_http_endpoints_unblock_and_dismiss(self) -> None:
        self.lb_store.mark_gfw_blocked(
            ip="198.51.100.10",
            domain_id=self.domain.id,
            domain_name=self.domain.name,
            blocked_port=20080,
            primary_node_id=self.primary["id"],
            primary_node_name="深圳主节点",
            primary_detail="timeout",
            backup_node_id="console",
            backup_node_name="Console",
            backup_detail="9ms",
        )
        alert = self.lb_store.upsert_port_alert(
            alert_key=f"port_unreachable:{self.domain.id}:198.51.100.20:30080",
            kind="port_unreachable",
            severity="error",
            domain_id=self.domain.id,
            domain_name=self.domain.name,
            ip="198.51.100.20",
            port=30080,
            message="业务端口异常",
        )
        token = create_token(settings.username)["token"]
        headers = {"Authorization": f"Bearer {token}"}
        with TestClient(app) as client:
            resp = client.get("/api/lb/port-health", headers=headers)
            self.assertEqual(resp.status_code, 200)
            body = resp.json()
            self.assertEqual(len(body["gfwBlocks"]), 1)
            self.assertEqual(len(body["alerts"]), 1)

            unblock = client.delete("/api/lb/gfw-blocks/198.51.100.10", headers=headers)
            self.assertEqual(unblock.status_code, 200)
            self.assertTrue(unblock.json()["removed"])

            dismiss = client.post(f"/api/lb/port-alerts/{alert['id']}/dismiss", headers=headers)
            self.assertEqual(dismiss.status_code, 200)

            after = client.get("/api/lb/port-health", headers=headers).json()
            self.assertEqual(after["gfwBlocks"], [])
            self.assertEqual(after["alerts"], [])

    def test_offline_primary_skips_without_false_positive_or_switch(self) -> None:
        self._bind_ports([20080])
        with self.job_store._db() as c:
            c.execute("UPDATE probe_nodes SET last_seen = 0 WHERE id = ?", (self.primary["id"],))
        cf = FakeCf(["198.51.100.10"])
        checker = DomainPortHealthChecker(check_interval=60)
        outcome = checker.run_checks(
            self.lb_store,
            self.probe_store,
            settings,
            force=True,
            cf_factory=lambda _token: cf,
            tcp_prober=lambda *_args: (False, "should not be called"),
            refresh_agents=False,
        )
        self.assertEqual(outcome["switchedCount"], 0)
        self.assertIn("离线", outcome["policySkipReason"] or "")
        self.assertEqual(self.lb_store.gfw_blocked_ips(), set())
        self.assertEqual(self.lb_store.list_port_alerts(status="active"), [])

    def test_probe_search_query_max_length_validation(self) -> None:
        token = create_token(settings.username)["token"]
        headers = {"Authorization": f"Bearer {token}"}
        too_long = "x" * 257
        with TestClient(app) as client:
            for path in ("/api/probe/servers", "/api/probe/servers/cursor", "/api/probe/discover/results"):
                resp = client.get(f"{path}?q={too_long}", headers=headers)
                self.assertEqual(resp.status_code, 422, path)


if __name__ == "__main__":
    unittest.main()
