"""Durable large server selections and bulk operations."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..control.database import connect_database, initialize_database
from ..models import now_iso
from .store import ProbeStore, ServerPageQuery

SELECTION_TTL_HOURS = 24
MAX_SELECTION_IDS = 5_000
MAX_FILTER_IDS = 300
BULK_CHUNK_SIZE = 250
SELECTION_BUILD_RANGE = 10_000
RETAIN_TERMINAL_DAYS = 7
MAINTENANCE_BATCH_SIZE = 10_000
LEASE_SECONDS = 30


class LeaseLostError(RuntimeError):
    pass


def _stamp_after(hours=SELECTION_TTL_HOURS):
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def _filters_query(filters):
    return ServerPageQuery(
        q=filters.get("q", ""), group=filters.get("group"),
        group_ids=tuple(filters.get("groupIds", ())), tag_id=filters.get("tagId"),
        include_tag_ids=tuple(filters.get("includeTagIds", ())),
        exclude_tag_ids=tuple(filters.get("excludeTagIds", ())),
        tag_mode=filters.get("tagMode", "any"), conn=filters.get("conn", "all"),
    )


class ServerBulkStore:
    def __init__(self, database_path: Path):
        self.database_path = Path(database_path)
        initialize_database(self.database_path)

    def _db(self, immediate=True):
        c = connect_database(self.database_path)
        c.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        return c

    @staticmethod
    def _assert_lease(connection, worker_id, token):
        row = connection.execute(
            "SELECT 1 FROM probe_server_bulk_lease WHERE id=1 AND owner=? AND token=? AND lease_until>?",
            (worker_id, token, time.time()),
        ).fetchone()
        if row is None:
            raise LeaseLostError("bulk worker lease lost")

    @staticmethod
    def _selection_view(row, count=None):
        return {"selectionId": row["id"], "state": row["state"],
                "count": row["count"] if count is None else count,
                "processed": row["processed"], "createdAt": row["created_at"],
                "updatedAt": row["updated_at"], "expiresAt": row["expires_at"],
                "error": row["error"]}

    def create_selection(self, owner, *, ids=None, filters=None):
        selection_id = str(uuid.uuid4())
        now = now_iso()
        conn = self._db()
        try:
            if ids is not None:
                if not isinstance(ids, list) or len(ids) > MAX_SELECTION_IDS:
                    raise ValueError("ids 最多支持 5000 个服务器")
                unique = list(dict.fromkeys(int(value) for value in ids))
                if any(value < 1 for value in unique):
                    raise ValueError("服务器 ID 无效")
                conn.execute("INSERT INTO probe_server_selections(id,owner,state,filters,created_at,updated_at,expires_at) VALUES(?,?,'building','{}',?,?,?)",
                             (selection_id, owner, now, now, _stamp_after()))
                for offset in range(0, len(unique), 500):
                    chunk = unique[offset:offset + 500]
                    placeholders = ",".join("?" for _ in chunk)
                    conn.execute(f"INSERT INTO probe_server_selection_members(selection_id,server_id,ip) SELECT ?,id,ip FROM probe_servers WHERE id IN ({placeholders})",
                                 (selection_id, *chunk))
                count = conn.execute("SELECT COUNT(*) FROM probe_server_selection_members WHERE selection_id=?", (selection_id,)).fetchone()[0]
                max_id = conn.execute("SELECT COALESCE(MAX(server_id),0) FROM probe_server_selection_members WHERE selection_id=?",
                                      (selection_id,)).fetchone()[0]
                conn.execute("UPDATE probe_server_selections SET state='ready',count=?,processed=?,max_server_id=?,updated_at=? WHERE id=?",
                             (count, count, max_id, now_iso(), selection_id))
            else:
                query = _filters_query(filters or {})
                normalized = {"q": query.q.strip(), "group": query.group,
                              "groupIds": list(dict.fromkeys(query.group_ids)), "tagId": query.tag_id,
                              "includeTagIds": list(dict.fromkeys(query.include_tag_ids)),
                              "excludeTagIds": list(dict.fromkeys(query.exclude_tag_ids)),
                              "tagMode": query.tag_mode, "conn": query.conn}
                max_server_id = int(conn.execute("SELECT COALESCE(MAX(id),0) FROM probe_servers").fetchone()[0])
                revision = int(conn.execute("SELECT revision FROM probe_server_catalog_revision WHERE id=1").fetchone()[0])
                conn.execute("INSERT INTO probe_server_selections(id,owner,state,filters,created_at,updated_at,expires_at,max_server_id,catalog_revision) VALUES(?,?,'queued',?,?,?,?,?,?)",
                             (selection_id, owner, json.dumps(normalized), now, now, _stamp_after(), max_server_id, revision))
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()
        return self.get_selection(owner, selection_id)

    def get_selection(self, owner, selection_id):
        c = connect_database(self.database_path)
        try:
            row = c.execute("SELECT * FROM probe_server_selections WHERE id=? AND owner=?", (selection_id, owner)).fetchone()
            if row is None:
                raise KeyError(selection_id)
            if row["state"] not in {"expired", "failed"} and row["expires_at"] <= now_iso():
                c.execute("UPDATE probe_server_selections SET state='expired',updated_at=? WHERE id=? AND owner=?", (now_iso(), selection_id, owner))
                c.commit()
                row = c.execute("SELECT * FROM probe_server_selections WHERE id=?", (selection_id,)).fetchone()
            return self._selection_view(row)
        finally:
            c.close()

    def submit_job(self, owner, selection_id, operation, payload, idempotency_key, *, retry_of=None):
        if operation not in {"update", "delete"}:
            raise ValueError("operation 须为 update/delete")
        if not idempotency_key or len(idempotency_key) > 200:
            raise ValueError("idempotencyKey 无效")
        if not isinstance(payload, dict) or len(json.dumps(payload)) > 65_536:
            raise ValueError("payload 无效或过大")
        conn = self._db()
        try:
            existing = conn.execute("SELECT * FROM probe_server_bulk_jobs WHERE owner=? AND idempotency_key=?", (owner, idempotency_key)).fetchone()
            if existing:
                same_request = existing["selection_id"] == selection_id and existing["retry_of"] == retry_of
                if retry_of is None:
                    same_request = same_request and existing["operation"] == operation and json.loads(existing["payload"]) == payload
                if not same_request:
                    raise ValueError("idempotencyKey 已用于不同的请求")
                return self._job_view(existing)
            if retry_of:
                source = conn.execute("SELECT id,selection_id,operation,payload,state,failed FROM probe_server_bulk_jobs WHERE id=? AND owner=?", (retry_of, owner)).fetchone()
                if source is None or source["selection_id"] != selection_id:
                    raise KeyError(retry_of)
                if source["state"] not in {"done", "partial", "failed"}:
                    raise ValueError("只有已结束的批量任务可以重试")
                if int(source["failed"]) == 0:
                    raise ValueError("原批量任务没有失败项")
                failed_count = conn.execute("SELECT COUNT(*) FROM probe_server_bulk_items WHERE job_id=? AND state='failed'", (retry_of,)).fetchone()[0]
                if failed_count == 0:
                    raise ValueError("原批量任务没有失败项")
                operation, payload = source["operation"], json.loads(source["payload"])
            else:
                failed_count = None
            selection = None
            if retry_of is None:
                selection = conn.execute("SELECT * FROM probe_server_selections WHERE id=? AND owner=?", (selection_id, owner)).fetchone()
                if selection is None:
                    raise KeyError(selection_id)
                if selection["state"] != "ready" or selection["expires_at"] <= now_iso():
                    raise ValueError("选择快照尚未就绪或已过期")
            job_id = str(uuid.uuid4())
            canonical_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            if retry_of:
                conn.execute("INSERT INTO probe_server_bulk_jobs(id,owner,selection_id,operation,payload,idempotency_key,state,total,created_at,updated_at,retry_of) VALUES(?,?,?,?,?,?,'queued',?,?,?,?)",
                             (job_id, owner, selection_id, operation, canonical_payload, idempotency_key, failed_count, now_iso(), now_iso(), retry_of))
            else:
                count = int(selection["count"])
                conn.execute("INSERT INTO probe_server_bulk_jobs(id,owner,selection_id,operation,payload,idempotency_key,state,total,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?)",
                             (job_id, owner, selection_id, operation, canonical_payload, idempotency_key, count, now_iso(), now_iso()))
            conn.commit()
            return self.get_job(owner, job_id)
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def _job_view(row):
        return {"jobId": row["id"], "selectionId": row["selection_id"], "operation": row["operation"],
                "state": row["state"], "total": row["total"], "processed": row["processed"],
                "succeeded": row["succeeded"], "failed": row["failed"], "createdAt": row["created_at"],
                "updatedAt": row["updated_at"], "error": row["error"], "retryOf": row["retry_of"]}

    def get_job(self, owner, job_id):
        c = connect_database(self.database_path)
        try:
            row = c.execute("SELECT * FROM probe_server_bulk_jobs WHERE id=? AND owner=?", (job_id, owner)).fetchone()
            if row is None:
                raise KeyError(job_id)
            return self._job_view(row)
        finally:
            c.close()

    def failures(self, owner, job_id, *, cursor=0, limit=100):
        limit = min(500, max(1, int(limit)))
        try: cursor = max(0, int(cursor))
        except (TypeError, ValueError): cursor = 0
        c = connect_database(self.database_path)
        try:
            if c.execute("SELECT 1 FROM probe_server_bulk_jobs WHERE id=? AND owner=?", (job_id, owner)).fetchone() is None:
                raise KeyError(job_id)
            rows = c.execute("SELECT ordinal,server_id AS serverId,ip,error FROM probe_server_bulk_items WHERE job_id=? AND state='failed' AND ordinal>? ORDER BY ordinal LIMIT ?", (job_id, cursor, limit)).fetchall()
            return {"items": [dict(r) for r in rows], "nextCursor": rows[-1]["ordinal"] if len(rows) == limit else None}
        finally: c.close()

    def cleanup_once(self, *, now=None):
        """Make bounded retention progress without deleting targets held by active jobs."""
        now = now or datetime.now(timezone.utc)
        now_stamp = now.isoformat()
        cutoff = (now - timedelta(days=RETAIN_TERMINAL_DAYS)).isoformat()
        c = self._db()
        try:
            # Mark a bounded set of expired snapshots, then trim no more than one
            # 10k-member page per pass. Keep membership while any job is active.
            expired = c.execute(
                "SELECT id FROM probe_server_selections WHERE expires_at<=? "
                "AND state NOT IN ('expired','failed') ORDER BY expires_at LIMIT 100", (now_stamp,)
            ).fetchall()
            for row in expired:
                c.execute("UPDATE probe_server_selections SET state='expired',updated_at=? WHERE id=?",
                          (now_stamp, row["id"]))
            # Old terminal result detail is retained for seven days. Remove item
            # rows in a bounded page before deleting their parent job.
            c.execute(
                "DELETE FROM probe_server_bulk_items WHERE rowid IN ("
                "SELECT i.rowid FROM probe_server_bulk_items i JOIN probe_server_bulk_jobs j ON j.id=i.job_id "
                "WHERE j.state IN ('done','partial','failed') AND j.updated_at<? "
                "AND NOT EXISTS(SELECT 1 FROM probe_server_bulk_jobs r WHERE r.retry_of=j.id AND r.state IN ('queued','running')) "
                "ORDER BY j.updated_at,i.ordinal LIMIT ?)", (cutoff, MAINTENANCE_BATCH_SIZE)
            )
            c.execute(
                "DELETE FROM probe_server_bulk_jobs WHERE id IN ("
                "SELECT j.id FROM probe_server_bulk_jobs j WHERE j.state IN ('done','partial','failed') "
                "AND j.updated_at<? AND NOT EXISTS(SELECT 1 FROM probe_server_bulk_items i WHERE i.job_id=j.id) "
                "AND NOT EXISTS(SELECT 1 FROM probe_server_bulk_jobs r WHERE r.retry_of=j.id AND r.state IN ('queued','running')) "
                "ORDER BY j.updated_at LIMIT 100)", (cutoff,)
            )
            candidate = c.execute(
                "SELECT s.id FROM probe_server_selections s WHERE "
                "(s.state='expired' OR (s.state='failed' AND (s.updated_at<? OR s.expires_at<=?))) "
                "AND NOT EXISTS(SELECT 1 FROM probe_server_bulk_jobs j WHERE j.selection_id=s.id AND j.state IN ('queued','running')) "
                "ORDER BY s.expires_at LIMIT 1", (cutoff, now_stamp)
            ).fetchone()
            if candidate:
                selection_id = candidate["id"]
                c.execute("DELETE FROM probe_server_selection_members WHERE rowid IN ("
                          "SELECT rowid FROM probe_server_selection_members WHERE selection_id=? LIMIT ?)",
                          (selection_id, MAINTENANCE_BATCH_SIZE))
                remaining = c.execute("SELECT 1 FROM probe_server_selection_members WHERE selection_id=? LIMIT 1",
                                      (selection_id,)).fetchone()
                if remaining is None:
                    c.execute("DELETE FROM probe_server_selections WHERE id=?", (selection_id,))
            c.commit()
            return bool(expired or candidate)
        except BaseException:
            c.rollback()
            raise
        finally:
            c.close()

    def _claim(self, worker_id):
        c = self._db()
        try:
            lease = c.execute("SELECT owner,lease_until FROM probe_server_bulk_lease WHERE id=1").fetchone()
            if lease["lease_until"] > time.time():
                c.rollback(); return None
            token = str(uuid.uuid4())
            c.execute("UPDATE probe_server_bulk_lease SET owner=?,token=?,lease_until=? WHERE id=1",
                      (worker_id, token, time.time()+LEASE_SECONDS))
            row = c.execute("SELECT id,state FROM probe_server_selections WHERE state IN ('queued','building') ORDER BY created_at LIMIT 1").fetchone()
            kind = "selection"
            if row is None:
                row = c.execute("SELECT id,state FROM probe_server_bulk_jobs WHERE state IN ('queued','running') ORDER BY created_at LIMIT 1").fetchone()
                kind = "job"
            if row is None:
                c.execute("UPDATE probe_server_bulk_lease SET owner='',token='',lease_until=0 WHERE id=1 AND owner=? AND token=?",
                          (worker_id, token))
            c.commit()
            return (kind, row["id"], token) if row else None
        except BaseException:
            c.rollback(); raise
        finally: c.close()

    def _build(self, selection_id, worker_id, token):
        c = self._db()
        try:
            self._assert_lease(c, worker_id, token)
            row = c.execute("SELECT * FROM probe_server_selections WHERE id=? AND state IN ('queued','building')", (selection_id,)).fetchone()
            if row is None:
                c.rollback(); return
            if row["expires_at"] <= now_iso():
                c.execute("UPDATE probe_server_selections SET state='expired',error='selection expired during build',updated_at=? WHERE id=?", (now_iso(), selection_id))
                c.execute("DELETE FROM probe_server_selection_members WHERE rowid IN (SELECT rowid FROM probe_server_selection_members WHERE selection_id=? LIMIT ?)",
                          (selection_id, MAINTENANCE_BATCH_SIZE))
                c.commit(); return
            revision = c.execute("SELECT revision FROM probe_server_catalog_revision WHERE id=1").fetchone()[0]
            if revision != row["catalog_revision"]:
                c.execute("UPDATE probe_server_selections SET state='failed',error='asset catalog changed during selection build',updated_at=? WHERE id=?",
                          (now_iso(), selection_id))
                c.execute("DELETE FROM probe_server_selection_members WHERE rowid IN (SELECT rowid FROM probe_server_selection_members WHERE selection_id=? LIMIT ?)",
                          (selection_id, MAINTENANCE_BATCH_SIZE))
                c.commit(); return
            filters = json.loads(row["filters"])
            query = _filters_query(filters)
            store = ProbeStore(self.database_path)
            where, params = store._server_where(query)
            source = store._server_count_from_sql(query)
            c.execute("UPDATE probe_server_selections SET state='building',updated_at=? WHERE id=?", (now_iso(), selection_id))
            upper = min(int(row["max_server_id"]), int(row["build_cursor"]) + SELECTION_BUILD_RANGE)
            bounded_where = where + (" AND " if where else " WHERE ") + "s.id>? AND s.id<=?"
            inserted = c.execute("INSERT INTO probe_server_selection_members(selection_id,server_id,ip) SELECT ?,s.id,s.ip " + source + bounded_where,
                                 (selection_id, *params, int(row["build_cursor"]), upper)).rowcount
            processed = int(row["processed"]) + max(0, int(inserted))
            if upper >= int(row["max_server_id"]):
                # BEGIN IMMEDIATE keeps the revision stable through this final check and READY transition.
                final_revision = c.execute("SELECT revision FROM probe_server_catalog_revision WHERE id=1").fetchone()[0]
                if final_revision != row["catalog_revision"]:
                    c.execute("UPDATE probe_server_selections SET state='failed',processed=?,error='asset catalog changed during selection build',updated_at=? WHERE id=?",
                              (processed, now_iso(), selection_id))
                    c.execute("DELETE FROM probe_server_selection_members WHERE rowid IN (SELECT rowid FROM probe_server_selection_members WHERE selection_id=? LIMIT ?)",
                              (selection_id, MAINTENANCE_BATCH_SIZE))
                else:
                    c.execute("UPDATE probe_server_selections SET state='ready',count=?,processed=?,build_cursor=?,updated_at=? WHERE id=?",
                              (processed, processed, upper, now_iso(), selection_id))
            else:
                c.execute("UPDATE probe_server_selections SET processed=?,build_cursor=?,updated_at=? WHERE id=?",
                          (processed, upper, now_iso(), selection_id))
            c.commit()
        except BaseException as exc:
            c.rollback()
            if not isinstance(exc, LeaseLostError):
                e = self._db()
                try:
                    self._assert_lease(e, worker_id, token)
                    e.execute("UPDATE probe_server_selections SET state='failed',error=?,updated_at=? WHERE id=? AND state IN ('queued','building')",
                              (str(exc)[:500], now_iso(), selection_id))
                    e.commit()
                except LeaseLostError:
                    e.rollback()
                finally:
                    e.close()
            raise
        finally: c.close()

    def _process_job(self, job_id, worker_id, token):
        c = self._db()
        try:
            self._assert_lease(c, worker_id, token)
            job = c.execute("SELECT * FROM probe_server_bulk_jobs WHERE id=? AND state IN ('queued','running')", (job_id,)).fetchone()
            if job is None:
                c.rollback(); return
            c.execute("UPDATE probe_server_bulk_jobs SET state='running',updated_at=? WHERE id=?", (now_iso(), job_id))
            if not job["items_ready"]:
                if job["retry_of"]:
                    tail = c.execute("SELECT MAX(ordinal) FROM (SELECT ordinal FROM probe_server_bulk_items "
                                     "WHERE job_id=? AND state='failed' AND ordinal>? ORDER BY ordinal LIMIT ?)",
                                     (job["retry_of"], job["materialize_cursor"], MAINTENANCE_BATCH_SIZE)).fetchone()[0]
                    if tail is None:
                        ready = 1
                        c.execute("UPDATE probe_server_bulk_jobs SET items_ready=1,total=0 WHERE id=?", (job_id,))
                    else:
                        c.execute("INSERT INTO probe_server_bulk_items(job_id,ordinal,server_id,ip) "
                                  "SELECT ?,ordinal,server_id,ip FROM probe_server_bulk_items "
                                  "WHERE job_id=? AND state='failed' AND ordinal>? AND ordinal<=? ORDER BY ordinal",
                                  (job_id, job["retry_of"], job["materialize_cursor"], tail))
                        ready = c.execute("SELECT 1 FROM probe_server_bulk_items WHERE job_id=? AND state='failed' AND ordinal>? LIMIT 1",
                                          (job["retry_of"], tail)).fetchone() is None
                        c.execute("UPDATE probe_server_bulk_jobs SET materialize_cursor=?,items_ready=? WHERE id=?",
                                  (tail, int(ready), job_id))
                else:
                    selection = c.execute("SELECT max_server_id FROM probe_server_selections WHERE id=?",
                                          (job["selection_id"],)).fetchone()
                    max_id = int(selection["max_server_id"] if selection else 0)
                    upper = min(max_id, int(job["materialize_cursor"]) + SELECTION_BUILD_RANGE)
                    c.execute("INSERT INTO probe_server_bulk_items(job_id,ordinal,server_id,ip) "
                              "SELECT ?,server_id,server_id,ip "
                              "FROM probe_server_selection_members WHERE selection_id=? AND server_id>? AND server_id<=?",
                              (job_id, job["selection_id"], job["materialize_cursor"], upper))
                    ready = upper >= max_id
                    c.execute("UPDATE probe_server_bulk_jobs SET materialize_cursor=?,items_ready=? WHERE id=?",
                              (upper, int(ready), job_id))
            rows = c.execute("SELECT ordinal,server_id,ip FROM probe_server_bulk_items WHERE job_id=? AND state='pending' ORDER BY ordinal LIMIT ?", (job_id, BULK_CHUNK_SIZE)).fetchall()
            if not rows:
                ready_row = c.execute("SELECT items_ready FROM probe_server_bulk_jobs WHERE id=?", (job_id,)).fetchone()
                if ready_row and not ready_row["items_ready"]:
                    c.commit()
                    return
                totals = c.execute("SELECT COUNT(*) total, SUM(state='done') done, SUM(state='failed') failed FROM probe_server_bulk_items WHERE job_id=?", (job_id,)).fetchone()
                state = 'done' if not totals['failed'] else ('partial' if totals['done'] else 'failed')
                c.execute("UPDATE probe_server_bulk_jobs SET state=?,total=?,processed=?,succeeded=?,failed=?,updated_at=? WHERE id=?",
                          (state, totals['total'], totals['total'], totals['done'] or 0, totals['failed'] or 0, now_iso(), job_id))
                c.commit(); return
            payload = json.loads(job["payload"])
            c.commit()
        finally: c.close()
        store = ProbeStore(self.database_path)
        outcomes = {}
        lease_guard = (worker_id, token)
        if job["operation"] == "delete":
            try:
                store.delete_servers_batch([r["server_id"] for r in rows], lease_guard=lease_guard)
                for row in rows: outcomes[row["ordinal"]] = ("done", "")
            except LeaseLostError:
                raise
            except Exception as exc:
                for row in rows: outcomes[row["ordinal"]] = ("failed", str(exc)[:500])
        else:
            try:
                existing_ids = store.update_servers_batch(
                    [r["server_id"] for r in rows], group=payload.get("group"),
                    add_labels=payload.get("addLabels", ()), remove_labels=payload.get("removeLabels", ()),
                    add_tag_ids=payload.get("addTagIds", ()), remove_tag_ids=payload.get("removeTagIds", ()),
                    lease_guard=lease_guard, return_ids=True)
                for row in rows:
                    exists = int(row["server_id"]) in existing_ids
                    outcomes[row["ordinal"]] = ("done", "") if exists else ("failed", "server no longer exists")
            except LeaseLostError:
                raise
            except Exception as exc:
                for row in rows: outcomes[row["ordinal"]] = ("failed", str(exc)[:500])
        c = self._db()
        try:
            self._assert_lease(c, worker_id, token)
            c.executemany("UPDATE probe_server_bulk_items SET state=?,error=? WHERE job_id=? AND ordinal=?",
                          [(state, error, job_id, ordinal) for ordinal, (state, error) in outcomes.items()])
            c.execute("UPDATE probe_server_bulk_jobs SET processed=(SELECT COUNT(*) FROM probe_server_bulk_items WHERE job_id=? AND state!='pending'),succeeded=(SELECT COUNT(*) FROM probe_server_bulk_items WHERE job_id=? AND state='done'),failed=(SELECT COUNT(*) FROM probe_server_bulk_items WHERE job_id=? AND state='failed'),updated_at=? WHERE id=?",
                      (job_id, job_id, job_id, now_iso(), job_id))
            c.commit()
        finally: c.close()

    def run_once(self, worker_id):
        if time.monotonic() - getattr(self, "_last_cleanup", 0) >= 60:
            self.cleanup_once()
            self._last_cleanup = time.monotonic()
        work = self._claim(worker_id)
        if work is None: return False
        kind, item_id, token = work
        renew_stop = threading.Event()
        lease_lost = threading.Event()
        def renew():
            while not renew_stop.wait(5):
                c = connect_database(self.database_path)
                try:
                    changed = c.execute("UPDATE probe_server_bulk_lease SET lease_until=? WHERE id=1 AND owner=? AND token=? AND lease_until>?",
                                        (time.time()+LEASE_SECONDS, worker_id, token, time.time())).rowcount
                    c.commit()
                    if not changed:
                        lease_lost.set()
                        return
                except Exception:
                    lease_lost.set()
                    return
                finally: c.close()
        renew_thread = threading.Thread(target=renew, daemon=True, name="probe-server-bulk-lease")
        renew_thread.start()
        try:
            if lease_lost.is_set():
                raise LeaseLostError("bulk worker lease lost")
            (self._build if kind == 'selection' else self._process_job)(item_id, worker_id, token)
        finally:
            renew_stop.set()
            renew_thread.join(timeout=1)
            c = connect_database(self.database_path)
            try:
                c.execute("UPDATE probe_server_bulk_lease SET owner='',token='',lease_until=0 WHERE id=1 AND owner=? AND token=?",
                          (worker_id, token))
                c.commit()
            finally: c.close()
        return True


class ServerBulkWorker:
    def __init__(self, store):
        self.store = store
        self.worker_id = str(uuid.uuid4())
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True, name="probe-server-bulk")

    def start(self):
        self.thread.start()
        return self.stop

    def _run(self):
        while not self.stop_event.is_set():
            try:
                did_work = self.store.run_once(self.worker_id)
            except Exception:
                did_work = False
            if not did_work: self.stop_event.wait(0.5)

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=5)
