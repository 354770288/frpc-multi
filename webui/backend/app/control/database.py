from __future__ import annotations

import sqlite3
from pathlib import Path


SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    uuid TEXT NOT NULL DEFAULT '',
    secret TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unknown',
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    node_id INTEGER,
    instance_name TEXT,
    success INTEGER NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    server_group TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_connectivity_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_ip TEXT NOT NULL,
    frps_reachable INTEGER NOT NULL DEFAULT 0,
    tunnel_established INTEGER NOT NULL DEFAULT 0,
    firewall_open INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '',
    test_time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probe_conn_ip ON probe_connectivity_results (server_ip, id);

CREATE TABLE IF NOT EXISTS probe_speed_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_ip TEXT NOT NULL,
    frps_reachable INTEGER NOT NULL DEFAULT 0,
    tunnel_ok INTEGER NOT NULL DEFAULT 0,
    dl_ok INTEGER NOT NULL DEFAULT 0,
    dl_speed_mbps REAL NOT NULL DEFAULT 0,
    dl_speed_mbs REAL NOT NULL DEFAULT 0,
    dl_bytes INTEGER NOT NULL DEFAULT 0,
    dl_sec REAL NOT NULL DEFAULT 0,
    ul_ok INTEGER NOT NULL DEFAULT 0,
    ul_speed_mbps REAL NOT NULL DEFAULT 0,
    ul_speed_mbs REAL NOT NULL DEFAULT 0,
    ul_bytes INTEGER NOT NULL DEFAULT 0,
    ul_sec REAL NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '',
    test_time TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_groups (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lb_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lb_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    zone_id TEXT NOT NULL,
    zone_name TEXT NOT NULL,
    group_name TEXT NOT NULL,
    ttl INTEGER NOT NULL DEFAULT 60,
    sync_mode TEXT NOT NULL DEFAULT 'manual',
    interval_seconds INTEGER NOT NULL DEFAULT 300,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_sync_at TEXT,
    last_sync_ok INTEGER,
    last_sync_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lb_sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL,
    added TEXT NOT NULL DEFAULT '[]',
    removed TEXT NOT NULL DEFAULT '[]',
    kept INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_probe_speed_ip ON probe_speed_results (server_ip, id);
"""


def _column_names(connection: sqlite3.Connection, table: str) -> set[str]:
    rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
    return {row[1] for row in rows}


def _migrate_nodes(connection: sqlite3.Connection) -> None:
    """把旧版 nodes 表（Console→Agent HTTP 时代）迁移到反转模型。

    旧表有 ``base_url`` / ``token`` 两列且为 ``NOT NULL`` 无默认值。反转模型不再写这两列，
    新建节点会触发 ``NOT NULL constraint failed``。SQLite 无法直接修改列约束，因此用
    "建新表 → 拷数据 → 替换" 的方式重建为新 schema（uuid/secret，无 base_url/token）。
    旧行的 uuid/secret 置空（这些旧节点需在面板重新创建才能在反转模型下连接）。
    """
    columns = _column_names(connection, "nodes")
    if not columns:
        return  # 表尚不存在，SCHEMA 会创建新结构。

    has_legacy = "base_url" in columns or "token" in columns
    has_new = "uuid" in columns and "secret" in columns

    if has_legacy:
        # 旧表存在 base_url/token，必须重建以解除其 NOT NULL 约束。
        connection.executescript(
            """
            CREATE TABLE nodes_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                uuid TEXT NOT NULL DEFAULT '',
                secret TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'unknown',
                last_seen_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        uuid_expr = "uuid" if "uuid" in columns else "''"
        secret_expr = "secret" if "secret" in columns else "''"
        connection.execute(
            f"""
            INSERT INTO nodes_new (id, name, uuid, secret, status, last_seen_at, created_at, updated_at)
            SELECT id, name, {uuid_expr}, {secret_expr}, status, last_seen_at, created_at, updated_at
            FROM nodes
            """
        )
        connection.execute("DROP TABLE nodes")
        connection.execute("ALTER TABLE nodes_new RENAME TO nodes")
        return

    # 无旧列：只是新 schema 缺补列的情况（理论上 SCHEMA 已建全，这里兜底）。
    if not has_new:
        if "uuid" not in columns:
            connection.execute("ALTER TABLE nodes ADD COLUMN uuid TEXT NOT NULL DEFAULT ''")
        if "secret" not in columns:
            connection.execute("ALTER TABLE nodes ADD COLUMN secret TEXT NOT NULL DEFAULT ''")


def connect_database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(SCHEMA)
    _migrate_nodes(connection)
    connection.commit()
    return connection
