from __future__ import annotations

import ipaddress
import sqlite3
import threading
import uuid
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
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS probe_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL UNIQUE,
    ip_sort INTEGER,
    speed_sort REAL NOT NULL DEFAULT 0,
    time_sort TEXT,
    label TEXT NOT NULL DEFAULT '',
    server_group TEXT NOT NULL DEFAULT '',
    group_id TEXT,
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
    id TEXT NOT NULL UNIQUE,
    name TEXT PRIMARY KEY,
    color TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_tag_categories (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_tags (
    id TEXT PRIMARY KEY NOT NULL,
    category_id TEXT NOT NULL REFERENCES probe_tag_categories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (category_id, name)
);
CREATE TABLE IF NOT EXISTS probe_server_tags (
    server_id INTEGER NOT NULL REFERENCES probe_servers(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES probe_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (server_id, tag_id)
);
CREATE TABLE IF NOT EXISTS probe_server_selections (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL,
    filters TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
    max_server_id INTEGER NOT NULL DEFAULT 0, catalog_revision INTEGER NOT NULL DEFAULT 0,
    build_cursor INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_probe_server_selections_owner ON probe_server_selections(owner,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_probe_server_selections_expiry ON probe_server_selections(expires_at,state);
CREATE TABLE IF NOT EXISTS probe_server_selection_members (
    selection_id TEXT NOT NULL REFERENCES probe_server_selections(id) ON DELETE CASCADE,
    server_id INTEGER NOT NULL, ip TEXT NOT NULL,
    PRIMARY KEY(selection_id,server_id)
);
CREATE TABLE IF NOT EXISTS probe_server_bulk_jobs (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, selection_id TEXT NOT NULL,
    operation TEXT NOT NULL, payload TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    state TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
    succeeded INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    items_ready INTEGER NOT NULL DEFAULT 0,
    materialize_cursor INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
    retry_of TEXT, UNIQUE(owner,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_probe_server_bulk_jobs_owner ON probe_server_bulk_jobs(owner,created_at DESC);
CREATE TABLE IF NOT EXISTS probe_server_bulk_items (
    job_id TEXT NOT NULL REFERENCES probe_server_bulk_jobs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, server_id INTEGER NOT NULL, ip TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(job_id,ordinal)
);
CREATE INDEX IF NOT EXISTS idx_probe_server_bulk_items_state ON probe_server_bulk_items(job_id,state,ordinal);
CREATE TABLE IF NOT EXISTS probe_server_bulk_lease (
    id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL DEFAULT '', lease_until REAL NOT NULL DEFAULT 0,
    token TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO probe_server_bulk_lease(id) VALUES(1);
CREATE INDEX IF NOT EXISTS idx_probe_server_tags_tag_server
    ON probe_server_tags (tag_id, server_id);

CREATE TABLE IF NOT EXISTS probe_server_views (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    filters TEXT NOT NULL,
    sort TEXT NOT NULL,
    sort_order TEXT NOT NULL,
    visible_columns TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probe_server_views_updated ON probe_server_views(updated_at DESC,id);

CREATE TABLE IF NOT EXISTS probe_discover_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    ip_sort INTEGER,
    port INTEGER NOT NULL,
    latency_ms REAL NOT NULL DEFAULT 0,
    server_group TEXT NOT NULL DEFAULT '',
    group_id TEXT,
    label TEXT NOT NULL DEFAULT '',
    discovered_at TEXT NOT NULL,
    UNIQUE (ip, port)
);

CREATE TABLE IF NOT EXISTS probe_nodes (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'worker', version TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '[]', last_seen REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, protocol_features TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS probe_jobs (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'running',
    options TEXT NOT NULL, created_at TEXT NOT NULL,
    primary_managed INTEGER NOT NULL DEFAULT 0,
    execution_policy TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_probe_jobs_time ON probe_jobs(created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS probe_job_producers (
    job_id TEXT PRIMARY KEY NOT NULL REFERENCES probe_jobs(id) ON DELETE CASCADE,
    selection_id TEXT NOT NULL, created_by TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
    stage TEXT NOT NULL, target_total INTEGER NOT NULL,
    materialized_count INTEGER NOT NULL DEFAULT 0,
    cursor_server_id INTEGER NOT NULL DEFAULT 0,
    max_server_id INTEGER NOT NULL DEFAULT 0,
    current_node_id TEXT NOT NULL, owner_index INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'queued', failover_waiting INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(created_by,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_probe_job_producers_owner_state
    ON probe_job_producers(state,current_node_id,created_at,job_id);
CREATE INDEX IF NOT EXISTS idx_probe_job_producers_selection
    ON probe_job_producers(selection_id,state,updated_at);
CREATE TABLE IF NOT EXISTS probe_job_producer_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
    from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL,
    generation INTEGER NOT NULL, cursor_server_id INTEGER NOT NULL,
    reason TEXT NOT NULL, transferred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probe_job_producer_transfers_time
    ON probe_job_producer_transfers(transferred_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_probe_job_producer_transfers_job
    ON probe_job_producer_transfers(job_id,transferred_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS probe_tasks (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES probe_jobs(id),
    node_id TEXT NOT NULL, stage TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'pending', attempt_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    lease_until REAL NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0,
    progress TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0, failover_waiting INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_probe_tasks_claim ON probe_tasks(node_id,state,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_probe_task_pipeline ON probe_tasks(job_id,node_id,stage,ip,port) WHERE stage != 'discover';
CREATE INDEX IF NOT EXISTS idx_probe_tasks_job ON probe_tasks(job_id,state);
CREATE TABLE IF NOT EXISTS probe_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL DEFAULT '',
    job_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL,
    server_ip TEXT NOT NULL, port INTEGER NOT NULL, test_time TEXT NOT NULL,
    data TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, UNIQUE(task_id,attempt_id)
);
CREATE INDEX IF NOT EXISTS idx_probe_results_source ON probe_results(node_id,kind,server_ip,port,id);
CREATE INDEX IF NOT EXISTS idx_probe_results_history ON probe_results(node_id,kind,id DESC);
CREATE TABLE IF NOT EXISTS probe_current_results (
    server_ip TEXT NOT NULL, kind TEXT NOT NULL, port INTEGER NOT NULL CHECK(port=7000),
    source_result_id INTEGER NOT NULL, node_id TEXT NOT NULL, job_id TEXT NOT NULL,
    task_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
    test_time TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(server_ip,kind,port)
);
CREATE INDEX IF NOT EXISTS idx_probe_current_results_kind_ip ON probe_current_results(kind,server_ip);
CREATE TABLE IF NOT EXISTS probe_discover_observations (
    node_id TEXT NOT NULL, ip TEXT NOT NULL, port INTEGER NOT NULL,
    latency_ms REAL NOT NULL, discovered_at TEXT NOT NULL,
    PRIMARY KEY(node_id,ip,port)
);

CREATE TABLE IF NOT EXISTS probe_task_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, job_id TEXT NOT NULL,
    from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, generation INTEGER NOT NULL,
    reason TEXT NOT NULL, transferred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probe_task_transfers_time ON probe_task_transfers(transferred_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_probe_task_transfers_node ON probe_task_transfers(from_node_id,to_node_id,transferred_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS probe_failover_scan_cursor (
    id INTEGER PRIMARY KEY CHECK(id=1), job_id TEXT NOT NULL DEFAULT '', owner_index INTEGER NOT NULL DEFAULT -1
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
    group_id TEXT,
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
    if columns and "id" not in columns:
        connection.execute("ALTER TABLE probe_groups ADD COLUMN id TEXT")


def _migrate_stable_group_ids(connection: sqlite3.Connection) -> None:
    """Backfill canonical groups and their nullable references from legacy names."""
    marker = connection.execute(
        "SELECT value FROM probe_settings WHERE key = 'probe_stable_group_ids_migrated'"
    ).fetchone()
    if marker is not None:
        return

    for table in ("probe_servers", "probe_discover_results", "lb_domains"):
        columns = _column_names(connection, table)
        if columns and "group_id" not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN group_id TEXT")

    # Existing group table had name as its primary key. Add IDs once and enforce
    # uniqueness after filling historical rows.
    rows = connection.execute("SELECT name, id FROM probe_groups ORDER BY name")
    for row in rows:
        if not row["id"]:
            connection.execute("UPDATE probe_groups SET id = ? WHERE name = ?",
                               (str(uuid.uuid4()), row["name"]))

    # Include every legacy name in each consumer; iterate the small distinct-name
    # set instead of materializing potentially large asset/discovery tables.
    names = connection.execute(
        "SELECT server_group AS name FROM probe_servers WHERE trim(server_group) != '' "
        "UNION SELECT server_group AS name FROM probe_discover_results WHERE trim(server_group) != '' "
        "UNION SELECT group_name AS name FROM lb_domains WHERE trim(group_name) != '' "
        "ORDER BY name"
    )
    for row in names:
        connection.execute(
            "INSERT OR IGNORE INTO probe_groups (id, name, color, created_at) VALUES (?, ?, '', ?)",
            (str(uuid.uuid4()), row["name"], "1970-01-01T00:00:00+00:00"),
        )

    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_probe_groups_id ON probe_groups(id)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_probe_servers_group_id ON probe_servers(group_id)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_probe_discover_group_id ON probe_discover_results(group_id)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_lb_domains_group_id ON lb_domains(group_id)")
    connection.execute(
        "UPDATE probe_servers SET group_id = (SELECT id FROM probe_groups g WHERE g.name = probe_servers.server_group) "
        "WHERE trim(server_group) != '' AND group_id IS NULL"
    )
    connection.execute(
        "UPDATE probe_discover_results SET group_id = (SELECT id FROM probe_groups g WHERE g.name = probe_discover_results.server_group) "
        "WHERE trim(server_group) != '' AND group_id IS NULL"
    )
    connection.execute(
        "UPDATE lb_domains SET group_id = (SELECT id FROM probe_groups g WHERE g.name = lb_domains.group_name) "
        "WHERE trim(group_name) != '' AND group_id IS NULL"
    )
    # initialize_database commits this marker together with the complete backfill.
    # If any preceding statement fails, the enclosing initialization transaction
    # rolls back both the changes and this marker, allowing the migration to retry.
    connection.execute(
        "INSERT INTO probe_settings (key, value) VALUES ('probe_stable_group_ids_migrated', '1')"
    )


def _migrate_probe_discover_results(connection: sqlite3.Connection) -> None:
    """Atomically add/backfill the IPv4 key using bounded cursor batches."""
    columns = _column_names(connection, "probe_discover_results")
    if not columns:
        return

    try:
        connection.execute("BEGIN IMMEDIATE")
        if "ip_sort" not in columns:
            connection.execute("ALTER TABLE probe_discover_results ADD COLUMN ip_sort INTEGER")

        # 每轮先物化一批 id 再更新：避免「遍历游标的同时更新 WHERE 依赖的同一列」
        # （SQLite 对未访问行被修改的行为未定义，极端情况会漏行且迁移永不重跑）。
        # 无法解析的 legacy/IPv6 行（ip 永远算不出 ip_sort）用 id 游标跳过，
        # 防止同一批被反复取回造成死循环；这些行永驻 NULL，由 null-last 排序兜底。
        last_seen_id = 0
        while True:
            batch = connection.execute(
                "SELECT id, ip FROM probe_discover_results "
                "WHERE ip_sort IS NULL AND id > ? LIMIT ?",
                (last_seen_id, DISCOVER_MIGRATION_BATCH_SIZE),
            ).fetchall()
            if not batch:
                break
            last_seen_id = max(row["id"] for row in batch)
            valid = []
            for row in batch:
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


def _probe_asset_host_sql(value: str) -> str:
    """Extract the fixed-port host while preserving split_probe_endpoint semantics."""
    colon_count = f"length({value})-length(replace({value},':',''))"
    suffix = f"substr({value},instr({value},':')+1)"
    is_port_7000 = (f"({colon_count}=1 AND {suffix}<>'' "
                    f"AND {suffix} NOT GLOB '*[^0-9]*' AND CAST({suffix} AS INTEGER)=7000)")
    return f"(CASE WHEN {is_port_7000} THEN substr({value},1,instr({value},':')-1) ELSE {value} END)"


def _migrate_probe_servers(connection: sqlite3.Connection) -> None:
    """Maintain materialized IP/speed/time sort keys and their query indexes."""
    columns = _column_names(connection, "probe_servers")
    if not columns:
        return

    try:
        connection.execute("BEGIN IMMEDIATE")
        if "ip_sort" not in columns:
            connection.execute("ALTER TABLE probe_servers ADD COLUMN ip_sort INTEGER")
        if "speed_sort" not in columns:
            connection.execute("ALTER TABLE probe_servers ADD COLUMN speed_sort REAL NOT NULL DEFAULT 0")
        if "time_sort" not in columns:
            connection.execute("ALTER TABLE probe_servers ADD COLUMN time_sort TEXT")

        # 物化批次 + id 单调游标：既避免「遍历游标同时改 WHERE 列」的未定义行为，
        # 也保证整批无法解析的行不会死循环（这些行永驻 NULL，null-last 排序兜底）。
        last_seen_id = 0
        while True:
            batch = connection.execute(
                "SELECT id, ip FROM probe_servers WHERE ip_sort IS NULL AND id > ? LIMIT ?",
                (last_seen_id, DISCOVER_MIGRATION_BATCH_SIZE),
            ).fetchall()
            if not batch:
                break
            last_seen_id = max(row["id"] for row in batch)
            valid = []
            for row in batch:
                try:
                    address = ipaddress.ip_address(row["ip"])
                except ValueError:
                    continue
                if address.version == 4:
                    valid.append((int(address), row["id"]))
            if valid:
                connection.executemany(
                    "UPDATE probe_servers SET ip_sort = ? WHERE id = ?", valid
                )

        # These keys follow the server-list endpoint join: any host accepted by
        # probe_endpoint_host participates, including domains and IPv6, while
        # only fixed-port current speed rows are considered. Keep unmeasured
        # speed at zero and time at NULL.
        projection_seeded = connection.execute(
            "SELECT 1 FROM probe_settings WHERE key='probe_server_measurement_sort_seeded'"
        ).fetchone()
        if projection_seeded is None:
            asset_host = _probe_asset_host_sql("probe_servers.ip")
            connection.execute(
                "UPDATE probe_servers SET speed_sort=COALESCE(("
                "SELECT COALESCE(json_extract(r.data,'$.dl_speed_bps'),0)*8.0/1048576 "
                "FROM probe_current_results r WHERE r.kind='speed' AND r.port=7000 "
                f"AND r.server_ip={asset_host}"
                "),0), time_sort=(SELECT r.test_time FROM probe_current_results r "
                "WHERE r.kind='speed' AND r.port=7000 "
                f"AND r.server_ip={asset_host})"
            )
            connection.execute(
                "INSERT INTO probe_settings(key,value) "
                "VALUES('probe_server_measurement_sort_seeded','1')"
            )

        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_servers_group_ip "
            "ON probe_servers (server_group, ip)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_servers_label ON probe_servers (label)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_servers_ip "
            "ON probe_servers ((ip_sort IS NULL), ip_sort, id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_servers_ip_desc "
            "ON probe_servers ((ip_sort IS NULL) ASC, ip_sort DESC, id DESC)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_servers_ip_sort_id "
            "ON probe_servers (ip_sort, id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_servers_speed_sort_id "
            "ON probe_servers (speed_sort, id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_servers_current_host "
            f"ON probe_servers ({_probe_asset_host_sql('ip')})"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_servers_time_sort_asc "
            "ON probe_servers ((time_sort IS NULL) ASC, time_sort ASC, id ASC)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_probe_servers_time_sort_desc "
            "ON probe_servers ((time_sort IS NULL) ASC, time_sort DESC, id DESC)"
        )

        # Current results are the canonical source. These triggers keep derived
        # sort keys in the same transaction as projection and asset mutations.
        current_asset_host = _probe_asset_host_sql("ip")
        new_asset_host = _probe_asset_host_sql("NEW.ip")
        connection.execute(f"""CREATE TRIGGER IF NOT EXISTS probe_servers_speed_insert
            AFTER INSERT ON probe_current_results
            WHEN NEW.kind='speed' AND NEW.port=7000
            BEGIN
                UPDATE probe_servers SET
                    speed_sort=COALESCE(json_extract(NEW.data,'$.dl_speed_bps'),0)*8.0/1048576,
                    time_sort=NEW.test_time
                WHERE {current_asset_host}=NEW.server_ip;
            END""")
        connection.execute(f"""CREATE TRIGGER IF NOT EXISTS probe_servers_speed_update
            AFTER UPDATE ON probe_current_results
            BEGIN
                UPDATE probe_servers SET speed_sort=0,time_sort=NULL
                WHERE OLD.kind='speed' AND OLD.port=7000
                  AND {current_asset_host}=OLD.server_ip;
                UPDATE probe_servers SET
                    speed_sort=COALESCE(json_extract(NEW.data,'$.dl_speed_bps'),0)*8.0/1048576,
                    time_sort=NEW.test_time
                WHERE NEW.kind='speed' AND NEW.port=7000
                  AND {current_asset_host}=NEW.server_ip;
            END""")
        connection.execute(f"""CREATE TRIGGER IF NOT EXISTS probe_servers_speed_delete
            AFTER DELETE ON probe_current_results
            WHEN OLD.kind='speed' AND OLD.port=7000
            BEGIN
                UPDATE probe_servers SET speed_sort=0,time_sort=NULL
                WHERE {current_asset_host}=OLD.server_ip;
            END""")
        connection.execute(f"""CREATE TRIGGER IF NOT EXISTS probe_servers_ip_sort_refresh
            AFTER UPDATE OF ip ON probe_servers
            BEGIN
                UPDATE probe_servers SET
                    speed_sort=COALESCE((SELECT COALESCE(json_extract(r.data,'$.dl_speed_bps'),0)*8.0/1048576
                        FROM probe_current_results r WHERE r.kind='speed' AND r.port=7000
                        AND r.server_ip={new_asset_host}),0),
                    time_sort=(SELECT r.test_time FROM probe_current_results r
                        WHERE r.kind='speed' AND r.port=7000
                        AND r.server_ip={new_asset_host})
                WHERE id=NEW.id;
            END""")
        connection.execute(f"""CREATE TRIGGER IF NOT EXISTS probe_servers_speed_asset_insert
            AFTER INSERT ON probe_servers
            BEGIN
                UPDATE probe_servers SET
                    speed_sort=COALESCE((SELECT COALESCE(json_extract(r.data,'$.dl_speed_bps'),0)*8.0/1048576
                        FROM probe_current_results r WHERE r.kind='speed' AND r.port=7000
                        AND r.server_ip={new_asset_host}),0),
                    time_sort=(SELECT r.test_time FROM probe_current_results r
                        WHERE r.kind='speed' AND r.port=7000
                        AND r.server_ip={new_asset_host})
                WHERE id=NEW.id;
            END""")
    except Exception:
        connection.rollback()
        raise
    else:
        connection.commit()


def _migrate_probe_tags(connection: sqlite3.Connection) -> None:
    """Seed categories and backfill asset labels once, atomically and in bounded batches."""
    namespace = uuid.UUID("895bfb47-4ce4-4b5f-a8fd-266ef7129031")
    category_ids = {
        name: str(uuid.uuid5(namespace, f"probe-tag-category:{name}"))
        for name in ("region", "carrier", "purpose", "other")
    }
    try:
        connection.execute("BEGIN IMMEDIATE")
        marker = connection.execute(
            "SELECT value FROM probe_settings WHERE key = 'probe_categorized_tags_migrated'"
        ).fetchone()
        if marker is not None:
            connection.execute("DROP INDEX IF EXISTS idx_probe_tags_category_name")
            connection.commit()
            return
        connection.execute("DROP INDEX IF EXISTS idx_probe_tags_category_name")
        created_at = "1970-01-01T00:00:00+00:00"
        connection.executemany(
            "INSERT OR IGNORE INTO probe_tag_categories (id, name, created_at) VALUES (?, ?, ?)",
            [(category_id, name, created_at) for name, category_id in category_ids.items()],
        )
        other_id = connection.execute(
            "SELECT id FROM probe_tag_categories WHERE name = 'other'"
        ).fetchone()["id"]

        last_seen_id = 0
        while True:
            batch = connection.execute(
                "SELECT id, label FROM probe_servers WHERE id > ? ORDER BY id LIMIT ?",
                (last_seen_id, DISCOVER_MIGRATION_BATCH_SIZE),
            ).fetchall()
            if not batch:
                break
            last_seen_id = batch[-1]["id"]
            for row in batch:
                labels = [part.strip() for part in str(row["label"] or "").strip(",").split(",")
                          if part.strip()]
                labels = list(dict.fromkeys(labels))
                packed = "," + ",".join(labels) + "," if labels else ""
                connection.execute(
                    "UPDATE probe_servers SET label = ? WHERE id = ?", (packed, row["id"])
                )
                for label in labels:
                    tag_id = str(uuid.uuid5(namespace, f"probe-tag:{other_id}:{label}"))
                    connection.execute(
                        "INSERT OR IGNORE INTO probe_tags (id, category_id, name, created_at) "
                        "VALUES (?, ?, ?, ?)", (tag_id, other_id, label, created_at),
                    )
                    connection.execute(
                        "INSERT OR IGNORE INTO probe_server_tags (server_id, tag_id) VALUES (?, ?)",
                        (row["id"], tag_id),
                    )

        connection.execute(
            "INSERT INTO probe_settings (key, value) VALUES ('probe_categorized_tags_migrated', '1')"
        )
    except Exception:
        connection.rollback()
        raise
    else:
        connection.commit()


def _migrate_labels_to_multi(connection: sqlite3.Connection) -> None:
    """label 单值 → 逗号哨兵多值格式（`,a,b,`）；幂等：已归一化的行跳过。

    支持一个 IP 挂多个标签；空串表示无标签。legacy「a,b」视为已用逗号
    分隔的多个标签。路由结论标签（CN2/非CN2/未路由测试）无逗号，安全。
    """
    try:
        for table in ("probe_servers", "probe_discover_results"):
            columns = _column_names(connection, table)
            if not columns or "label" not in columns:
                continue
            rows = connection.execute(
                f"SELECT id, label FROM {table} WHERE label != '' AND label NOT LIKE ',%'"
            ).fetchall()
            for row in rows:
                parts = [part.strip() for part in str(row["label"]).split(",") if part.strip()]
                if not parts:
                    connection.execute(f"UPDATE {table} SET label = '' WHERE id = ?", (row["id"],))
                else:
                    connection.execute(
                        f"UPDATE {table} SET label = ? WHERE id = ?",
                        ("," + ",".join(parts) + ",", row["id"]),
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


def _migrate_probe_server_bulk(connection: sqlite3.Connection) -> None:
    """Extend durable selection snapshots, async jobs, and catalog revision fencing."""
    additions = {
        "probe_server_bulk_jobs": [
            ("items_ready", "INTEGER NOT NULL DEFAULT 0"),
            ("materialize_cursor", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "probe_server_selections": [
            ("max_server_id", "INTEGER NOT NULL DEFAULT 0"),
            ("catalog_revision", "INTEGER NOT NULL DEFAULT 0"),
            ("build_cursor", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "probe_server_bulk_lease": [("token", "TEXT NOT NULL DEFAULT ''")],
    }
    for table, fields in additions.items():
        columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        for name, declaration in fields:
            if name not in columns:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
    connection.execute(
        "UPDATE probe_server_bulk_jobs SET items_ready=1 WHERE items_ready=0 "
        "AND EXISTS(SELECT 1 FROM probe_server_bulk_items i WHERE i.job_id=probe_server_bulk_jobs.id)"
    )
    connection.execute("CREATE TABLE IF NOT EXISTS probe_server_catalog_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0)")
    connection.execute("INSERT OR IGNORE INTO probe_server_catalog_revision(id,revision) VALUES(1,0)")
    connection.execute(
        "UPDATE probe_server_selections SET max_server_id=(SELECT COALESCE(MAX(id),0) FROM probe_servers), "
        "catalog_revision=(SELECT revision FROM probe_server_catalog_revision WHERE id=1) "
        "WHERE state IN ('queued','building') AND max_server_id=0 AND filters!='{}'"
    )
    triggers = {
        "probe_bulk_servers_update": """CREATE TRIGGER IF NOT EXISTS probe_bulk_servers_update
            AFTER UPDATE OF ip,label,server_group,group_id,ip_sort ON probe_servers
            WHEN EXISTS(SELECT 1 FROM probe_server_selections WHERE state IN ('queued','building') AND max_server_id>=OLD.id)
            BEGIN UPDATE probe_server_catalog_revision SET revision=revision+1 WHERE id=1; END""",
        "probe_bulk_servers_delete": """CREATE TRIGGER IF NOT EXISTS probe_bulk_servers_delete
            AFTER DELETE ON probe_servers
            WHEN EXISTS(SELECT 1 FROM probe_server_selections WHERE state IN ('queued','building') AND max_server_id>=OLD.id)
            BEGIN UPDATE probe_server_catalog_revision SET revision=revision+1 WHERE id=1; END""",
        "probe_bulk_tags_insert": """CREATE TRIGGER IF NOT EXISTS probe_bulk_tags_insert
            AFTER INSERT ON probe_server_tags
            WHEN EXISTS(SELECT 1 FROM probe_server_selections WHERE state IN ('queued','building') AND max_server_id>=NEW.server_id)
            BEGIN UPDATE probe_server_catalog_revision SET revision=revision+1 WHERE id=1; END""",
        "probe_bulk_tags_delete": """CREATE TRIGGER IF NOT EXISTS probe_bulk_tags_delete
            AFTER DELETE ON probe_server_tags
            WHEN EXISTS(SELECT 1 FROM probe_server_selections WHERE state IN ('queued','building') AND max_server_id>=OLD.server_id)
            BEGIN UPDATE probe_server_catalog_revision SET revision=revision+1 WHERE id=1; END""",
        "probe_bulk_tags_update": """CREATE TRIGGER IF NOT EXISTS probe_bulk_tags_update
            AFTER UPDATE OF server_id,tag_id ON probe_server_tags
            WHEN EXISTS(SELECT 1 FROM probe_server_selections WHERE state IN ('queued','building') AND max_server_id>=OLD.server_id)
            BEGIN UPDATE probe_server_catalog_revision SET revision=revision+1 WHERE id=1; END""",
        "probe_bulk_current_insert": """CREATE TRIGGER IF NOT EXISTS probe_bulk_current_insert
            AFTER INSERT ON probe_current_results
            WHEN EXISTS(SELECT 1 FROM probe_server_selections WHERE state IN ('queued','building'))
            BEGIN UPDATE probe_server_catalog_revision SET revision=revision+1 WHERE id=1; END""",
        "probe_bulk_current_update": """CREATE TRIGGER IF NOT EXISTS probe_bulk_current_update
            AFTER UPDATE ON probe_current_results
            WHEN EXISTS(SELECT 1 FROM probe_server_selections WHERE state IN ('queued','building'))
            BEGIN UPDATE probe_server_catalog_revision SET revision=revision+1 WHERE id=1; END""",
        "probe_bulk_current_delete": """CREATE TRIGGER IF NOT EXISTS probe_bulk_current_delete
            AFTER DELETE ON probe_current_results
            WHEN EXISTS(SELECT 1 FROM probe_server_selections WHERE state IN ('queued','building'))
            BEGIN UPDATE probe_server_catalog_revision SET revision=revision+1 WHERE id=1; END""",
        "probe_bulk_groups_update": """CREATE TRIGGER IF NOT EXISTS probe_bulk_groups_update
            AFTER UPDATE OF id,name ON probe_groups
            WHEN EXISTS(SELECT 1 FROM probe_server_selections WHERE state IN ('queued','building'))
            BEGIN UPDATE probe_server_catalog_revision SET revision=revision+1 WHERE id=1; END""",
        "probe_bulk_groups_delete": """CREATE TRIGGER IF NOT EXISTS probe_bulk_groups_delete
            AFTER DELETE ON probe_groups
            WHEN EXISTS(SELECT 1 FROM probe_server_selections WHERE state IN ('queued','building'))
            BEGIN UPDATE probe_server_catalog_revision SET revision=revision+1 WHERE id=1; END""",
    }
    for sql in triggers.values():
        connection.execute(sql)


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
            _migrate_probe_server_bulk(connection)
            _migrate_probe_failover(connection)
            _migrate_probe_current_results(connection)
            _migrate_nodes(connection)
            _migrate_lb_domains(connection)
            _migrate_probe_groups(connection)
            _migrate_stable_group_ids(connection)
            connection.commit()
            # 各迁移自带 BEGIN IMMEDIATE/COMMIT，必须都在外层 commit 之后调用，
            # 避免撞上前面 DML 留下的隐式事务
            _migrate_probe_discover_results(connection)
            _migrate_probe_servers(connection)
            _migrate_labels_to_multi(connection)
            _migrate_probe_tags(connection)
        finally:
            connection.close()

        _initialized_paths.add(resolved_path)


def _migrate_probe_failover(connection: sqlite3.Connection) -> None:
    """Add durable primary failover metadata to existing probe databases."""
    additions = {
        "probe_nodes": [("protocol_features", "TEXT NOT NULL DEFAULT '[]'")],
        "probe_jobs": [
            ("primary_managed", "INTEGER NOT NULL DEFAULT 0"),
            ("execution_policy", "TEXT NOT NULL DEFAULT '{}'"),
        ],
        "probe_tasks": [
            ("generation", "INTEGER NOT NULL DEFAULT 0"),
            ("failover_waiting", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "probe_results": [("generation", "INTEGER NOT NULL DEFAULT 0")],
    }
    added_failover_waiting = False
    for table, columns in additions.items():
        existing = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        for name, declaration in columns:
            if name not in existing:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
                if table == 'probe_tasks' and name == 'failover_waiting':
                    added_failover_waiting = True
    if added_failover_waiting:
        connection.execute("UPDATE probe_tasks SET failover_waiting=1 WHERE state='pending' AND error='waiting for an online backup'")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_probe_tasks_failover_wait ON probe_tasks(job_id,node_id,state,failover_waiting,created_at)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_probe_tasks_failover_batch ON probe_tasks(node_id,state,job_id,created_at)")
    connection.execute("INSERT OR IGNORE INTO probe_failover_scan_cursor(id,job_id,owner_index) VALUES(1,'',-1)")


def _migrate_probe_current_results(connection: sqlite3.Connection) -> None:
    """Seed the rebuildable current projection from the configured policy primary only.

    If policy has not been configured yet, leave the projection empty and retry on
    the next initialization. Accepted primary-managed reports maintain it after seed.
    """
    if connection.execute(
        "SELECT 1 FROM probe_settings WHERE key='probe_current_results_seeded'"
    ).fetchone():
        return
    try:
        row = connection.execute(
            "SELECT value FROM probe_settings WHERE key='probe_execution_policy'"
        ).fetchone()
        if row is None:
            return
        import json
        policy = json.loads(row[0])
        primary = policy.get('primaryNodeId') if isinstance(policy, dict) else None
        backups = policy.get('backupNodeIds') if isinstance(policy, dict) else None
        if (not isinstance(primary, str) or not primary or not isinstance(backups, list)
                or any(not isinstance(node_id, str) or not node_id for node_id in backups)
                or len(set(backups)) != len(backups) or primary in backups):
            return
        for node_id in [primary, *backups]:
            node = connection.execute('SELECT kind,capabilities FROM probe_nodes WHERE id=?', (node_id,)).fetchone()
            if node is None or node['kind'] != 'worker':
                return
            capabilities = json.loads(node['capabilities'])
            if (not isinstance(capabilities, list)
                    or not all(isinstance(capability, str) for capability in capabilities)
                    or not {'discover', 'route', 'connectivity', 'speed'}.issubset(capabilities)):
                return
    except (ValueError, TypeError, sqlite3.Error):
        return

    # INSERT OR IGNORE keeps a live projection maintained by accepted reports
    # intact across repeated startup migrations.
    connection.create_function("canonical_ipv4", 1, _canonical_ipv4)
    connection.execute(
        "INSERT OR IGNORE INTO probe_current_results "
        "(server_ip,kind,port,source_result_id,node_id,job_id,task_id,generation,test_time,data) "
        "SELECT r.server_ip,r.kind,r.port,r.id,r.node_id,r.job_id,r.task_id,r.generation,r.test_time,r.data "
        "FROM probe_results r WHERE r.node_id=? AND r.port=7000 "
        "AND r.kind IN ('route','connectivity','speed') AND canonical_ipv4(r.server_ip)=1 "
        "AND r.id=(SELECT MAX(x.id) FROM probe_results x WHERE x.node_id=r.node_id "
        "AND x.kind=r.kind AND x.server_ip=r.server_ip AND x.port=r.port)",
        (primary,),
    )
    connection.execute(
        "INSERT INTO probe_settings(key,value) VALUES('probe_current_results_seeded','1')"
    )


def _canonical_ipv4(value: str) -> int:
    try:
        return int(str(ipaddress.IPv4Address(value)) == value)
    except (ipaddress.AddressValueError, ValueError, TypeError):
        return 0


def connect_database(path: Path) -> sqlite3.Connection:
    """Return a fresh connection owned by the calling thread."""
    resolved_path = _resolved_path(path)
    initialize_database(resolved_path)
    return _open_database(resolved_path)
