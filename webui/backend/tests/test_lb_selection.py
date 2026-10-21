"""Ranking source isolation and freshness; health remains Console-owned."""

import json
import os
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

if "PROJECT_DIR" not in os.environ:
    os.environ["PROJECT_DIR"] = tempfile.mkdtemp(prefix="lb-selection-env-")

from app.lb.health import PoolHealthMonitor, best_ip_for_domain
from app.lb.selection import save_selection_config, selection_for_domain
from app.lb.store import LbStore
from app.probe.store import ProbeStore


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        db = Path(self.tmp.name) / "test.db"
        self.lb, self.probe = LbStore(db), ProbeStore(db)
        self.probe.import_servers([{"ip": ip, "group": "pool"}
                                   for ip in ("1.1.1.10", "1.1.1.2")])
        self.domain = self.lb.create_domain(name="test.example.com", zone_id="z", zone_name="example.com",
                                             group_name="pool")
        self.lb.set_setting("selection_config", json.dumps({"nodeId": "cn", "maxAgeHours": 24}))
        self.monitor = PoolHealthMonitor()
        self.records = {"connectivity": [], "speed": []}
        owner = self

        class Observations:
            def __init__(self, path):
                pass

            def latest_results(self, node, kind):
                owner.assertEqual(node, "cn")
                return owner.records[kind]

            def get_node(self, node):
                return {"capabilities": ["connectivity", "speed"]} if node in {"cn", "console"} else None

        self.addCleanup(patch.stopall)
        patch.dict("sys.modules", {"app.probe.jobs": types.SimpleNamespace(ProbeJobStore=Observations)}).start()

    def record(self, ip, *, hours=0, **data):
        return {"server_ip": ip, "port": 7000,
                "test_time": (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(), **data}

    def decide(self):
        return selection_for_domain(self.domain, self.probe, self.monitor)

    def unhealthy(self, ip):
        self.monitor._record(ip, 7000, False, "down")
        self.monitor._record(ip, 7000, False, "down")

    def test_missing_data_numeric_order(self):
        view = self.decide()
        self.assertEqual(view["bestIp"], "1.1.1.2")
        self.assertEqual(view["reason"], "healthy_ip_order")

    def test_missing_current_preserves_healthy_address(self):
        self.domain.current_ip = "1.1.1.10"
        self.records["speed"] = [self.record("1.1.1.2", dl_ok=True, dl_speed_bps=900000)]
        self.assertEqual(self.decide()["bestIp"], "1.1.1.10")
        self.assertEqual(self.decide()["reason"], "keep_healthy_current")

    def test_current_fault_switches_without_worker(self):
        self.domain.current_ip = "1.1.1.10"
        self.unhealthy("1.1.1.10")
        self.assertEqual(best_ip_for_domain(self.domain, self.probe, self.monitor), "1.1.1.2")

    def test_fresh_remote_results_rank_without_console_metrics(self):
        self.records["connectivity"] = [self.record("1.1.1.10", frps_reachable=True),
                                         self.record("1.1.1.2", frps_reachable=True)]
        self.records["speed"] = [self.record("1.1.1.10", dl_ok=True, dl_speed_bps=900),
                                  self.record("1.1.1.2", dl_ok=True, dl_speed_bps=100)]
        view = self.decide()
        self.assertEqual(view["bestIp"], "1.1.1.10")
        self.assertEqual(view["validCandidates"], 2)
        self.assertEqual(view["healthSource"], "console")

    def test_expired_speed_ignored_independently(self):
        self.records["connectivity"] = [self.record("1.1.1.10", frps_reachable=True),
                                         self.record("1.1.1.2", frps_reachable=True)]
        self.records["speed"] = [self.record("1.1.1.10", hours=25, dl_ok=True, dl_speed_bps=900),
                                  self.record("1.1.1.2", dl_ok=True, dl_speed_bps=100)]
        self.assertEqual(self.decide()["bestIp"], "1.1.1.2")

    def test_latest_failed_speed_is_not_ranked_as_success(self):
        self.records["connectivity"] = [self.record("1.1.1.10", frps_reachable=True),
                                         self.record("1.1.1.2", frps_reachable=True)]
        self.records["speed"] = [self.record("1.1.1.10", dl_ok=False, dl_speed_bps=900000),
                                  self.record("1.1.1.2", dl_ok=True, dl_speed_bps=100)]
        self.assertEqual(self.decide()["bestIp"], "1.1.1.2")

    def test_failed_and_missing_observations_tie_break_numerically(self):
        self.records["connectivity"] = [self.record("1.1.1.10", frps_reachable=False)]
        self.assertEqual(self.decide()["bestIp"], "1.1.1.2")

    def test_observation_port_must_match(self):
        self.records["connectivity"] = [{**self.record("1.1.1.10", frps_reachable=True), "port": 7001}]
        self.assertEqual(self.decide()["validCandidates"], 0)

    def test_all_unhealthy_preserves_no_selection(self):
        self.unhealthy("1.1.1.10")
        self.unhealthy("1.1.1.2")
        self.assertIsNone(self.decide()["bestIp"])

    def test_config_validation(self):
        self.assertEqual(save_selection_config(self.lb, "cn", 24)["nodeId"], "cn")
        with self.assertRaises(ValueError):
            save_selection_config(self.lb, "missing", 24)
        with self.assertRaises(ValueError):
            save_selection_config(self.lb, "cn", 0)


class SelectionIntegrationTests(unittest.TestCase):
    def test_console_jobs_visible_to_default_lb_selection(self):
        from app.probe.jobs import ProbeJobStore

        with tempfile.TemporaryDirectory() as root:
            db = Path(root) / "test.db"
            lb, probe, jobs = LbStore(db), ProbeStore(db), ProbeJobStore(db)
            probe.import_servers([{"ip": ip, "group": "pool"} for ip in ("1.1.1.10", "1.1.1.2")])
            domain = lb.create_domain(name="test.example.com", zone_id="z", zone_name="example.com",
                                      group_name="pool")
            jobs.create_job("connectivity", ["console"], ips=["1.1.1.2"])
            task = jobs.claim("console")
            jobs.report("console", task["taskId"], task["attemptId"], result={
                "frps_reachable": True, "tunnel_established": True, "firewall_open": True})
            self.assertEqual(selection_for_domain(domain, probe, PoolHealthMonitor())["bestIp"], "1.1.1.2")

    def test_real_store_latest_failure_supersedes_success(self):
        from app.probe.jobs import ProbeJobStore

        with tempfile.TemporaryDirectory() as root:
            db = Path(root) / "test.db"
            lb, probe, jobs = LbStore(db), ProbeStore(db), ProbeJobStore(db)
            probe.import_servers([{"ip": ip, "group": "pool"} for ip in ("1.1.1.10", "1.1.1.2")])
            domain = lb.create_domain(name="test.example.com", zone_id="z", zone_name="example.com",
                                      group_name="pool")
            node = jobs.create_node("cn")
            save_selection_config(lb, node["id"], 24)

            def report(ip, reachable):
                jobs.create_job("connectivity", [node["id"]], ips=[ip])
                task = jobs.claim(node["id"])
                self.assertIsNotNone(task)
                jobs.report(node["id"], task["taskId"], task["attemptId"], result={
                    "frps_reachable": reachable, "tunnel_established": reachable, "firewall_open": reachable})

            report("1.1.1.10", True)
            self.assertEqual(selection_for_domain(domain, probe, PoolHealthMonitor())["bestIp"], "1.1.1.10")
            report("1.1.1.10", False)
            self.assertEqual(selection_for_domain(domain, probe, PoolHealthMonitor())["bestIp"], "1.1.1.2")
