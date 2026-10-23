import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("PROJECT_DIR", tempfile.mkdtemp(prefix="probe-import-api-"))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import create_token
from app.probe import router as probe_router
from app.probe.bulk import ServerBulkStore
from app.probe.store import ProbeStore, ServerPageQuery


class ProbeAsyncImportApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "console.db"
        self.bulk = ServerBulkStore(self.path)
        self.assets = ProbeStore(self.path)
        self.app = FastAPI()
        self.app.include_router(probe_router.router)
        self.client_context = TestClient(self.app)
        self.client = self.client_context.__enter__()
        self.store_patch = patch.object(probe_router, "server_bulk_store", return_value=self.bulk)
        self.audit_patch = patch.object(probe_router, "audit")
        self.store_patch.start()
        self.audit_patch.start()
        self.admin = {"Authorization": "Bearer " + create_token("admin")["token"]}
        self.other = {"Authorization": "Bearer " + create_token("other")["token"]}

    def tearDown(self):
        self.audit_patch.stop()
        self.store_patch.stop()
        self.client_context.__exit__(None, None, None)
        self.tmp.cleanup()

    def test_async_import_routes_preserve_idempotency_owner_scope_and_failure_page(self):
        payload = {
            "text": "192.0.2.1 edge\n192.0.2.1 duplicate\nbad/host invalid",
            "group": "edge",
            "idempotencyKey": "import-once",
        }
        created = self.client.post("/api/probe/server-import-jobs", headers=self.admin, json=payload)
        self.assertEqual(created.status_code, 200, created.text)
        job = created.json()
        self.assertEqual(job["state"], "queued")
        replay = self.client.post("/api/probe/server-import-jobs", headers=self.admin, json=payload)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json()["jobId"], job["jobId"])
        mismatch = self.client.post("/api/probe/server-import-jobs", headers=self.admin,
                                    json={**payload, "text": "192.0.2.99"})
        self.assertEqual(mismatch.status_code, 400)
        self.assertEqual(self.client.get(f"/api/probe/server-import-jobs/{job['jobId']}",
                                         headers=self.other).status_code, 404)

        self.assertTrue(self.bulk.run_once("worker"))  # bounded parse/staging pass
        self.assertTrue(self.bulk.run_once("worker"))  # insert/skip/fail batch
        current = self.client.get(f"/api/probe/server-import-jobs/{job['jobId']}",
                                  headers=self.admin)
        self.assertEqual(current.status_code, 200, current.text)
        self.assertEqual(current.json()["state"], "partial")
        self.assertEqual((current.json()["inserted"], current.json()["skipped"],
                          current.json()["failed"]), (1, 1, 1))
        self.assertEqual(current.json()["retryableFailed"], 0)
        failures = self.client.get(
            f"/api/probe/server-import-jobs/{job['jobId']}/failures?cursor=0&limit=10",
            headers=self.admin,
        )
        self.assertEqual(failures.status_code, 200, failures.text)
        self.assertEqual(failures.json()["items"], [{
            "line": 3, "input": "bad/host", "error": "服务器地址只允许字母、数字、点、冒号、连字符（IP 或域名）",
            "retryable": False,
        }])
        self.assertEqual(self.client.get(f"/api/probe/server-import-jobs/{job['jobId']}",
                                         headers={}).status_code, 401)

    def test_retry_failed_route_is_idempotent_and_status_uses_import_contract(self):
        create = self.client.post("/api/probe/server-import-jobs", headers=self.admin, json={
            "text": "192.0.2.3",
            "idempotencyKey": "retry-source",
        })
        job_id = create.json()["jobId"]
        self.assertTrue(self.bulk.run_once("worker"))
        self.assertTrue(self.bulk.run_once("worker"))
        finished = self.client.get(f"/api/probe/server-import-jobs/{job_id}", headers=self.admin).json()
        self.assertEqual(finished["state"], "done")
        self.assertEqual(self.assets.count_servers(ServerPageQuery()), 1)
        self.assertEqual(self.client.post(f"/api/probe/server-import-jobs/{job_id}/retry-failed",
                                          headers=self.admin,
                                          json={"idempotencyKey": "retry-no-failures"}).status_code, 400)

    def test_import_api_rejects_group_limits_and_malformed_json_without_assets(self):
        too_long = self.client.post("/api/probe/server-import-jobs", headers=self.admin, json={
            "text": "192.0.2.20", "group": "x" * 129, "idempotencyKey": "group-too-long",
        })
        self.assertEqual(too_long.status_code, 400)
        text_surrogate = self.client.post(
            "/api/probe/server-import-jobs",
            headers={**self.admin, "Content-Type": "application/json"},
            content='{"text":"\\ud800","idempotencyKey":"text-surrogate"}',
        )
        group_surrogate = self.client.post(
            "/api/probe/server-import-jobs",
            headers={**self.admin, "Content-Type": "application/json"},
            content='{"text":"192.0.2.23","group":"\\ud800","idempotencyKey":"group-surrogate"}',
        )
        self.assertEqual(text_surrogate.status_code, 400)
        self.assertEqual(group_surrogate.status_code, 400)
        for index, constant in enumerate(("NaN", "Infinity", "-Infinity")):
            key = f"outer-json-constant-{index}"
            rejected = self.client.post(
                "/api/probe/server-import-jobs",
                headers={**self.admin, "Content-Type": "application/json"},
                content=f'{{"text":"192.0.2.24","group":{constant},"idempotencyKey":"{key}"}}',
            )
            self.assertEqual(rejected.status_code, 400, rejected.text)
            with self.bulk._db() as c:
                self.assertIsNone(c.execute("SELECT 1 FROM probe_server_import_jobs WHERE idempotency_key=?",
                                            (key,)).fetchone())
        at_limit = "😀" * 128
        accepted = self.client.post("/api/probe/server-import-jobs", headers=self.admin, json={
            "text": "192.0.2.21", "group": at_limit, "idempotencyKey": "group-at-limit",
        })
        self.assertEqual(accepted.status_code, 200, accepted.text)
        accepted_job = accepted.json()["jobId"]
        while self.bulk.get_import("admin", accepted_job)["state"] in {"queued", "running"}:
            self.assertTrue(self.bulk.run_once("group-limit-worker"))
        item_group_response = self.client.post("/api/probe/server-import-jobs", headers=self.admin, json={
            "text": '{"servers":[{"ip":"192.0.2.22","group":"' + ("x" * 129) + '"}]}',
            "idempotencyKey": "item-group-too-long",
        })
        self.assertEqual(item_group_response.status_code, 200, item_group_response.text)
        item_group_job = item_group_response.json()["jobId"]
        while self.bulk.get_import("admin", item_group_job)["state"] in {"queued", "running"}:
            self.assertTrue(self.bulk.run_once("item-group-worker"))
        self.assertEqual(self.bulk.get_import("admin", item_group_job)["failed"], 1)
        item_failures = self.client.get(
            f"/api/probe/server-import-jobs/{item_group_job}/failures", headers=self.admin,
        ).json()["items"]
        self.assertEqual(item_failures[0]["retryable"], False)
        self.assertEqual(self.client.post(
            f"/api/probe/server-import-jobs/{item_group_job}/retry-failed", headers=self.admin,
            json={"idempotencyKey": "retry-permanent-group-error"},
        ).status_code, 400)

        malformed = [
            '["192.0.2.30",,"192.0.2.31"]',
            '["192.0.2.32",]',
            '["192.0.2.33"] trailing',
            '{"servers":["192.0.2.34"],"extra":1,}',
            '["192.0.2.35",NaN]',
            '["192.0.2.36",Infinity]',
            '["192.0.2.37",-Infinity]',
            '{"ip":"192.0.2.38"}\n{"ip":NaN}',
            '{"servers":["192.0.2.39"],"servers":null}',
            '{"servers":"192.0.2.40"}',
        ]
        jobs = []
        for index, text in enumerate(malformed):
            response = self.client.post("/api/probe/server-import-jobs", headers=self.admin, json={
                "text": text, "idempotencyKey": f"malformed-{index}",
            })
            self.assertEqual(response.status_code, 200, response.text)
            jobs.append(response.json()["jobId"])
        for _ in jobs:
            self.assertTrue(self.bulk.run_once("strict-json-worker"))
        for job_id in jobs:
            status = self.client.get(f"/api/probe/server-import-jobs/{job_id}", headers=self.admin)
            self.assertEqual(status.json()["state"], "failed")
        self.assertEqual(self.assets.count_servers(ServerPageQuery()), 1)
        self.assertEqual(self.assets.query_servers(ServerPageQuery(q="192.0.2.3"))["items"], [])


if __name__ == "__main__":
    unittest.main()
