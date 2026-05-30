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
    """把旧版 nodes 表（Console→Agent HTTP 时代的 base_url/token 列）迁移到反转模型。

    反转后节点不再保存 Agent 的可达地址与 bearer token，改为 uuid（绑定身份）+ secret
    （Agent 出站鉴权）。旧列保留即可（SQLite 无 DROP COLUMN 顾虑），只补齐新列。
    """
    columns = _column_names(connection, "nodes")
    if not columns:
        return  # 表尚不存在，SCHEMA 会创建新结构。
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
