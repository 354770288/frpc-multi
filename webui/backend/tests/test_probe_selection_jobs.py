import json
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("PROJECT_DIR", tempfile.mkdtemp(prefix="probe-selection-jobs-"))

from app.control import database
from app.probe.bulk import ServerBulkStore
from app.probe.engine import ProbeOptions
from app.probe.jobs import ProbeJobStore
from app.probe.router import JobCreate, jobs_create
from app.probe.store import ProbeStore


class ProbeSelectionJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "console.db"
        self.jobs = ProbeJobStore(self.path)
        self.primary = self.jobs.create_node("primary")["id"]
        self.backup = self.jobs.create_node("backup")["id"]
        self.jobs.set_execution_policy(self.primary, [self.backup])
        self.assets = ProbeStore(self.path)
        self.bulk = ServerBulkStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def add_assets(self, count, start=1):
        return [self.assets.create_server(ip=f"198.18.{(value - 1) // 256}.{(value - 1) % 256}").id
                for value in range(start, start + count)]

    def selection(self, ids, owner="alice"):
        return self.bulk.create_selection(owner, ids=ids)

    def create_job(self, selection, *, mode="route", key="job-key", owner="alice", **kwargs):
        return self.jobs.create_primary_selection_job(
            owner, selection["selectionId"], mode, key, **kwargs,
        )

    def online(self, node_id, *, generation=True):
        features = ["task-generation-v1"] if generation else []
        return self.jobs.heartbeat(node_id, "test", ["discover", "route", "connectivity", "speed"], [], features)

    def expire_primary(self):
        with self.jobs._db() as c:
            c.execute("UPDATE probe_nodes SET last_seen=? WHERE id=?", (time.time() - 120, self.primary))
            self.jobs._expire(c)

    def test_owner_expiry_capability_and_fixed_port_validation(self):
        ids = self.add_assets(1)
        selection = self.selection(ids)
        with self.assertRaises(KeyError):
            self.create_job(selection, owner="bob")

        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_selections SET expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
                      (selection["selectionId"],))
        with self.assertRaisesRegex(ValueError, "过期"):
            self.create_job(selection)

        selection = self.selection(ids)
        with self.jobs._db() as c:
            c.execute("UPDATE probe_nodes SET capabilities='[\"route\"]' WHERE id=?", (self.primary,))
        with self.assertRaises(ValueError):
            self.create_job(selection, key="bad-policy")
        with self.assertRaisesRegex(ValueError, "固定为 7000"):
            self.create_job(selection, key="bad-port", port=7001)

    def test_selection_api_and_idempotency_survive_expiry_and_policy_change(self):
        selection = self.selection(self.add_assets(2))
        payload = JobCreate(mode="route", targetScope="selection", selectionId=selection["selectionId"],
                            idempotencyKey="api-key", nodeIds=[self.primary])
        # Other tests reload app.probe.router after removing it from sys.modules.
        # This imported function can then retain the old module globals while
        # `router` resolves to the newly loaded module object.
        with patch.dict(jobs_create.__globals__, {
            "job_store": lambda: self.jobs,
            "_effective_options": lambda: ProbeOptions(),
        }):
            created = jobs_create(payload, user="alice")
            self.assertEqual(created["targetTotal"], 2)
            self.assertEqual(created["targetMaterialized"], 0)
            self.assertEqual(created["taskTotal"], 0)
            with self.bulk._db() as c:
                c.execute("UPDATE probe_server_selections SET expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
                          (selection["selectionId"],))
            self.jobs.set_execution_policy(self.backup, [])
            repeated = jobs_create(payload, user="alice")
            self.assertEqual(repeated["id"], created["id"])
            self.bulk.cleanup_once()
            with self.bulk._db() as c:
                self.assertIsNotNone(c.execute("SELECT 1 FROM probe_server_selections WHERE id=?",
                                               (selection["selectionId"],)).fetchone())
            conflict = payload.model_copy(update={"mode": "speed"})
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as mismatch:
                jobs_create(conflict, user="alice")
            self.assertEqual(mismatch.exception.status_code, 409)

    def test_bounded_chunk_backlog_and_restart_cursor_no_duplicates(self):
        selection = self.selection(self.add_assets(1000))
        job = self.create_job(selection, key="bounded")
        self.online(self.primary)
        for _ in range(30):
            task = self.jobs.claim(self.primary)
            if task is None:
                break
        with self.jobs._db() as c:
            producer = c.execute("SELECT * FROM probe_job_producers WHERE job_id=?", (job["id"],)).fetchone()
            active = c.execute("SELECT COUNT(*) FROM probe_tasks WHERE job_id=? AND state IN ('pending','running','cancelling')",
                               (job["id"],)).fetchone()[0]
            task_count = c.execute("SELECT COUNT(*) FROM probe_tasks WHERE job_id=?", (job["id"],)).fetchone()[0]
        self.assertEqual(producer["materialized_count"], 500)
        self.assertLessEqual(active, 500)
        self.assertEqual(task_count, 500)

        # A restart resumes from the durable cursor and never duplicates an IP.
        another = self.selection(self.add_assets(600, start=2000))
        restart_job = self.create_job(another, key="restart")
        for _ in range(2):
            with self.jobs._db() as c:
                self.jobs._materialize_selection_chunk(c, self.primary, {"route"})
        restarted_store = ProbeJobStore(self.path)
        with restarted_store._db() as c:
            producer = c.execute("SELECT materialized_count,cursor_server_id FROM probe_job_producers WHERE job_id=?",
                                 (restart_job["id"],)).fetchone()
            rows = c.execute("SELECT ip,COUNT(*) n FROM probe_tasks WHERE job_id=? GROUP BY ip",
                             (restart_job["id"],)).fetchall()
        self.assertEqual(producer["materialized_count"], 500)
        self.assertEqual(len(rows), 500)
        self.assertTrue(all(row["n"] == 1 for row in rows))

    def test_refresh_waits_for_producer_then_completes_after_tasks(self):
        selection = self.selection(self.add_assets(300))
        job = self.create_job(selection, key="refresh")
        self.online(self.primary)
        task = self.jobs.claim(self.primary)
        self.assertIsNotNone(task)
        with self.jobs._db() as c:
            c.execute("UPDATE probe_tasks SET state='done' WHERE job_id=?", (job["id"],))
            self.jobs._refresh(c, [job["id"]])
            self.assertEqual(c.execute("SELECT state FROM probe_jobs WHERE id=?", (job["id"],)).fetchone()[0], "running")
            c.execute("UPDATE probe_job_producers SET state='done' WHERE job_id=?", (job["id"],))
            self.jobs._refresh(c, [job["id"]])
            self.assertEqual(c.execute("SELECT state FROM probe_jobs WHERE id=?", (job["id"],)).fetchone()[0], "done")

    def test_failover_moves_zero_task_producer_and_generates_backup_generation(self):
        selection = self.selection(self.add_assets(2))
        self.online(self.backup)
        job = self.create_job(selection, key="zero-task-failover")
        with self.jobs._db() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM probe_tasks WHERE job_id=?", (job["id"],)).fetchone()[0], 0)
        self.expire_primary()
        with self.jobs._db() as c:
            producer = c.execute("SELECT * FROM probe_job_producers WHERE job_id=?", (job["id"],)).fetchone()
            transfer = c.execute("SELECT * FROM probe_job_producer_transfers WHERE job_id=?", (job["id"],)).fetchone()
        self.assertEqual(producer["current_node_id"], self.backup)
        self.assertEqual(producer["generation"], 1)
        self.assertEqual(producer["cursor_server_id"], 0)
        self.assertEqual(transfer["to_node_id"], self.backup)
        task = self.jobs.claim(self.backup)
        self.assertEqual(task["nodeId"], self.backup)
        self.assertEqual(task["generation"], 1)
        self.assertEqual(task["port"], 7000)

    def test_partial_failover_respects_sweep_limit_and_keeps_task_ids_cursor(self):
        ids = self.add_assets(700, start=1)
        selection = self.selection(ids)
        self.online(self.backup)
        job = self.create_job(selection, key="sweep-failover")
        with self.jobs._db() as c:
            rows = c.execute("SELECT server_id,ip FROM probe_server_selection_members WHERE selection_id=? ORDER BY server_id LIMIT 600",
                             (selection["selectionId"],)).fetchall()
            for row in rows:
                self.jobs._task(c, job["id"], self.primary, "route", row["ip"], 7000)
            cursor = rows[-1]["server_id"]
            c.execute("UPDATE probe_job_producers SET cursor_server_id=?,materialized_count=600 WHERE job_id=?",
                      (cursor, job["id"]))
            before = {row[0] for row in c.execute("SELECT id FROM probe_tasks WHERE job_id=?", (job["id"],))}
            c.execute("UPDATE probe_nodes SET last_seen=? WHERE id=?", (time.time() - 120, self.primary))
            self.jobs._expire(c)
            first_pass = c.execute("SELECT COUNT(*) FROM probe_tasks WHERE job_id=? AND node_id=?",
                                   (job["id"], self.backup)).fetchone()[0]
            producer_cursor = c.execute("SELECT cursor_server_id FROM probe_job_producers WHERE job_id=?",
                                        (job["id"],)).fetchone()[0]
        self.assertEqual(first_pass, 500)
        self.assertEqual(producer_cursor, cursor)
        with self.jobs._db() as c:
            self.jobs._expire(c)
            after = {row[0] for row in c.execute("SELECT id FROM probe_tasks WHERE job_id=?", (job["id"],))}
            moved = c.execute("SELECT COUNT(*) FROM probe_tasks WHERE job_id=? AND node_id=?",
                              (job["id"], self.backup)).fetchone()[0]
        self.assertEqual(after, before)
        self.assertEqual(moved, 600)

    def test_no_backup_waiting_resumes_when_backup_comes_online(self):
        selection = self.selection(self.add_assets(2))
        job = self.create_job(selection, key="wait-resume")
        self.expire_primary()
        with self.jobs._db() as c:
            producer = c.execute("SELECT state,failover_waiting FROM probe_job_producers WHERE job_id=?", (job["id"],)).fetchone()
            self.assertEqual((producer["state"], producer["failover_waiting"]), ("waiting", 1))
            self.assertEqual(c.execute("SELECT state FROM probe_jobs WHERE id=?", (job["id"],)).fetchone()[0], "running")
        self.online(self.backup)
        with self.jobs._db() as c:
            producer = c.execute("SELECT current_node_id,generation,state FROM probe_job_producers WHERE job_id=?", (job["id"],)).fetchone()
        self.assertEqual((producer["current_node_id"], producer["generation"], producer["state"]),
                         (self.backup, 1, "running"))

    def test_stop_cleanup_expiry_whole_retry_and_task_only_retry(self):
        ids = self.add_assets(300, start=1)
        selection = self.selection(ids)
        self.online(self.primary)
        job = self.create_job(selection, key="stop-resume")
        self.jobs.claim(self.primary)
        with self.jobs._db() as c:
            before = c.execute("SELECT cursor_server_id FROM probe_job_producers WHERE job_id=?", (job["id"],)).fetchone()[0]
        self.jobs.action(job["id"], "stop")
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_selections SET expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
                      (selection["selectionId"],))
        self.bulk.cleanup_once()
        with self.bulk._db() as c:
            self.assertIsNotNone(c.execute("SELECT 1 FROM probe_server_selections WHERE id=?",
                                           (selection["selectionId"],)).fetchone())
        self.jobs.action(job["id"], "retry")
        with self.jobs._db() as c:
            producer = c.execute("SELECT state,cursor_server_id FROM probe_job_producers WHERE job_id=?", (job["id"],)).fetchone()
        self.assertEqual(producer["state"], "running")
        self.assertEqual(producer["cursor_server_id"], before)
        self.jobs.claim(self.primary)
        with self.jobs._db() as c:
            resumed = c.execute("SELECT materialized_count FROM probe_job_producers WHERE job_id=?", (job["id"],)).fetchone()[0]
        self.assertGreater(resumed, 250)

        other = self.selection(self.add_assets(300, start=1000))
        second = self.create_job(other, key="task-only-retry")
        self.jobs.claim(self.primary)
        self.jobs.action(second["id"], "stop")
        with self.jobs._db() as c:
            task_id = c.execute("SELECT id FROM probe_tasks WHERE job_id=? LIMIT 1", (second["id"],)).fetchone()[0]
            old_cursor = c.execute("SELECT cursor_server_id FROM probe_job_producers WHERE job_id=?", (second["id"],)).fetchone()[0]
        self.jobs.action(second["id"], "retry", [task_id])
        self.online(self.primary)
        self.jobs.claim(self.primary)
        with self.jobs._db() as c:
            producer = c.execute("SELECT state,cursor_server_id FROM probe_job_producers WHERE job_id=?", (second["id"],)).fetchone()
        self.assertEqual(producer["state"], "stopped")
        self.assertEqual(producer["cursor_server_id"], old_cursor)

    def test_delete_node_blocked_by_snapshot_policy_owner(self):
        selection = self.selection(self.add_assets(1))
        job = self.create_job(selection, key="owner-delete")
        replacement = self.jobs.create_node("replacement")["id"]
        self.jobs.set_execution_policy(replacement, [])
        with self.assertRaisesRegex(ValueError, "未完成的选择快照"):
            self.jobs.delete_node(self.primary)
        with self.jobs._db() as c:
            self.assertIsNotNone(c.execute("SELECT 1 FROM probe_job_producers WHERE job_id=?", (job["id"],)).fetchone())

    def test_owner_remains_protected_after_materialization_until_job_terminal(self):
        selection = self.selection(self.add_assets(1))
        self.online(self.primary)
        job = self.create_job(selection, key="owner-until-terminal")
        replacement = self.jobs.create_node("replacement-after-materialization")["id"]
        self.jobs.set_execution_policy(replacement, [])
        with self.jobs._db() as c:
            self.jobs._materialize_selection_chunk(c, self.primary, {"route"})
            producer = c.execute("SELECT state,materialized_count FROM probe_job_producers WHERE job_id=?",
                                 (job["id"],)).fetchone()
            self.assertEqual((producer["state"], producer["materialized_count"]), ("done", 1))
            self.assertEqual(c.execute("SELECT state FROM probe_jobs WHERE id=?", (job["id"],)).fetchone()[0], "running")
        with self.assertRaisesRegex(ValueError, "未完成的选择快照"):
            self.jobs.delete_node(self.primary)
        with self.jobs._db() as c:
            c.execute("UPDATE probe_tasks SET state='done' WHERE job_id=?", (job["id"],))
            self.jobs._refresh(c, [job["id"]])
        self.assertEqual(self.jobs.get_job(job["id"])["state"], "done")
        self.jobs.delete_node(self.primary)

    def test_whole_stop_retains_completed_producer_for_retry_window(self):
        selection = self.selection(self.add_assets(1))
        self.online(self.primary)
        job = self.create_job(selection, key="stop-completed-producer")
        with self.jobs._db() as c:
            self.jobs._materialize_selection_chunk(c, self.primary, {"route"})
            producer = c.execute("SELECT state,cursor_server_id FROM probe_job_producers WHERE job_id=?",
                                 (job["id"],)).fetchone()
            task_id = c.execute("SELECT id FROM probe_tasks WHERE job_id=?", (job["id"],)).fetchone()[0]
        self.assertEqual(producer["state"], "done")
        self.jobs.action(job["id"], "stop")
        replacement = self.jobs.create_node("replacement-after-stop")["id"]
        self.jobs.set_execution_policy(replacement, [])
        with self.jobs._db() as c:
            stopped = c.execute("SELECT state,cursor_server_id FROM probe_job_producers WHERE job_id=?",
                                 (job["id"],)).fetchone()
        self.assertEqual(stopped["state"], "stopped")
        self.assertEqual(stopped["cursor_server_id"], producer["cursor_server_id"])
        with self.assertRaisesRegex(ValueError, "未完成的选择快照"):
            self.jobs.delete_node(self.primary)

        self.jobs.action(job["id"], "retry")
        with self.jobs._db() as c:
            resumed = c.execute("SELECT state,cursor_server_id FROM probe_job_producers WHERE job_id=?",
                                (job["id"],)).fetchone()
            self.assertEqual(c.execute("SELECT state FROM probe_tasks WHERE id=?", (task_id,)).fetchone()[0], "pending")
        self.assertEqual(resumed["state"], "done")
        self.assertEqual(resumed["cursor_server_id"], producer["cursor_server_id"])
        with self.jobs._db() as c:
            c.execute("UPDATE probe_tasks SET state='done' WHERE id=?", (task_id,))
            self.jobs._refresh(c, [job["id"]])
        self.assertEqual(self.jobs.get_job(job["id"])["state"], "done")
        self.jobs.delete_node(self.primary)

    def test_100k_selection_generates_only_one_bounded_chunk(self):
        selection_id = "large-selection"
        with self.bulk._db() as c:
            c.execute("INSERT INTO probe_server_selections(id,owner,state,filters,created_at,updated_at,expires_at,count,processed,max_server_id) "
                      "VALUES(?,'alice','ready','{}','2026-10-24','2026-10-24','2099-01-01',100000,100000,100000)",
                      (selection_id,))
            c.execute("WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<100000) "
                      "INSERT INTO probe_server_selection_members(selection_id,server_id,ip) "
                      "SELECT ?,x,printf('198.%d.%d.%d',18+((x-1)/65536),((x-1)/256)%256,(x-1)%256) FROM seq",
                      (selection_id,))
        self.online(self.primary)
        job = self.jobs.create_primary_selection_job("alice", selection_id, "route", "large-100k")
        task = self.jobs.claim(self.primary)
        self.assertIsNotNone(task)
        detail = self.jobs.get_job(job["id"])
        self.assertEqual(detail["targetTotal"], 100000)
        self.assertEqual(detail["targetMaterialized"], 250)
        self.assertEqual(detail["taskTotal"], 250)

    def test_additive_schema_migration_creates_producer_tables_for_legacy_job_db(self):
        legacy = Path(self.tmp.name) / "legacy.db"
        raw = sqlite3.connect(legacy)
        try:
            raw.execute("CREATE TABLE probe_jobs(id TEXT PRIMARY KEY,mode TEXT NOT NULL,state TEXT NOT NULL,options TEXT NOT NULL,created_at TEXT NOT NULL)")
            raw.commit()
        finally:
            raw.close()
        database.initialize_database(legacy)
        connection = database.connect_database(legacy)
        try:
            tables = {row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            columns = {row[1] for row in connection.execute("PRAGMA table_info(probe_job_producers)")}
            indexes = {row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='probe_job_producers'")}
        finally:
            connection.close()
        self.assertIn("probe_job_producers", tables)
        self.assertIn("probe_job_producer_transfers", tables)
        self.assertTrue({"selection_id", "cursor_server_id", "generation", "current_node_id", "request_fingerprint"}.issubset(columns))
        self.assertIn("idx_probe_job_producers_owner_state", indexes)


if __name__ == "__main__":
    unittest.main()
