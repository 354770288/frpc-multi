from __future__ import annotations

from pathlib import Path
from typing import Callable, TypeVar

from ..models import now_iso
from .database import connect_database
from .models import AuditLogRecord

T = TypeVar("T")


def _record_from_row(row) -> AuditLogRecord:
    return AuditLogRecord(
        id=int(row["id"]),
        username=row["username"],
        action=row["action"],
        node_id=int(row["node_id"]) if row["node_id"] is not None else None,
        instance_name=row["instance_name"],
        success=bool(row["success"]),
        message=row["message"],
        created_at=row["created_at"],
    )


class AuditStore:
    def __init__(self, database_path: Path):
        self.database_path = database_path
        self._with_connection(lambda connection: None)

    def _with_connection(self, callback: Callable, *args) -> T:
        connection = connect_database(self.database_path)
        try:
            return callback(connection, *args)
        finally:
            connection.close()

    def create_log(
        self,
        *,
        username: str,
        action: str,
        node_id: int | None = None,
        instance_name: str | None = None,
        success: bool = True,
        message: str = "",
    ) -> AuditLogRecord:
        created_at = now_iso()

        def write(connection):
            cursor = connection.execute(
                """
                INSERT INTO audit_logs (username, action, node_id, instance_name, success, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    (username or "").strip(),
                    (action or "").strip(),
                    node_id,
                    instance_name,
                    1 if success else 0,
                    message,
                    created_at,
                ),
            )
            connection.commit()
            return int(cursor.lastrowid)

        log_id = self._with_connection(write)
        return self.get_log(log_id)

    def get_log(self, log_id: int) -> AuditLogRecord:
        def read(connection):
            return connection.execute("SELECT * FROM audit_logs WHERE id = ?", (log_id,)).fetchone()

        row = self._with_connection(read)
        if row is None:
            raise KeyError(f"审计日志不存在: {log_id}")
        return _record_from_row(row)

    def list_logs(self, *, limit: int = 100) -> list[AuditLogRecord]:
        bounded_limit = min(max(limit, 1), 500)

        def read(connection):
            rows = connection.execute(
                "SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?",
                (bounded_limit,),
            ).fetchall()
            return [_record_from_row(row) for row in rows]

        return self._with_connection(read)
