import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.setdefault('PROJECT_DIR', tempfile.mkdtemp(prefix='geoip-test-env-'))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import require_auth
from app.control.database import initialize_database
from app.geoip.database import open_snapshot
from app.geoip.router import router
from app.geoip.service import GeoService
from app.geoip.store import GeoStore, enrich
from app.lb.store import LbStore
from app.probe.jobs import ProbeJobStore
from app.probe.store import ProbeStore, ServerPageQuery

FIXTURE = Path(__file__).parent / 'fixtures/ipinfo_lite.sample.mmdb'


class GeoIpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'console.db'
        self.mmdb = Path(self.tmp.name) / 'geoip/ipinfo_lite.mmdb'
        self.mmdb.parent.mkdir()
        shutil.copyfile(FIXTURE, self.mmdb)
        self.probe = ProbeStore(self.path)
        self.geo = GeoService(self.path, self.mmdb)
        self.addCleanup(self.close_reader)

    def close_reader(self):
        if self.geo._snapshot:
            self.geo._snapshot.close()

    def drain(self):
        for _ in range(30):
            self.geo.step()
            state = self.geo.store.state()
            if (not self.geo.store.counts()['pending'] and state['backfill_phase'] == 'done'
                    and not state['refresh_requested']):
                return
        self.fail('maintenance did not converge')

    def hit(self, ip='1.0.0.1'):
        self.probe.upsert_discover_results_batch([(ip, 7000, 1)])

    def record(self, ip='1.0.0.1'):
        with self.geo.store.db() as c:
            row = c.execute('SELECT * FROM geoip_records WHERE ip=?', (ip,)).fetchone()
            return dict(row) if row else None

    def test_local_reader_country_asn_and_non_public(self):
        with patch('httpx.stream', side_effect=AssertionError('per-IP HTTP forbidden')):
            snapshot = open_snapshot(self.mmdb)
            try:
                record = snapshot.lookup('1.0.0.1')
                self.assertEqual((record['country_code'], record['asn']), ('AU', 'AS13335'))
                self.assertEqual(snapshot.lookup('10.0.0.1')['status'], 'non_public')
                self.assertEqual(snapshot.lookup('224.0.0.1')['status'], 'non_public')
                self.assertEqual(snapshot.lookup('8.8.8.8')['status'], 'not_found')
            finally:
                snapshot.close()

    def test_reader_version_pins_exact_bytes_even_when_mounted_path_changes(self):
        import hashlib
        import maxminddb
        original = maxminddb.open_database
        original_bytes = self.mmdb.read_bytes()
        def replace_path(*args, **kwargs):
            self.mmdb.write_bytes(b'replaced while loading')
            return original(*args, **kwargs)
        with patch('app.geoip.database.maxminddb.open_database', side_effect=replace_path):
            snapshot = open_snapshot(self.mmdb)
        try:
            self.assertEqual(snapshot.lookup('1.0.0.1')['country_code'], 'AU')
            self.assertEqual(snapshot.version, hashlib.sha256(original_bytes).hexdigest())
        finally:
            snapshot.close()

    def test_corrupt_record_does_not_poison_other_ips_in_batch(self):
        from maxminddb.errors import InvalidDatabaseError
        self.hit()
        self.hit('1.0.0.2')
        self.geo._load()
        original = self.geo._snapshot.lookup
        def lookup(ip):
            if ip == '1.0.0.1':
                raise InvalidDatabaseError('corrupt test record')
            return original(ip)
        with patch.object(self.geo._snapshot, 'lookup', side_effect=lookup):
            self.geo.step()
        self.assertEqual(self.record()['status'], 'error')
        self.assertEqual(self.record('1.0.0.2')['status'], 'ready')
        self.assertEqual(self.record('1.0.0.2')['queued'], 0)

    def test_discovery_is_idempotent_and_import_reuses_system_tags(self):
        self.hit()
        self.drain()
        first = self.record()
        self.hit()
        self.drain()
        self.assertEqual(self.record()['looked_up_at'], first['looked_up_at'])
        server = self.probe.create_server(ip='1.0.0.1', labels=['待观察'], server_group='生产')
        self.assertEqual(set(server.labels), {'AU', 'AS13335', '待观察'})
        with self.geo.store.db() as c:
            items = enrich(c, [{'ip': server.ip}])
        self.assertEqual(items[0]['geo']['asName'], 'Cloudflare, Inc.')
        tags = [tag for tag in self.probe.list_tags() if tag['source'] == 'geoip']
        self.assertTrue(all(tag['readOnly'] is True for tag in tags))
        result = self.probe.query_servers_cursor(ServerPageQuery(sort='ip', include_tag_ids=(tags[0]['id'],)))
        self.assertEqual([row['id'] for row in result['items']], [server.id])

    def test_untested_import_is_not_enqueued_and_failed_result_is(self):
        server = self.probe.create_server(ip='1.0.0.1')
        self.drain()
        self.assertIsNone(self.record())
        self.probe.add_connectivity_result({'server_ip': server.ip, 'frps_reachable': False})
        self.drain()
        self.assertEqual(self.record()['status'], 'ready')

    def test_ip_edit_removes_old_auto_projection_and_keeps_manual_same_name(self):
        self.hit()
        self.drain()
        # This manual tag deliberately collides with an automatic country code.
        manual_category = next(c['id'] for c in self.probe.list_tag_categories() if c['name'] == 'other')
        manual = self.probe.create_tag(manual_category, 'AU')
        server = self.probe.create_server(ip='1.0.0.1', labels=['人工'], tag_ids=[manual['id']])
        with self.geo.store.db() as c:
            item = enrich(c, [{'ip': server.ip, 'latestConnectivity': None}])[0]
        self.assertEqual(set(item['manualLabels']), {'AU', '人工'})
        updated = self.probe.update_server(server.id, ip='8.8.8.8')
        self.assertEqual(set(updated.labels), {'AU', '人工'})
        self.assertNotIn('AS13335', updated.labels)
        self.assertIsNone(self.record('8.8.8.8'))

    def test_rejected_cancelled_and_infrastructure_reports_do_not_enqueue(self):
        self.probe.create_server(ip='1.0.0.1')
        jobs = ProbeJobStore(self.path)
        node = jobs.create_node('test')['id']
        jobs.heartbeat(node, 'test', ['connectivity'], [], [])
        job = jobs.create_job('connectivity', [node], ips=['1.0.0.1'])
        task = jobs.claim(node)
        jobs.report(node, task['taskId'], 'old-attempt', result={})
        self.assertIsNone(self.record())
        jobs.report(node, task['taskId'], task['attemptId'], generation=999, result={})
        self.assertIsNone(self.record())
        jobs.report(node, task['taskId'], task['attemptId'], infra_error='offline')
        self.assertIsNone(self.record())
        task = jobs.claim(node)
        jobs.action(job['id'], 'stop')
        jobs.report(node, task['taskId'], task['attemptId'], result={})
        self.assertIsNone(self.record())
        jobs.create_job('connectivity', [node], ips=['1.0.0.1'])
        task = jobs.claim(node)
        jobs.report(node, task['taskId'], task['attemptId'], result={'frps_reachable': False})
        self.assertIsNotNone(self.record())

    def test_manual_writers_preserve_and_cannot_manage_auto_tags(self):
        self.hit()
        self.drain()
        server = self.probe.create_server(ip='1.0.0.1', labels=['人工'], server_group='生产')
        server = self.probe.update_server(server.id, labels=['AU', 'AS13335', '新人工'])
        self.assertEqual(set(server.labels), {'AU', 'AS13335', '新人工'})
        self.assertFalse(any(tag['name'] == 'AU' and tag['source'] == 'manual' for tag in self.probe.list_tags()))
        self.probe.update_servers_batch([server.id], remove_labels=['AU', 'AS13335'], group='')
        self.assertEqual(self.probe.get_server(server.id).server_group, '')
        self.assertIn('AU', self.probe.get_server(server.id).labels)
        tag = next(tag for tag in self.probe.list_tags() if tag['source'] == 'geoip')
        manual = self.probe.create_tag(next(c['id'] for c in self.probe.list_tag_categories() if c['name'] == 'other'), 'manual')
        operations = [lambda: self.probe.delete_tag(tag['id']),
                      lambda: self.probe.update_tag(tag['id'], name='renamed'),
                      lambda: self.probe.merge_tags(tag['id'], manual['id']),
                      lambda: self.probe.merge_tags(manual['id'], tag['id']),
                      lambda: self.probe.create_tag(tag['categoryId'], 'fake'),
                      lambda: self.probe.rename_tag_category(tag['categoryId'], 'renamed'),
                      lambda: self.probe.update_tag(manual['id'], category_id=tag['categoryId']),
                      lambda: self.probe.update_servers_batch([server.id], add_tag_ids=[tag['id']]),
                      lambda: self.probe.update_servers_batch([server.id], remove_tag_ids=[tag['id']])]
        for operation in operations:
            with self.assertRaises(ValueError):
                operation()
        self.probe.update_server(server.id, tag_ids=[manual['id']])
        self.assertEqual(set(self.probe.get_server(server.id).labels), {'AU', 'AS13335', 'manual'})

    def test_auto_refresh_preserves_manual_groups_and_domain_membership(self):
        self.hit()
        self.drain()
        server = self.probe.create_server(ip='1.0.0.1', labels=['manual'], server_group='生产')
        lb = LbStore(self.path)
        domain = lb.create_domain(name='geo.example.com', zone_id='zone', zone_name='example.com', server_ids=[server.id])
        old = self.record()
        updated = dict(old, country_code='JP', country='Japan', asn='AS2497', as_name='IIJ')
        self.geo.store.save_batch([updated], old['database_version'])
        self.assertEqual(set(self.probe.get_server(server.id).labels), {'JP', 'AS2497', 'manual'})
        self.assertEqual(self.probe.get_server(server.id).server_group, '生产')
        self.assertEqual(lb.domain_server_count(domain.id), 1)
        self.geo.store.request_refresh()
        self.drain()
        self.assertEqual(set(self.probe.get_server(server.id).labels), {'AU', 'AS13335', 'manual'})
        self.assertEqual(lb.domain_server_count(domain.id), 1)

    def test_unchanged_geo_refresh_does_not_rewrite_asset_tags_or_catalog(self):
        from app.probe.bulk import ServerBulkStore
        self.hit()
        self.drain()
        self.probe.create_server(ip='1.0.0.1', labels=['manual'])
        ServerBulkStore(self.path).create_selection('test', filters={})
        with self.geo.store.db() as c:
            before = c.execute('SELECT revision FROM probe_server_catalog_revision WHERE id=1').fetchone()[0]
        record = self.record()
        self.geo.store.save_batch([record], record['database_version'])
        with self.geo.store.db() as c:
            after = c.execute('SELECT revision FROM probe_server_catalog_revision WHERE id=1').fetchone()[0]
        self.assertEqual(before, after)

    def test_restart_missing_corrupt_database_and_old_version_write(self):
        self.mmdb.unlink()
        self.hit()
        self.geo.step()
        self.assertEqual(self.record()['queued'], 1)
        self.assertIn('尚未挂载', self.geo.status()['lastError'])
        shutil.copyfile(FIXTURE, self.mmdb)
        restarted = GeoService(self.path, self.mmdb)
        self.geo = restarted
        self.drain()
        record = self.record()
        self.assertFalse(self.geo.store.save_batch([dict(record, country_code='JP')], 'old-version'))
        self.assertEqual(self.record()['country_code'], 'AU')
        self.mmdb.write_bytes(b'not a database')
        self.geo._load()
        self.hit('1.0.0.2')
        self.drain()
        self.assertEqual(self.record('1.0.0.2')['country_code'], 'AU')

    def test_restart_missing_file_does_not_report_persisted_version_as_ready(self):
        self.hit()
        self.drain()
        self.assertTrue(self.geo.status()['version'])
        self.mmdb.unlink()
        restarted = GeoService(self.path, self.mmdb)
        restarted.step()
        self.assertIsNone(restarted.status()['version'])
        self.assertIn('尚未挂载', restarted.status()['lastError'])

    def test_backfill_resumes_in_bounded_batches(self):
        with self.geo.store.db() as c:
            c.executemany('INSERT OR IGNORE INTO probe_servers(ip,created_at) VALUES(?,?)',
                          [(f'11.0.{i//256}.{i%256}', 'now') for i in range(600)])
        self.assertTrue(self.geo.store.backfill())  # discovery -> assets
        self.geo.store.backfill()
        self.assertEqual(self.geo.store.state()['backfill_cursor'], 250)
        resumed = GeoStore(self.path)
        resumed.backfill()
        self.assertEqual(resumed.state()['backfill_cursor'], 500)
        self.drain()
        self.assertEqual(self.geo.store.counts()['pending'], 0)
        self.assertIsNone(self.record('11.0.0.1'))

    def test_measurement_summary_decoding_is_bounded_by_page_size(self):
        with self.geo.store.db() as c:
            c.executemany('INSERT INTO probe_servers(ip,ip_sort,server_group,created_at) VALUES(?,?,?,?)',
                          [(f'11.0.{i//256}.{i%256}', i, 'production', 'now') for i in range(1000)])
        calls = []
        class CountingStore(ProbeStore):
            def _source_views(inner, connection):
                super()._source_views(connection)
                connection.create_function('probe_endpoint_host', 1, lambda value: (calls.append(value), value)[1])
        page = CountingStore(self.path).query_servers(ServerPageQuery(sort='group', page_size=25))
        self.assertEqual(len(page['items']), 25)
        self.assertLessEqual(len(calls), 100)

    def test_tag_only_total_matches_page_for_empty_and_combined_filters(self):
        self.hit()
        self.drain()
        self.probe.create_server(ip='1.0.0.1')
        self.probe.create_server(ip='1.0.0.2')
        for query in (
            ServerPageQuery(tag_id=' '),
            ServerPageQuery(include_tag_ids=('geoip:country:AU',)),
            ServerPageQuery(include_tag_ids=('geoip:country:AU', 'geoip:asn:AS13335'), tag_mode='all'),
            ServerPageQuery(include_tag_ids=('geoip:country:AU', 'missing'), tag_mode='any'),
            ServerPageQuery(include_tag_ids=('geoip:country:AU', 'missing'), tag_mode='all'),
        ):
            page = self.probe.query_servers(query)
            self.assertEqual(page['total'], len(page['items']))
            self.assertEqual(page['total'], self.probe.count_servers(query))

    def test_stale_unreferenced_cache_requeues_when_rediscovered(self):
        self.hit()
        self.drain()
        with self.geo.store.db() as c:
            c.execute('DELETE FROM probe_discover_results')
        self.geo.store.activate('new-version', 2)
        while self.geo.store.refresh_batch():
            pass
        self.assertEqual(self.record()['queued'], 0)
        self.hit()
        self.assertEqual(self.record()['queued'], 1)
        self.assertEqual(self.geo.store.pending(0), ['1.0.0.1'])

    def test_fixed_port_legacy_asset_uses_canonical_ip_for_queue_tags_and_api(self):
        server = self.probe.create_server(ip='1.0.0.1:7000', labels=['manual'])
        self.probe.add_connectivity_result({'server_ip': server.ip, 'frps_reachable': False})
        self.assertIsNotNone(self.record())
        self.assertIsNone(self.record(server.ip))
        self.drain()
        self.assertEqual(set(self.probe.get_server(server.id).labels), {'AU', 'AS13335', 'manual'})
        with self.geo.store.db() as c:
            item = enrich(c, [{'ip': server.ip, 'latestConnectivity': None}])[0]
        self.assertEqual(item['geo']['countryCode'], 'AU')
        self.assertEqual(item['manualLabels'], ['manual'])

    def test_manual_attributes_survive_enrichment_outside_geo_address_scope(self):
        addresses = ('frps.example.com', '2001:db8::1', '1.0.0.1:7001')
        for address in addresses:
            self.probe.create_server(ip=address, labels=['manual'])
        with self.geo.store.db() as c:
            items = enrich(c, [{'ip': address, 'latestConnectivity': None} for address in addresses])
        self.assertTrue(all(item['manualLabels'] == ['manual'] and item['geo'] is None for item in items))
        for address in addresses:
            self.probe.add_connectivity_result({'server_ip': address, 'frps_reachable': False})
        with self.geo.store.db() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM geoip_records').fetchone()[0], 0)

    def test_manual_category_name_collisions_preserve_categories_and_system_identity(self):
        from app.geoip.schema import migrate
        with self.geo.store.db() as c:
            c.execute("DELETE FROM probe_tag_categories WHERE source='geoip'")
            for index, name in enumerate(('自动归属地', '自动归属地（系统）', '自动 ASN', '自动 ASN（系统）')):
                c.execute('INSERT INTO probe_tag_categories(id,name,created_at) VALUES(?,?,?)',
                          (f'manual-{index}', name, 'now'))
            c.commit()
            migrate(c)
        self.hit()
        self.drain()
        categories = self.probe.list_tag_categories()
        self.assertEqual(len([c for c in categories if c['id'].startswith('manual-')]), 4)
        self.assertEqual(len([c for c in categories if c['source'] == 'geoip']), 2)
        self.assertEqual(self.record()['status'], 'ready')

    def test_discovery_import_empty_group_clears_and_omission_inherits(self):
        self.hit('1.0.0.1')
        self.hit('1.0.0.2')
        with self.geo.store.db() as c:
            c.execute("UPDATE probe_discover_results SET server_group='生产'")
            ids = [row[0] for row in c.execute('SELECT id FROM probe_discover_results ORDER BY id')]
        self.probe.import_discover_results([ids[0]], group='')
        self.probe.import_discover_results([ids[1]])
        groups = {server.ip: server.server_group for server in self.probe.list_servers()}
        self.assertEqual(groups, {'1.0.0.1': '', '1.0.0.2': '生产'})

    def test_atomic_download_and_redacted_failure(self):
        self.geo.token = 'secret-token-value'
        response = MagicMock(status_code=200)
        response.iter_bytes.return_value = [FIXTURE.read_bytes()]
        with patch('httpx.stream') as stream:
            stream.return_value.__enter__.return_value = response
            self.geo.download()
        self.assertTrue(self.geo.status()['version'])
        before = self.mmdb.read_bytes()
        response.iter_bytes.return_value = [b'corrupt']
        with patch('httpx.stream') as stream:
            stream.return_value.__enter__.return_value = response
            self.geo.download()
        self.assertEqual(self.mmdb.read_bytes(), before)
        self.assertNotIn(self.geo.token, json.dumps(self.geo.status()))
        self.assertEqual(list(self.mmdb.parent.glob('.ipinfo-*')), [])

        import httpx
        def interrupted():
            yield FIXTURE.read_bytes()[:16]
            raise httpx.ReadError('interrupted download secret-token-value')
        response.iter_bytes.side_effect = interrupted
        with patch('httpx.stream') as stream:
            stream.return_value.__enter__.return_value = response
            self.geo.download()
        self.assertEqual(self.mmdb.read_bytes(), before)
        self.assertNotIn(self.geo.token, json.dumps(self.geo.status()))
        self.assertEqual(self.geo._snapshot.lookup('1.0.0.1')['country_code'], 'AU')
        self.assertEqual(list(self.mmdb.parent.glob('.ipinfo-*')), [])

    def test_authenticated_maintenance_api_and_disabled_service(self):
        app = FastAPI()
        app.include_router(router)
        app.state.geoip = self.geo
        with TestClient(app) as client:
            self.assertEqual(client.get('/api/geoip/status').status_code, 401)
            app.dependency_overrides[require_auth] = lambda: 'test'
            self.assertEqual(client.get('/api/geoip/status').status_code, 200)
            self.assertEqual(client.post('/api/geoip/update').status_code, 409)
            self.assertEqual(client.post('/api/geoip/refresh').status_code, 202)
            self.geo.enabled = False
            self.assertEqual(client.post('/api/geoip/refresh').status_code, 409)
            self.hit()
            self.geo.step()
            self.assertEqual(self.record()['queued'], 1)

    def test_download_resets_busy_flag_even_when_error_reporting_database_fails(self):
        import sqlite3
        with patch.object(self.geo.store, 'db', side_effect=sqlite3.OperationalError('database is locked')):
            with self.assertRaises(sqlite3.OperationalError):
                self.geo.download()
        self.assertFalse(self.geo._updating)
        self.assertGreater(self.geo._last_download, 0)

    def test_worker_survives_database_failure_during_error_reporting(self):
        import sqlite3
        import threading
        recovered = threading.Event()
        attempts = 0
        def step():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise sqlite3.OperationalError('database is locked')
            recovered.set()
            return False
        with patch.object(self.geo, 'step', side_effect=step), patch.object(
            self.geo, '_error', side_effect=sqlite3.OperationalError('database is locked')
        ):
            stop = self.geo.start()
            try:
                self.assertTrue(recovered.wait(3), 'worker terminated instead of retrying')
            finally:
                stop()


if __name__ == '__main__':
    unittest.main()
