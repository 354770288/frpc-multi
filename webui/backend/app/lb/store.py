"""负载均衡（DDNS 域名池）数据存储。

lb_settings 存 Cloudflare API Token；lb_domains 是候选域名（绑定服务器库健康分组）；
lb_sync_logs 记录每次同步的增删明细。访问模式照 ProbeStore：短连接。
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, TypeVar

from ..models import now_iso
from ..control.database import connect_database, initialize_database

T = TypeVar("T")

# 域名白名单：逐标签校验（字母数字开头结尾，中间可连字符），杜绝注入与畸形域名
_SAFE_LABEL = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
_MANAGED_COMMENT = "frpc-multi-lb"
_MAX_DOMAIN_SERVER_IDS = 5_000
_DOMAIN_SERVER_ID_CHUNK = 500
_UNSET = object()


def _resolve_group(connection, value: str) -> tuple[str, str]:
    clean = (value or "").strip()
    if not clean:
        raise ValueError("绑定的分组不能为空")
    row = connection.execute(
        "SELECT id, name FROM probe_groups WHERE id = ? OR name = ? LIMIT 1", (clean, clean)
    ).fetchone()
    if row is None:
        group_id = str(uuid.uuid4())
        connection.execute(
            "INSERT INTO probe_groups(id,name,color,created_at) VALUES(?,?,'',?)",
            (group_id, clean, now_iso()),
        )
        return clean, group_id
    return str(row["name"]), str(row["id"])


def _normalize_server_ids(server_ids: Iterable[int] | None) -> list[int]:
    if server_ids is None:
        return []
    try:
        iterator = iter(server_ids)
    except TypeError as exc:
        raise ValueError("服务器 ID 必须是列表") from exc
    normalized = []
    seen = set()
    input_count = 0
    for value in iterator:
        input_count += 1
        if input_count > _MAX_DOMAIN_SERVER_IDS:
            raise ValueError(f"单次最多处理 {_MAX_DOMAIN_SERVER_IDS} 台服务器")
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError("服务器 ID 必须是正整数")
        if value not in seen:
            seen.add(value)
            normalized.append(value)
    return normalized


def _validate_existing_servers(connection, server_ids: list[int]) -> None:
    missing = []
    for start in range(0, len(server_ids), _DOMAIN_SERVER_ID_CHUNK):
        batch = server_ids[start:start + _DOMAIN_SERVER_ID_CHUNK]
        placeholders = ",".join("?" for _ in batch)
        rows = connection.execute(
            f"SELECT id FROM probe_servers WHERE id IN ({placeholders})", batch
        ).fetchall()
        found = {int(row[0]) for row in rows}
        missing.extend(server_id for server_id in batch if server_id not in found)
    if missing:
        raise ValueError(f"服务器不存在: {', '.join(str(value) for value in missing[:20])}")


def _require_domain(connection, domain_id: int) -> None:
    if connection.execute("SELECT 1 FROM lb_domains WHERE id = ?", (domain_id,)).fetchone() is None:
        raise KeyError(f"候选域名不存在: {domain_id}")


def _bounded_page(limit: int, offset: int) -> tuple[int, int]:
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError("limit 必须是正整数")
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset 必须是非负整数")
    return min(limit, _MAX_DOMAIN_SERVER_IDS), offset


def _group_server_ids(connection, group_id: str, group_name: str) -> list[int]:
    rows = connection.execute(
        "SELECT id FROM probe_servers WHERE group_id = ? OR "
        "((group_id IS NULL OR group_id = '') AND server_group = ?) ORDER BY id",
        (group_id, group_name),
    ).fetchall()
    return [int(row[0]) for row in rows]


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
    group_id: str | None
    ttl: int
    sync_mode: str  # manual | scheduled
    interval_seconds: int
    enabled: bool
    last_sync_at: str | None
    last_sync_ok: bool | None
    last_sync_message: str
    current_ip: str | None
    created_at: str
    preferred_server_id: int | None = None


def _domain_from_row(row) -> LbDomain:
    return LbDomain(
        id=int(row["id"]),
        name=row["name"],
        zone_id=row["zone_id"],
        zone_name=row["zone_name"],
        group_name=row["group_name"],
        group_id=row["group_id"],
        ttl=int(row["ttl"]),
        sync_mode=row["sync_mode"],
        interval_seconds=int(row["interval_seconds"]),
        enabled=bool(row["enabled"]),
        last_sync_at=row["last_sync_at"],
        last_sync_ok=(None if row["last_sync_ok"] is None else bool(row["last_sync_ok"])),
        last_sync_message=row["last_sync_message"],
        current_ip=row["current_ip"],
        created_at=row["created_at"],
        preferred_server_id=(
            int(row["preferred_server_id"]) if row["preferred_server_id"] is not None else None
        ),
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

    def create_domain(self, *, name: str, zone_id: str, zone_name: str, group_name: str = "",
                      ttl: int = 60, sync_mode: str = "manual", interval_seconds: int = 300,
                      enabled: bool = True, server_ids: Iterable[int] | None = None,
                      preferred_server_id: int | None = None) -> LbDomain:
        clean_name = validate_domain_name(name)
        if sync_mode not in {"manual", "scheduled"}:
            raise ValueError("同步模式必须是 manual 或 scheduled")
        if not 30 <= ttl <= 3600:
            raise ValueError("TTL 必须在 30-3600 秒")
        if not 60 <= interval_seconds <= 86400:
            raise ValueError("同步间隔必须在 60-86400 秒")
        if not (zone_id or "").strip() or not (zone_name or "").strip():
            raise ValueError("Zone 不能为空")
        clean_group = (group_name or "").strip()
        selected_ids = _normalize_server_ids(server_ids) if server_ids is not None else None
        if preferred_server_id is not None:
            preferred_server_id = _normalize_server_ids([preferred_server_id])[0]
            if selected_ids is not None and preferred_server_id not in selected_ids:
                raise ValueError("首选服务器必须属于域名候选列表")

        def write(connection):
            try:
                # group_name remains a compatibility adapter: when explicitly
                # supplied without candidates, take one snapshot and discard
                # the live group relationship.
                snapshot_ids = selected_ids
                if snapshot_ids is None and clean_group:
                    resolved_name, group_id = _resolve_group(connection, clean_group)
                    snapshot_ids = _group_server_ids(connection, group_id, resolved_name)
                # Keep the legacy columns detached even when a legacy caller
                # supplied a group; only the materialized members persist.
                resolved_name, group_id = "", None
                cursor = connection.execute(
                    "INSERT INTO lb_domains (name, zone_id, zone_name, group_name, group_id, ttl, sync_mode, "
                    "interval_seconds, enabled, preferred_server_id, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (clean_name, zone_id.strip(), validate_domain_name(zone_name),
                     resolved_name, group_id, ttl, sync_mode, interval_seconds,
                     1 if enabled else 0, preferred_server_id, now_iso()),
                )
                domain_id = int(cursor.lastrowid)
                if snapshot_ids:
                    _validate_existing_servers(connection, snapshot_ids)
                    connection.executemany(
                        "INSERT INTO lb_domain_servers(domain_id, server_id) VALUES (?, ?)",
                        [(domain_id, server_id) for server_id in snapshot_ids],
                    )
                if preferred_server_id is not None and not connection.execute(
                    "SELECT 1 FROM lb_domain_servers WHERE domain_id = ? AND server_id = ?",
                    (domain_id, preferred_server_id),
                ).fetchone():
                    raise ValueError("首选服务器必须属于域名候选列表")
            except Exception as exc:
                connection.rollback()
                if "UNIQUE" in str(exc):
                    raise ValueError(f"候选域名已存在: {clean_name}") from exc
                raise
            connection.commit()
            return domain_id

        domain_id = self._with_connection(write)
        return self.get_domain(domain_id)

    def update_domain(self, domain_id: int, *, group_name: str | None = None, ttl: int | None = None,
                      sync_mode: str | None = None, interval_seconds: int | None = None,
                      enabled: bool | None = None,
                      preferred_server_id: int | None | object = _UNSET) -> LbDomain:
        domain = self.get_domain(domain_id)
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
        new_preferred = domain.preferred_server_id
        if preferred_server_id is not _UNSET:
            if preferred_server_id is None:
                new_preferred = None
            else:
                new_preferred = _normalize_server_ids([preferred_server_id])[0]

        def write(connection):
            if new_preferred is not None:
                _validate_existing_servers(connection, [new_preferred])
            # An explicit legacy group edit replaces the candidate snapshot;
            # ordinary domain edits leave membership untouched.
            replacement_ids = None
            if group_name is not None:
                new_group = (group_name or "").strip()
                if new_group:
                    resolved_name, group_id = _resolve_group(connection, new_group)
                    replacement_ids = _group_server_ids(connection, group_id, resolved_name)
                else:
                    resolved_name, group_id = "", None
            connection.execute(
                "UPDATE lb_domains SET group_name = ?, group_id = ?, ttl = ?, sync_mode = ?, "
                "interval_seconds = ?, enabled = ?, preferred_server_id = ? WHERE id = ?",
                ("", None, new_ttl, new_mode, new_interval,
                 1 if new_enabled else 0, new_preferred, domain_id),
            )
            if group_name is not None:
                connection.execute("DELETE FROM lb_domain_servers WHERE domain_id = ?", (domain_id,))
                if replacement_ids:
                    _validate_existing_servers(connection, replacement_ids)
                    connection.executemany(
                        "INSERT INTO lb_domain_servers(domain_id, server_id) VALUES (?, ?)",
                        [(domain_id, server_id) for server_id in replacement_ids],
                    )
            if new_preferred is not None and not connection.execute(
                "SELECT 1 FROM lb_domain_servers WHERE domain_id = ? AND server_id = ?",
                (domain_id, new_preferred),
            ).fetchone():
                raise ValueError("首选服务器必须属于域名候选列表")
            connection.commit()

        self._with_connection(write)
        return self.get_domain(domain_id)

    def add_domain_servers(self, domain_id: int, server_ids: Iterable[int]) -> int:
        """Atomically add up to 5000 existing assets; return newly added count."""
        ids = _normalize_server_ids(server_ids)

        def write(connection):
            connection.execute("BEGIN IMMEDIATE")
            _require_domain(connection, domain_id)
            _validate_existing_servers(connection, ids)
            before = connection.total_changes
            connection.executemany(
                "INSERT OR IGNORE INTO lb_domain_servers(domain_id, server_id) VALUES (?, ?)",
                [(domain_id, server_id) for server_id in ids],
            )
            added = connection.total_changes - before
            connection.commit()
            return added

        return self._with_connection(write)

    def remove_domain_servers(self, domain_id: int, server_ids: Iterable[int]) -> int:
        """Atomically remove up to 5000 existing assets; return removed count."""
        ids = _normalize_server_ids(server_ids)

        def write(connection):
            connection.execute("BEGIN IMMEDIATE")
            _require_domain(connection, domain_id)
            _validate_existing_servers(connection, ids)
            before = connection.total_changes
            connection.executemany(
                "DELETE FROM lb_domain_servers WHERE domain_id = ? AND server_id = ?",
                [(domain_id, server_id) for server_id in ids],
            )
            removed = connection.total_changes - before
            if ids:
                placeholders = ",".join("?" for _ in ids)
                connection.execute(
                    "UPDATE lb_domains SET preferred_server_id = NULL "
                    f"WHERE id = ? AND preferred_server_id IN ({placeholders})",
                    (domain_id, *ids),
                )
            connection.commit()
            return removed

        return self._with_connection(write)

    def domain_server_count(self, domain_id: int) -> int:
        def read(connection):
            _require_domain(connection, domain_id)
            return int(connection.execute(
                "SELECT COUNT(*) FROM lb_domain_servers WHERE domain_id = ?", (domain_id,)
            ).fetchone()[0])

        return self._with_connection(read)

    def domain_server_ids(self, domain_id: int, *, limit: int = 500, offset: int = 0) -> list[int]:
        bounded, page_offset = _bounded_page(limit, offset)

        def read(connection):
            _require_domain(connection, domain_id)
            return [int(row[0]) for row in connection.execute(
                "SELECT server_id FROM lb_domain_servers WHERE domain_id = ? "
                "ORDER BY server_id LIMIT ? OFFSET ?", (domain_id, bounded, page_offset)
            ).fetchall()]

        return self._with_connection(read)

    def domain_candidate_rows(self, domain_id: int, *, limit: int | None = 500,
                              offset: int = 0) -> list[dict]:
        """Read a bounded page of member assets with the fields used for selection."""
        if limit is None:
            if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
                raise ValueError("offset 必须是非负整数")
            bounded, page_offset = None, offset
        else:
            bounded, page_offset = _bounded_page(limit, offset)

        def read(connection):
            _require_domain(connection, domain_id)
            query = (
                "SELECT s.id, s.ip, s.label, s.conn_score, s.speed_sort, s.time_sort, s.server_group, s.group_id "
                "FROM lb_domain_servers m JOIN probe_servers s ON s.id = m.server_id "
                "WHERE m.domain_id = ? ORDER BY s.id"
            )
            params: tuple = (domain_id,)
            if bounded is not None:
                query += " LIMIT ? OFFSET ?"
                params += (bounded, page_offset)
            elif page_offset:
                query += " LIMIT -1 OFFSET ?"
                params += (page_offset,)
            rows = connection.execute(query, params).fetchall()
            return [dict(row) for row in rows]

        return self._with_connection(read)

    def domain_candidate_page(self, domain_id: int, *, page: int = 1, page_size: int = 50,
                              q: str = "") -> dict:
        """Return a searchable, stable-id-ordered page from domain membership."""
        if isinstance(page, bool) or not isinstance(page, int) or page < 1:
            raise ValueError("page 必须是正整数")
        bounded, _ = _bounded_page(page_size, 0)
        offset = (page - 1) * bounded
        search = (q or "").strip()

        def read(connection):
            _require_domain(connection, domain_id)
            predicate = "m.domain_id = ?"
            params: list[object] = [domain_id]
            if search:
                predicate += " AND (s.ip LIKE ? ESCAPE '\\' OR s.label LIKE ? ESCAPE '\\')"
                escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                params.extend((f"%{escaped}%", f"%{escaped}%"))
            total = int(connection.execute(
                "SELECT COUNT(*) FROM lb_domain_servers m JOIN probe_servers s ON s.id = m.server_id "
                f"WHERE {predicate}", params,
            ).fetchone()[0])
            rows = connection.execute(
                "SELECT s.id, s.ip, s.label, s.conn_score, s.speed_sort, s.time_sort, s.server_group, s.group_id "
                "FROM lb_domain_servers m JOIN probe_servers s ON s.id = m.server_id "
                f"WHERE {predicate} ORDER BY s.id LIMIT ? OFFSET ?",
                (*params, bounded, offset),
            ).fetchall()
            return {"items": [dict(row) for row in rows], "page": page,
                    "pageSize": bounded, "total": total}

        return self._with_connection(read)

    def iter_domain_candidate_rows(self, domain_id: int, *, batch_size: int = 500):
        """Yield all member candidates in bounded batches for selection/health work."""
        bounded, _ = _bounded_page(batch_size, 0)

        def read_batch(connection, cursor):
            _require_domain(connection, domain_id)
            rows = connection.execute(
                "SELECT s.id, s.ip, s.conn_score, s.speed_sort, s.time_sort, s.server_group, s.group_id "
                "FROM lb_domain_servers m JOIN probe_servers s ON s.id = m.server_id "
                "WHERE m.domain_id = ? AND s.id > ? ORDER BY s.id LIMIT ?",
                (domain_id, cursor, bounded),
            ).fetchall()
            return [dict(row) for row in rows]

        cursor = 0
        while True:
            rows = self._with_connection(read_batch, cursor)
            if not rows:
                return
            yield from rows
            cursor = int(rows[-1]["id"])

    def delete_domain(self, domain_id: int) -> None:
        self.get_domain(domain_id)

        def write(connection):
            connection.execute("DELETE FROM lb_sync_logs WHERE domain_id = ?", (domain_id,))
            connection.execute("DELETE FROM lb_domains WHERE id = ?", (domain_id,))
            connection.commit()

        self._with_connection(write)

    def mark_sync_result(self, domain_id: int, *, ok: bool, message: str,
                         added: list[str], removed: list[str], kept: int,
                         current_ip: str | None = None,
                         preferred_server_id: int | None | object = _UNSET) -> None:
        timestamp = now_iso()
        preferred = preferred_server_id
        if preferred is not _UNSET and preferred is not None:
            preferred = _normalize_server_ids([preferred])[0]

        def write(connection):
            _require_domain(connection, domain_id)
            if ok and preferred is not _UNSET and preferred is not None and not connection.execute(
                "SELECT 1 FROM lb_domain_servers WHERE domain_id = ? AND server_id = ?",
                (domain_id, preferred),
            ).fetchone():
                raise ValueError("首选服务器必须属于域名候选列表")
            preferred_sql = "" if preferred is _UNSET or not ok else ", preferred_server_id = ?"
            update_params = [timestamp, 1 if ok else 0, message[:500], current_ip]
            if preferred_sql:
                update_params.append(preferred)
            update_params.append(domain_id)
            connection.execute(
                "UPDATE lb_domains SET last_sync_at = ?, last_sync_ok = ?, last_sync_message = ?, "
                "current_ip = ?" + preferred_sql + " WHERE id = ?",
                update_params,
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
