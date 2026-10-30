"""Additive geo migration. Triggers enqueue only persisted, accepted facts."""
from __future__ import annotations

import sqlite3

from .identity import host_sql

COUNTRY_CATEGORY = 'geoip:country'
ASN_CATEGORY = 'geoip:asn'


def _ipv4_shape(value):
    # Accepted test hosts are already validated; this boundary excludes legacy
    # hostnames/IPv6 without registering SQL functions on external connections.
    return (f"({value} NOT GLOB '*[^0-9.]*' AND "
            f"length({value})-length(replace({value},'.',''))=3)")


def migrate(connection: sqlite3.Connection) -> None:
    for table in ('probe_tag_categories', 'probe_tags'):
        columns = {row[1] for row in connection.execute(f'PRAGMA table_info({table})')}
        if 'source' not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
    connection.executescript(f"""
        CREATE TABLE IF NOT EXISTS geoip_records (
            ip TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
            country_code TEXT, country TEXT, asn TEXT, as_name TEXT, as_domain TEXT,
            database_version TEXT NOT NULL DEFAULT '', looked_up_at TEXT,
            queued INTEGER NOT NULL DEFAULT 1, retry_at REAL NOT NULL DEFAULT 0,
            error TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_geoip_pending ON geoip_records(queued,retry_at,ip);
        CREATE INDEX IF NOT EXISTS idx_geoip_status ON geoip_records(queued,status);
        CREATE INDEX IF NOT EXISTS idx_probe_tags_name ON probe_tags(name,id);
        CREATE TABLE IF NOT EXISTS geoip_state (
            id INTEGER PRIMARY KEY CHECK(id=1), version TEXT NOT NULL DEFAULT '',
            build_epoch INTEGER, updated_at TEXT, last_check_at TEXT,
            last_error TEXT NOT NULL DEFAULT '', update_requested INTEGER NOT NULL DEFAULT 0,
            refresh_requested INTEGER NOT NULL DEFAULT 0, refresh_cursor TEXT NOT NULL DEFAULT '',
            backfill_phase TEXT NOT NULL DEFAULT 'discovery', backfill_cursor INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO geoip_state(id) VALUES(1);
        CREATE TABLE IF NOT EXISTS geoip_record_tags (
            ip TEXT NOT NULL REFERENCES geoip_records(ip) ON DELETE CASCADE,
            tag_id TEXT NOT NULL REFERENCES probe_tags(id) ON DELETE CASCADE,
            PRIMARY KEY(ip,tag_id)
        );
        CREATE TRIGGER IF NOT EXISTS geoip_discover_insert AFTER INSERT ON probe_discover_results
        BEGIN INSERT INTO geoip_records(ip) VALUES(NEW.ip) ON CONFLICT(ip) DO UPDATE SET queued=1,retry_at=0
          WHERE database_version != (SELECT version FROM geoip_state WHERE id=1); END;
        CREATE TRIGGER IF NOT EXISTS geoip_discover_update AFTER UPDATE OF discovered_at ON probe_discover_results
        BEGIN INSERT INTO geoip_records(ip) VALUES(NEW.ip) ON CONFLICT(ip) DO UPDATE SET queued=1,retry_at=0
          WHERE database_version != (SELECT version FROM geoip_state WHERE id=1); END;
        CREATE TRIGGER IF NOT EXISTS geoip_result_insert AFTER INSERT ON probe_results
        WHEN NEW.kind IN ('route','connectivity','speed') AND NEW.port=7000
          AND {_ipv4_shape('NEW.server_ip')}
          AND EXISTS(SELECT 1 FROM probe_servers WHERE {host_sql('ip')}=NEW.server_ip)
        BEGIN INSERT INTO geoip_records(ip) VALUES(NEW.server_ip) ON CONFLICT(ip) DO UPDATE SET queued=1,retry_at=0
          WHERE database_version != (SELECT version FROM geoip_state WHERE id=1); END;
        CREATE TRIGGER IF NOT EXISTS geoip_asset_insert AFTER INSERT ON probe_servers
        BEGIN
            INSERT INTO geoip_records(ip)
              SELECT {host_sql('NEW.ip')} WHERE {_ipv4_shape(host_sql('NEW.ip'))}
              AND (EXISTS(SELECT 1 FROM probe_discover_results WHERE ip={host_sql('NEW.ip')})
              OR EXISTS(SELECT 1 FROM probe_results WHERE server_ip={host_sql('NEW.ip')} AND port=7000
                        AND kind IN ('route','connectivity','speed'))) ON CONFLICT(ip) DO UPDATE SET queued=1,retry_at=0
                  WHERE database_version != (SELECT version FROM geoip_state WHERE id=1);
            INSERT INTO probe_server_tags(server_id,tag_id)
              SELECT NEW.id,tag_id FROM geoip_record_tags WHERE ip={host_sql('NEW.ip')}
              ON CONFLICT(server_id,tag_id) DO NOTHING;
        END;
        CREATE TRIGGER IF NOT EXISTS geoip_asset_ip_update AFTER UPDATE OF ip ON probe_servers
        WHEN OLD.ip != NEW.ip
        BEGIN
            DELETE FROM probe_server_tags WHERE server_id=NEW.id
              AND tag_id IN (SELECT id FROM probe_tags WHERE source='geoip');
            INSERT INTO geoip_records(ip)
              SELECT {host_sql('NEW.ip')} WHERE {_ipv4_shape(host_sql('NEW.ip'))}
              AND (EXISTS(SELECT 1 FROM probe_discover_results WHERE ip={host_sql('NEW.ip')})
              OR EXISTS(SELECT 1 FROM probe_results WHERE server_ip={host_sql('NEW.ip')} AND port=7000
                        AND kind IN ('route','connectivity','speed'))) ON CONFLICT(ip) DO UPDATE SET queued=1,retry_at=0
                  WHERE database_version != (SELECT version FROM geoip_state WHERE id=1);
            INSERT INTO probe_server_tags(server_id,tag_id)
              SELECT NEW.id,tag_id FROM geoip_record_tags WHERE ip={host_sql('NEW.ip')}
              ON CONFLICT(server_id,tag_id) DO NOTHING;
        END;
    """)
    for category_id, name in ((COUNTRY_CATEGORY, '自动归属地'), (ASN_CATEGORY, '自动 ASN')):
        # A pre-existing manual category with this name keeps its identity.
        base_name = name
        suffix = 0
        while connection.execute('SELECT 1 FROM probe_tag_categories WHERE name=? AND id!=?',
                                  (name, category_id)).fetchone():
            suffix += 1
            name = f'{base_name}（系统{suffix if suffix > 1 else ""}）'
        connection.execute(
            "INSERT OR IGNORE INTO probe_tag_categories(id,name,created_at,source) VALUES(?,?,'1970-01-01T00:00:00+00:00','geoip')",
            (category_id, name),
        )
    connection.commit()
