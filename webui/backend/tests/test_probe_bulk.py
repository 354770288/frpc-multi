import tempfile
import time
import unittest
from pathlib import Path

from app.probe.bulk import LeaseLostError, ServerBulkStore
from app.probe.store import ProbeStore, ServerPageQuery


class ProbeBulkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "console.db"
        self.assets = ProbeStore(self.path)
        self.bulk = ServerBulkStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, ip, group="", labels=()):
        return self.assets.create_server(ip=ip, labels=list(labels), server_group=group).id

    def test_owner_expiry_and_frozen_membership(self):
        first = self.add("192.0.2.1", "edge")
        selection = self.bulk.create_selection("alice", ids=[first])
        self.assertEqual(selection["state"], "ready")
        self.add("192.0.2.2", "edge")
        job = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "once")
        self.assertEqual(job["total"], 1)
        with self.bulk._db() as c:
            items_ready = c.execute("SELECT items_ready FROM probe_server_bulk_jobs WHERE id=?", (job["jobId"],)).fetchone()[0]
        self.assertEqual(items_ready, 0)
        with self.assertRaises(KeyError): self.bulk.get_selection("bob", selection["selectionId"])
        with self.assertRaises(KeyError): self.bulk.get_job("bob", job["jobId"])
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_selections SET expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
                      (selection["selectionId"],))
        self.assertEqual(self.bulk.get_selection("alice", selection["selectionId"])["state"], "expired")

    def test_all_matching_count_matches_filter_and_worker_recovery(self):
        self.add("192.0.2.11", "edge")
        self.add("192.0.2.12", "edge")
        self.add("192.0.2.13", "origin")
        filters = {"q": "192.0.2.", "group": "edge", "groupIds": [], "tagId": None,
                   "includeTagIds": [], "excludeTagIds": [], "tagMode": "any", "conn": "all"}
        selection = self.bulk.create_selection("alice", filters=filters)
        self.assertEqual(selection["state"], "queued")
        # A dead process leaves a durable queued build. Expiring its lease allows
        # a newly started worker to claim and complete it.
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_bulk_lease SET owner='dead-process',lease_until=0 WHERE id=1")
        self.assertTrue(self.bulk.run_once("replacement"))
        ready = self.bulk.get_selection("alice", selection["selectionId"])
        expected = self.assets.count_servers(ServerPageQuery(q="192.0.2.", group="edge"))
        self.assertEqual(ready["state"], "ready")
        self.assertEqual(ready["count"], expected)
        with self.bulk._db() as c:
            lease = c.execute("SELECT owner,lease_until FROM probe_server_bulk_lease WHERE id=1").fetchone()
        self.assertEqual(lease["owner"], "")
        self.assertEqual(lease["lease_until"], 0)

    def test_all_matching_label_matches_server_list_and_count(self):
        included = [self.add("192.0.2.41", labels=("north",)),
                    self.add("192.0.2.42", labels=("north", "transit"))]
        self.add("192.0.2.43", labels=("south",))
        query = ServerPageQuery(label="north")
        expected_list = self.assets.query_servers(query)
        expected_count = self.assets.count_servers(query)
        selection = self.bulk.create_selection("alice", filters={"label": "north"})
        while self.bulk.get_selection("alice", selection["selectionId"])["state"] in {"queued", "building"}:
            self.assertTrue(self.bulk.run_once("label-worker"))
        ready = self.bulk.get_selection("alice", selection["selectionId"])
        with self.bulk._db() as c:
            members = [row[0] for row in c.execute(
                "SELECT server_id FROM probe_server_selection_members WHERE selection_id=? ORDER BY server_id",
                (selection["selectionId"],))]
        list_ids = sorted(row["id"] for row in expected_list["items"])
        self.assertEqual(ready["count"], expected_count)
        self.assertEqual(members, list_ids)
        self.assertEqual(members, sorted(included))

    def test_all_matching_freezes_high_water_and_fails_on_prior_asset_mutation(self):
        first = self.add("192.0.2.31", "edge")
        selection = self.bulk.create_selection("alice", filters={"group": "edge"})
        later = self.add("192.0.2.32", "edge")
        while self.bulk.get_selection("alice", selection["selectionId"])["state"] in {"queued", "building"}:
            self.assertTrue(self.bulk.run_once("snapshot-worker"))
        ready = self.bulk.get_selection("alice", selection["selectionId"])
        self.assertEqual(ready["state"], "ready")
        with self.bulk._db() as c:
            members = [r[0] for r in c.execute("SELECT server_id FROM probe_server_selection_members WHERE selection_id=?",
                                                (selection["selectionId"],))]
        self.assertEqual(members, [first])
        self.assertNotIn(later, members)

        changing = self.bulk.create_selection("alice", filters={"group": "edge"})
        self.assets.update_server(first, server_group="origin")
        self.assertTrue(self.bulk.run_once("snapshot-worker"))
        failed = self.bulk.get_selection("alice", changing["selectionId"])
        self.assertEqual(failed["state"], "failed")
        self.assertIn("catalog changed", failed["error"])

    def test_bulk_job_sparse_materialization_does_not_finish_before_later_ranges(self):
        selection = self.bulk.create_selection("alice", ids=[])
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_selections SET max_server_id=20000,count=1 WHERE id=?",
                      (selection["selectionId"],))
            c.execute("INSERT INTO probe_server_selection_members(selection_id,server_id,ip) VALUES(?,15000,'fixture')",
                      (selection["selectionId"],))
        job = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "sparse-job")
        self.assertTrue(self.bulk.run_once("sparse-worker"))
        after_empty = self.bulk.get_job("alice", job["jobId"])
        self.assertEqual(after_empty["state"], "running")
        self.assertEqual(after_empty["processed"], 0)
        self.assertTrue(self.bulk.run_once("sparse-worker"))
        self.assertEqual(self.bulk.get_job("alice", job["jobId"])["processed"], 1)
        self.assertTrue(self.bulk.run_once("sparse-worker"))
        self.assertEqual(self.bulk.get_job("alice", job["jobId"])["state"], "done")

    def test_idempotent_submission_and_no_work_releases_global_lease(self):
        selection = self.bulk.create_selection("alice", ids=[self.add("192.0.2.21")])
        first = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "key-1")
        again = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "key-1")
        self.assertEqual(first["jobId"], again["jobId"])
        self.assertTrue(self.bulk.run_once("worker"))
        self.assertTrue(self.bulk.run_once("worker"))
        self.assertFalse(self.bulk.run_once("worker"))
        with self.bulk._db() as c:
            lease = c.execute("SELECT owner,lease_until FROM probe_server_bulk_lease WHERE id=1").fetchone()
        self.assertEqual((lease["owner"], lease["lease_until"]), ("", 0))
        self.assertEqual(self.bulk.get_job("alice", first["jobId"])["state"], "done")

    def test_two_workers_exclude_each_other_and_expired_lease_recovers(self):
        server_id = self.add("203.0.113.9")
        selection = self.bulk.create_selection("alice", ids=[server_id])
        job = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "worker-test")
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_bulk_lease SET owner='worker-one',lease_until=? WHERE id=1",
                      (time.time() + 60,))
        self.assertFalse(self.bulk.run_once("worker-two"))
        self.assertEqual(self.bulk.get_job("alice", job["jobId"])["state"], "queued")
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_bulk_lease SET lease_until=0 WHERE id=1")
        # The asset disappeared after the snapshot. Replaying delete is still a
        # successful idempotent operation, and the expired worker lease recovers.
        self.assets.delete_server(server_id)
        self.assertTrue(self.bulk.run_once("worker-two"))
        self.assertTrue(self.bulk.run_once("worker-two"))
        self.assertEqual(self.bulk.get_job("alice", job["jobId"])["state"], "done")

    def test_chunk_delete_is_idempotent_and_cascades_tag_relations(self):
        server_id = self.add("203.0.113.10", labels=("bulk-tag",))
        selection = self.bulk.create_selection("alice", ids=[server_id])
        job = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "cascade-delete")
        self.assertTrue(self.bulk.run_once("worker"))
        self.assertTrue(self.bulk.run_once("worker"))
        self.assertEqual(self.bulk.get_job("alice", job["jobId"])["state"], "done")
        self.assertEqual(self.assets.delete_servers_batch([server_id]), 0)
        with self.bulk._db() as c:
            relations = c.execute("SELECT COUNT(*) FROM probe_server_tags WHERE server_id=?", (server_id,)).fetchone()[0]
        self.assertEqual(relations, 0)

    def test_update_marks_snapshot_target_deleted_before_execution_as_failed(self):
        server_id = self.add("203.0.113.11")
        selection = self.bulk.create_selection("alice", ids=[server_id])
        self.assets.delete_server(server_id)
        job = self.bulk.submit_job("alice", selection["selectionId"], "update", {"group": "edge"}, "missing-update")
        self.assertTrue(self.bulk.run_once("worker"))
        self.assertTrue(self.bulk.run_once("worker"))
        self.assertEqual(self.bulk.get_job("alice", job["jobId"])["state"], "failed")
        self.assertEqual(self.bulk.failures("alice", job["jobId"])["items"][0]["serverId"], server_id)

    def test_stale_worker_token_cannot_materialize_or_mutate(self):
        server_id = self.add("203.0.113.12")
        selection = self.bulk.create_selection("alice", ids=[server_id])
        job = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "stale-worker")
        claimed = self.bulk._claim("old-worker")
        self.assertEqual(claimed[1], job["jobId"])
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_bulk_lease SET owner='new-worker',token='new-token',lease_until=? WHERE id=1",
                      (time.time() + 60,))
        with self.assertRaises(LeaseLostError):
            self.bulk._process_job(job["jobId"], "old-worker", claimed[2])
        self.assertEqual(self.assets.get_server(server_id).id, server_id)
        with self.bulk._db() as c:
            materialized = c.execute("SELECT items_ready FROM probe_server_bulk_jobs WHERE id=?", (job["jobId"],)).fetchone()[0]
            items = c.execute("SELECT COUNT(*) FROM probe_server_bulk_items WHERE job_id=?", (job["jobId"],)).fetchone()[0]
        self.assertEqual((materialized, items), (0, 0))

    def test_cleanup_is_bounded_and_preserves_selection_for_active_job(self):
        server_id = self.add("203.0.113.13")
        selection = self.bulk.create_selection("alice", ids=[server_id])
        job = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "retention-job")
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_selections SET expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
                      (selection["selectionId"],))
        self.bulk.cleanup_once()
        with self.bulk._db() as c:
            active_selection = c.execute("SELECT 1 FROM probe_server_selections WHERE id=?",
                                         (selection["selectionId"],)).fetchone()
            membership = c.execute("SELECT 1 FROM probe_server_selection_members WHERE selection_id=?",
                                  (selection["selectionId"],)).fetchone()
        self.assertIsNotNone(active_selection)
        self.assertIsNotNone(membership)
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_bulk_jobs SET state='failed',updated_at='2000-01-01T00:00:00+00:00' WHERE id=?",
                      (job["jobId"],))
            c.execute("INSERT INTO probe_server_bulk_items(job_id,ordinal,server_id,ip,state) VALUES(?,?,?,?,'failed')",
                      (job["jobId"], server_id, server_id, "203.0.113.13"))
        self.bulk.cleanup_once()
        with self.bulk._db() as c:
            self.assertIsNone(c.execute("SELECT 1 FROM probe_server_bulk_jobs WHERE id=?", (job["jobId"],)).fetchone())
            self.assertIsNone(c.execute("SELECT 1 FROM probe_server_selections WHERE id=?", (selection["selectionId"],)).fetchone())

    def test_failures_are_paged_and_retry_copies_only_failed_source_operation(self):
        ids = [self.add(f"198.51.100.{n}") for n in (1, 2, 3)]
        selection = self.bulk.create_selection("alice", ids=ids)
        source = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "delete-original")
        with self.assertRaisesRegex(ValueError, "已结束"):
            self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "retry-running", retry_of=source["jobId"])
        # Inject one durable item failure to exercise retry pagination without
        # depending on an infrastructure error from a SQLite fixture.
        with self.bulk._db() as c:
            c.execute("INSERT INTO probe_server_bulk_items(job_id,ordinal,server_id,ip) "
                      "SELECT ?,row_number() OVER (ORDER BY server_id),server_id,ip "
                      "FROM probe_server_selection_members WHERE selection_id=?",
                      (source["jobId"], selection["selectionId"]))
            c.execute("UPDATE probe_server_bulk_jobs SET items_ready=1 WHERE id=?", (source["jobId"],))
            c.execute("UPDATE probe_server_bulk_items SET state='failed',error='fixture failure' WHERE job_id=? AND ordinal=2",
                      (source["jobId"],))
            c.execute("UPDATE probe_server_bulk_jobs SET total=3,processed=1,failed=1 WHERE id=?", (source["jobId"],))
            c.execute("UPDATE probe_server_bulk_jobs SET state='partial' WHERE id=?", (source["jobId"],))
        page = self.bulk.failures("alice", source["jobId"], limit=1)
        self.assertEqual(len(page["items"]), 1)
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_selections SET expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
                      (selection["selectionId"],))
        self.bulk.cleanup_once()
        with self.bulk._db() as c:
            self.assertIsNone(c.execute("SELECT 1 FROM probe_server_selections WHERE id=?",
                                        (selection["selectionId"],)).fetchone())
        retry = self.bulk.submit_job("alice", selection["selectionId"], "update", {"group": "ignored"},
                                     "retry-key", retry_of=source["jobId"])
        self.assertEqual(retry["operation"], "delete")
        self.assertEqual(retry["total"], 1)
        with self.bulk._db() as c:
            before_worker = c.execute("SELECT COUNT(*) FROM probe_server_bulk_items WHERE job_id=?", (retry["jobId"],)).fetchone()[0]
        self.assertEqual(before_worker, 0)
        self.assertTrue(self.bulk.run_once("retry-worker"))
        with self.bulk._db() as c:
            copied = c.execute("SELECT COUNT(*) FROM probe_server_bulk_items WHERE job_id=?", (retry["jobId"],)).fetchone()[0]
            payload = c.execute("SELECT payload FROM probe_server_bulk_jobs WHERE id=?", (retry["jobId"],)).fetchone()[0]
        self.assertEqual(copied, 1)
        self.assertEqual(payload, "{}")

    def test_idempotency_key_rejects_different_request(self):
        selection = self.bulk.create_selection("alice", ids=[])
        self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "same-key")
        with self.assertRaisesRegex(ValueError, "不同的请求"):
            self.bulk.submit_job("alice", selection["selectionId"], "update", {"group": "edge"}, "same-key")

    def test_cleanup_retains_failed_source_items_while_retry_is_active(self):
        ids = [self.add(f"198.51.100.{n}") for n in (21, 22)]
        selection = self.bulk.create_selection("alice", ids=ids)
        source = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "retained-source")
        with self.bulk._db() as c:
            c.execute("INSERT INTO probe_server_bulk_items(job_id,ordinal,server_id,ip,state,error) "
                      "SELECT ?,server_id,server_id,ip,CASE WHEN server_id=? THEN 'failed' ELSE 'done' END,'fixture' "
                      "FROM probe_server_selection_members WHERE selection_id=?",
                      (source["jobId"], ids[1], selection["selectionId"]))
            c.execute("UPDATE probe_server_bulk_jobs SET items_ready=1,state='partial',total=2,processed=2,succeeded=1,failed=1,updated_at='2000-01-01T00:00:00+00:00' WHERE id=?",
                      (source["jobId"],))
        retry = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "active-retry",
                                     retry_of=source["jobId"])
        self.bulk.cleanup_once()
        with self.bulk._db() as c:
            source_row = c.execute("SELECT 1 FROM probe_server_bulk_jobs WHERE id=?", (source["jobId"],)).fetchone()
            failed_source = c.execute("SELECT COUNT(*) FROM probe_server_bulk_items WHERE job_id=? AND state='failed'",
                                      (source["jobId"],)).fetchone()[0]
        self.assertIsNotNone(source_row)
        self.assertEqual(failed_source, 1)
        self.assertTrue(self.bulk.run_once("retry-worker"))
        with self.bulk._db() as c:
            retry_items = [dict(row) for row in c.execute("SELECT server_id,state FROM probe_server_bulk_items WHERE job_id=?",
                                                           (retry["jobId"],))]
        self.assertEqual(retry_items, [{"server_id": ids[1], "state": "done"}])

    def test_100k_selection_uses_sql_materialization(self):
        with self.bulk._db() as c:
            c.execute("WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<100000) "
                      "INSERT INTO probe_servers(ip,ip_sort,label,server_group,created_at) "
                      "SELECT 'asset-'||x,NULL,'','edge','2026-10-23' FROM seq")
        selection = self.bulk.create_selection("alice", filters={"q": "asset-", "conn": "all"})
        while self.bulk.get_selection("alice", selection["selectionId"])["state"] in {"queued", "building"}:
            self.assertTrue(self.bulk.run_once("worker"))
        result = self.bulk.get_selection("alice", selection["selectionId"])
        self.assertEqual(result["count"], 100_000)
        with self.bulk._db() as c:
            count = c.execute("SELECT COUNT(*) FROM probe_server_selection_members WHERE selection_id=?",
                              (selection["selectionId"],)).fetchone()[0]
        self.assertEqual(count, 100_000)
        job = self.bulk.submit_job("alice", selection["selectionId"], "delete", {}, "delete-100k")
        with self.bulk._db() as c:
            state = c.execute("SELECT items_ready FROM probe_server_bulk_jobs WHERE id=?", (job["jobId"],)).fetchone()[0]
            prebuilt = c.execute("SELECT COUNT(*) FROM probe_server_bulk_items WHERE job_id=?", (job["jobId"],)).fetchone()[0]
        self.assertEqual((state, prebuilt), (0, 0))
        for _ in range(10):
            self.assertTrue(self.bulk.run_once("bulk-worker"))
        with self.bulk._db() as c:
            materialized = c.execute("SELECT COUNT(*) FROM probe_server_bulk_items WHERE job_id=?", (job["jobId"],)).fetchone()[0]
        self.assertEqual(materialized, 100_000)


if __name__ == "__main__":
    unittest.main()
