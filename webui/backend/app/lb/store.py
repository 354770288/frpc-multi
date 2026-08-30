"""负载均衡（DDNS 域名池）数据存储。

lb_settings 存 Cloudflare API Token；lb_domains 是候选域名（绑定服务器库健康分组）；
lb_sync_logs 记录每次同步的增删明细。访问模式照 ProbeStore：短连接。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TypeVar

from ..models import now_iso
from ..control.database import connect_database, initialize_database

T = TypeVar("T")

# 域名白名单：逐标签校验（字母数字开头结尾，中间可连字符），杜绝注入与畸形域名
_SAFE_LABEL = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
_MANAGED_COMMENT = "frpc-multi-lb"


def validate_domain_name(name: str) -> str:
    value = (name or "").strip().lower().rstrip(".")
    if not value or len(value) > 253:
        raise ValueError("域名不能为空")
    labels = value.split(".")
    if any(not _SAFE_LABEL.match(label) for label in labels):
        raise ValueError("域名格式不合法（只允许小写字母、数字、点、连字符）")
    return value


def managed_comment() -> str:
    """托管标记：同步只增删带此 comment 的 A 记录，用户手动记录不受影响。"""
    return _MANAGED_COMMENT


@dataclass
class LbDomain:
    id: int
    name: str
    zone_id: str
    zone_name: str
    group_name: str
    ttl: int
    sync_mode: str  # manual | scheduled
    interval_seconds: int
    enabled: bool
    last_sync_at: str | None
    last_sync_ok: bool | None
    last_sync_message: str
    current_ip: str | None
    created_at: str


def _domain_from_row(row) -> LbDomain:
    return LbDomain(
        id=int(row["id"]),
        name=row["name"],
        zone_id=row["zone_id"],
        zone_name=row["zone_name"],
        group_name=row["group_name"],
        ttl=int(row["ttl"]),
        sync_mode=row["sync_mode"],
        interval_seconds=int(row["interval_seconds"]),
        enabled=bool(row["enabled"]),
        last_sync_at=row["last_sync_at"],
        last_sync_ok=(None if row["last_sync_ok"] is None else bool(row["last_sync_ok"])),
        last_sync_message=row["last_sync_message"],
        current_ip=row["current_ip"],
        created_at=row["created_at"],
    )


class LbStore:
    def __init__(self, database_path: Path):
        self.database_path = database_path
        initialize_database(database_path)

    def _with_connection(self, callback: Callable, *args) -> T:
        connection = connect_database(self.database_path)
        try:
            return callback(connection, *args)
        finally:
            connection.close()

    # ---- Cloudflare 凭据 ----

    def get_setting(self, key: str) -> str | None:
        def read(connection):
            row = connection.execute("SELECT value FROM lb_settings WHERE key = ?", (key,)).fetchone()
            return row[0] if row else None

        return self._with_connection(read)

    def set_setting(self, key: str, value: str) -> None:
        def write(connection):
            connection.execute(
                "INSERT INTO lb_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
            connection.commit()

        self._with_connection(write)

    def cloudflare_token(self) -> str | None:
        return self.get_setting("cloudflare_token")

    def set_cloudflare_token(self, token: str) -> None:
        self.set_setting("cloudflare_token", token.strip())

    # ---- 候选域名 ----

    def list_domains(self) -> list[LbDomain]:
        def read(connection):
            rows = connection.execute("SELECT * FROM lb_domains ORDER BY name").fetchall()
            return [_domain_from_row(row) for row in rows]

        return self._with_connection(read)

    def get_domain(self, domain_id: int) -> LbDomain:
        def read(connection):
            return connection.execute("SELECT * FROM lb_domains WHERE id = ?", (domain_id,)).fetchone()

        row = self._with_connection(read)
        if row is None:
            raise KeyError(f"候选域名不存在: {domain_id}")
        return _domain_from_row(row)

    def get_domain_by_name(self, name: str) -> LbDomain | None:
        def read(connection):
            return connection.execute("SELECT * FROM lb_domains WHERE name = ?", (name,)).fetchone()

        row = self._with_connection(read)
        return _domain_from_row(row) if row else None

    def create_domain(self, *, name: str, zone_id: str, zone_name: str, group_name: str,
                      ttl: int = 60, sync_mode: str = "manual", interval_seconds: int = 300,
                      enabled: bool = True) -> LbDomain:
        clean_name = validate_domain_name(name)
        if sync_mode not in {"manual", "scheduled"}:
            raise ValueError("同步模式必须是 manual 或 scheduled")
        if not 30 <= ttl <= 3600:
            raise ValueError("TTL 必须在 30-3600 秒")
        if not 60 <= interval_seconds <= 86400:
            raise ValueError("同步间隔必须在 60-86400 秒")
        if not (zone_id or "").strip() or not (zone_name or "").strip():
            raise ValueError("Zone 不能为空")
        if not (group_name or "").strip():
            raise ValueError("绑定的分组不能为空")

        def write(connection):
            try:
                cursor = connection.execute(
                    "INSERT INTO lb_domains (name, zone_id, zone_name, group_name, ttl, sync_mode, "
                    "interval_seconds, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (clean_name, zone_id.strip(), validate_domain_name(zone_name),
                     group_name.strip(), ttl, sync_mode, interval_seconds,
                     1 if enabled else 0, now_iso()),
                )
            except Exception as exc:
                if "UNIQUE" in str(exc):
                    raise ValueError(f"候选域名已存在: {clean_name}") from exc
                raise
            connection.commit()
            return int(cursor.lastrowid)

        domain_id = self._with_connection(write)
        return self.get_domain(domain_id)

    def update_domain(self, domain_id: int, *, group_name: str | None = None, ttl: int | None = None,
                      sync_mode: str | None = None, interval_seconds: int | None = None,
                      enabled: bool | None = None) -> LbDomain:
        domain = self.get_domain(domain_id)
        new_group = (group_name or "").strip() if group_name is not None else domain.group_name
        if not new_group:
            raise ValueError("绑定的分组不能为空")
        new_mode = sync_mode if sync_mode is not None else domain.sync_mode
        if new_mode not in {"manual", "scheduled"}:
            raise ValueError("同步模式必须是 manual 或 scheduled")
        new_ttl = ttl if ttl is not None else domain.ttl
        if not 30 <= new_ttl <= 3600:
            raise ValueError("TTL 必须在 30-3600 秒")
        new_interval = interval_seconds if interval_seconds is not None else domain.interval_seconds
        if not 60 <= new_interval <= 86400:
            raise ValueError("同步间隔必须在 60-86400 秒")
        new_enabled = enabled if enabled is not None else domain.enabled

        def write(connection):
            connection.execute(
                "UPDATE lb_domains SET group_name = ?, ttl = ?, sync_mode = ?, "
                "interval_seconds = ?, enabled = ? WHERE id = ?",
                (new_group, new_ttl, new_mode, new_interval, 1 if new_enabled else 0, domain_id),
            )
            connection.commit()

        self._with_connection(write)
        return self.get_domain(domain_id)

    def delete_domain(self, domain_id: int) -> None:
        self.get_domain(domain_id)

        def write(connection):
            connection.execute("DELETE FROM lb_sync_logs WHERE domain_id = ?", (domain_id,))
            connection.execute("DELETE FROM lb_domains WHERE id = ?", (domain_id,))
            connection.commit()

        self._with_connection(write)

    def mark_sync_result(self, domain_id: int, *, ok: bool, message: str,
                         added: list[str], removed: list[str], kept: int,
                         current_ip: str | None = None) -> None:
        timestamp = now_iso()

        def write(connection):
            connection.execute(
                "UPDATE lb_domains SET last_sync_at = ?, last_sync_ok = ?, last_sync_message = ?, "
                "current_ip = ? WHERE id = ?",
                (timestamp, 1 if ok else 0, message[:500], current_ip, domain_id),
            )
            connection.execute(
                "INSERT INTO lb_sync_logs (domain_id, added, removed, kept, success, message, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (domain_id, json.dumps(added), json.dumps(removed), kept,
                 1 if ok else 0, message[:500], timestamp),
            )
            connection.commit()

        self._with_connection(write)

    def list_sync_logs(self, domain_id: int, *, limit: int = 50) -> list[dict]:
        bounded = min(max(limit, 1), 200)

        def read(connection):
            rows = connection.execute(
                "SELECT * FROM lb_sync_logs WHERE domain_id = ? ORDER BY id DESC LIMIT ?",
                (domain_id, bounded),
            ).fetchall()
            result = []
            for row in rows:
                result.append({
                    "id": int(row["id"]),
                    "domainId": int(row["domain_id"]),
                    "added": json.loads(row["added"]),
                    "removed": json.loads(row["removed"]),
                    "kept": int(row["kept"]),
                    "success": bool(row["success"]),
                    "message": row["message"],
                    "createdAt": row["created_at"],
                })
            return result

        return self._with_connection(read)
