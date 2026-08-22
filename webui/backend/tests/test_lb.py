"""lb 模块测试：存储、Cloudflare 客户端（MockTransport）、同步引擎、调度、API。"""

import importlib
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

os.environ.setdefault("PROJECT_DIR", tempfile.mkdtemp(prefix="frpc-multi-lb-tests-"))

import httpx

from app.lb.cloudflare import CloudflareClient, CloudflareError
from app.lb.store import LbStore, validate_domain_name
from app.lb.syncer import SyncResult, sync_domain
from app.lb.scheduler import due_domains


def make_stores(tmp: str):
    from app.probe.store import ProbeStore

    db = Path(tmp) / "lb.db"
    return LbStore(db), ProbeStore(db)


# ---------------------------------------------------------------------------
# Fake Cloudflare：内存实现同步引擎所需的三个接口
# ---------------------------------------------------------------------------
class FakeCloudflare:
    def __init__(self, records: list | None = None, fail_on: str | None = None):
        # records: [{id, name, content, ttl, managed}]
        self.records = records or []
        self.next_id = 100
        self.fail_on = fail_on  # 'create' | 'delete' | 'list'

    def list_a_records(self, zone_id, name):
        if self.fail_on == "list":
            raise CloudflareError("读取 DNS 记录失败: mock")
        return [type("R", (), {
            "id": r["id"], "name": r["name"], "content": r["content"],
            "ttl": r["ttl"], "managed": r["managed"],
        })() for r in self.records if r["name"] == name]

    def create_a_record(self, zone_id, name, ip, ttl=60):
        if self.fail_on == "create":
            raise CloudflareError(f"新增 {ip} 失败: mock")
        self.next_id += 1
        self.records.append({"id": str(self.next_id), "name": name, "content": ip,
                             "ttl": ttl, "managed": True})
        return self.records[-1]

    def delete_a_record(self, zone_id, record_id):
        if self.fail_on == "delete":
            raise CloudflareError("移除失败: mock")
        self.records = [r for r in self.records if r["id"] != record_id]

    def ips(self, name):
        return sorted(r["content"] for r in self.records if r["name"] == name and r["managed"])


class LbStoreTests(unittest.TestCase):
    def setUp(self):
        self.store, self.probe = make_stores(tempfile.mkdtemp(prefix="lb-store-"))

    def test_token_settings(self):
        self.assertIsNone(self.store.cloudflare_token())
        self.store.set_cloudflare_token("  abc123  ")
        self.assertEqual(self.store.cloudflare_token(), "abc123")

    def test_domain_crud_and_validation(self):
        domain = self.store.create_domain(
            name="FRPS.Example.COM.", zone_id="z1", zone_name="example.com",
            group_name="健康池", ttl=120, sync_mode="scheduled", interval_seconds=600,
        )
        self.assertEqual(domain.name, "frps.example.com")  # 规范化为小写去尾点
        with self.assertRaises(ValueError):
            self.store.create_domain(name="frps.example.com", zone_id="z", zone_name="example.com", group_name="g")
        with self.assertRaises(ValueError):
            validate_domain_name("bad..name")
        with self.assertRaises(ValueError):
            self.store.create_domain(name="ok.example.com", zone_id="z", zone_name="example.com",
                                     group_name="g", ttl=10)  # TTL 越界
        with self.assertRaises(ValueError):
            self.store.update_domain(domain.id, sync_mode="bogus")
        updated = self.store.update_domain(domain.id, group_name="新池", enabled=False)
        self.assertEqual(updated.group_name, "新池")
        self.assertFalse(updated.enabled)
        self.store.delete_domain(domain.id)
        self.assertEqual(self.store.list_domains(), [])

    def test_sync_result_logging(self):
        domain = self.store.create_domain(name="a.example.com", zone_id="z", zone_name="example.com",
                                          group_name="g")
        self.store.mark_sync_result(domain.id, ok=True, message="ok", added=["1.1.1.1"], removed=[], kept=2)
        logs = self.store.list_sync_logs(domain.id)
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["added"], ["1.1.1.1"])
        self.assertEqual(logs[0]["kept"], 2)
        domain = self.store.get_domain(domain.id)
        self.assertTrue(domain.last_sync_ok)
        self.assertIsNotNone(domain.last_sync_at)


class SyncerTests(unittest.TestCase):
    def setUp(self):
        self.lb, self.probe = make_stores(tempfile.mkdtemp(prefix="lb-sync-"))
        self.probe.import_servers([
            {"ip": "1.1.1.1", "group": "pool"}, {"ip": "2.2.2.2", "group": "pool"},
            {"ip": "3.3.3.3", "group": "other"},
        ])
        self.domain = self.lb.create_domain(name="frps.example.com", zone_id="z1",
                                            zone_name="example.com", group_name="pool")

    def test_initial_sync_adds_pool(self):
        cf = FakeCloudflare()
        result = sync_domain(self.domain, self.probe, self.lb, cf)
        self.assertTrue(result.ok)
        self.assertEqual(result.added, ["1.1.1.1", "2.2.2.2"])
        self.assertEqual(cf.ips("frps.example.com"), ["1.1.1.1", "2.2.2.2"])
        # 结果落库
        domain = self.lb.get_domain(self.domain.id)
        self.assertTrue(domain.last_sync_ok)

    def test_idempotent_resync_keeps(self):
        cf = FakeCloudflare()
        sync_domain(self.domain, self.probe, self.lb, cf)
        result = sync_domain(self.domain, self.probe, self.lb, cf)
        self.assertEqual(result.added, [])
        self.assertEqual(result.removed, [])
        self.assertEqual(result.kept, 2)

    def test_pool_change_adds_and_removes(self):
        cf = FakeCloudflare()
        sync_domain(self.domain, self.probe, self.lb, cf)
        self.probe.update_servers_batch(
            [s.id for s in self.probe.list_servers() if s.ip == "1.1.1.1"], group="out", label=None,
        )
        result = sync_domain(self.domain, self.probe, self.lb, cf)
        self.assertEqual(result.removed, ["1.1.1.1"])
        self.assertEqual(result.kept, 1)
        self.assertEqual(cf.ips("frps.example.com"), ["2.2.2.2"])

    def test_unmanaged_records_untouched(self):
        cf = FakeCloudflare(records=[{"id": "manual-1", "name": "frps.example.com",
                                      "content": "9.9.9.9", "ttl": 300, "managed": False}])
        result = sync_domain(self.domain, self.probe, self.lb, cf)
        self.assertEqual(result.unmanaged_count, 1)
        self.assertIn("9.9.9.9", [r["content"] for r in cf.records])  # 保留
        self.assertEqual(result.added, ["1.1.1.1", "2.2.2.2"])

    def test_empty_pool_removes_all(self):
        cf = FakeCloudflare()
        sync_domain(self.domain, self.probe, self.lb, cf)
        self.lb.update_domain(self.domain.id, group_name="空组")
        # 重新读取：sync_domain 需要最新绑定
        domain = self.lb.get_domain(self.domain.id)
        result = sync_domain(domain, self.probe, self.lb, cf)
        self.assertEqual(result.removed, ["1.1.1.1", "2.2.2.2"])
        self.assertEqual(result.pool_size, 0)
        self.assertIn("警告", result.message)

    def test_errors_collected_not_fatal(self):
        cf = FakeCloudflare(fail_on="create")
        result = sync_domain(self.domain, self.probe, self.lb, cf)
        self.assertFalse(result.ok)
        self.assertEqual(len(result.errors), 2)
        domain = self.lb.get_domain(self.domain.id)
        self.assertFalse(domain.last_sync_ok)

    def test_list_failure_marks_not_ok(self):
        cf = FakeCloudflare(fail_on="list")
        result = sync_domain(self.domain, self.probe, self.lb, cf)
        self.assertFalse(result.ok)
        self.assertIn("读取 DNS 记录失败", result.errors[0])


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.lb, _ = make_stores(tempfile.mkdtemp(prefix="lb-sched-"))

    def _domain(self, **kwargs):
        base = dict(name="frps.example.com", zone_id="z", zone_name="example.com",
                    group_name="g", sync_mode="scheduled", interval_seconds=300)
        base.update(kwargs)
        return self.lb.create_domain(**base)

    def test_due_rules(self):
        now = datetime.now().astimezone()
        never = self._domain(name="never.example.com")
        fresh = self._domain(name="fresh.example.com")
        self.lb.mark_sync_result(fresh.id, ok=True, message="", added=[], removed=[], kept=0)
        stale = self._domain(name="stale.example.com", interval_seconds=60)
        self.lb.mark_sync_result(stale.id, ok=True, message="", added=[], removed=[], kept=0)
        manual = self._domain(name="manual.example.com", sync_mode="manual")

        # +200s：stale（间隔 60s）到期，fresh（间隔 300s）未到期
        early = {d.name for d in due_domains(self.lb, now=now + timedelta(seconds=200))}
        self.assertIn("never.example.com", early)
        self.assertIn("stale.example.com", early)
        self.assertNotIn("fresh.example.com", early)
        self.assertNotIn("manual.example.com", early)
        # +400s：fresh 也到期
        late = {d.name for d in due_domains(self.lb, now=now + timedelta(seconds=400))}
        self.assertIn("fresh.example.com", late)

    def test_disabled_excluded(self):
        self._domain(name="off.example.com", enabled=False)
        self.assertEqual(due_domains(self.lb), [])


class CloudflareClientTests(unittest.TestCase):
    """用 httpx.MockTransport 模拟 CF API，验证协议细节与错误映射。"""

    @staticmethod
    def make_client(handler) -> CloudflareClient:
        return CloudflareClient("tok", base_url="https://cf.test",
                                transport=httpx.MockTransport(handler)) if False else None

    def test_verify_and_error_mapping(self):
        from app.lb import cloudflare as cf_mod

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/zones":
                return httpx.Response(200, json={
                    "success": True,
                    "result": [{"id": "z1", "name": "example.com"}],
                })
            return httpx.Response(401, json={"success": False, "errors": [{"message": "bad token"}]})

        # 构造函数不接受 transport，monkeypatch httpx.Client
        original_client = cf_mod.httpx.Client

        def patched_client(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return original_client(*args, **kwargs)

        cf_mod.httpx.Client = patched_client
        try:
            client = CloudflareClient("tok", base_url="https://cf.test")
            zones = client.verify()
            self.assertEqual(zones, [{"id": "z1", "name": "example.com"}])
            with self.assertRaises(CloudflareError) as ctx:
                client.list_a_records("z9", "x.example.com")
            self.assertIn("令牌无效", str(ctx.exception))
        finally:
            cf_mod.httpx.Client = original_client

    def test_create_uses_grey_cloud_and_managed_comment(self):
        from app.lb import cloudflare as cf_mod

        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST":
                captured.update(json.loads(request.content.decode()))
                return httpx.Response(200, json={
                    "success": True,
                    "result": {"id": "r1", "name": "frps.example.com", "content": "1.1.1.1", "ttl": 60},
                })
            if request.method == "DELETE":
                return httpx.Response(200, json={"success": True, "result": {"id": "r1"}})
            return httpx.Response(200, json={"success": True, "result": []})

        original_client = cf_mod.httpx.Client

        def patched_client(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return original_client(*args, **kwargs)

        cf_mod.httpx.Client = patched_client
        try:
            with CloudflareClient("tok", base_url="https://cf.test") as client:
                record = client.create_a_record("z1", "frps.example.com", "1.1.1.1", ttl=90)
                self.assertTrue(record.managed)
                client.delete_a_record("z1", "r1")
        finally:
            cf_mod.httpx.Client = original_client
        self.assertFalse(captured["proxied"])  # 必须灰云
        self.assertEqual(captured["comment"], "frpc-multi-lb")
        self.assertEqual(captured["ttl"], 90)


class LbApiTests(unittest.TestCase):
    @staticmethod
    def load_lb_app(**env: str):
        previous = {key: os.environ.get(key) for key in env}
        os.environ.update(env)
        for module_name in [
            "app.main", "app.lb.router", "app.probe.router", "app.probe.runner",
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

    def make_client(self):
        from fastapi.testclient import TestClient

        self.db_path = Path(tempfile.mkdtemp(prefix="lb-api-")) / "console.db"
        app = self.load_lb_app(
            WEBUI_USERNAME="admin", WEBUI_PASSWORD="password", DATABASE_PATH=str(self.db_path),
        )
        client = TestClient(app)
        token = client.post("/api/auth/login", json={"username": "admin", "password": "password"}).json()["token"]
        return client, {"Authorization": f"Bearer {token}"}

    def test_domain_crud_flow(self):
        client, headers = self.make_client()
        # 未配置 token 状态
        info = client.get("/api/lb/cloudflare", headers=headers).json()
        self.assertFalse(info["configured"])
        # 保存 + 掩码
        saved = client.put("/api/lb/cloudflare", json={"token": "cf-token-123456789"}, headers=headers).json()
        self.assertTrue(saved["configured"])
        self.assertIn("…", saved["tokenMasked"])
        # 创建域名（zone 归属校验失败路径）
        bad = client.post("/api/lb/domains", json={
            "name": "frps.other.com", "zoneId": "z1", "zoneName": "example.com", "group": "pool",
        }, headers=headers)
        self.assertEqual(bad.status_code, 400)
        created = client.post("/api/lb/domains", json={
            "name": "frps.example.com", "zoneId": "z1", "zoneName": "example.com", "group": "pool",
        }, headers=headers).json()
        self.assertEqual(created["name"], "frps.example.com")
        self.assertEqual(created["syncMode"], "manual")
        # PATCH / DELETE / 404
        patched = client.patch(f"/api/lb/domains/{created['id']}", json={"ttl": 120}, headers=headers).json()
        self.assertEqual(patched["ttl"], 120)
        self.assertEqual(client.delete(f"/api/lb/domains/{created['id']}", headers=headers).status_code, 200)
        self.assertEqual(client.get(f"/api/lb/domains/{created['id']}/logs", headers=headers).status_code, 404)
        # 审计
        actions = {log["action"] for log in client.get("/api/audit-logs?limit=20", headers=headers).json()}
        self.assertIn("lb_update_cloudflare", actions)
        self.assertIn("lb_create_domain", actions)

    def test_sync_endpoint_with_fake_client(self):
        client, headers = self.make_client()
        from app.probe.store import ProbeStore
        from app.lb import router as lb_router

        probe = ProbeStore(self.db_path)
        probe.import_servers([{"ip": "1.1.1.1", "group": "pool"}, {"ip": "2.2.2.2", "group": "pool"}])
        client.put("/api/lb/cloudflare", json={"token": "tok"}, headers=headers)
        created = client.post("/api/lb/domains", json={
            "name": "frps.example.com", "zoneId": "z1", "zoneName": "example.com", "group": "pool",
        }, headers=headers).json()

        class FakeContext:
            def __init__(self, inner):
                self.inner = inner

            def __enter__(self):
                return self.inner

            def __exit__(self, *args):
                return None

        fake = FakeCloudflare()
        lb_router._cf_client = lambda token: FakeContext(fake)
        try:
            result = client.post(f"/api/lb/domains/{created['id']}/sync", headers=headers).json()
            self.assertTrue(result["ok"])
            self.assertEqual(result["added"], ["1.1.1.1", "2.2.2.2"])
            self.assertEqual(result["poolSize"], 2)
            logs = client.get(f"/api/lb/domains/{created['id']}/logs", headers=headers).json()
            self.assertEqual(len(logs), 1)
            # 域名列表带池统计
            domains = client.get("/api/lb/domains", headers=headers).json()
            self.assertEqual(domains[0]["poolSize"], 2)
            self.assertTrue(domains[0]["lastSyncOk"])
        finally:
            lb_router._cf_client = lb_router.CloudflareClient


if __name__ == "__main__":
    unittest.main()
