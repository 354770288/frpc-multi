from __future__ import annotations

import secrets
from pathlib import Path
from typing import Callable, TypeVar

from ..models import now_iso
from .database import connect_database
from .models import NodeRecord

T = TypeVar("T")


def _normalize_name(name: str) -> str:
    value = (name or "").strip()
    if not value:
        raise ValueError("节点名称不能为空")
    if len(value) > 80:
        raise ValueError("节点名称过长")
    return value


def _generate_uuid() -> str:
    # 32 hex chars，作为节点的稳定身份标识，写入 Agent 安装命令。
    return secrets.token_hex(16)


def _generate_secret() -> str:
    # Agent 出站连接 Console 的鉴权密钥，仅在创建/轮换时返回明文一次。
    return secrets.token_urlsafe(32)


def _record_from_row(row) -> NodeRecord:
    keys = row.keys()
    return NodeRecord(
        id=int(row["id"]),
        name=row["name"],
        uuid=row["uuid"] if "uuid" in keys else "",
        secret=row["secret"] if "secret" in keys else "",
        status=row["status"],
        last_seen_at=row["last_seen_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class NodeStore:
    def __init__(self, database_path: Path):
        self.database_path = database_path
        self._with_connection(lambda connection: None)

    def _with_connection(self, callback: Callable, *args) -> T:
        connection = connect_database(self.database_path)
        try:
            return callback(connection, *args)
        finally:
            connection.close()

    def list_nodes(self) -> list[NodeRecord]:
        def read(connection):
            rows = connection.execute("SELECT * FROM nodes ORDER BY id").fetchall()
            return [_record_from_row(row) for row in rows]

        return self._with_connection(read)

    def get_node(self, node_id: int) -> NodeRecord:
        def read(connection):
            return connection.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()

        row = self._with_connection(read)
        if row is None:
            raise KeyError(f"节点不存在: {node_id}")
        return _record_from_row(row)

    def get_node_by_uuid(self, uuid: str) -> NodeRecord:
        def read(connection):
            return connection.execute("SELECT * FROM nodes WHERE uuid = ?", (uuid,)).fetchone()

        row = self._with_connection(read)
        if row is None:
            raise KeyError(f"节点不存在: {uuid}")
        return _record_from_row(row)

    def create_node(self, *, name: str) -> NodeRecord:
        """新建节点，自动生成 uuid + secret（用于一键安装命令）。"""
        now = now_iso()
        node_uuid = _generate_uuid()
        node_secret = _generate_secret()

        def write(connection):
            cursor = connection.execute(
                """
                INSERT INTO nodes (name, uuid, secret, status, last_seen_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (_normalize_name(name), node_uuid, node_secret, "pending", None, now, now),
            )
            connection.commit()
            return int(cursor.lastrowid)

        node_id = self._with_connection(write)
        return self.get_node(node_id)

    def rotate_secret(self, node_id: int) -> NodeRecord | None:
        """轮换节点 secret（旧 Agent 需用新 secret 重连）。"""
        try:
            self.get_node(node_id)
        except KeyError:
            return None
        new_secret = _generate_secret()

        def write(connection):
            connection.execute(
                "UPDATE nodes SET secret = ?, updated_at = ? WHERE id = ?",
                (new_secret, now_iso(), node_id),
            )
            connection.commit()

        self._with_connection(write)
        return self.get_node(node_id)

    def update_node(
        self,
        node_id: int,
        *,
        name: str | None = None,
        status: str | None = None,
        last_seen_at: str | None = None,
    ) -> NodeRecord | None:
        try:
            current = self.get_node(node_id)
        except KeyError:
            return None
        updated = {
            "name": _normalize_name(name) if name is not None else current.name,
            "status": (status or "unknown").strip() if status is not None else current.status,
            "last_seen_at": last_seen_at if last_seen_at is not None else current.last_seen_at,
            "updated_at": now_iso(),
        }

        def write(connection):
            connection.execute(
                """
                UPDATE nodes
                SET name = ?, status = ?, last_seen_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    updated["name"],
                    updated["status"],
                    updated["last_seen_at"],
                    updated["updated_at"],
                    node_id,
                ),
            )
            connection.commit()

        self._with_connection(write)
        return self.get_node(node_id)

    def mark_status_by_uuid(
        self, uuid: str, *, status: str, last_seen_at: str | None = None
    ) -> NodeRecord | None:
        try:
            current = self.get_node_by_uuid(uuid)
        except KeyError:
            return None
        return self.update_node(current.id, status=status, last_seen_at=last_seen_at)

    def delete_node(self, node_id: int) -> bool:
        def write(connection):
            cursor = connection.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
            connection.commit()
            return cursor.rowcount > 0

        return self._with_connection(write)
