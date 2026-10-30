"""System tag projection and the boundary shared by manual tag writers."""
from __future__ import annotations

import sqlite3

from .schema import ASN_CATEGORY, COUNTRY_CATEGORY
from .identity import host_sql


def assert_manual(connection: sqlite3.Connection, ids, *, categories=False) -> None:
    table = 'probe_tag_categories' if categories else 'probe_tags'
    for item_id in dict.fromkeys(ids):
        row = connection.execute(f'SELECT source FROM {table} WHERE id=?', (item_id,)).fetchone()
        if row and row['source'] != 'manual':
            raise ValueError('自动标签及分类由归属地数据库维护，仅支持筛选')


def restore_projection(connection: sqlite3.Connection, server_ids) -> None:
    """Restore from geo facts, not from possibly edited compatibility labels."""
    from ..probe.store import _refresh_server_projections
    ids = list(server_ids)
    touched = []
    for server_id in ids:
        cursor = connection.execute(
            'INSERT OR IGNORE INTO probe_server_tags(server_id,tag_id) '
            f'SELECT s.id,g.tag_id FROM probe_servers s JOIN geoip_record_tags g ON g.ip={host_sql("s.ip")} WHERE s.id=?',
            (server_id,),
        )
        if cursor.rowcount or connection.execute(
            "SELECT 1 FROM probe_server_tags st JOIN probe_tags t ON t.id=st.tag_id WHERE st.server_id=? AND t.source='geoip' LIMIT 1",
            (server_id,),
        ).fetchone():
            touched.append(server_id)
    _refresh_server_projections(connection, touched)


def apply_record(connection: sqlite3.Connection, record: dict) -> None:
    """Facts and their generated tag membership are committed together by caller."""
    ip = record['ip']
    wanted = []
    for category_id, value in ((COUNTRY_CATEGORY, record.get('country_code')),
                               (ASN_CATEGORY, record.get('asn'))):
        if not value:
            continue
        tag_id = f'{category_id}:{value}'
        connection.execute(
            "INSERT OR IGNORE INTO probe_tags(id,category_id,name,created_at,source) VALUES(?,?,?,?,'geoip')",
            (tag_id, category_id, value, record['looked_up_at']),
        )
        wanted.append(tag_id)
    wanted_ids = set(wanted)
    current_ids = {row['tag_id'] for row in connection.execute(
        'SELECT tag_id FROM geoip_record_tags WHERE ip=?', (ip,))}
    if current_ids != wanted_ids:
        connection.executemany('DELETE FROM geoip_record_tags WHERE ip=? AND tag_id=?',
                               [(ip, tag_id) for tag_id in current_ids - wanted_ids])
        connection.executemany('INSERT INTO geoip_record_tags(ip,tag_id) VALUES(?,?)',
                               [(ip, tag_id) for tag_id in wanted_ids - current_ids])
    server_ids = [row['id'] for row in connection.execute(f'SELECT id FROM probe_servers WHERE {host_sql("ip")}=?', (ip,))]
    changed = []
    for server_id in server_ids:
        assigned_ids = {row['tag_id'] for row in connection.execute(
            "SELECT st.tag_id FROM probe_server_tags st JOIN probe_tags t ON t.id=st.tag_id WHERE st.server_id=? AND t.source='geoip'",
            (server_id,))}
        if assigned_ids != wanted_ids:
            connection.executemany('DELETE FROM probe_server_tags WHERE server_id=? AND tag_id=?',
                                   [(server_id, tag_id) for tag_id in assigned_ids - wanted_ids])
            connection.executemany('INSERT INTO probe_server_tags(server_id,tag_id) VALUES(?,?)',
                                   [(server_id, tag_id) for tag_id in wanted_ids - assigned_ids])
            changed.append(server_id)
    from ..probe.store import _refresh_server_projections
    _refresh_server_projections(connection, changed)
