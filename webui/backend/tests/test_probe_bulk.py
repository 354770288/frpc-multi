import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from app.probe.bulk import LeaseLostError, ServerBulkStore, _parsed_import_pages
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

    def test_async_import_idempotency_invalid_and_duplicate_inputs(self):
        self.add("192.0.2.90")
        text = "192.0.2.90\n192.0.2.91\n192.0.2.91\nbad!invalid\n"
        job = self.bulk.create_import("alice", text, "edge", "import-once")
        replay = self.bulk.create_import("alice", text, "edge", "import-once")
        self.assertEqual(job["jobId"], replay["jobId"])
        with self.assertRaises(ValueError):
            self.bulk.create_import("alice", text + "192.0.2.92\n", "edge", "import-once")
        while self.bulk.get_import("alice", job["jobId"])["state"] in {"queued", "running"}:
            self.assertTrue(self.bulk.run_once("import-worker"))
        result = self.bulk.get_import("alice", job["jobId"])
        self.assertEqual(result["state"], "partial")
        self.assertEqual((result["total"], result["inserted"], result["skipped"], result["failed"]), (4, 1, 2, 1))
        failure = self.bulk.import_failures("alice", job["jobId"])
        self.assertEqual(failure["items"][0]["line"], 4)
        self.assertIn("地址", failure["items"][0]["error"])

    def test_async_import_json_page_parse_and_existing_asset_skip(self):
        self.add("198.51.100.10")
        job = self.bulk.create_import("alice", '{"servers":[{"ip":"198.51.100.10"},{"ip":"198.51.100.11","label":"edge"}]}', "", "json-import")
        while self.bulk.get_import("alice", job["jobId"])["state"] in {"queued", "running"}:
            self.assertTrue(self.bulk.run_once("json-worker"))
        result = self.bulk.get_import("alice", job["jobId"])
        self.assertEqual((result["state"], result["inserted"], result["skipped"]), ("done", 1, 1))
        row = self.assets.query_servers(ServerPageQuery(q="198.51.100.11"))["items"][0]
        self.assertEqual(self.assets.get_server(row["id"]).labels, ["edge"])

    def test_streamed_import_parser_rejects_repeated_or_non_array_servers(self):
        for text, message in (
            ('{"servers":["192.0.2.1"],"servers":null}', "重复"),
            ('{"servers":"192.0.2.1"}', "须为数组"),
            ('{"servers":null,"servers":["192.0.2.1"]}', None),
        ):
            with self.subTest(text=text):
                if message:
                    with self.assertRaisesRegex(ValueError, message):
                        list(_parsed_import_pages(text, ""))
                else:
                    with self.assertRaises(ValueError):
                        list(_parsed_import_pages(text, ""))

    def test_async_import_existing_asset_skip_preserves_existing_tag_relations(self):
        server_id = self.add("198.51.100.12", labels=("keep-tag",))
        before = {row[0] for row in self.assets._with_connection(
            lambda c: c.execute("SELECT tag_id FROM probe_server_tags WHERE server_id=?", (server_id,)).fetchall()
        )}
        job = self.bulk.create_import("alice", "198.51.100.12 incoming-label\n", "", "skip-tagged")
        while self.bulk.get_import("alice", job["jobId"])["state"] in {"queued", "running"}:
            self.assertTrue(self.bulk.run_once("tag-skip-worker"))
        after_server = self.assets.get_server(server_id)
        after = {row[0] for row in self.assets._with_connection(
            lambda c: c.execute("SELECT tag_id FROM probe_server_tags WHERE server_id=?", (server_id,)).fetchall()
        )}
        self.assertEqual(after_server.labels, ["keep-tag"])
        self.assertEqual(after, before)
        self.assertEqual(self.bulk.get_import("alice", job["jobId"])["skipped"], 1)

    def test_async_import_group_limits_and_max_group_staging_compaction(self):
        with self.assertRaises(ValueError):
            self.bulk.create_import("alice", "192.0.2.1", "x" * 129, "group-too-long")
        max_group = "😀" * 128
        self.assertEqual(len(max_group.encode("utf-8")), 512)
        job = self.bulk.create_import("alice", "192.0.2.1\n", max_group, "group-at-limit")
        self.assertTrue(self.bulk.run_once("group-worker"))
        with self.bulk._db() as c:
            stored_job = c.execute("SELECT default_group FROM probe_server_import_jobs WHERE id=?", (job["jobId"],)).fetchone()
            staged_group = c.execute("SELECT group_name FROM probe_server_import_items WHERE job_id=?", (job["jobId"],)).fetchone()
        self.assertEqual(stored_job[0], max_group)
        self.assertEqual(staged_group[0], "")
        while self.bulk.get_import("alice", job["jobId"])["state"] in {"queued", "running"}:
            self.assertTrue(self.bulk.run_once("group-worker"))
        self.assertEqual(self.assets.get_server(1).server_group, max_group)

    def test_async_import_permanent_failure_has_no_retry_job(self):
        job = self.bulk.create_import("alice", "bad!\n", "", "invalid-import")
        while self.bulk.get_import("alice", job["jobId"])["state"] in {"queued", "running"}:
            self.assertTrue(self.bulk.run_once("invalid-worker"))
        source = self.bulk.get_import("alice", job["jobId"])
        self.assertEqual(source["retryableFailed"], 0)
        with self.assertRaisesRegex(ValueError, "没有可重试"):
            self.bulk.retry_import_failures("alice", job["jobId"], "retry-invalid")
        self.assertEqual(self.bulk.import_failures("alice", job["jobId"])["items"][0]["retryable"], False)

    def test_async_import_retry_copies_only_retryable_rows(self):
        job = self.bulk.create_import("alice", "bad!\n192.0.2.44\n", "", "mixed-import-errors")
        self.assertTrue(self.bulk.run_once("mixed-import-worker"))
        with patch.object(ProbeStore, "import_servers_chunk", side_effect=RuntimeError("transient db error")):
            self.assertTrue(self.bulk.run_once("mixed-import-worker"))
        source = self.bulk.get_import("alice", job["jobId"])
        self.assertEqual((source["failed"], source["retryableFailed"]), (2, 1))
        failures = self.bulk.import_failures("alice", job["jobId"])["items"]
        self.assertEqual([row["retryable"] for row in failures], [False, True])

        retry = self.bulk.retry_import_failures("alice", job["jobId"], "retry-mixed-errors")
        again = self.bulk.retry_import_failures("alice", job["jobId"], "retry-mixed-errors")
        self.assertEqual(retry["jobId"], again["jobId"])
        with self.bulk._db() as c:
            rows = [dict(row) for row in c.execute("SELECT ordinal,ip,retryable FROM probe_server_import_items WHERE job_id=? ORDER BY ordinal",
                                                   (retry["jobId"],))]
        self.assertEqual(rows, [{"ordinal": 2, "ip": "192.0.2.44", "retryable": 1}])
        while self.bulk.get_import("alice", retry["jobId"])["state"] in {"queued", "running"}:
            self.assertTrue(self.bulk.run_once("mixed-import-retry-worker"))
        self.assertEqual((self.bulk.get_import("alice", retry["jobId"])["inserted"],
                          self.bulk.get_import("alice", retry["jobId"])["failed"]), (1, 0))
        self.assertEqual(len(self.bulk.import_failures("alice", job["jobId"])["items"]), 2)

    def test_async_import_recovers_durable_staging_after_worker_lease_expiry(self):
        job = self.bulk.create_import("alice", "203.0.113.80\n203.0.113.81\n", "", "recover-import")
        claimed = self.bulk._claim("dead-import-worker")
        self.assertEqual(claimed[0:2], ("import", job["jobId"]))
        self.bulk._stage_import(job["jobId"], "dead-import-worker", claimed[2])
        self.assertFalse(self.bulk.run_once("concurrent-import-worker"))
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_bulk_lease SET lease_until=0 WHERE id=1")
        while self.bulk.get_import("alice", job["jobId"])["state"] in {"queued", "running"}:
            self.assertTrue(self.bulk.run_once("replacement-import-worker"))
        result = self.bulk.get_import("alice", job["jobId"])
        self.assertEqual((result["state"], result["inserted"], result["failed"]), ("done", 2, 0))

    def test_async_import_100k_uses_bounded_asset_batches(self):
        text = "\n".join(
            f"10.{1 + i // 65024}.{(i // 254) % 256}.{i % 254 + 1}" for i in range(100_000)
        )
        max_group = "😀" * 128
        job = self.bulk.create_import("alice", text, max_group, "import-100k")
        runs = 0
        while self.bulk.get_import("alice", job["jobId"])["state"] in {"queued", "running"}:
            self.assertTrue(self.bulk.run_once("large-import-worker"))
            runs += 1
        result = self.bulk.get_import("alice", job["jobId"])
        self.assertEqual((result["state"], result["total"], result["inserted"], result["failed"]),
                         ("done", 100_000, 100_000, 0))
        self.assertGreater(runs, 300)
        with self.bulk._db() as c:
            staged_groups = c.execute("SELECT COUNT(*) FROM probe_server_import_items WHERE job_id=? AND group_name!=''",
                                       (job["jobId"],)).fetchone()[0]
        self.assertEqual(staged_groups, 0)
        self.assertEqual(self.assets.get_server(1).server_group, max_group)

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

    def test_import_cleanup_expires_terminal_history_and_protects_active_retry_chain(self):
        source = self.bulk.create_import("alice", "192.0.2.70\n", "", "cleanup-import-source")
        self.assertTrue(self.bulk.run_once("cleanup-import-worker"))
        with patch.object(ProbeStore, "import_servers_chunk", side_effect=RuntimeError("temporary insert error")):
            self.assertTrue(self.bulk.run_once("cleanup-import-worker"))
        old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_import_jobs SET updated_at=? WHERE id=?", (old, source["jobId"]))
        retry = self.bulk.retry_import_failures("alice", source["jobId"], "cleanup-import-retry")

        self.bulk.cleanup_once()
        with self.bulk._db() as c:
            self.assertIsNotNone(c.execute("SELECT 1 FROM probe_server_import_jobs WHERE id=?", (source["jobId"],)).fetchone())
            self.assertEqual(c.execute("SELECT COUNT(*) FROM probe_server_import_items WHERE job_id=?", (source["jobId"],)).fetchone()[0], 1)
            self.assertIsNotNone(c.execute("SELECT 1 FROM probe_server_import_jobs WHERE id=?", (retry["jobId"],)).fetchone())

        with self.bulk._db() as c:
            c.execute("UPDATE probe_server_import_jobs SET state='done',updated_at=? WHERE id=?", (old, retry["jobId"]))
        self.bulk.cleanup_once()
        with self.bulk._db() as c:
            for job_id in (source["jobId"], retry["jobId"]):
                self.assertIsNone(c.execute("SELECT 1 FROM probe_server_import_jobs WHERE id=?", (job_id,)).fetchone())
                self.assertEqual(c.execute("SELECT COUNT(*) FROM probe_server_import_items WHERE job_id=?", (job_id,)).fetchone()[0], 0)

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
