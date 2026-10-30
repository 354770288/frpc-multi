"""Bounded durable backfill, refresh and per-IP query state."""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from ..control.database import connect_database
from ..models import now_iso
from .tags import apply_record
from .identity import ipv4_host, host_sql

BATCH_SIZE = 250


def public_record(row, version='') -> dict:
    return {
        'status': row['status'], 'countryCode': row['country_code'], 'country': row['country'],
        'asn': row['asn'], 'asName': row['as_name'], 'asDomain': row['as_domain'],
        'source': 'ipinfo_lite', 'databaseVersion': row['database_version'] or None,
        'lookedUpAt': row['looked_up_at'],
        'stale': bool(row['queued'] or row['database_version'] != version),
    }


def enrich(connection, items: list[dict], *, assets=False) -> list[dict]:
    """Page-sized enrichment; never issue per-row database or network requests."""
    if not items:
        return items
    ips = list(dict.fromkeys(ip for item in items if (ip := ipv4_host(item['ip'])) is not None))
    version = connection.execute('SELECT version FROM geoip_state WHERE id=1').fetchone()[0]
    rows = {}
    manual_labels = {}
    for offset in range(0, len(ips), BATCH_SIZE):
        chunk = ips[offset:offset+BATCH_SIZE]
        rows.update((row['ip'], public_record(row, version)) for row in connection.execute(
            f"SELECT * FROM geoip_records WHERE ip IN ({','.join('?' for _ in chunk)})", chunk))
    # Manual attributes apply to every supported asset address, including
    # retained hostnames/IPv6/nonstandard ports outside geo's IPv4 scope.
    asset_ips = list(dict.fromkeys(item['ip'] for item in items if assets or 'latestConnectivity' in item))
    for offset in range(0, len(asset_ips), BATCH_SIZE):
        chunk = asset_ips[offset:offset+BATCH_SIZE]
        marks = ','.join('?' for _ in chunk)
        for row in connection.execute(
            'SELECT s.ip,t.name FROM probe_servers s JOIN probe_server_tags st ON st.server_id=s.id '
            "JOIN probe_tags t ON t.id=st.tag_id WHERE t.source='manual' "
            f'AND s.ip IN ({marks}) ORDER BY t.name', chunk,
        ):
            manual_labels.setdefault(row['ip'], []).append(row['name'])
    for item in items:
        item['geo'] = rows.get(ipv4_host(item['ip']))
        if assets or 'latestConnectivity' in item:
            item['manualLabels'] = list(dict.fromkeys(manual_labels.get(item['ip'], [])))
    return items


class GeoStore:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def db(self):
        connection = connect_database(self.path)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def state(self):
        with self.db() as c:
            return dict(c.execute('SELECT * FROM geoip_state WHERE id=1').fetchone())

    def request_update(self):
        with self.db() as c:
            c.execute('UPDATE geoip_state SET update_requested=1 WHERE id=1')

    def request_refresh(self):
        with self.db() as c:
            c.execute("UPDATE geoip_state SET refresh_requested=1,refresh_cursor='',backfill_phase='discovery',backfill_cursor=0 WHERE id=1")

    def backfill(self) -> bool:
        """Range scans bound both history traversal and SQLite lock duration."""
        with self.db() as c:
            c.execute('BEGIN IMMEDIATE')
            state = c.execute('SELECT * FROM geoip_state WHERE id=1').fetchone()
            phase, cursor = state['backfill_phase'], state['backfill_cursor']
            if phase == 'done':
                return False
            if phase == 'discovery':
                rows = c.execute('SELECT id,ip FROM probe_discover_results WHERE id>? ORDER BY id LIMIT ?',
                                 (cursor, BATCH_SIZE)).fetchall()
                next_phase = 'assets'
            else:
                rows = c.execute('SELECT id,ip FROM probe_servers WHERE id>? ORDER BY id LIMIT ?',
                                 (cursor, BATCH_SIZE)).fetchall()
                next_phase = 'done'
            for row in rows:
                ip = ipv4_host(row['ip'])
                if ip is None:
                    continue
                if phase == 'discovery' or c.execute(
                    "SELECT 1 FROM probe_results WHERE server_ip=? AND port=7000 AND kind IN ('route','connectivity','speed') LIMIT 1",
                    (ip,),
                ).fetchone() or c.execute('SELECT 1 FROM probe_discover_results WHERE ip=? LIMIT 1',
                                          (ip,)).fetchone() or c.execute(
                    'SELECT 1 FROM probe_connectivity_results WHERE server_ip=? LIMIT 1', (row['ip'],)
                ).fetchone() or c.execute('SELECT 1 FROM probe_speed_results WHERE server_ip=? LIMIT 1', (row['ip'],)).fetchone():
                    c.execute('INSERT INTO geoip_records(ip) VALUES(?) ON CONFLICT(ip) DO UPDATE SET queued=1,retry_at=0 '
                              'WHERE database_version != (SELECT version FROM geoip_state WHERE id=1)', (ip,))
                    # Cached discoveries imported before this migration also get tags.
                    from .tags import restore_projection
                    if phase == 'assets':
                        restore_projection(c, [row['id']])
            if rows:
                c.execute('UPDATE geoip_state SET backfill_cursor=? WHERE id=1', (rows[-1]['id'],))
            else:
                c.execute('UPDATE geoip_state SET backfill_phase=?,backfill_cursor=0 WHERE id=1', (next_phase,))
            return True

    def refresh_batch(self):
        with self.db() as c:
            c.execute('BEGIN IMMEDIATE')
            state = c.execute('SELECT * FROM geoip_state WHERE id=1').fetchone()
            if not state['refresh_requested']:
                return False
            rows = c.execute('SELECT ip FROM geoip_records WHERE ip>? ORDER BY ip LIMIT ?',
                             (state['refresh_cursor'], BATCH_SIZE)).fetchall()
            for row in rows:
                ip = row['ip']
                # Deleted candidates and assets no longer consume refresh work.
                if c.execute(f'SELECT 1 FROM probe_servers WHERE {host_sql("ip")}=?', (ip,)).fetchone() or c.execute(
                    'SELECT 1 FROM probe_discover_results WHERE ip=? LIMIT 1', (ip,)
                ).fetchone():
                    c.execute('UPDATE geoip_records SET queued=1,retry_at=0 WHERE ip=?', (ip,))
            if rows:
                c.execute('UPDATE geoip_state SET refresh_cursor=? WHERE id=1', (rows[-1]['ip'],))
            else:
                c.execute("UPDATE geoip_state SET refresh_requested=0,refresh_cursor='' WHERE id=1")
            return True

    def pending(self, clock):
        with self.db() as c:
            return [row['ip'] for row in c.execute(
                'SELECT ip FROM geoip_records WHERE queued=1 AND retry_at<=? ORDER BY retry_at,ip LIMIT ?',
                (clock, BATCH_SIZE))]

    def save_batch(self, records, version):
        with self.db() as c:
            c.execute('BEGIN IMMEDIATE')
            if c.execute('SELECT version FROM geoip_state WHERE id=1').fetchone()[0] != version:
                return False
            for record in records:
                c.execute(
                    'UPDATE geoip_records SET status=:status,country_code=:country_code,country=:country,'
                    'asn=:asn,as_name=:as_name,as_domain=:as_domain,database_version=:database_version,'
                    'looked_up_at=:looked_up_at,queued=0,retry_at=0,error=\'\' WHERE ip=:ip', record)
                apply_record(c, record)
            return True

    def fail_batch(self, ips, retry_at):
        with self.db() as c:
            c.executemany("UPDATE geoip_records SET status=CASE WHEN looked_up_at IS NULL THEN 'error' ELSE status END,error='本地数据库查询异常',retry_at=? WHERE ip=?",
                          [(retry_at, ip) for ip in ips])

    def exclude_invalid(self, ip):
        with self.db() as c:
            c.execute("UPDATE geoip_records SET status='error',queued=0,retry_at=0,error='仅支持规范 IPv4 地址' WHERE ip=?", (ip,))

    def activate(self, version, build_epoch):
        with self.db() as c:
            old = c.execute('SELECT version FROM geoip_state WHERE id=1').fetchone()[0]
            if old != version:
                c.execute("UPDATE geoip_state SET version=?,build_epoch=?,updated_at=?,last_error='',refresh_requested=1,refresh_cursor='' WHERE id=1",
                          (version, build_epoch, now_iso()))

    def counts(self):
        with self.db() as c:
            result = dict(pending=0, ready=0, notFound=0, nonPublic=0, error=0)
            for row in c.execute('SELECT status,queued,COUNT(*) AS n FROM geoip_records GROUP BY queued,status'):
                if row['queued']:
                    result['pending'] += row['n']
                key = {'not_found': 'notFound', 'non_public': 'nonPublic'}.get(row['status'], row['status'])
                if key in result and key != 'pending':
                    result[key] += row['n']
            return result
