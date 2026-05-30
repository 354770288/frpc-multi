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
