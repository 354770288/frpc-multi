from __future__ import annotations

from contextlib import ExitStack
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("WEBUI_JWT_SECRET", "test-secret-webui-enhancements-32chars")
os.environ.setdefault("PROJECT_DIR", tempfile.gettempdir())

from fastapi.testclient import TestClient

from app.control import wsproto
from app.control.audit_store import AuditStore
from app.control.node_store import NodeStore
from app.lb.store import LbStore
from app.probe.store import ProbeStore


class WebUiBackendEnhancementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "console.db"
        self.stack = ExitStack()
        settings_mod = importlib.import_module("app.settings")
        auth_mod = importlib.import_module("app.auth")
        self.main_mod = importlib.import_module("app.main")
        seen_ids: set[int] = set()
        for mod in list(sys.modules.values()):
            cfg = getattr(mod, "settings", None)
            if cfg is not None and hasattr(cfg, "database_path") and id(cfg) not in seen_ids:
                seen_ids.add(id(cfg))
                self.stack.enter_context(mock.patch.object(cfg, "database_path", self.db_path))
        self.stack.enter_context(mock.patch.dict(os.environ, {"AGENT_VERSION": "sha-new-123"}))
        token = auth_mod.create_token(settings_mod.settings.username)["token"]
        self.headers = {"Authorization": f"Bearer {token}"}

    def tearDown(self) -> None:
        self.stack.close()
        self.tmp.cleanup()

    def test_b3_servers_domain_assignment_projection_and_filter(self) -> None:
        pstore = ProbeStore(self.db_path)
        lstore = LbStore(self.db_path)
        s1 = pstore.create_server(ip="198.51.100.1", server_group="hk")
        s2 = pstore.create_server(ip="198.51.100.2", server_group="hk")
        s3 = pstore.create_server(ip="198.51.100.3", server_group="us")
        domain = lstore.create_domain(name="hk.example.com", zone_id="z1", zone_name="example.com")
        lstore.add_domain_servers(domain.id, [s1.id])

        with TestClient(self.main_mod.app) as client:
            all_res = client.get("/api/probe/servers/cursor?pageSize=50&sort=ip&order=asc", headers=self.headers)
            self.assertEqual(all_res.status_code, 200, all_res.text)
            by_id = {item["id"]: item for item in all_res.json()["items"]}
            self.assertEqual(by_id[s1.id]["domainId"], domain.id)
            self.assertEqual(by_id[s1.id]["domainName"], "hk.example.com")
            self.assertIsNone(by_id[s2.id]["domainId"])
            self.assertIsNone(by_id[s2.id]["domainName"])

            unassigned = client.get(
                "/api/probe/servers/cursor?pageSize=50&sort=ip&order=asc&domainStatus=unassigned",
                headers=self.headers,
            )
            self.assertEqual(unassigned.status_code, 200)
            self.assertEqual([item["id"] for item in unassigned.json()["items"]], [s2.id, s3.id])

            unassigned_cnt = client.get("/api/probe/servers/count?domainStatus=unassigned", headers=self.headers)
            self.assertEqual(unassigned_cnt.json()["total"], 2)

            assigned_cnt = client.get("/api/probe/servers/count?domainStatus=assigned", headers=self.headers)
            self.assertEqual(assigned_cnt.json()["total"], 1)

            view_res = client.post(
                "/api/probe/server-views",
                headers=self.headers,
                json={"name": "未分配池", "filters": {"domainStatus": "unassigned"}, "sort": "ip", "order": "asc"},
            )
            self.assertEqual(view_res.status_code, 200, view_res.text)
            self.assertEqual(view_res.json()["filters"].get("domainStatus"), "unassigned")

    def test_b1_b2_b4_b5_b6_summary_workspace_overview_port_check_and_batch_upgrade(self) -> None:
        nstore = NodeStore(self.db_path)
        astore = AuditStore(self.db_path)
        pstore = ProbeStore(self.db_path)
        lstore = LbStore(self.db_path)

        node_old = nstore.create_node(name="old-agent-node")
        node_cur = nstore.create_node(name="cur-agent-node")
        srv = pstore.create_server(ip="203.0.113.10")
        dom = lstore.create_domain(name="edge.example.com", zone_id="z1", zone_name="example.com")
        lstore.add_domain_servers(dom.id, [srv.id])
        lstore.mark_gfw_blocked(
            ip="203.0.113.10", domain_id=dom.id, domain_name=dom.name, blocked_port=1255,
            primary_node_id="cn", primary_node_name="CN", primary_detail="timeout",
            backup_node_id="console", backup_node_name="Console", backup_detail="20ms",
        )
        astore.create_log(username="admin", action="restart_instance", node_id=node_old.id, instance_name="app-01")
        astore.create_log(username="admin", action="restart_instance", node_id=node_old.id, instance_name="app-02")

        upgraded_calls: list[str] = []

        class FakeConn:
            def __init__(self, ver: str, legacy: bool) -> None:
                self.ver = ver
                self.legacy = legacy

            async def call(self, method: str, params=None, timeout: float = 15.0):
                if method == wsproto.M_SUMMARY:
                    inst: dict = {
                        "name": "app-01",
                        "displayName": "App 01",
                        "enabled": True,
                        "updatedAt": "2026-11-18T00:00:00Z",
                        "runtime": {"status": "running", "running": True},
                    }
                    if not self.legacy:
                        inst["summary"] = {
                            "serverAddr": "edge.example.com",
                            "serverPort": 7000,
                            "proxyCount": 1,
                            "proxyTypes": {"tcp": 1},
                            "remotePorts": [1255],
                            "tcpRemotePorts": [1255],
                        }
                    return {"total": 1, "running": 1, "stopped": 0, "error": 0, "instances": [inst]}
                if method == wsproto.M_GET_INSTANCE:
                    return {
                        "name": "app-01",
                        "summary": {
                            "serverAddr": "edge.example.com",
                            "serverPort": 7000,
                            "proxyCount": 1,
                            "proxyTypes": {"tcp": 1},
                            "remotePorts": [2235],
                            "tcpRemotePorts": [2235],
                        },
                    }
                if method == wsproto.M_GET_SYSTEM:
                    return {"agentVersion": self.ver}
                if method == wsproto.M_UPGRADE_AGENT:
                    upgraded_calls.append(self.ver)
                    return {"image": "ghcr.io/354770288/frpc-multi:latest"}
                return {}

        conns = {
            node_old.uuid: FakeConn("old-sha-000", legacy=True),
            node_cur.uuid: FakeConn("sha-new-123", legacy=False),
        }

        hub_mod = importlib.import_module("app.control.hub")
        ph_mod = importlib.import_module("app.lb.port_health")

        with (
            mock.patch.object(hub_mod.hub, "is_online", side_effect=lambda u: u in conns),
            mock.patch.object(hub_mod.hub, "get", side_effect=lambda u: conns[u]),
            mock.patch.object(ph_mod.hub, "is_online", side_effect=lambda u: u in conns),
            mock.patch.object(ph_mod.hub, "get", side_effect=lambda u: conns[u]),
            TestClient(self.main_mod.app) as client,
        ):
            info_res = client.get("/api/console-info", headers=self.headers)
            self.assertEqual(info_res.status_code, 200)
            self.assertEqual(info_res.json()["buildVersion"], "sha-new-123")

            sum_res = client.get("/api/summary", headers=self.headers)
            self.assertEqual(sum_res.status_code, 200, sum_res.text)
            instances = sum_res.json()["instances"]
            self.assertEqual(len(instances), 2)
            self.assertTrue(all(isinstance(i.get("summary"), dict) for i in instances))

            ov_res = client.get("/api/workspace/overview", headers=self.headers)
            self.assertEqual(ov_res.status_code, 200, ov_res.text)
            ov = ov_res.json()
            self.assertEqual(ov["summary"]["running"], 2)
            self.assertGreaterEqual(ov["badges"]["anomalies"], 1)

            cand_res = client.get(f"/api/lb/domains/{dom.id}/servers", headers=self.headers)
            self.assertEqual(cand_res.status_code, 200)
            self.assertTrue(cand_res.json()["items"][0]["gfwBlocked"])
            self.assertEqual(cand_res.json()["items"][0]["gfwBlockedPort"], 1255)

            chk_res = client.post(f"/api/lb/domains/{dom.id}/check-ports", headers=self.headers)
            self.assertEqual(chk_res.status_code, 200, chk_res.text)

            aud_res = client.get(
                f"/api/audit-logs/page?nodeId={node_old.id}&instanceName=app-01",
                headers=self.headers,
            )
            self.assertEqual(aud_res.status_code, 200)
            self.assertEqual(aud_res.json()["total"], 1)

            upg_res = client.post("/api/nodes/upgrade-outdated", headers=self.headers, json={})
            self.assertEqual(upg_res.status_code, 200, upg_res.text)
            upg = upg_res.json()
            self.assertEqual([n["id"] for n in upg["upgraded"]], [node_old.id])
            self.assertEqual([n["id"] for n in upg["skipped"]], [node_cur.id])
            self.assertEqual(upgraded_calls, ["old-sha-000"])


if __name__ == "__main__":
    unittest.main()
