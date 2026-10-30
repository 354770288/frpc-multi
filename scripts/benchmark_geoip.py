#!/usr/bin/env python3
"""Isolated, reproducible GeoIP SQLite capacity benchmark (no HTTP).

Run with webui/backend/.venv/bin/python scripts/benchmark_geoip.py --size 100000.
Synthetic positive lookups measure label/storage throughput, not MMDB coverage.
All database files live in /tmp; failed fixtures are retained for reproduction.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import ipaddress
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'webui/backend'))
from app.control.database import connect_database, initialize_database
from app.geoip.database import open_snapshot
from app.geoip.schema import migrate
from app.geoip.service import BATCH_PAUSE_SECONDS, GeoService
from app.geoip.store import BATCH_SIZE, GeoStore, enrich
from app.models import now_iso
from app.probe.store import DiscoverPageQuery, ProbeStore, ServerPageQuery

COUNTRIES = ('US', 'CN', 'DE', 'GB', 'JP', 'FR', 'CA', 'AU', 'BR', 'IN',
             'SG', 'KR', 'NL', 'SE', 'NO', 'FI', 'ES', 'IT', 'CH', 'NZ')
BASE = int(ipaddress.IPv4Address('11.0.0.0'))
VERSION = 'synthetic-capacity-20-countries-200-asns-v1'
STAMP = '2026-10-30T00:00:00+00:00'
KINDS = ('route', 'connectivity', 'speed')


def log(stage, **values):
    print(json.dumps(dict(stage=stage, **values)), flush=True)


def ip_for(index):
    return str(ipaddress.IPv4Address(BASE + index))


class SyntheticSnapshot:
    """Deterministic positive fixture; deliberately no network or MMDB claims."""
    version = VERSION
    build_epoch = 0

    def lookup(self, ip):
        n = int(ipaddress.IPv4Address(ip)) - BASE
        return dict(ip=ip, status='ready', country_code=COUNTRIES[n % 20],
                    country='Synthetic country ' + COUNTRIES[n % 20],
                    asn=f'AS{64500 + n % 200}', as_name=f'Synthetic ASN {n % 200}',
                    as_domain=f'as{n % 200}.invalid', database_version=self.version,
                    looked_up_at=now_iso())

    def close(self):
        pass


def data_for(kind, n):
    if kind == 'route':
        return json.dumps(dict(ok=True, isCn2=n % 2 == 0), separators=(',', ':'))
    if kind == 'connectivity':
        return json.dumps(dict(frps_reachable=n % 5 != 0, tunnel_established=n % 5 > 1,
                               firewall_open=n % 5 > 2, detail='synthetic'), separators=(',', ':'))
    return json.dumps(dict(dl_ok=True, ul_ok=True, dl_speed_bps=1048576 + n % 100 * 4096,
                           ul_speed_bps=524288, detail='synthetic'), separators=(',', ':'))


def file_sizes(path):
    return {suffix or 'database': Path(str(path) + suffix).stat().st_size
            if Path(str(path) + suffix).exists() else 0 for suffix in ('', '-wal', '-shm')}


def distribution(samples):
    ordered = sorted(samples)
    if not ordered:
        return dict(n=0)
    return dict(n=len(ordered), p50_ms=statistics.median(ordered) * 1000,
                p95_ms=ordered[min(len(ordered)-1, int(len(ordered)*0.95))] * 1000,
                max_ms=max(ordered)*1000)


def seed(path, size, rounds):
    initialize_database(path)
    c = connect_database(path)
    try:
        # Model a pre-GeoIP database so actual migration/backfill is measurable.
        for row in c.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'geoip_%'").fetchall():
            c.execute('DROP TRIGGER ' + row[0])
        c.executemany('INSERT INTO probe_groups(id,name,color,created_at) VALUES(?,?,?,?)',
                      [(f'g{i:02}', f'group-{i:02}', '', STAMP) for i in range(16)])
        c.commit()
        start = time.perf_counter()
        result_id = 0
        for first in range(0, size, BATCH_SIZE):
            last = min(size, first + BATCH_SIZE)
            assets, discoveries, history, current = [], [], [], []
            for n in range(first, last):
                ip = ip_for(n)
                assets.append((ip, BASE+n, f'group-{n%16:02}', f'g{n%16:02}', STAMP))
                if n % 4 != 3:
                    discoveries.append((ip, BASE+n, n % 50, f'group-{n%16:02}', f'g{n%16:02}', STAMP))
                for round_index in range(rounds):
                    for kind in KINDS:
                        result_id += 1
                        task = f'{n:x}-{round_index}-{kind[0]}'
                        data = data_for(kind, n)
                        history.append((result_id, task, 'fixture-job', 'fixture-node', kind, ip, STAMP, data))
                        if round_index == rounds-1:
                            current.append((ip, kind, result_id, 'fixture-node', 'fixture-job', task, STAMP, data))
            with c:
                c.executemany('INSERT INTO probe_servers(ip,ip_sort,server_group,group_id,created_at) VALUES(?,?,?,?,?)', assets)
                c.executemany("INSERT INTO probe_discover_results(ip,ip_sort,port,latency_ms,label,server_group,group_id,discovered_at) VALUES(?,?,7000,?,',未路由测试,',?,?,?)", discoveries)
                # <=250 IPs/transaction; bound each executemany allocation too.
                for offset in range(0, len(history), BATCH_SIZE):
                    c.executemany('INSERT INTO probe_results(id,task_id,job_id,node_id,kind,server_ip,port,test_time,data) VALUES(?,?,?,?,?,?,7000,?,?)', history[offset:offset+BATCH_SIZE])
                for offset in range(0, len(current), BATCH_SIZE):
                    c.executemany('INSERT INTO probe_current_results(server_ip,kind,port,source_result_id,node_id,job_id,task_id,test_time,data) VALUES(?,?,7000,?,?,?,?,?,?)', current[offset:offset+BATCH_SIZE])
            if last % 25000 == 0 or last == size:
                log('seed', ips=last, seconds=round(time.perf_counter()-start, 3), files=file_sizes(path))
        elapsed = time.perf_counter()-start
        migrate(c)
        return dict(seconds=elapsed, ips_per_second=size/elapsed, history_rows=result_id,
                    current_rows=size*3, discovery_rows=(size//4)*3+min(size%4, 3), files=file_sizes(path))
    finally:
        c.close()


def plans(path, store):
    output = {}
    c = connect_database(path)
    try:
        store._source_views(c)
        for name, query in [('list_ip', ServerPageQuery(sort='ip')),
                            ('filter_country', ServerPageQuery(sort='ip', include_tag_ids=('geoip:country:US',))),
                            ('filter_complex', ServerPageQuery(sort='ip', group_ids=('g00',), conn='fail', include_tag_ids=('geoip:country:US',), exclude_tag_ids=('geoip:asn:AS64500',)))]:
            where, params = store._server_where(query)
            order = ','.join(f'{expr} {direction}' for expr, direction in store._server_order_terms(query))
            sql = store._server_select_sql()+' '+store._server_from_sql()+where+' ORDER BY '+order+' LIMIT 50'
            output[name] = [dict(row) for row in c.execute('EXPLAIN QUERY PLAN '+sql, params)]
            output[name+'_count'] = [dict(row) for row in c.execute('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM probe_servers s'+where, params)]
        for name, sql in [('pending', 'SELECT ip FROM geoip_records WHERE queued=1 AND retry_at<=0 ORDER BY retry_at,ip LIMIT 250'),
                          ('backfill_discovery', 'SELECT id,ip FROM probe_discover_results WHERE id>0 ORDER BY id LIMIT 250'),
                          ('backfill_assets', 'SELECT id,ip FROM probe_servers WHERE id>0 ORDER BY id LIMIT 250'),
                          ('geo_counts', 'SELECT status,queued,COUNT(*) FROM geoip_records GROUP BY queued,status')]:
            output[name] = [dict(row) for row in c.execute('EXPLAIN QUERY PLAN '+sql)]
        # Trace bound SQL from real API methods, then explain the same statements.
        original_connect = connect_database
        captured = []
        def traced_connect(database_path):
            traced = original_connect(database_path)
            traced.set_trace_callback(lambda sql: captured.append(sql) if sql.lstrip().upper().startswith(('SELECT', 'WITH')) else None)
            return traced
        cases = [
            ('list_ip', lambda: store.query_servers(ServerPageQuery(sort='ip'))),
            ('list_speed', lambda: store.query_servers(ServerPageQuery(sort='speed'))),
            ('list_time', lambda: store.query_servers(ServerPageQuery(sort='time'))),
            ('filter_country', lambda: store.query_servers(ServerPageQuery(sort='ip', include_tag_ids=('geoip:country:US',)))),
            ('filter_complex', lambda: store.query_servers(ServerPageQuery(sort='group', group_ids=('g00',), conn='fail', include_tag_ids=('geoip:country:US',), exclude_tag_ids=('geoip:asn:AS64500',)))),
            ('facets_contextual', lambda: store.server_facets(ServerPageQuery(conn='fail'), tag_page=1, tag_page_size=50)),
            ('facets_global', store.server_facets),
            ('discovery_filter', lambda: store.query_discover_results(DiscoverPageQuery(library='new'))),
        ]
        for name, call in cases:
            captured.clear()
            with patch('app.probe.store.connect_database', traced_connect):
                call()
            output[name] = [dict(sql=sql, plan=[dict(row) for row in c.execute('EXPLAIN QUERY PLAN '+sql)]) for sql in captured]
        return output
    finally:
        c.close()


def concurrent_workload(path, size, duration, writer_pause=BATCH_PAUSE_SECONDS):
    store, geo = ProbeStore(path), GeoStore(path)
    timings, errors, writer_stats = defaultdict(list), [], dict(batches=0, records=0)
    stop = threading.Event()
    start_barrier = threading.Barrier(6)
    simple = ServerPageQuery(sort='ip', include_tag_ids=('geoip:country:US',))
    complex_query = ServerPageQuery(sort='group', group_ids=('g00',), conn='fail',
                                  include_tag_ids=('geoip:country:US',), exclude_tag_ids=('geoip:asn:AS64500',))
    def page_with_geo(call, *, asset=True):
        result = call()
        items = [dict(row, latestConnectivity=None) if asset else dict(row) for row in result['items']]
        with geo.db() as c:
            result['items'] = enrich(c, items)
        if items:
            assert items[0]['geo']['status'] == 'ready'
            if asset:
                assert 'manualLabels' in items[0]
        return result

    profiles = [
        [('list_ip', lambda: page_with_geo(lambda: store.query_servers(ServerPageQuery(sort='ip')))),
         ('list_speed', lambda: page_with_geo(lambda: store.query_servers(ServerPageQuery(sort='speed')))),
         ('list_time', lambda: page_with_geo(lambda: store.query_servers(ServerPageQuery(sort='time'))))],
        [('filter_country', lambda: page_with_geo(lambda: store.query_servers(simple))),
         ('filter_complex', lambda: page_with_geo(lambda: store.query_servers(complex_query)))],
        [('count_complex', lambda: store.count_servers(complex_query)), ('geo_counts', geo.counts)],
        [('facets_global', store.server_facets),
         ('facets_contextual', lambda: store.server_facets(ServerPageQuery(conn='fail'), tag_page=1, tag_page_size=50))],
        [('discovery_list', lambda: page_with_geo(lambda: store.query_discover_results(DiscoverPageQuery()), asset=False)),
         ('discovery_filter', lambda: page_with_geo(lambda: store.query_discover_results(DiscoverPageQuery(library='new')), asset=False)),
         ('discovery_facets', store.discover_facets)],
    ]

    def readers(index):
        start_barrier.wait()
        while not stop.is_set():
            for name, call in profiles[index]:
                if stop.is_set():
                    break
                began = time.perf_counter()
                try:
                    call()
                    timings[name].append(time.perf_counter()-began)
                except Exception as exc:
                    errors.append(dict(operation=name, error=repr(exc)))
                    stop.set()
                    break

    def writer():
        snap = SyntheticSnapshot()
        cursor = 0
        start_barrier.wait()
        while not stop.is_set():
            ips = [ip_for((cursor+i) % size) for i in range(BATCH_SIZE)]
            began = time.perf_counter()
            try:
                # Same bounded, positive facts+tags transaction as real maintenance.
                geo.save_batch([snap.lookup(ip) for ip in ips], VERSION)
                writer_stats['batches'] += 1
                writer_stats['records'] += len(ips)
                timings['geo_write_batch'].append(time.perf_counter()-began)
                cursor = (cursor+BATCH_SIZE) % size
                # Match the production worker's bounded batch scheduling. The
                # initial unpaced saturation run is retained separately.
                stop.wait(writer_pause)
            except Exception as exc:
                errors.append(dict(operation='geo_write_batch', error=repr(exc)))
                stop.set()

    before = time.perf_counter()
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(readers, i) for i in range(5)] + [pool.submit(writer)]
        stop.wait(duration)
        stop.set()
        for future in futures:
            future.result()
    elapsed = time.perf_counter()-before
    gates = dict(list_ms=300 if size<=100000 else 800,
                 filter_ms=500 if size<=100000 else 1500,
                 counts_ms=1000 if size<=100000 else 3000)
    measured = {name: distribution(samples) for name, samples in timings.items()}
    for name, values in measured.items():
        if name == 'geo_write_batch':
            continue
        family = 'list_ms' if name.startswith('list_') or name == 'discovery_list' else 'filter_ms' if name.startswith('filter_') or name=='discovery_filter' else 'counts_ms'
        values.update(gate_ms=gates[family], passed=values['p95_ms']<=gates[family])
    return dict(seconds=elapsed, readers=5, writer_pause_seconds=writer_pause, sustained_writer=writer_stats, queries=measured,
                errors=errors, gates=gates, all_measured_gates_pass=not errors and writer_stats['batches']>0 and all(v.get('passed', True) for v in measured.values()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--size', type=int, choices=(100000, 1000000), default=100000)
    parser.add_argument('--history-rounds', type=int, default=3)
    parser.add_argument('--duration', type=float, default=30)
    parser.add_argument('--writer-pause', type=float, default=BATCH_PAUSE_SECONDS,
                        help='Seconds between write batches; defaults to production cadence, 0 tests unpaced saturation.')
    parser.add_argument('--query-only', type=Path,
                        help='Remeasure an existing retained /tmp fixture in a fresh process; preserve fill evidence.')
    parser.add_argument('--keep-data-on-failure', action=argparse.BooleanOptionalAction, default=True,
                        help='Retain a checkpointed database copy under /tmp if any query gate fails.')
    args = parser.parse_args()
    if args.history_rounds < 1:
        parser.error('--history-rounds must be positive')
    if args.duration <= 0 or args.writer_pause < 0:
        parser.error('--duration must be positive and --writer-pause must be nonnegative')
    report_path = Path(f'/tmp/frpc-geoip-capacity-{args.size}.json')
    report = dict(size=args.size, history_rounds=args.history_rounds, batch_size=BATCH_SIZE,
                  synthetic=True, synthetic_snapshot=VERSION, started_at=now_iso(),
                  hardware=dict(platform=platform.platform(), machine=platform.machine(), cpu_count=os.cpu_count(),
                                python=sys.version, sqlite=sqlite3.sqlite_version), caveats=[
        'Synthetic fixed positive snapshot: 20 countries/200 ASNs; measures label storage and SQLite throughput, not real geographic coverage.',
        'All IPs have assets, 75% also discoveries; every IP has all three current kinds and requested immutable history rounds.',
        'Seed bypasses GeoIP insert triggers to model pre-feature storage; actual GeoIP migration and bounded backfill run afterward.',
        'Direct ProbeStore APIs plus geo/manualLabels page enrichment; no HTTP/browser/network latency or route/public-serialization enrichment. Five reader threads and one continuous 250-IP geo fact/tag rewrite thread.',
        'Refresh writer rewrites existing positive facts/tags; no probe-result writes during measured query concurrency.',
        'Warm local filesystem cache; single host/process, not production hardware. Facet sample counts may be small.',
    ])
    for key in ('hw.memsize', 'machdep.cpu.brand_string'):
        if not shutil.which('sysctl'):
            break
        result = subprocess.run(['sysctl', '-n', key], capture_output=True, text=True)
        if result.returncode == 0:
            report['hardware'][key] = result.stdout.strip()
    report['source_sha256'] = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in [ROOT/'scripts/benchmark_geoip.py', *sorted((ROOT/'webui/backend/app/geoip').glob('*.py')), ROOT/'webui/backend/app/probe/store.py', ROOT/'webui/backend/app/control/database.py']}
    http_calls = []
    def denied_http(*a, **kw):
        http_calls.append('HTTP attempted')
        raise AssertionError('benchmark must use only local fixtures')
    with patch('httpx.Client.send', denied_http), patch('httpx.AsyncClient.send', denied_http), patch('httpx.stream', denied_http):
        if args.query_only:
            path = args.query_only.resolve()
            if not path.is_relative_to(Path('/tmp').resolve()) or not path.is_file():
                parser.error('--query-only must name an existing database under /tmp')
            previous = json.loads(report_path.read_text())
            fresh = report
            report = previous
            report.setdefault('initial_fill_source_sha256', previous['source_sha256'])
            report.setdefault('initial_concurrency', previous['concurrency'])
            report.setdefault('initial_query_plans', previous['query_plans'])
            if not previous['concurrency'].get('writer_pause_seconds'):
                report.setdefault('unpaced_concurrency', previous['concurrency'])
            report['source_sha256'] = fresh['source_sha256']
            report['final_query_source_sha256'] = fresh['source_sha256']
            report['final_query_started_at'] = fresh['started_at']
            report['retained_failure_database'] = str(path)
            query_keeper = connect_database(path)
            report['query_plans'] = plans(path, ProbeStore(path))
            report['concurrency'] = concurrent_workload(path, args.size, args.duration, args.writer_pause)
            with GeoStore(path).db() as c:
                report['final_ready_records'] = c.execute("SELECT COUNT(*) FROM geoip_records WHERE status='ready' AND queued=0").fetchone()[0]
                report['final_geo_tag_links'] = c.execute('SELECT COUNT(*) FROM geoip_record_tags').fetchone()[0]
                report['final_asset_tag_links'] = c.execute('SELECT COUNT(*) FROM probe_server_tags').fetchone()[0]
                report['quick_check'] = c.execute('PRAGMA quick_check').fetchone()[0]
            report['final_query_files_before_checkpoint'] = file_sizes(path)
            query_keeper.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            query_keeper.close()
            report['final_query_workload'] = dict(requested_seconds=args.duration,
                stable_positive_refresh=True,
                writer_pause_seconds=args.writer_pause, production_worker_pause_seconds=BATCH_PAUSE_SECONDS,
                note='Pacing is explicit; default matches production. Refresh changes timestamps while membership stays stable. Full positive growth is measured by initial fill; unpaced saturation results are retained.')
            report['final_query_http_attempts'] = len(http_calls)
            report['final_query_peak_rss_bytes'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform=='darwin' else 1024)
            report['final_query_files'] = file_sizes(path)
            report['final_query_finished_at'] = now_iso()
            report_path.write_text(json.dumps(report, indent=2)+'\n')
            log('query_only_finished', report=str(report_path), all_measured_gates_pass=report['concurrency']['all_measured_gates_pass'], errors=report['concurrency']['errors'])
            return
        fixture = ROOT / 'webui/backend/tests/fixtures/ipinfo_lite.sample.mmdb'
        began = time.perf_counter()
        snapshot = open_snapshot(fixture)
        open_seconds = time.perf_counter()-began
        networks = [str(network.network_address) for network, _ in snapshot.reader]
        began = time.perf_counter()
        statuses = defaultdict(int)
        for n in range(100000):
            statuses[snapshot.lookup(networks[n % len(networks)])['status']] += 1
        read_seconds = time.perf_counter()-began
        report['mmdb_reader'] = dict(fixture=str(fixture.relative_to(ROOT)), fixture_bytes=fixture.stat().st_size,
                                     open_seconds=open_seconds, lookups=100000, seconds=read_seconds,
                                     lookups_per_second=100000/read_seconds, statuses=dict(statuses))
        snapshot.close()
        with tempfile.TemporaryDirectory(prefix='frpc-geoip-capacity-', dir='/tmp') as temp:
            path = Path(temp) / 'capacity.db'
            report['seed'] = seed(path, args.size, args.history_rounds)
            # Keep a connection alive so WAL bytes and concurrent reader behavior are observable.
            keeper = connect_database(path)
            geo = GeoStore(path)
            began = time.perf_counter()
            backfill_calls = 0
            backfill_samples = []
            while True:
                call_start = time.perf_counter()
                more = geo.backfill()
                backfill_samples.append(time.perf_counter()-call_start)
                if not more:
                    break
                backfill_calls += 1
            report['backfill'] = dict(seconds=time.perf_counter()-began, calls=backfill_calls,
                                      batch=distribution(backfill_samples), queued=geo.counts())
            log('backfill', **report['backfill'])
            service = GeoService(path, Path(temp)/'synthetic.mmdb')
            service._snapshot = SyntheticSnapshot()
            service._load = lambda: None
            geo.activate(VERSION, 0)
            began = time.perf_counter()
            steps = 0
            while service.step():
                steps += 1
                if steps % 100 == 0:
                    log('geo', steps=steps, upper_bound_ips=min(args.size, steps*BATCH_SIZE), seconds=round(time.perf_counter()-began, 3))
            elapsed = time.perf_counter()-began
            report['geo_processing'] = dict(seconds=elapsed, steps=steps, ips_per_second=args.size/elapsed, counts=geo.counts(), files=file_sizes(path))
            counts = {}
            for table in ('probe_servers', 'probe_discover_results', 'probe_results', 'probe_current_results', 'geoip_records', 'geoip_record_tags', 'probe_server_tags', 'probe_tags'):
                counts[table] = keeper.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]
            counts['positive_fact_rows'] = keeper.execute("SELECT COUNT(*) FROM geoip_records WHERE status='ready' AND country_code IS NOT NULL AND asn IS NOT NULL AND queued=0").fetchone()[0]
            counts['nonempty_asset_labels'] = keeper.execute("SELECT COUNT(*) FROM probe_servers WHERE label!=''").fetchone()[0]
            report['verified_cardinalities'] = counts
            assert counts['positive_fact_rows'] == args.size, counts
            assert counts['geoip_record_tags'] == counts['probe_server_tags'] == args.size*2, counts
            assert counts['nonempty_asset_labels'] == args.size, counts
            assert counts['probe_results'] == args.size*args.history_rounds*3, counts
            report['query_plans'] = plans(path, ProbeStore(path))
            log('concurrency_start', counts=counts)
            report['concurrency'] = concurrent_workload(path, args.size, args.duration, args.writer_pause)
            report['files_before_checkpoint'] = file_sizes(path)
            keeper.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            report['files_after_checkpoint'] = file_sizes(path)
            report['quick_check'] = keeper.execute('PRAGMA quick_check').fetchone()[0]
            keeper.close()
            if args.keep_data_on_failure and not report['concurrency']['all_measured_gates_pass']:
                retained = Path(tempfile.mkdtemp(prefix=f'frpc-geoip-failure-{args.size}-', dir='/tmp')) / 'capacity.db'
                shutil.copy2(path, retained)
                report['retained_failure_database'] = str(retained)
            report['temporary_database_removed'] = True
    report['http_attempts'] = len(http_calls)
    report['peak_process_rss_bytes'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform=='darwin' else 1024)
    report['finished_at'] = now_iso()
    report_path.write_text(json.dumps(report, indent=2)+'\n')
    log('finished', report=str(report_path), all_measured_gates_pass=report['concurrency']['all_measured_gates_pass'], errors=report['concurrency']['errors'])


if __name__ == '__main__':
    main()
