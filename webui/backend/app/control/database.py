from __future__ import annotations

import ipaddress
import sqlite3
import threading
from pathlib import Path


BUSY_TIMEOUT_MS = 5_000
DISCOVER_MIGRATION_BATCH_SIZE = 1_000

_initialized_paths: set[Path] = set()
_initialization_locks: dict[Path, threading.Lock] = {}
_initialization_locks_guard = threading.Lock()


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
    color TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_discover_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    ip_sort INTEGER,
    port INTEGER NOT NULL,
    latency_ms REAL NOT NULL DEFAULT 0,
    server_group TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    discovered_at TEXT NOT NULL,
    UNIQUE (ip, port)
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
    current_ip TEXT,
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


def _migrate_lb_domains(connection: sqlite3.Connection) -> None:
    """lb_domains 补 current_ip 列（单 A 主备模式：当前 A 记录指向的 IP）。"""
    columns = _column_names(connection, "lb_domains")
    if columns and "current_ip" not in columns:
        connection.execute("ALTER TABLE lb_domains ADD COLUMN current_ip TEXT")


def _migrate_probe_groups(connection: sqlite3.Connection) -> None:
    """probe_groups 补 color 列（分组颜色标记：red/yellow/blue/green，空=无色）。"""
    columns = _column_names(connection, "probe_groups")
    if columns and "color" not in columns:
        connection.execute("ALTER TABLE probe_groups ADD COLUMN color TEXT NOT NULL DEFAULT ''")


def _migrate_probe_discover_results(connection: sqlite3.Connection) -> None:
    """Atomically add/backfill the IPv4 key using bounded cursor batches."""
    columns = _column_names(connection, "probe_discover_results")
    if not columns:
        return

    try:
        connection.execute("BEGIN IMMEDIATE")
        if "ip_sort" not in columns:
            connection.execute("ALTER TABLE probe_discover_results ADD COLUMN ip_sort INTEGER")

        cursor = connection.execute(
            "SELECT id, ip FROM probe_discover_results WHERE ip_sort IS NULL"
        )
        while rows := cursor.fetchmany(DISCOVER_MIGRATION_BATCH_SIZE):
            valid = []
            for row in rows:
                try:
                    address = ipaddress.ip_address(row["ip"])
                except ValueError:
                    continue
                if address.version == 4:
                    valid.append((int(address), row["id"]))
            if valid:
                connection.executemany(
                    "UPDATE probe_discover_results SET ip_sort = ? WHERE id = ?", valid
                )

        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_discover_time "
            "ON probe_discover_results (discovered_at, id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_discover_ip "
            "ON probe_discover_results ((ip_sort IS NULL), ip_sort, id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_discover_ip_desc "
            "ON probe_discover_results ((ip_sort IS NULL) ASC, ip_sort DESC, id DESC)"
        )
        connection.execute("DROP INDEX IF EXISTS idx_probe_discover_group")
        connection.execute("DROP INDEX IF EXISTS idx_probe_discover_label")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_discover_group_time "
            "ON probe_discover_results (server_group, discovered_at, id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_discover_label_time "
            "ON probe_discover_results (label, discovered_at, id)"
        )
    except Exception:
        connection.rollback()
        raise
    else:
        connection.commit()


def _resolved_path(path: Path) -> Path:
    return Path(path).expanduser().resolve()


def _initialization_lock(path: Path) -> threading.Lock:
    with _initialization_locks_guard:
        return _initialization_locks.setdefault(path, threading.Lock())


def _open_database(path: Path) -> sqlite3.Connection:
    """Open and configure one owner-local connection without initializing schema."""
    connection = sqlite3.connect(path)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
        connection.execute("PRAGMA synchronous = NORMAL")
        return connection
    except Exception:
        connection.close()
        raise


def initialize_database(path: Path) -> None:
    """Initialize one database path once per process, retrying after failures."""
    resolved_path = _resolved_path(path)
    if resolved_path in _initialized_paths:
        return

    with _initialization_lock(resolved_path):
        if resolved_path in _initialized_paths:
            return

        resolved_path.parent.mkdir(parents=True, exist_ok=True)
        connection = _open_database(resolved_path)
        try:
            journal_mode = connection.execute("PRAGMA journal_mode = WAL").fetchone()[0]
            if str(journal_mode).lower() != "wal":
                raise RuntimeError(
                    f"failed to enable SQLite WAL mode for {resolved_path}: {journal_mode}"
                )
            connection.executescript(SCHEMA)
            _migrate_nodes(connection)
            _migrate_lb_domains(connection)
            _migrate_probe_groups(connection)
            connection.commit()
            _migrate_probe_discover_results(connection)
        finally:
            connection.close()

        _initialized_paths.add(resolved_path)


def connect_database(path: Path) -> sqlite3.Connection:
    """Return a fresh connection owned by the calling thread."""
    resolved_path = _resolved_path(path)
    initialize_database(resolved_path)
    return _open_database(resolved_path)
