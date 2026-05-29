from __future__ import annotations

from pathlib import Path
from typing import Callable, TypeVar

from ..models import now_iso
from .database import connect_database
from .models import NodeRecord

T = TypeVar("T")


def _normalize_base_url(base_url: str) -> str:
    value = (base_url or "").strip().rstrip("/")
    if not value:
        raise ValueError("节点地址不能为空")
    return value


def _normalize_name(name: str) -> str:
    value = (name or "").strip()
    if not value:
        raise ValueError("节点名称不能为空")
    if len(value) > 80:
        raise ValueError("节点名称过长")
    return value


def _record_from_row(row) -> NodeRecord:
    return NodeRecord(
        id=int(row["id"]),
        name=row["name"],
        base_url=row["base_url"],
        token=row["token"],
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
            row = connection.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
            return row

        row = self._with_connection(read)
        if row is None:
            raise KeyError(f"节点不存在: {node_id}")
        return _record_from_row(row)

    def create_node(
        self,
        *,
        name: str,
        base_url: str,
        token: str,
        status: str = "unknown",
        last_seen_at: str | None = None,
    ) -> NodeRecord:
        now = now_iso()
        def write(connection):
            cursor = connection.execute(
                """
                INSERT INTO nodes (name, base_url, token, status, last_seen_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _normalize_name(name),
                    _normalize_base_url(base_url),
                    (token or "").strip(),
                    (status or "unknown").strip(),
                    last_seen_at,
                    now,
                    now,
                ),
            )
            connection.commit()
            return int(cursor.lastrowid)

        node_id = self._with_connection(write)
        return self.get_node(node_id)

    def update_node(
        self,
        node_id: int,
        *,
        name: str | None = None,
        base_url: str | None = None,
        token: str | None = None,
        status: str | None = None,
        last_seen_at: str | None = None,
    ) -> NodeRecord | None:
        try:
            current = self.get_node(node_id)
        except KeyError:
            return None
        updated = {
            "name": _normalize_name(name) if name is not None else current.name,
            "base_url": _normalize_base_url(base_url) if base_url is not None else current.base_url,
            "token": (token or "").strip() if token is not None else current.token,
            "status": (status or "unknown").strip() if status is not None else current.status,
            "last_seen_at": last_seen_at if last_seen_at is not None else current.last_seen_at,
            "updated_at": now_iso(),
        }
        def write(connection):
            connection.execute(
                """
                UPDATE nodes
                SET name = ?, base_url = ?, token = ?, status = ?, last_seen_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    updated["name"],
                    updated["base_url"],
                    updated["token"],
                    updated["status"],
                    updated["last_seen_at"],
                    updated["updated_at"],
                    node_id,
                ),
            )
            connection.commit()

        self._with_connection(write)
        return self.get_node(node_id)

    def delete_node(self, node_id: int) -> bool:
        def write(connection):
            cursor = connection.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
            connection.commit()
            return cursor.rowcount > 0

        return self._with_connection(write)
