"""Runtime selection/sync behavior for explicit per-domain server membership."""

import os
import threading
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("PROJECT_DIR", tempfile.mkdtemp(prefix="lb-membership-runtime-"))

from app.lb.cloudflare import CloudflareError
from app.lb.health import PoolHealthMonitor
from app.lb.selection import selection_for_domain
from app.lb.store import LbStore
from app.lb.syncer import sync_domain
from app.probe.store import ProbeStore


class FakeCloudflare:
    def __init__(self, records=(), *, fail_create=False, fail_delete=False):
        self.records = [dict(row) for row in records]
        self.fail_create = fail_create
        self.fail_delete = fail_delete
        self.calls = []
        self.next_id = 1

    def list_a_records(self, zone_id, name):
        self.calls.append(("list", name))
        return [type("Record", (), dict(row))() for row in self.records if row["name"] == name]

    def create_a_record(self, zone_id, name, ip, ttl=60):
        self.calls.append(("create", ip))
        if self.fail_create:
            raise CloudflareError("mock create failure")
        self.next_id += 1
        row = {"id": str(self.next_id), "name": name, "content": ip,
               "ttl": ttl, "managed": True}
        self.records.append(row)
        return row

    def delete_a_record(self, zone_id, record_id):
        self.calls.append(("delete", record_id))
        if self.fail_delete:
            raise CloudflareError("mock delete failure")
        self.records = [row for row in self.records if row["id"] != record_id]

    def managed_ips(self, name):
        return sorted(row["content"] for row in self.records
                      if row["name"] == name and row["managed"])


class BlockingCreateCloudflare(FakeCloudflare):
    def __init__(self, records):
        super().__init__(records)
        self.create_started = threading.Event()
        self.release_create = threading.Event()

    def create_a_record(self, zone_id, name, ip, ttl=60):
        self.create_started.set()
        if not self.release_create.wait(timeout=3):
            raise TimeoutError("test did not release blocked Cloudflare create")
        return super().create_a_record(zone_id, name, ip, ttl)


class DomainMembershipRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        db = Path(self.tmp.name) / "lb.db"
        self.lb, self.probe = LbStore(db), ProbeStore(db)
        self.first = self.probe.create_server(ip="1.1.1.1", server_group="legacy-pool")
        self.second = self.probe.create_server(ip="2.2.2.2", server_group="unrelated")
        self.outside = self.probe.create_server(ip="3.3.3.3", server_group="legacy-pool")
        self.domain = self.lb.create_domain(
            name="frps.example.com", zone_id="z", zone_name="example.com",
            server_ids=[self.first.id, self.second.id],
        )
        self.monitor = PoolHealthMonitor()

    def mark_unhealthy(self, ip):
        self.monitor._record(ip, 7000, False, "down")
        self.monitor._record(ip, 7000, False, "down")

    def test_preferred_healthy_member_beats_faster_observation(self):
        pinned = self.lb.update_domain(self.domain.id, preferred_server_id=self.second.id)
        stamp = datetime.now(timezone.utc).isoformat()

        def results(_store, kind, ips=None):
            if kind == "connectivity":
                return [{"server_ip": "1.1.1.1", "port": 7000, "test_time": stamp,
                         "frps_reachable": True}]
            return [{"server_ip": "1.1.1.1", "port": 7000, "test_time": stamp,
                     "dl_ok": True, "dl_speed_bps": 10**9}]

        from app.probe.jobs import ProbeJobStore
        with patch.object(ProbeJobStore, "current_results", results):
            selected = selection_for_domain(pinned, self.probe, self.monitor)
        self.assertEqual(selected["bestIp"], "2.2.2.2")
        self.assertEqual(selected["bestServerId"], self.second.id)
        self.assertEqual(selected["reason"], "preferred_server")

    def test_unhealthy_pin_falls_back_and_does_not_switch_back(self):
        self.lb.update_domain(self.domain.id, preferred_server_id=self.second.id)
        self.mark_unhealthy("2.2.2.2")
        cf = FakeCloudflare()

        failed_over = sync_domain(self.domain, self.probe, self.lb, cf, self.monitor)
        self.assertTrue(failed_over.ok)
        self.assertEqual(failed_over.target_ip, "1.1.1.1")
        persisted = self.lb.get_domain(self.domain.id)
        self.assertEqual(persisted.current_ip, "1.1.1.1")
        self.assertIsNone(persisted.preferred_server_id)

        self.monitor._record("2.2.2.2", 7000, True, "up")
        recovered = sync_domain(self.domain, self.probe, self.lb, cf, self.monitor)
        self.assertTrue(recovered.ok)
        self.assertEqual(recovered.target_ip, "1.1.1.1")
        self.assertEqual(cf.managed_ips(self.domain.name), ["1.1.1.1"])

    def test_manual_target_must_be_healthy_member_before_cloudflare_calls(self):
        cf = FakeCloudflare()
        outside = sync_domain(self.domain, self.probe, self.lb, cf, self.monitor,
                              target_server_id=self.outside.id)
        self.assertFalse(outside.ok)
        self.assertEqual(cf.calls, [])

        self.mark_unhealthy("2.2.2.2")
        unhealthy = sync_domain(self.domain, self.probe, self.lb, cf, self.monitor,
                                target_server_id=self.second.id)
        self.assertFalse(unhealthy.ok)
        self.assertEqual(cf.calls, [])
        persisted = self.lb.get_domain(self.domain.id)
        self.assertIsNone(persisted.current_ip)
        self.assertIsNone(persisted.preferred_server_id)

    def test_create_failure_keeps_old_record_and_domain_state(self):
        self.lb.update_domain(self.domain.id, preferred_server_id=self.first.id)
        self.lb.mark_sync_result(self.domain.id, ok=True, message="seed", added=[], removed=[],
                                 kept=1, current_ip="1.1.1.1")
        stale_snapshot = self.lb.get_domain(self.domain.id)
        cf = FakeCloudflare([{"id": "old", "name": self.domain.name, "content": "1.1.1.1",
                              "ttl": 60, "managed": True}], fail_create=True)

        result = sync_domain(stale_snapshot, self.probe, self.lb, cf, self.monitor,
                             target_server_id=self.second.id)
        self.assertFalse(result.ok)
        self.assertEqual(cf.managed_ips(self.domain.name), ["1.1.1.1"])
        persisted = self.lb.get_domain(self.domain.id)
        self.assertEqual(persisted.current_ip, "1.1.1.1")
        self.assertEqual(persisted.preferred_server_id, self.first.id)

    def test_delete_failure_keeps_old_domain_state_and_pin(self):
        self.lb.update_domain(self.domain.id, preferred_server_id=self.second.id)
        self.lb.mark_sync_result(self.domain.id, ok=True, message="seed", added=[], removed=[],
                                 kept=1, current_ip="2.2.2.2")
        self.mark_unhealthy("2.2.2.2")
        cf = FakeCloudflare([{"id": "pinned", "name": self.domain.name, "content": "2.2.2.2",
                              "ttl": 60, "managed": True}], fail_delete=True)

        result = sync_domain(self.domain, self.probe, self.lb, cf, self.monitor)
        self.assertFalse(result.ok)
        self.assertEqual(cf.managed_ips(self.domain.name), ["1.1.1.1", "2.2.2.2"])
        persisted = self.lb.get_domain(self.domain.id)
        self.assertEqual(persisted.current_ip, "2.2.2.2")
        self.assertEqual(persisted.preferred_server_id, self.second.id)

    def test_sync_reloads_domain_instead_of_using_stale_scheduler_snapshot(self):
        stale_snapshot = self.lb.get_domain(self.domain.id)
        self.lb.update_domain(self.domain.id, preferred_server_id=self.second.id)
        cf = FakeCloudflare()

        result = sync_domain(stale_snapshot, self.probe, self.lb, cf, self.monitor)
        self.assertTrue(result.ok)
        self.assertEqual(result.target_ip, "2.2.2.2")
        self.assertEqual(self.lb.get_domain(self.domain.id).preferred_server_id, self.second.id)

    def test_health_checks_only_enabled_domain_members(self):
        class SettingsStub:
            def probe_options(self):
                return type("Options", (), {"frps_port": 7000})()

        checked = []
        monitor = PoolHealthMonitor(prober=lambda host, port: (checked.append(host) or True, "ok"))
        results = monitor.run_due_checks(self.lb, self.probe, SettingsStub())
        self.assertEqual(set(results), {"1.1.1.1", "2.2.2.2"})
        self.assertEqual(set(checked), {"1.1.1.1", "2.2.2.2"})

    def _assert_server_delete_waits_for_dns_switch(self, *, batch=False, edit=False):
        self.lb.update_domain(self.domain.id, preferred_server_id=self.first.id)
        self.lb.mark_sync_result(self.domain.id, ok=True, message="seed", added=[], removed=[],
                                 kept=1, current_ip="1.1.1.1")
        cf = BlockingCreateCloudflare([{"id": "old", "name": self.domain.name,
                                        "content": "1.1.1.1", "ttl": 60, "managed": True}])
        sync_results = []
        delete_results = []
        errors = []
        delete_started = threading.Event()
        delete_done = threading.Event()

        def sync():
            try:
                sync_results.append(sync_domain(
                    self.domain, self.probe, self.lb, cf, self.monitor,
                    target_server_id=self.second.id,
                ))
            except BaseException as exc:  # capture thread failures for assertions
                errors.append(exc)

        def delete():
            delete_started.set()
            try:
                if edit:
                    delete_results.append(self.probe.update_server(self.second.id, ip='2.2.2.3'))
                elif batch:
                    delete_results.append(self.probe.delete_servers_batch([self.second.id]))
                else:
                    delete_results.append(self.probe.delete_server(self.second.id))
            except BaseException as exc:  # capture thread failures for assertions
                errors.append(exc)
            finally:
                delete_done.set()

        sync_thread = threading.Thread(target=sync, daemon=True)
        delete_thread = threading.Thread(target=delete, daemon=True)
        sync_thread.start()
        try:
            self.assertTrue(cf.create_started.wait(timeout=2), "sync did not reach Cloudflare create")
            delete_thread.start()
            self.assertTrue(delete_started.wait(timeout=1), "delete thread did not start")
            # Deletion must not pass the same sync lock while create is blocked.
            self.assertFalse(delete_done.wait(timeout=0.1))
        finally:
            cf.release_create.set()
            sync_thread.join(timeout=3)
            if delete_thread.ident is not None:
                delete_thread.join(timeout=3)

        self.assertFalse(sync_thread.is_alive(), "sync thread did not finish")
        self.assertFalse(delete_thread.is_alive(), "delete thread did not finish")
        self.assertEqual(errors, [])
        self.assertTrue(sync_results[0].ok)
        self.assertEqual(sync_results[0].target_ip, "2.2.2.2")
        if edit:
            self.assertEqual(delete_results[0].ip, '2.2.2.3')
        else:
            self.assertEqual(delete_results, [1 if batch else None])
        domain = self.lb.get_domain(self.domain.id)
        self.assertEqual(domain.current_ip, "2.2.2.2")
        if edit:
            self.assertEqual(domain.preferred_server_id, self.second.id)
            self.assertEqual(self.lb.domain_server_ids(self.domain.id), [self.first.id, self.second.id])
        else:
            self.assertIsNone(domain.preferred_server_id)
            self.assertEqual(self.lb.domain_server_ids(self.domain.id), [self.first.id])

    def test_individual_server_delete_waits_for_dns_switch_commit(self):
        self._assert_server_delete_waits_for_dns_switch(batch=False)

    def test_batch_server_delete_waits_for_dns_switch_commit(self):
        self._assert_server_delete_waits_for_dns_switch(batch=True)

    def test_server_ip_edit_waits_for_dns_switch_commit(self):
        self._assert_server_delete_waits_for_dns_switch(edit=True)


if __name__ == "__main__":
    unittest.main()
