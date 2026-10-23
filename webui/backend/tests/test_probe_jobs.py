import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

os.environ.setdefault('PROJECT_DIR',tempfile.mkdtemp(prefix='probe-jobs-env-'))
from app.probe.jobs import ProbeJobStore
from app.probe.store import ProbeStore, ServerPageQuery, DiscoverPageQuery
from app.probe.package import worker_bundle


class ProbeJobsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'console.db';self.store=ProbeJobStore(self.path)
        self.a=self.store.create_node('a')['id'];self.b=self.store.create_node('b')['id']
    def tearDown(self):self.tmp.cleanup()
    def job(self,mode='connectivity',nodes=None,ips=None,**kw):
        return self.store.create_job(mode,nodes or [self.a],ips=ips or ['192.0.2.1'],**kw)
    def finish(self,node,task,result=None,infra_error=None):
        return self.store.report(node,task['taskId'],task['attemptId'],result=result or {},infra_error=infra_error)
    def set_primary(self, node=None):
        return self.store.set_execution_policy(node or self.a, [])
    def expire(self,task):
        with self.store._db() as c:c.execute('UPDATE probe_tasks SET lease_until=0 WHERE id=?',(task['taskId'],))
    def online_generation_worker(self, node_id):
        self.store.heartbeat(node_id, 'test', ['discover', 'route', 'connectivity', 'speed'], [], ['task-generation-v1'])
    def test_multi_node_every_target_isolated_and_port(self):
        self.job(nodes=[self.a,self.b],ips=['192.0.2.1','192.0.2.2'])
        first=self.store.claim(self.a)
        parallel=self.store.claim(self.b);self.assertNotEqual(first['ip'],parallel['ip'])
        self.finish(self.b,parallel,{'frps_reachable':False})
        self.finish(self.a,first,{'frps_reachable':True})
        other=self.store.claim(self.b);self.finish(self.b,other,{'frps_reachable':False})
        self.assertTrue(self.store.latest_results(self.a,'connectivity')[0]['frps_reachable'])
        self.assertFalse(self.store.latest_results(self.b,'connectivity')[0]['frps_reachable'])
        self.assertEqual(self.store.latest_results(self.a,'connectivity')[0]['port'],7000)

    def test_current_projection_seeds_once_from_explicit_primary(self):
        with self.store._db() as c:
            for node, reachable in ((self.a, True), (self.b, False)):
                self.store._result(c, 'seed-' + node, 'seed-job', node, 'connectivity',
                                   '192.0.2.81', 7000,
                                   {'frps_reachable': reachable, 'tunnel_established': reachable,
                                    'firewall_open': reachable}, stamp='2026-10-20T00:00:00+00:00')
                self.store._result(c, 'seed-route-' + node, 'seed-job', node, 'route',
                                   '192.0.2.81', 7000, {'ok': reachable},
                                   stamp='2026-10-20T00:00:00+00:00')
        self.set_primary(self.a)
        current = self.store.current_results('connectivity')
        self.assertEqual(len(current), 1)
        self.assertTrue(current[0]['frps_reachable'])
        self.assertEqual(current[0]['node_id'], self.a)
        route = self.store.current_results('route')[0]
        self.assertTrue(route['ok'])
        self.assertEqual(route['node_id'], self.a)
        # Saving a later role order and repeating the seed preserves current state.
        self.store.set_execution_policy(self.b, [self.a])
        self.assertEqual(self.store.current_results('connectivity')[0]['node_id'], self.a)
        self.assertEqual(self.store.current_results('route')[0]['node_id'], self.a)
        with self.store._db() as c:
            from app.control.database import _migrate_probe_current_results
            _migrate_probe_current_results(c)
        self.assertEqual(self.store.current_results('connectivity')[0]['node_id'], self.a)

    def test_invalid_primary_does_not_mark_seed_complete_and_valid_policy_repairs_it(self):
        with self.store._db() as c:
            self.store._result(c, 'invalid-primary-seed', 'seed-job', self.a, 'connectivity',
                               '192.0.2.86', 7000, {'frps_reachable': True},
                               stamp='2026-10-20T00:00:00+00:00')
            self.store._seed_current_results(c, 'deleted-node')
            c.execute("INSERT INTO probe_settings(key,value) VALUES('probe_execution_policy',?)",
                      (json.dumps({'primaryNodeId': 'deleted-node', 'backupNodeIds': []}),))
            from app.control.database import _migrate_probe_current_results
            _migrate_probe_current_results(c)
            self.assertIsNone(c.execute(
                "SELECT 1 FROM probe_settings WHERE key='probe_current_results_seeded'"
            ).fetchone())
        self.set_primary(self.a)
        current = self.store.current_results('connectivity')
        self.assertEqual(len(current), 1)
        self.assertEqual(current[0]['node_id'], self.a)

    def test_invalid_backup_does_not_mark_seed_complete_until_policy_chain_is_repaired(self):
        with self.store._db() as c:
            self.store._result(c, 'invalid-backup-seed', 'seed-job', self.a, 'connectivity',
                               '192.0.2.88', 7000, {'frps_reachable': True},
                               stamp='2026-10-20T00:00:00+00:00')
            c.execute("INSERT INTO probe_settings(key,value) VALUES('probe_execution_policy',?)",
                      (json.dumps({'primaryNodeId': self.a, 'backupNodeIds': ['deleted-backup']}),))
            from app.control.database import _migrate_probe_current_results
            _migrate_probe_current_results(c)
            self.store._seed_current_results(c, self.a)
            self.assertIsNone(c.execute(
                "SELECT 1 FROM probe_settings WHERE key='probe_current_results_seeded'"
            ).fetchone())
        self.store.set_execution_policy(self.a, [self.b])
        current = self.store.current_results('connectivity')
        self.assertEqual(len(current), 1)
        self.assertEqual(current[0]['node_id'], self.a)

    def test_unmanaged_node_history_does_not_fall_back_into_current_projection(self):
        job = self.job(nodes=[self.b], ips=['192.0.2.82'])
        task = self.store.claim(self.b)
        self.finish(self.b, task, {'frps_reachable': True, 'tunnel_established': True, 'firewall_open': True})
        self.assertEqual(self.store.latest_results(self.b, 'connectivity')[0]['job_id'], job['id'])
        self.assertEqual(self.store.current_results('connectivity'), [])
        with self.store._db() as c:
            self.assertIsNone(c.execute("SELECT 1 FROM probe_settings WHERE key='probe_current_results_seeded'").fetchone())

    def test_current_results_api_is_source_free(self):
        self.set_primary(self.a)
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.82'])
        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        task = self.store.claim(self.a)
        self.finish(self.a, task, {'frps_reachable': True, 'tunnel_established': True, 'firewall_open': True})
        from app.probe import router
        with patch.object(router, 'job_store', return_value=self.store):
            response = router.results_current('connectivity')
        self.assertEqual(response['items'][0]['job_id'], job['id'])
        self.assertEqual(response['items'][0]['node_id'], self.a)

    def test_primary_managed_route_report_updates_current_projection(self):
        self.set_primary(self.a)
        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        self.store.create_primary_job('route', ips=['192.0.2.85'])
        task = self.store.claim(self.a)
        self.assertEqual(task['stage'], 'route')
        self.finish(self.a, task, {'ok': False, 'error': 'route failed'})
        current = self.store.current_results('route')[0]
        self.assertFalse(current['ok'])
        self.assertEqual(current['node_id'], self.a)

    def test_accepted_backup_result_updates_projection_and_stale_owner_does_not(self):
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b])
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.83'])
        task_id = job['tasks'][0]['taskId']
        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        first = self.store.claim(self.a)
        self.expire(first)
        with self.store._db() as c:
            c.execute('UPDATE probe_nodes SET last_seen=0 WHERE id=?', (self.a,))
        self.online_generation_worker(self.b)
        second = self.store.claim(self.b)
        self.assertEqual(second['generation'], 1)
        stale = self.store.report(self.a, task_id, first['attemptId'], generation=0,
                                  result={'frps_reachable': True})
        self.assertFalse(stale['applied'])
        accepted = self.store.report(self.b, task_id, second['attemptId'], generation=1,
                                     result={'frps_reachable': True, 'tunnel_established': True,
                                             'firewall_open': True})
        self.assertTrue(accepted['accepted'])
        current = self.store.current_results('connectivity')[0]
        self.assertEqual(current['node_id'], self.b)
        self.assertEqual(current['job_id'], job['id'])
        self.assertEqual(current['generation'], 1)

    def test_latest_accepted_failure_replaces_current_success(self):
        self.set_primary(self.a)
        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        good = self.store.create_primary_job('connectivity', ips=['192.0.2.84'])
        good_task = self.store.claim(self.a)
        self.finish(self.a, good_task, {'frps_reachable': True, 'tunnel_established': True, 'firewall_open': True})
        self.assertTrue(self.store.current_results('connectivity')[0]['frps_reachable'])
        bad = self.store.create_primary_job('connectivity', ips=['192.0.2.84'])
        bad_task = self.store.claim(self.a)
        self.finish(self.a, bad_task, {'frps_reachable': False, 'tunnel_established': False, 'firewall_open': False})
        current = self.store.current_results('connectivity')[0]
        self.assertFalse(current['frps_reachable'])
        self.assertEqual(current['job_id'], bad['id'])
        self.assertNotEqual(current['job_id'], good['id'])

    def test_clear_history_removes_projection_for_deleted_source_result(self):
        self.set_primary(self.a)
        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        self.store.create_primary_job('connectivity', ips=['192.0.2.87'])
        task = self.store.claim(self.a)
        self.finish(self.a, task, {'frps_reachable': True, 'tunnel_established': True, 'firewall_open': True})
        self.assertEqual(len(self.store.current_results('connectivity')), 1)
        self.store.clear_history(self.a, 'connectivity')
        self.assertEqual(self.store.current_results('connectivity'), [])

    def test_job_owner_rejects_nonfixed_ports(self):
        with self.assertRaisesRegex(ValueError, '端口固定为 7000'):
            self.job(port=7001)
        with self.assertRaisesRegex(ValueError, '端口固定为 7000'):
            self.job(port=7000.9)
        with self.assertRaisesRegex(ValueError, '端口固定为 7000'):
            self.job(port=True)
        with self.assertRaisesRegex(ValueError, '端口固定为 7000'):
            self.job(ips=['192.0.2.1:7001'])

    def test_execution_policy_validation_offline_nodes_and_order(self):
        legacy = self.store.create_node('legacy-policy', kind='legacy')['id']
        with self.assertRaisesRegex(ValueError, '不存在'):
            self.store.set_execution_policy('missing-node', [])
        with self.assertRaisesRegex(ValueError, '完整测试能力'):
            self.store.set_execution_policy('console', [])
        with self.assertRaisesRegex(ValueError, '完整测试能力'):
            self.store.set_execution_policy(legacy, [])
        with self.store._db() as c:
            c.execute('UPDATE probe_nodes SET capabilities=? WHERE id=?', ('["discover","route","connectivity"]', self.b))
        with self.assertRaisesRegex(ValueError, '完整测试能力'):
            self.store.set_execution_policy(self.a, [self.b])
        with self.store._db() as c:
            c.execute('UPDATE probe_nodes SET capabilities=?,last_seen=0 WHERE id=?', ('["discover","route","connectivity","speed"]', self.b))
        self.assertFalse(self.store.get_node(self.b)['online'])
        saved = self.store.set_execution_policy(self.a, [self.b])
        self.assertTrue(saved['configured'])
        self.assertEqual(saved['primaryNodeId'], self.a)
        self.assertEqual(saved['backupNodeIds'], [self.b])
        with self.assertRaisesRegex(ValueError, '不能重复'):
            self.store.set_execution_policy(self.a, [self.b, self.b])
        with self.assertRaisesRegex(ValueError, '不能同时列为备用'):
            self.store.set_execution_policy(self.a, [self.a])

    def test_execution_policy_suggestion_is_hint_and_not_persisted(self):
        with self.store._db() as c:
            c.execute("INSERT INTO lb_settings(key,value) VALUES('selection_config',?)", (json.dumps({'nodeId': self.a}),))
        current = self.store.get_execution_policy()
        self.assertEqual(current, {
            'configured': False, 'primaryNodeId': None, 'backupNodeIds': [],
            'suggestedPrimaryNodeId': self.a,
        })
        with self.store._db() as c:
            self.assertIsNone(c.execute("SELECT value FROM probe_settings WHERE key='probe_execution_policy'").fetchone())
            c.execute("UPDATE probe_nodes SET kind='legacy' WHERE id=?", (self.a,))
        self.assertIsNone(self.store.get_execution_policy()['suggestedPrimaryNodeId'])

        with self.store._db() as c:
            c.execute("UPDATE probe_nodes SET kind='worker',capabilities=? WHERE id=?", ('not-json', self.a))
        with self.assertRaisesRegex(ValueError, '完整测试能力'):
            self.store.set_execution_policy(self.a, [])
        self.assertIsNone(self.store.get_execution_policy()['suggestedPrimaryNodeId'])

    def test_execution_policy_corruption_fails_closed_and_put_repairs(self):
        cases = [
            ('{', 'JSON'),
            (json.dumps({'primaryNodeId': self.a, 'backupNodeIds': [self.b, self.b]}), '重复备用'),
            (json.dumps({'primaryNodeId': self.a, 'backupNodeIds': [self.a]}), '重复列为备用'),
            (json.dumps({'primaryNodeId': 'missing-node', 'backupNodeIds': []}), '不存在的节点'),
            (json.dumps({'primaryNodeId': 'console', 'backupNodeIds': []}), '不符合要求的节点'),
        ]
        for raw, error in cases:
            with self.subTest(error=error):
                with self.store._db() as c:
                    c.execute("INSERT INTO probe_settings(key,value) VALUES('probe_execution_policy',?) "
                              "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (raw,))
                with self.assertRaisesRegex(ValueError, error):
                    self.store.get_execution_policy()
                with self.assertRaises(ValueError):
                    self.store.delete_node(self.a)
                self.assertEqual(self.store.get_node(self.a)['id'], self.a)
                repaired = self.store.set_execution_policy(self.b, [])
                self.assertEqual(repaired['primaryNodeId'], self.b)
                self.assertEqual(repaired['backupNodeIds'], [])

    def test_execution_policy_deletion_guard_and_job_snapshot(self):
        job = self.job(nodes=[self.a], ips=['192.0.2.1'])
        before = self.store.get_job(job['id'])
        self.store.set_execution_policy(self.a, [self.b])
        after = self.store.get_job(job['id'])
        self.assertEqual(after, before)
        with self.assertRaisesRegex(ValueError, '仍被主备测试策略引用'):
            self.store.delete_node(self.a)
        self.store.set_execution_policy(self.b, [])
        self.store.delete_node(self.a)
        self.assertEqual(self.store.get_execution_policy()['primaryNodeId'], self.b)

    def test_public_job_assignment_requires_and_uses_saved_primary(self):
        from fastapi import HTTPException
        from app.probe.router import JobCreate, jobs_create
        import app.probe.router as router

        payload = JobCreate(mode='connectivity', ips=['192.0.2.20'])
        before = len(self.store.list_jobs())
        from app.probe.engine import ProbeOptions
        with patch.object(router, 'job_store', return_value=self.store), \
             patch.object(router, '_effective_options', return_value=ProbeOptions()):
            with self.assertRaises(HTTPException) as unconfigured:
                jobs_create(payload)
            self.assertEqual(unconfigured.exception.status_code, 400)
            self.assertIn('配置测试节点', unconfigured.exception.detail)
            self.assertEqual(len(self.store.list_jobs()), before)

            self.set_primary(self.a)
            omitted = jobs_create(payload)
            matched = jobs_create(JobCreate(mode='connectivity', nodeIds=[self.a], ips=['192.0.2.21']))
            self.assertEqual({t['nodeId'] for t in omitted['tasks']}, {self.a})
            self.assertEqual({t['nodeId'] for t in matched['tasks']}, {self.a})

            for requested in ([self.b], [self.a, self.b], [self.a, self.a]):
                with self.subTest(requested=requested):
                    count = len(self.store.list_jobs())
                    with self.assertRaises(HTTPException) as rejected:
                        jobs_create(JobCreate(mode='connectivity', nodeIds=requested, ips=['192.0.2.22']))
                    self.assertEqual(rejected.exception.status_code, 400)
                    self.assertEqual(len(self.store.list_jobs()), count)

    def test_primary_assignment_reads_policy_and_inserts_tasks_in_same_write_transaction(self):
        self.set_primary(self.a)
        seen = {'policy_connections': []}
        original_policy = self.store._stored_execution_policy
        original_task = self.store._task

        def policy_spy(connection):
            seen['policy_connections'].append(connection)
            seen['policy_in_transaction'] = connection.in_transaction
            return original_policy(connection)

        def task_spy(connection, *args, **kwargs):
            seen['task_connection'] = connection
            seen['task_in_transaction'] = connection.in_transaction
            return original_task(connection, *args, **kwargs)

        self.store._stored_execution_policy = policy_spy
        self.store._task = task_spy
        self.store.get_execution_policy = lambda: (_ for _ in ()).throw(
            AssertionError('job assignment must not read policy in a separate transaction'))

        job = self.store.create_primary_job('connectivity', ips=['192.0.2.23'])

        self.assertEqual({task['nodeId'] for task in job['tasks']}, {self.a})
        self.assertTrue(seen['policy_in_transaction'])
        self.assertTrue(seen['task_in_transaction'])
        self.assertTrue(any(connection is seen['task_connection'] for connection in seen['policy_connections']))

    def test_primary_discovery_route_and_legacy_adapters_stay_single_node(self):
        from app.probe.adapters import LegacyDiscoverAdapter, LegacyProbeAdapter
        from app.probe.discover import DiscoverParams
        from app.probe.engine import ProbeOptions

        self.set_primary(self.a)
        discover = LegacyDiscoverAdapter(lambda: self.store, lambda: ProbeOptions())
        discover.start(DiscoverParams(['192.0.2.0/30'], [], 7000, 4, 1.0), auto_route=True)
        djob = self.store.get_job(discover.job_id)
        self.assertEqual({t['nodeId'] for t in djob['tasks']}, {self.a})
        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        first = self.store.claim(self.a)
        self.store.progress(self.a, first['taskId'], first['attemptId'], 1,
                            hits=[{'ip': '192.0.2.1', 'port': 7000, 'latencyMs': 1.0}],
                            progress={'scanned': 1, 'foundCount': 1})
        route_child = next(t for t in self.store.get_job(discover.job_id)['tasks'] if t['stage'] == 'route')
        self.assertEqual(route_child['nodeId'], self.a)

        legacy = LegacyProbeAdapter(lambda: self.store)
        ok, _ = legacy.start('connectivity', ['192.0.2.30'], ProbeOptions())
        self.assertTrue(ok)
        self.assertEqual({t['nodeId'] for t in self.store.get_job(legacy.job_id)['tasks']}, {self.a})

    def test_legacy_public_handlers_reject_non_primary_and_multiple_node_ids(self):
        from fastapi import HTTPException
        from app.probe.adapters import LegacyDiscoverAdapter, LegacyProbeAdapter
        from app.probe.engine import ProbeOptions
        from app.probe.router import DiscoverStart, TestStart, discover_start, start_test
        import app.probe.router as router

        self.set_primary(self.a)
        probe_adapter = LegacyProbeAdapter(lambda: self.store)
        discover_adapter = LegacyDiscoverAdapter(lambda: self.store, lambda: ProbeOptions())
        invalid_node_selections = ([self.b], [self.a, self.b], [self.a, self.a])
        with patch.object(router, 'runner', probe_adapter), \
             patch.object(router, 'discover_scans', discover_adapter), \
             patch.object(router, 'probe_store', return_value=ProbeStore(self.path)), \
             patch.object(router, '_effective_options', return_value=ProbeOptions()), \
             patch.object(router, 'audit'):
            for node_ids in invalid_node_selections:
                with self.subTest(endpoint='test', node_ids=node_ids):
                    before = len(self.store.list_jobs())
                    with self.assertRaises(HTTPException) as rejected:
                        start_test(TestStart(mode='connectivity', ips=['192.0.2.40'], nodeIds=list(node_ids)), 'tester')
                    self.assertEqual(rejected.exception.status_code, 400)
                    self.assertEqual(len(self.store.list_jobs()), before)

                with self.subTest(endpoint='discover', node_ids=node_ids):
                    before = len(self.store.list_jobs())
                    with self.assertRaises(HTTPException) as rejected:
                        discover_start(DiscoverStart(targets='192.0.2.0/30', nodeIds=list(node_ids)), 'tester')
                    self.assertEqual(rejected.exception.status_code, 400)
                    self.assertEqual(len(self.store.list_jobs()), before)

    def test_legacy_public_handlers_validate_bad_ids_before_busy_conflict(self):
        from fastapi import HTTPException
        from app.probe.adapters import LegacyDiscoverAdapter, LegacyProbeAdapter
        from app.probe.engine import ProbeOptions
        from app.probe.router import DiscoverStart, TestStart, discover_start, start_test
        import app.probe.router as router

        self.set_primary(self.a)
        probe_adapter = LegacyProbeAdapter(lambda: self.store)
        discover_adapter = LegacyDiscoverAdapter(lambda: self.store, lambda: ProbeOptions())
        with patch.object(router, 'runner', probe_adapter), \
             patch.object(router, 'discover_scans', discover_adapter), \
             patch.object(router, 'probe_store', return_value=ProbeStore(self.path)), \
             patch.object(router, '_effective_options', return_value=ProbeOptions()), \
             patch.object(router, 'audit'):
            ok, _ = probe_adapter.start('connectivity', ['192.0.2.41'], ProbeOptions())
            self.assertTrue(ok)
            with self.assertRaises(HTTPException) as rejected_test:
                start_test(TestStart(mode='connectivity', ips=['192.0.2.42'], nodeIds=[self.b]), 'tester')
            self.assertEqual(rejected_test.exception.status_code, 400)

            from app.probe.discover import DiscoverParams
            discover_adapter.start(DiscoverParams(['192.0.2.0/30'], [], 7000, 4, 1.0))
            with self.assertRaises(HTTPException) as rejected_discover:
                discover_start(DiscoverStart(targets='192.0.2.4/30', nodeIds=[self.b]), 'tester')
            self.assertEqual(rejected_discover.exception.status_code, 400)

    def test_legacy_route_delete_maps_concurrent_missing_node_to_404(self):
        from fastapi import HTTPException
        from app.probe import router as probe_router

        store = Mock()
        store.list_nodes.return_value = [{'id': self.a, 'name': 'node-a'}]
        store.delete_node.side_effect = KeyError(self.a)
        with patch.object(probe_router, 'job_store', return_value=store):
            with self.assertRaises(HTTPException) as raised:
                probe_router.route_nodes_delete('node-a', user='test')
        self.assertEqual(raised.exception.status_code, 404)
    def test_latest_failure_overrides_success_then_ttl(self):
        self.job();t=self.store.claim(self.a);self.finish(self.a,t,{'frps_reachable':True})
        self.job();t=self.store.claim(self.a);self.finish(self.a,t,{'frps_reachable':False})
        self.assertFalse(self.store.latest_results(self.a,'connectivity')[0]['frps_reachable'])
        with self.store._db() as c:c.execute("UPDATE probe_results SET test_time='2000-01-01T00:00:00+00:00' WHERE task_id=?",(t['taskId'],))
        self.assertEqual(self.store.latest_results(self.a,'connectivity',86400),[])
    def test_lease_fencing_and_max_three_attempts(self):
        j=self.job();first=self.store.claim(self.a);self.expire(first)
        second=self.store.claim(self.a);self.assertNotEqual(first['attemptId'],second['attemptId'])
        self.assertFalse(self.finish(self.a,first)['applied'])
        self.finish(self.a,second,infra_error='network')
        third=self.store.claim(self.a);self.finish(self.a,third,infra_error='network')
        self.assertIsNone(self.store.claim(self.a));self.assertEqual(self.store.get_job(j['id'])['state'],'failed')
    def test_target_failure_no_retry_and_report_idempotent(self):
        self.job();t=self.store.claim(self.a);self.finish(self.a,t,{'frps_reachable':False})
        response=self.finish(self.a,t,{'frps_reachable':True});self.assertFalse(response['applied']);self.assertTrue(response['accepted'])
        self.assertIsNone(self.store.claim(self.a));self.assertEqual(len(self.store.history(self.a,'connectivity')),1)
    def test_heartbeat_renew_and_cancel_cleanup_holds_host_lock(self):
        j=self.job(nodes=[self.a,self.b]);t=self.store.claim(self.a)
        with self.store._db() as c:c.execute('UPDATE probe_tasks SET lease_until=lease_until-50 WHERE id=?',(t['taskId'],))
        self.store.heartbeat(self.a,'sha',['connectivity'],[{'taskId':t['taskId'],'attemptId':t['attemptId']}])
        self.store.action(j['id'],'skip',[t['taskId']])
        self.assertIsNone(self.store.claim(self.b))
        hb=self.store.heartbeat(self.a,'sha',['connectivity'],[{'taskId':t['taskId'],'attemptId':t['attemptId']}]);self.assertEqual(len(hb['cancelled']),1)
        self.finish(self.a,t,{'cancelled':True});self.assertIsNotNone(self.store.claim(self.b))
    def test_speed_exclusive_node_other_hosts_tunnel_exclusive_host(self):
        self.job('route',ips=['192.0.2.10']);route=self.store.claim(self.a)
        self.job('speed',ips=['192.0.2.2']);self.assertIsNone(self.store.claim(self.a))
        self.finish(self.a,route);speed=self.store.claim(self.a)
        self.job('route',ips=['192.0.2.3']);self.assertIsNone(self.store.claim(self.a));self.finish(self.a,speed)
        self.assertEqual(self.store.claim(self.a)['stage'],'route')
    def test_full_route_failure_continues_conn_failure_skips_speed(self):
        j=self.job('full');t=self.store.claim(self.a);self.finish(self.a,t,{'ok':False})
        t=self.store.claim(self.a);self.assertEqual(t['stage'],'connectivity');self.finish(self.a,t,{'frps_reachable':False})
        job=self.store.get_job(j['id']);self.assertEqual(job['counts'],{'failed':2,'skipped':1});self.assertIsNone(self.store.claim(self.a))
    def test_full_pass_speed(self):
        self.job('full');self.finish(self.a,self.store.claim(self.a),{'ok':False})
        self.finish(self.a,self.store.claim(self.a),{'frps_reachable':True,'tunnel_established':True,'firewall_open':True})
        self.assertEqual(self.store.claim(self.a)['stage'],'speed')
    def test_scan_chunk_bounded_restart_unacked_and_seq_atomic(self):
        j=self.store.create_job('discover',[self.a],targets='10.0.0.1-10.0.39.16',auto_full=True,concurrency=20)
        task=self.store.claim(self.a);self.assertEqual(task['payload']['size'],4096)
        hit={'ip':'10.0.0.1','port':7000,'latencyMs':1.2}
        self.assertTrue(self.store.progress(self.a,task['taskId'],task['attemptId'],1,hits=[hit])['accepted'])
        self.store.progress(self.a,task['taskId'],task['attemptId'],1,hits=[hit])
        detail=self.store.get_job(j['id']);self.assertEqual(len(detail['tasks']),2)
        self.expire(task);reopened=ProbeJobStore(self.path);new=reopened.claim(self.a)
        self.assertEqual(new['payload']['cursor'],0)
        self.finish(self.a,new,{'scanned':4096})
        tasks=reopened.get_job(j['id'])['tasks'];self.assertEqual(sum(t['stage']=='discover' for t in tasks),2)
        self.assertTrue(any(t['payload'].get('cursor')==4096 for t in tasks))
        self.assertEqual(len(ProbeStore(self.path,node_id=self.a).query_discover_results(DiscoverPageQuery())['items']),1)
    def test_progress_validation_rolls_back_and_fencing(self):
        self.store.create_job('discover',[self.a],targets='192.0.2.1',auto_route=True)
        t=self.store.claim(self.a)
        with self.assertRaises(ValueError):self.store.progress(self.a,t['taskId'],t['attemptId'],1,hits=[{'ip':'192.0.2.1'},{'ip':'192.0.2.2'}])
        self.assertEqual(ProbeStore(self.path).query_discover_results(DiscoverPageQuery())['total'],0)
        self.assertFalse(self.store.progress(self.a,t['taskId'],'wrong',1)['accepted'])
    def test_retry_selected_and_empty_list_noop(self):
        j=self.job();t=self.store.claim(self.a);self.store.action(j['id'],'stop');self.finish(self.a,t)
        self.assertEqual(self.store.action(j['id'],'retry',[])['changed'],0)
        self.assertEqual(self.store.action(j['id'],'retry',[t['taskId']])['changed'],1)
        self.assertIsNotNone(self.store.claim(self.a))
    def test_legacy_nodes_migration_stable_deleted_not_resurrected_upgrade(self):
        path=Path(self.tmp.name)/'legacy.db';old=ProbeStore(path);old.set_setting('route_nodes',json.dumps([{'name':'legacy','token':'saved-token'}]))
        store=ProbeJobStore(path);node=store.authenticate('saved-token');self.assertEqual(node['capabilities'],['route'])
        self.assertEqual(ProbeJobStore(path).authenticate('saved-token')['id'],node['id'])
        store.heartbeat(node['id'],'new',['discover','route','connectivity','speed'],[]);self.assertEqual(store.get_node(node['id'])['kind'],'worker')
        store.delete_node(node['id']);self.assertEqual(len(ProbeJobStore(path).list_nodes()),1)
    def test_source_query_filters_and_speed_sort(self):
        assets=ProbeStore(self.path);assets.create_server(ip='192.0.2.1');assets.create_server(ip='192.0.2.2')
        self.job('speed',ips=['192.0.2.1','192.0.2.2']);t=self.store.claim(self.a);self.finish(self.a,t,{'dl_ok':True,'dl_speed_bps':1024*1024,'ul_speed_bps':2})
        t=self.store.claim(self.a);self.finish(self.a,t,{'dl_ok':False,'dl_speed_bps':0})
        a=ProbeStore(self.path,node_id=self.a).query_servers(ServerPageQuery(sort='speed',order='desc'))
        self.assertEqual(a['items'][0]['ip'],'192.0.2.1');self.assertEqual(a['items'][0]['s_dl_speed_mbps'],8)
        b=ProbeStore(self.path,node_id=self.b).query_servers(ServerPageQuery());self.assertIsNone(b['items'][0]['s_test_time'])

    def test_fixed_port_current_result_lookup_ignores_configured_frps_port(self):
        assets=ProbeStore(self.path)
        assets.create_server(ip='192.0.2.44')
        assets.update_config_overrides({'frps_port':7001})
        self.job(ips=['192.0.2.44'])
        task=self.store.claim(self.a)
        self.assertEqual(task['port'],7000)
        self.finish(self.a,task,{'frps_reachable':True,'tunnel_established':True,'firewall_open':True})

        row=ProbeStore(self.path,node_id=self.a).query_servers(ServerPageQuery())['items'][0]
        self.assertTrue(row['c_frps_reachable'])
        self.assertIsNotNone(row['c_test_time'])
    def test_worker_bundle_uses_canonical_sources(self):
        self.assertEqual(worker_bundle(),worker_bundle())
        with tarfile.open(fileobj=io.BytesIO(worker_bundle())) as archive:
            self.assertEqual(archive.extractfile('app/probe/engine.py').read(),Path('app/probe/engine.py').read_bytes())
            self.assertEqual(archive.extractfile('app/probe/discover.py').read(),Path('app/probe/discover.py').read_bytes())
            worker_source = archive.extractfile('app/probe/worker.py').read()
            self.assertEqual(worker_source, Path('app/probe/worker.py').read_bytes())
            self.assertIn(b'task-generation-v1', worker_source)


    def test_retry_preserves_gate_and_successful_downstream(self):
        j=self.job('full');route=self.store.claim(self.a);self.finish(self.a,route,{'ok':False})
        conn=self.store.claim(self.a);self.finish(self.a,conn,{'frps_reachable':False})
        speed=next(t for t in self.store.get_job(j['id'])['tasks'] if t['stage']=='speed')
        self.assertEqual(self.store.action(j['id'],'retry',[speed['taskId']])['changed'],0)
        self.store.action(j['id'],'retry',[conn['taskId']]);conn2=self.store.claim(self.a)
        self.finish(self.a,conn2,{'frps_reachable':True,'tunnel_established':True,'firewall_open':True})
        speed2=self.store.claim(self.a);self.assertEqual(speed2['taskId'],speed['taskId'])
        self.finish(self.a,speed2,{'dl_ok':True,'ul_ok':True})
        self.store.action(j['id'],'retry',[route['taskId']]);route2=self.store.claim(self.a);self.finish(self.a,route2,{'ok':True})
        self.assertIsNone(self.store.claim(self.a))
        self.assertEqual(self.store.get_job(j['id'])['taskTotal'],3)
        self.assertEqual(len(self.store.history(self.a,'connectivity')),2)
    def test_parallel_connectivity_slots_and_paged_detail(self):
        j=self.job(ips=['192.0.2.1','192.0.2.2'])
        first=self.store.claim(self.a);second=self.store.claim(self.a)
        self.assertEqual(abs(first['options']['local_base_port']-second['options']['local_base_port']),3)
        page=self.store.get_job(j['id'],1,1);self.assertEqual(len(page['tasks']),1);self.assertEqual(page['taskTotal'],2)


    def test_endpoint_ports_not_mixed_in_asset_status(self):
        assets=ProbeStore(self.path)
        assets.create_server(ip='192.0.2.1');assets.create_server(ip='192.0.2.1:7001')
        self.job(ips=['192.0.2.1:7000'])
        first=self.store.claim(self.a);self.assertEqual(first['port'],7000);self.finish(self.a,first,{'frps_reachable':True,'tunnel_established':True,'firewall_open':True})
        rows={r['ip']:r for r in ProbeStore(self.path,node_id=self.a).query_servers(ServerPageQuery())['items']}
        self.assertTrue(rows['192.0.2.1']['c_frps_reachable']);self.assertIsNone(rows['192.0.2.1:7001']['c_frps_reachable'])
        self.assertEqual(len(self.store.latest_results(self.a,'connectivity')),1)


    def test_local_bind_and_nonexecutable_frpc_are_infrastructure(self):
        import socket
        from app.probe.executor import execute_task,InfrastructureError
        sock=socket.socket();sock.bind(('0.0.0.0',0));sock.listen(16)
        try:
            task={'stage':'connectivity','ip':'127.0.0.1','port':sock.getsockname()[1],'options':{'tcping_retries':1,'local_base_port':sock.getsockname()[1],'frpc_bin':'/bin/echo'}}
            with self.assertRaises(InfrastructureError):execute_task(task,lambda:False,lambda *a:None)
            bad=Path(self.tmp.name)/'bad-frpc';bad.write_text('bad');bad.chmod(0o600)
            task['options']['local_base_port']=0;task['options']['frpc_bin']=str(bad)
            with self.assertRaises(InfrastructureError):execute_task(task,lambda:False,lambda *a:None)
        finally:sock.close()
    def test_local_service_stop_closes_accepted_clients(self):
        import socket,time
        from app.probe.engine import LocalEchoServer
        service=LocalEchoServer(0);self.assertTrue(service.start()[0])
        client=socket.create_connection(('127.0.0.1',service.server_socket.getsockname()[1]));client.sendall(b'hello');self.assertEqual(client.recv(5),b'hello')
        service.stop();client.settimeout(1);self.assertEqual(client.recv(1),b'');client.close()
        self.assertFalse(service._clients);self.assertFalse(service._handlers)


    def test_config_snapshot_port_ranges_do_not_overlap(self):
        self.job(ips=['192.0.2.1'],options={'local_base_port':11564})
        first=self.store.claim(self.a)
        self.job(ips=['192.0.2.2','192.0.2.3'],options={'local_base_port':11561})
        second=self.store.claim(self.a);third=self.store.claim(self.a)
        ranges=[set(range(t['options']['local_base_port'],t['options']['local_base_port']+3)) for t in (first,second,third)]
        self.assertFalse(ranges[0]&ranges[1]);self.assertFalse(ranges[0]&ranges[2]);self.assertFalse(ranges[1]&ranges[2])


    def test_endpoint_aliases_no_duplicate_rows_and_latest_failed_dashboard(self):
        assets=ProbeStore(self.path)
        assets.create_server(ip='192.0.2.1');assets.create_server(ip='192.0.2.1:7000')
        self.job('speed');self.finish(self.a,self.store.claim(self.a),{'dl_ok':True,'ul_ok':True,'dl_speed_bps':1048576,'ul_speed_bps':1048576})
        source=ProbeStore(self.path,node_id=self.a)
        rows=source.query_servers(ServerPageQuery());self.assertEqual(rows['total'],2);self.assertEqual(len(rows['items']),2)
        self.assertEqual(source.dashboard()['speed']['avgDownloadMbps'],8)
        self.job('speed');self.finish(self.a,self.store.claim(self.a),{'dl_ok':False,'ul_ok':False})
        self.assertIsNone(source.dashboard()['speed']['avgDownloadMbps'])

    def test_stage_counts_cover_whole_job_independent_of_task_page(self):
        job = self.job(nodes=[self.a, self.b], ips=['192.0.2.1', '192.0.2.2', '192.0.2.3'])
        self.store.claim(self.a)
        detail = self.store.get_job(job['id'], page=1, page_size=1)
        self.assertEqual(len(detail['tasks']), 1)
        counts = detail['stageCounts']
        self.assertEqual(sum(row['count'] for row in counts), 6)
        self.assertEqual(sum(row['count'] for row in counts if row['nodeId'] == self.a), 3)
        self.assertEqual(sum(row['count'] for row in counts if row['nodeId'] == self.b), 3)
        self.assertEqual(sum(row['count'] for row in counts if row['state'] == 'running'), 1)
        self.assertTrue(all(row['stage'] == 'connectivity' for row in counts))

    def test_job_detail_waiting_failover_count_is_unfiltered_and_unpaged(self):
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b])
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.61', '192.0.2.62', '192.0.2.63'])
        with self.store._db() as c:
            task_ids = [row['id'] for row in c.execute('SELECT id FROM probe_tasks WHERE job_id=? ORDER BY ip', (job['id'],))]
            c.execute("UPDATE probe_tasks SET state='done' WHERE id=?", (task_ids[0],))
            # Exercise the legacy error marker fallback alongside the new flag.
            c.execute("UPDATE probe_tasks SET failover_waiting=0 WHERE id=?", (task_ids[1],))

        detail = self.store.get_job(job['id'], page=1, page_size=1, state='done', target='192.0.2.61')
        self.assertEqual(len(detail['tasks']), 1)
        self.assertEqual(detail['filteredTaskTotal'], 1)
        self.assertEqual(detail['failoverWaitingCount'], 2)


    def test_runtime_capabilities_require_dependencies(self):
        from app.probe.worker import runtime_capabilities
        with patch('app.probe.worker.shutil.which',return_value=None):
            self.assertEqual(runtime_capabilities('/missing/frpc'),['discover'])
            self.assertEqual(runtime_capabilities('/bin/echo'),['discover','connectivity','speed'])


    def test_legacy_console_results_keep_original_port_after_config_change(self):
        assets=ProbeStore(self.path);assets.create_server(ip='192.0.2.1')
        assets.update_config_overrides({'frps_port':7000})
        assets.add_connectivity_result({'server_ip':'192.0.2.1','frps_reachable':True,'tunnel_established':True,'firewall_open':True})
        self.assertTrue(ProbeStore(self.path,node_id='console').query_servers(ServerPageQuery())['items'][0]['c_frps_reachable'])
        assets.update_config_overrides({'frps_port':7001})
        rows=ProbeStore(self.path,node_id='console').query_servers(ServerPageQuery())['items']
        self.assertTrue(rows[0]['c_frps_reachable'])
        self.assertEqual(self.store.latest_results('console','connectivity')[0]['port'],7000)
    def test_worker_lease_loss_reports_infra_after_execution(self):
        import threading
        from app.probe.worker import Worker
        reports=[]
        worker=Worker(lambda path,payload:reports.append((path,payload)) or {'accepted':True})
        task={'taskId':'t','attemptId':'a'}
        entry={'task':task,'key':'t:a','renewed':0,'cancel':threading.Event()}
        worker.active[entry['key']]=entry
        with patch('app.probe.worker.time.monotonic',return_value=100),patch('app.probe.worker.execute_task',return_value={'cancelled':True}):worker._run(entry)
        self.assertEqual(reports[0][0],'report');self.assertIn('infraError',reports[0][1]);self.assertNotIn('result',reports[0][1])


    def test_preexisting_history_survives_migration_with_visible_snapshots(self):
        path=Path(self.tmp.name)/'historical.db';old=ProbeStore(path);old.create_server(ip='192.0.2.1')
        from app.control.database import connect_database
        c=connect_database(path)
        try:
            c.execute("INSERT INTO probe_connectivity_results(server_ip,frps_reachable,tunnel_established,firewall_open,test_time) VALUES('192.0.2.1',1,1,1,'2026-10-21T00:00:00+00:00')")
            c.execute("INSERT INTO probe_speed_results(server_ip,dl_ok,ul_ok,dl_speed_mbps,ul_speed_mbps,test_time) VALUES('192.0.2.1',1,1,8,4,'2026-10-21T00:00:00+00:00')")
            c.commit()
        finally:c.close()
        jobs=ProbeJobStore(path);source=ProbeStore(path,node_id='console')
        row=source.query_servers(ServerPageQuery())['items'][0]
        self.assertTrue(row['c_frps_reachable']);self.assertEqual(row['s_dl_speed_mbps'],8)
        self.assertEqual(len(jobs.history('console','connectivity')),1)
        self.assertEqual(source.dashboard()['speed']['avgDownloadMbps'],8)

    def test_source_page_uses_bounded_indexed_projection(self):
        import ipaddress
        from dataclasses import replace

        base = int(ipaddress.IPv4Address('198.18.0.1'))
        ips = [str(ipaddress.IPv4Address(base + i)) for i in range(300)]
        ProbeStore(self.path).import_servers([{'ip': ip} for ip in ips])
        with self.store._db() as c:
            c.executemany(
                'INSERT INTO probe_results(task_id,job_id,node_id,kind,server_ip,port,test_time,data) VALUES(?,?,?,?,?,?,?,?)',
                [(f'perf-{i}-{generation}', '', self.a, 'connectivity', ip, 7000,
                  '2026-10-21T00:00:00+00:00', json.dumps({'frps_reachable': generation != 3}))
                 for i, ip in enumerate(ips) for generation in range(4)],
            )

        class BudgetStore(ProbeStore):
            def _source_views(self, connection):
                steps = 0
                def budget():
                    nonlocal steps
                    steps += 1000
                    return steps > 500_000
                connection.set_progress_handler(budget, 1000)
                super()._source_views(connection)

        source = BudgetStore(self.path, node_id=self.a)
        page = source.query_servers(replace(ServerPageQuery(), page_size=1))
        self.assertEqual(page['total'], 300)
        self.assertEqual(len(page['items']), 1)
        self.assertFalse(page['items'][0]['c_frps_reachable'])
        self.assertEqual(len(source.list_connectivity_history(ip=ips[0])), 4)
        filtered = self.store.latest_results(self.a, 'connectivity', ips=ips[:1])
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]['server_ip'], ips[0])
        self.assertEqual(self.store.latest_results(self.a, 'connectivity', ips=[]), [])

    def test_paged_jobs_and_history_keep_global_counts(self):
        first=self.job(ips=['192.0.2.10'])
        second=self.job(ips=['192.0.2.11'])
        third=self.job(ips=['192.0.2.12'])
        page=self.store.query_jobs(page=2,page_size=1,mode='connectivity',node_id=self.a)
        self.assertEqual(page['total'],3)
        self.assertEqual(len(page['items']),1)
        self.assertEqual(self.store.query_jobs(page=1,page_size=20,target='192.0.2.11')['items'][0]['id'],second['id'])
        self.assertEqual(self.store.query_jobs(page=1,page_size=20,target='192.0.2.11')['total'],1)
        self.assertEqual(self.store.get_job(first['id'],node_id=self.b)['filteredTaskTotal'],0)
        self.assertEqual(self.store.get_job(first['id'])['taskTotal'],1)
        task=self.store.claim(self.a)
        self.finish(self.a,task,{'frps_reachable':True})
        history=self.store.history_page(self.a,'connectivity',ip='192.0.2.10',port=7000)
        self.assertEqual(history['total'],1)
        self.assertEqual(history['items'][0]['job_id'],first['id'])
        self.assertEqual(self.store.history_page(self.b,'connectivity')['total'],0)
        self.assertEqual(self.store.query_jobs(page=1,page_size=20)['total'],3)

    def test_audit_pagination_searches_beyond_first_two_hundred(self):
        from app.control.audit_store import AuditStore
        audit=AuditStore(self.path)
        for i in range(205):audit.create_log(username='tester',action='review',message=f'entry-{i}',success=i!=0)
        result=audit.query_logs(page=5,page_size=50)
        self.assertEqual(result['total'],205)
        self.assertEqual(len(result['items']),5)
        self.assertEqual(audit.query_logs(page=1,page_size=50,success=False)['total'],1)
        self.assertEqual(audit.query_logs(page=1,page_size=50,keyword='entry-0')['total'],1)

    def test_explicit_job_scope_rejects_empty_or_mixed_target(self):
        from fastapi import HTTPException
        from app.probe.router import JobCreate, jobs_create
        with self.assertRaises(HTTPException) as empty:
            jobs_create(JobCreate(mode='connectivity',nodeIds=[self.a],ips=[],targetScope='explicit'))
        self.assertEqual(empty.exception.status_code,400)
        with self.assertRaises(HTTPException) as mixed:
            jobs_create(JobCreate(mode='connectivity',nodeIds=[self.a],ips=['192.0.2.1'],targetScope='all'))
        self.assertEqual(mixed.exception.status_code,400)

    def test_public_job_and_compat_discover_use_fixed_port(self):
        from fastapi import HTTPException
        from app.probe.engine import ProbeOptions
        from app.probe.router import JobCreate, DiscoverStart, jobs_create, discover_start
        from app.probe.adapters import LegacyDiscoverAdapter
        import app.probe.router as router

        self.set_primary(self.a)
        adapter = LegacyDiscoverAdapter(lambda: self.store, lambda: ProbeOptions(frps_port=7001))
        with patch.object(router, 'job_store', return_value=self.store), \
             patch.object(router, 'discover_scans', adapter), \
             patch.object(router, 'audit'), \
             patch.object(router, '_effective_options', return_value=ProbeOptions(frps_port=7001)):
            with self.assertRaises(HTTPException) as rejected:
                jobs_create(JobCreate(mode='connectivity', nodeIds=[self.a], ips=['192.0.2.1'], port=7001))
            self.assertEqual(rejected.exception.status_code, 400)

            job = jobs_create(JobCreate(mode='connectivity', nodeIds=[self.a], ips=['192.0.2.1']))
            self.assertEqual(job['tasks'][0]['port'], 7000)

            with self.assertRaises(HTTPException) as rejected_discovery:
                discover_start(DiscoverStart(targets='192.0.2.1', port=7001, nodeIds=[self.a]), 'tester')
            self.assertEqual(rejected_discovery.exception.status_code, 400)

            discovered = discover_start(DiscoverStart(targets='192.0.2.1', nodeIds=[self.a]), 'tester')
            self.assertEqual(discovered['total'], 1)
            stored = self.store.get_job(discovered['jobId'])
            self.assertEqual(stored['tasks'][0]['port'], 7000)

    def test_legacy_test_api_uses_fixed_port_when_config_differs(self):
        from fastapi import HTTPException
        from app.probe.adapters import LegacyProbeAdapter
        from app.probe.engine import ProbeOptions
        from app.probe.router import TestStart, start_test
        import app.probe.router as router

        assets=ProbeStore(self.path)
        assets.create_server(ip='192.0.2.1')
        self.set_primary(self.a)
        legacy_runner=LegacyProbeAdapter(lambda:self.store)
        with patch.object(router, 'probe_store', return_value=assets), \
             patch.object(router, 'runner', legacy_runner), \
             patch.object(router, 'audit'), \
             patch.object(router, '_effective_options', return_value=ProbeOptions(frps_port=7001)), \
             patch.object(router.settings, 'probe_frpc_bin', '/bin/echo'):
            with self.assertRaises(HTTPException) as rejected:
                start_test(TestStart(mode='connectivity', ips=['192.0.2.1:7001']), 'tester')
            self.assertEqual(rejected.exception.status_code, 400)
            self.assertEqual(self.store.list_jobs(), [])

            response = start_test(TestStart(mode='connectivity'), 'tester')

        self.assertNotIn('jobId', response)
        stored = self.store.get_job(legacy_runner.job_id)
        self.assertEqual(stored['tasks'][0]['port'], 7000)

    def test_route_start_maps_nonfixed_discovery_endpoint_to_400(self):
        from fastapi import HTTPException
        from app.probe.router import RouteStart, route_start
        from unittest.mock import Mock
        import app.probe.router as router

        assets=Mock()
        assets.get_discover_results_by_ids.return_value=[{'ip':'192.0.2.44:7001'}]
        self.set_primary(self.a)
        before=len(self.store.list_jobs())
        with patch.object(router, 'probe_store', return_value=assets), \
             patch.object(router, 'job_store', return_value=self.store):
            with self.assertRaises(HTTPException) as rejected:
                route_start(RouteStart(ids=[1]), 'tester')

        self.assertEqual(rejected.exception.status_code,400)
        self.assertEqual(len(self.store.list_jobs()),before)

    def test_primary_managed_pending_task_waits_then_fails_over_to_first_online_backup(self):
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b])
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.31'])
        task_id = job['tasks'][0]['taskId']
        with self.store._db() as c:
            before = c.execute('SELECT attempts,generation,node_id,error FROM probe_tasks WHERE id=?', (task_id,)).fetchone()
            self.assertEqual(before['node_id'], self.a)
            self.assertEqual(before['generation'], 0)
            self.assertEqual(before['error'], 'waiting for an online backup')
        self.online_generation_worker(self.b)
        claimed = self.store.claim(self.b)
        self.assertEqual(claimed['taskId'], task_id)
        self.assertEqual(claimed['generation'], 1)
        with self.store._db() as c:
            after = c.execute('SELECT attempts,generation,node_id FROM probe_tasks WHERE id=?', (task_id,)).fetchone()
            transfer = c.execute('SELECT from_node_id,to_node_id,generation,reason FROM probe_task_transfers WHERE task_id=?', (task_id,)).fetchone()
        self.assertEqual(after['attempts'], before['attempts'] + 1)
        self.assertEqual(after['node_id'], self.b)
        self.assertEqual(tuple(transfer), (self.a, self.b, 1, 'pending_owner_offline'))

    def test_failover_skips_online_old_backup_until_heartbeat_advertises_feature(self):
        cnode = self.store.create_node('generation-worker')['id']
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b, cnode])
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.35'])
        # A legacy backup stays valid configuration and online, but cannot take over.
        self.store.heartbeat(self.b, 'old', ['discover', 'route', 'connectivity', 'speed'], [])
        self.assertEqual(self.store.get_node(self.b)['protocolFeatures'], [])
        # Advertising support through the normal heartbeat makes the later backup eligible.
        self.store.heartbeat(cnode, 'new', ['discover', 'route', 'connectivity', 'speed'], [], ['task-generation-v1'])
        self.assertEqual(self.store.get_node(cnode)['protocolFeatures'], ['task-generation-v1'])
        claimed = self.store.claim(cnode)
        self.assertEqual(claimed['taskId'], job['tasks'][0]['taskId'])
        self.assertEqual(claimed['nodeId'], cnode)
        self.assertEqual(claimed['generation'], 1)

    def test_claim_rechecks_generation_protocol_after_backup_downgrade(self):
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b])
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.36'])
        task_id = job['tasks'][0]['taskId']
        self.store.heartbeat(self.b, 'new', ['discover', 'route', 'connectivity', 'speed'], [], ['task-generation-v1'])
        with self.store._db() as c:
            transferred = c.execute('SELECT node_id,generation,state FROM probe_tasks WHERE id=?', (task_id,)).fetchone()
        self.assertEqual(tuple(transferred), (self.b, 1, 'pending'))

        # A legacy/downgraded heartbeat clears the feature before claim.
        self.store.heartbeat(self.b, 'old', ['discover', 'route', 'connectivity', 'speed'], [])
        self.assertIsNone(self.store.claim(self.b))
        with self.store._db() as c:
            waiting = c.execute('SELECT node_id,generation,state FROM probe_tasks WHERE id=?', (task_id,)).fetchone()
        self.assertEqual(tuple(waiting), (self.b, 1, 'pending'))

        self.store.heartbeat(self.b, 'new', ['discover', 'route', 'connectivity', 'speed'], [], ['task-generation-v1'])
        claimed = self.store.claim(self.b)
        self.assertEqual(claimed['taskId'], task_id)
        self.assertEqual(claimed['generation'], 1)

    def test_online_downgraded_generation_owner_fails_over_to_later_capable_backup(self):
        cnode = self.store.create_node('later-generation-worker')['id']
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b, cnode])
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.39'])
        task_id = job['tasks'][0]['taskId']
        self.online_generation_worker(self.b)
        with self.store._db() as c:
            first = c.execute('SELECT node_id,generation FROM probe_tasks WHERE id=?', (task_id,)).fetchone()
            c.execute('UPDATE probe_nodes SET protocol_features=? WHERE id=?', ('[]', self.b))
        self.assertEqual(tuple(first), (self.b, 1))

        # B is still heartbeat-online, but has lost the generation protocol.
        self.online_generation_worker(cnode)
        with self.store._db() as c:
            task = c.execute('SELECT node_id,generation,state FROM probe_tasks WHERE id=?', (task_id,)).fetchone()
            transfers = c.execute('SELECT from_node_id,to_node_id,generation FROM probe_task_transfers WHERE task_id=? ORDER BY id', (task_id,)).fetchall()
        self.assertEqual(tuple(task), (cnode, 2, 'pending'))
        self.assertEqual([tuple(row) for row in transfers], [(self.a, self.b, 1), (self.b, cnode, 2)])

    def test_reported_pipeline_child_inherits_generation_and_backup_protocol_fence(self):
        cnode = self.store.create_node('pipeline-later-worker')['id']
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b, cnode])
        job = self.store.create_primary_job('full', ips=['192.0.2.40'])
        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        route = self.store.claim(self.a)
        self.expire(route)
        with self.store._db() as c:
            c.execute('UPDATE probe_nodes SET last_seen=0 WHERE id=?', (self.a,))
        self.online_generation_worker(self.b)
        # The heartbeat rehomes the pending expired route; B then claims it.
        takeover = self.store.claim(self.b)
        self.assertEqual(takeover['generation'], 1)
        self.assertTrue(self.store.report(self.b, takeover['taskId'], takeover['attemptId'], generation=1, result={'ok': True})['applied'])
        with self.store._db() as c:
            child = c.execute("SELECT id,node_id,generation,state FROM probe_tasks WHERE job_id=? AND stage='connectivity'", (job['id'],)).fetchone()
        self.assertEqual(tuple(child)[1:], (self.b, 1, 'pending'))

        # B remains heartbeat-online, but a downgraded version loses ownership.
        self.store.heartbeat(self.b, 'old', ['discover', 'route', 'connectivity', 'speed'], [])
        self.online_generation_worker(cnode)
        with self.store._db() as c:
            child_after = c.execute('SELECT node_id,generation,state FROM probe_tasks WHERE id=?', (child['id'],)).fetchone()
        self.assertEqual(tuple(child_after), (cnode, 2, 'pending'))
        self.assertIsNone(self.store.claim(self.b))

    def test_managed_generation_zero_task_on_backup_requires_protocol_feature(self):
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b])
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.41'])
        task_id = job['tasks'][0]['taskId']
        # Recreate the legacy child-task shape: managed job, backup owner, generation zero.
        with self.store._db() as c:
            c.execute('UPDATE probe_tasks SET node_id=? WHERE id=?', (self.b, task_id))
        self.store.heartbeat(self.b, 'old', ['discover', 'route', 'connectivity', 'speed'], [])
        self.assertIsNone(self.store.claim(self.b))
        with self.store._db() as c:
            waiting = c.execute('SELECT node_id,generation,state FROM probe_tasks WHERE id=?', (task_id,)).fetchone()
        self.assertEqual(tuple(waiting), (self.b, 0, 'pending'))
        self.store.heartbeat(self.b, 'new', ['discover', 'route', 'connectivity', 'speed'], [], ['task-generation-v1'])
        claimed = self.store.claim(self.b)
        self.assertEqual(claimed['generation'], 0)

    def test_expired_wait_flag_clears_when_primary_heartbeat_recovers(self):
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b])
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.42'])
        task_id = job['tasks'][0]['taskId']
        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        task = self.store.claim(self.a)
        self.expire(task)
        with self.store._db() as c:
            c.execute('UPDATE probe_nodes SET last_seen=0 WHERE id=?', (self.a,))
        self.assertIsNone(self.store.claim(self.a))
        with self.store._db() as c:
            row = c.execute('SELECT state,error,failover_waiting FROM probe_tasks WHERE id=?', (task_id,)).fetchone()
        self.assertEqual(tuple(row), ('pending', 'waiting for an online backup', 1))

        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        claimed = self.store.claim(self.a)
        self.assertEqual(claimed['taskId'], task_id)
        self.assertEqual(claimed['generation'], 0)

    def test_pending_failover_processing_is_bounded_to_500_ids_per_expire(self):
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b])
        ips = [f'192.0.2.{address}' for address in range(1, 256)] + [f'192.0.3.{address}' for address in range(1, 256)]
        original_update = self.store._update_pending_error_batch
        updates = []
        def tracked_update(connection, job_id, owner_id, old_error, new_error, limit, **kwargs):
            changed = original_update(connection, job_id, owner_id, old_error, new_error, limit, **kwargs)
            updates.append((limit, changed))
            return changed
        self.store._update_pending_error_batch = tracked_update
        job = self.store.create_primary_job('connectivity', ips=ips)
        with self.store._db() as c:
            plan = [row['detail'] for row in c.execute(
                "EXPLAIN QUERY PLAN SELECT id FROM probe_tasks WHERE node_id=? AND state='pending' AND job_id=? ORDER BY created_at,rowid LIMIT 500",
                (self.a, job['id']),
            )]
            waiting = c.execute("SELECT COUNT(*) FROM probe_tasks WHERE job_id=? AND error='waiting for an online backup'", (job['id'],)).fetchone()[0]
        self.assertTrue(any('idx_probe_tasks_failover_batch' in detail for detail in plan), plan)
        self.assertEqual(waiting, 500)
        self.assertEqual(updates[-1], (500, 500))
        self.assertIsNone(self.store.claim(self.a))
        self.assertIn((500, 10), updates)
        self.assertIsNone(self.store.claim(self.a))
        self.assertTrue(all(limit <= 500 and changed <= 500 for limit, changed in updates))

        original_batch = self.store._pending_failover_batch
        examined = []
        def tracked_batch(connection, job_id, owner_id, limit, **kwargs):
            rows = original_batch(connection, job_id, owner_id, limit, **kwargs)
            examined.append((limit, len(rows)))
            return rows
        self.store._pending_failover_batch = tracked_batch
        self.online_generation_worker(self.b)
        self.assertEqual(sum(count for _, count in examined), 500)
        self.assertTrue(all(limit <= 500 and count <= 500 for limit, count in examined))
        with self.store._db() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM probe_task_transfers WHERE job_id=?', (job['id'],)).fetchone()[0], 500)

        self.online_generation_worker(self.b)
        with self.store._db() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM probe_task_transfers WHERE job_id=?', (job['id'],)).fetchone()[0], 510)

    def test_job_policy_snapshot_survives_reorder_without_returning_to_former_primary(self):
        cnode = self.store.create_node('snapshot-later-backup')['id']
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b, cnode])
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.37'])
        with self.store._db() as c:
            snapshot = json.loads(c.execute('SELECT execution_policy FROM probe_jobs WHERE id=?', (job['id'],)).fetchone()[0])
        self.assertEqual(snapshot, {'primaryNodeId': self.a, 'backupNodeIds': [self.b, cnode]})

        # Heartbeat B to transfer from A without claiming the task.
        self.online_generation_worker(self.b)
        with self.store._db() as c:
            first_transfer = c.execute('SELECT node_id,generation,state FROM probe_tasks WHERE id=?', (job['tasks'][0]['taskId'],)).fetchone()
        self.assertEqual(tuple(first_transfer), (self.b, 1, 'pending'))

        # The global policy now puts A before C, but this in-flight job keeps A -> B -> C.
        self.store.set_execution_policy(self.b, [self.a, cnode])
        with self.store._db() as c:
            c.execute('UPDATE probe_nodes SET last_seen=0 WHERE id=?', (self.b,))
        self.online_generation_worker(self.a)
        self.online_generation_worker(cnode)
        self.store.heartbeat(cnode, 'new', ['discover', 'route', 'connectivity', 'speed'], [], ['task-generation-v1'])
        with self.store._db() as c:
            task = c.execute('SELECT node_id,generation,state FROM probe_tasks WHERE id=?', (job['tasks'][0]['taskId'],)).fetchone()
            transfers = c.execute('SELECT from_node_id,to_node_id,generation FROM probe_task_transfers WHERE job_id=? ORDER BY id', (job['id'],)).fetchall()
        self.assertEqual(tuple(task), (cnode, 2, 'pending'))
        self.assertEqual([tuple(row) for row in transfers], [(self.a, self.b, 1), (self.b, cnode, 2)])
        claimed = self.store.claim(cnode)
        self.assertEqual(claimed['generation'], 2)

    def test_claim_polling_does_not_refresh_node_heartbeat_or_bypass_wait_state(self):
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b])
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.38'])
        task_id = job['tasks'][0]['taskId']
        with self.store._db() as c:
            self.assertEqual(c.execute('SELECT last_seen FROM probe_nodes WHERE id=?', (self.a,)).fetchone()[0], 0)
        self.assertIsNone(self.store.claim(self.a))
        self.assertIsNone(self.store.claim(self.b))
        with self.store._db() as c:
            owner_seen = c.execute('SELECT last_seen FROM probe_nodes WHERE id=?', (self.a,)).fetchone()[0]
            backup_seen = c.execute('SELECT last_seen FROM probe_nodes WHERE id=?', (self.b,)).fetchone()[0]
            task = c.execute('SELECT attempts,state,error FROM probe_tasks WHERE id=?', (task_id,)).fetchone()
        self.assertEqual(owner_seen, 0)
        self.assertEqual(backup_seen, 0)
        self.assertEqual(tuple(task), (0, 'pending', 'waiting for an online backup'))

        # A real heartbeat makes the current owner online and releases the wait.
        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        claimed = self.store.claim(self.a)
        self.assertEqual(claimed['generation'], 0)

    def test_expired_running_primary_task_fails_over_and_stale_generation_is_fenced(self):
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b])
        job = self.store.create_primary_job('connectivity', ips=['192.0.2.32'])
        task_id = job['tasks'][0]['taskId']
        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        first = self.store.claim(self.a)
        self.assertEqual(first['generation'], 0)
        self.expire(first)
        with self.store._db() as c:
            c.execute('UPDATE probe_nodes SET last_seen=0 WHERE id=?', (self.a,))
        self.online_generation_worker(self.b)
        second = self.store.claim(self.b)
        self.assertEqual(second['taskId'], task_id)
        self.assertEqual(second['generation'], 1)
        stale_heartbeat = self.store.heartbeat(self.b, 'test', ['connectivity'], [
            {'taskId': task_id, 'attemptId': second['attemptId'], 'generation': 0},
        ])
        self.assertEqual(stale_heartbeat['cancelled'], [
            {'taskId': task_id, 'attemptId': second['attemptId'], 'generation': 0},
        ])
        stale_progress = self.store.progress(self.a, task_id, first['attemptId'], 1, generation=0)
        self.assertFalse(stale_progress['accepted'])
        stale_report = self.store.report(self.a, task_id, first['attemptId'], generation=0,
                                         result={'frps_reachable': True, 'tunnel_established': True, 'firewall_open': True})
        self.assertFalse(stale_report['applied'])
        self.assertEqual(self.store.report(self.b, task_id, second['attemptId'], generation=1,
                                           result={'frps_reachable': True, 'tunnel_established': True, 'firewall_open': True})['applied'], True)
        history = self.store.latest_results(self.b, 'connectivity')
        self.assertEqual(history[0]['generation'], 1)
        with self.store._db() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM probe_results WHERE task_id=?', (task_id,)).fetchone()[0], 1)

    def test_ordered_backup_transfer_never_returns_to_primary_and_children_keep_backup_owner(self):
        cnode = self.store.create_node('c')['id']
        self.set_primary(self.a)
        self.store.set_execution_policy(self.a, [self.b, cnode])
        job = self.store.create_primary_job('full', ips=['192.0.2.33'])
        self.store.heartbeat(self.a, 'primary', ['discover', 'route', 'connectivity', 'speed'], [])
        route = self.store.claim(self.a)
        self.expire(route)
        with self.store._db() as c:
            c.execute('UPDATE probe_nodes SET last_seen=0 WHERE id=?', (self.a,))
        self.online_generation_worker(self.b)
        takeover = self.store.claim(self.b)
        self.assertEqual(takeover['generation'], 1)
        self.assertTrue(self.store.report(self.b, takeover['taskId'], takeover['attemptId'], generation=1, result={'ok': True})['applied'])
        with self.store._db() as c:
            child = c.execute("SELECT node_id,stage FROM probe_tasks WHERE job_id=? AND stage='connectivity'", (job['id'],)).fetchone()
            c.execute('UPDATE probe_nodes SET last_seen=0 WHERE id=?', (self.b,))
        self.online_generation_worker(cnode)
        self.assertEqual(tuple(child), (self.b, 'connectivity'))
        second_takeover = self.store.claim(cnode)
        self.assertEqual(second_takeover['generation'], 2)
        with self.store._db() as c:
            self.assertEqual(c.execute('SELECT node_id FROM probe_tasks WHERE id=?', (second_takeover['taskId'],)).fetchone()[0], cnode)
            transfers = c.execute('SELECT from_node_id,to_node_id,generation FROM probe_task_transfers WHERE job_id=? ORDER BY id', (job['id'],)).fetchall()
        self.assertEqual([tuple(row) for row in transfers], [(self.a, self.b, 1), (self.b, cnode, 2)])
        self.assertEqual(self.store.report(self.a, route['taskId'], route['attemptId'], result={'ok': True})['applied'], False)

    def test_unmanaged_low_level_job_keeps_its_explicit_owner(self):
        import time
        job = self.store.create_job('connectivity', [self.a], ips=['192.0.2.34'])
        with self.store._db() as c:
            c.execute('UPDATE probe_nodes SET last_seen=? WHERE id=?', (time.time(), self.b))
            c.execute('UPDATE probe_nodes SET last_seen=0 WHERE id=?', (self.a,))
            self.assertEqual(c.execute('SELECT primary_managed FROM probe_jobs WHERE id=?', (job['id'],)).fetchone()[0], 0)
        self.assertIsNone(self.store.claim(self.b))
        with self.store._db() as c:
            row = c.execute('SELECT node_id,generation FROM probe_tasks WHERE job_id=?', (job['id'],)).fetchone()
            self.assertEqual(tuple(row), (self.a, 0))
            self.assertEqual(c.execute('SELECT COUNT(*) FROM probe_task_transfers WHERE job_id=?', (job['id'],)).fetchone()[0], 0)

    def test_existing_sqlite_probe_schema_gets_additive_failover_columns(self):
        import sqlite3
        from app.control.database import initialize_database
        old_path = Path(self.tmp.name) / 'pre-failover.db'
        connection = sqlite3.connect(old_path)
        connection.executescript('''
            CREATE TABLE probe_jobs (
                id TEXT PRIMARY KEY, mode TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'running',
                options TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE probe_nodes (
                id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL DEFAULT 'worker', version TEXT NOT NULL DEFAULT '',
                capabilities TEXT NOT NULL DEFAULT '[]', last_seen REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            INSERT INTO probe_nodes(id,name,token,created_at) VALUES('old-node','Old node','old-token','2026-10-22T00:00:00+00:00');
            CREATE TABLE probe_tasks (
                id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES probe_jobs(id),
                node_id TEXT NOT NULL, stage TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '',
                port INTEGER NOT NULL, payload TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'pending',
                attempt_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_until REAL NOT NULL DEFAULT 0,
                seq INTEGER NOT NULL DEFAULT 0, progress TEXT NOT NULL DEFAULT '{}',
                error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
            );
            CREATE TABLE probe_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL DEFAULT '',
                job_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL,
                server_ip TEXT NOT NULL, port INTEGER NOT NULL, test_time TEXT NOT NULL, data TEXT NOT NULL,
                UNIQUE(task_id,attempt_id)
            );
            INSERT INTO probe_jobs(id,mode,options,created_at) VALUES('old-job','connectivity','{}','2026-10-22T00:00:00+00:00');
            INSERT INTO probe_tasks(id,job_id,node_id,stage,ip,port,created_at) VALUES('old-task','old-job','old-node','connectivity','192.0.2.50',7000,'2026-10-22T00:00:00+00:00');
            INSERT INTO probe_results(task_id,attempt_id,job_id,node_id,kind,server_ip,port,test_time,data)
                VALUES('old-task','old-attempt','old-job','old-node','connectivity','192.0.2.50',7000,'2026-10-22T00:00:00+00:00','{}');
        ''')
        connection.close()
        initialize_database(old_path)
        connection = sqlite3.connect(old_path)
        try:
            for table, expected in (('probe_nodes', 'protocol_features'), ('probe_jobs', 'primary_managed'), ('probe_jobs', 'execution_policy'), ('probe_tasks', 'generation'), ('probe_tasks', 'failover_waiting'), ('probe_results', 'generation')):
                columns = {row[1] for row in connection.execute(f'PRAGMA table_info({table})')}
                self.assertIn(expected, columns)
            self.assertEqual(connection.execute('SELECT primary_managed FROM probe_jobs WHERE id=?', ('old-job',)).fetchone()[0], 0)
            self.assertEqual(connection.execute('SELECT execution_policy FROM probe_jobs WHERE id=?', ('old-job',)).fetchone()[0], '{}')
            self.assertEqual(connection.execute('SELECT protocol_features FROM probe_nodes').fetchone()[0], '[]')
            self.assertEqual(connection.execute('SELECT generation FROM probe_tasks WHERE id=?', ('old-task',)).fetchone()[0], 0)
            self.assertEqual(connection.execute('SELECT failover_waiting FROM probe_tasks WHERE id=?', ('old-task',)).fetchone()[0], 0)
            self.assertEqual(connection.execute('SELECT generation FROM probe_results WHERE task_id=?', ('old-task',)).fetchone()[0], 0)
            self.assertIsNotNone(connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='probe_task_transfers'").fetchone())
        finally:
            connection.close()
