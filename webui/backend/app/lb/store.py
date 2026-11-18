"""负载均衡（DDNS 域名池）数据存储。

lb_settings 存 Cloudflare API Token；lb_domains 保存域名候选与服务器同步分组；
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


class DomainMembershipConflict(ValueError):
    """An asset is already assigned to another domain candidate set."""


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


def _domain_query(where: str) -> str:
    return (
        "SELECT d.*, COALESCE(g.name, '') AS sync_group FROM lb_domains d "
        "LEFT JOIN probe_groups g ON g.id = d.sync_group_id " + where
    )


def _resolve_sync_group(connection, value: str | None, default_name: str) -> tuple[str, str]:
    clean = (value or default_name).strip()
    if not clean:
        clean = default_name
    row = connection.execute(
        "SELECT id, name FROM probe_groups WHERE id = ? OR name = ? LIMIT 1", (clean, clean)
    ).fetchone()
    if row is None:
        # Explicit values must identify a group; defaults are created on demand.
        if value is not None:
            raise ValueError("指定的服务器分组不存在")
        name, group_id = _resolve_group(connection, clean)
        return group_id, name
    return str(row["id"]), str(row["name"])


def _assert_domain_members_available(connection, domain_id: int | None, server_ids: list[int]) -> None:
    """Reject domain overlap even when legacy overlap prevented the unique index."""
    for start in range(0, len(server_ids), _DOMAIN_SERVER_ID_CHUNK):
        batch = server_ids[start:start + _DOMAIN_SERVER_ID_CHUNK]
        if not batch:
            continue
        placeholders = ",".join("?" for _ in batch)
        params: list[object] = list(batch)
        exclusion = ""
        if domain_id is not None:
            exclusion = " AND d.id != ?"
            params.append(domain_id)
        rows = connection.execute(
            "SELECT m.server_id, d.name FROM lb_domain_servers m "
            "JOIN lb_domains d ON d.id = m.domain_id "
            f"WHERE m.server_id IN ({placeholders}){exclusion} ORDER BY m.server_id,d.name",
            params,
        ).fetchall()
        if rows:
            conflicts = ", ".join(f"{row['server_id']} ({row['name']})" for row in rows[:20])
            raise DomainMembershipConflict(f"服务器已属于其他候选域名: {conflicts}")


def _assert_domain_has_no_legacy_overlap(connection, domain_id: int) -> None:
    row = connection.execute(
        "SELECT m.server_id, other.name FROM lb_domain_servers m "
        "JOIN lb_domain_servers overlap ON overlap.server_id = m.server_id "
        "JOIN lb_domains other ON other.id = overlap.domain_id "
        "WHERE m.domain_id = ? AND other.id != ? ORDER BY m.server_id, other.name LIMIT 1",
        (domain_id, domain_id),
    ).fetchone()
    if row:
        raise DomainMembershipConflict(
            f"服务器已属于其他候选域名: {row['server_id']} ({row['name']})"
        )


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
    sync_group_id: str | None
    sync_group: str
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
        sync_group_id=row["sync_group_id"],
        sync_group=row["sync_group"] or "",
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
            rows = connection.execute(_domain_query("ORDER BY d.name")).fetchall()
            return [_domain_from_row(row) for row in rows]

        return self._with_connection(read)

    def get_domain(self, domain_id: int) -> LbDomain:
        def read(connection):
            return connection.execute(_domain_query("WHERE d.id = ?"), (domain_id,)).fetchone()

        row = self._with_connection(read)
        if row is None:
            raise KeyError(f"候选域名不存在: {domain_id}")
        return _domain_from_row(row)

    def get_domain_by_name(self, name: str) -> LbDomain | None:
        def read(connection):
            return connection.execute(_domain_query("WHERE d.name = ?"), (name,)).fetchone()

        row = self._with_connection(read)
        return _domain_from_row(row) if row else None

    def create_domain(self, *, name: str, zone_id: str, zone_name: str, group_name: str = "",
                      ttl: int = 60, sync_mode: str = "manual", interval_seconds: int = 300,
                      enabled: bool = True, server_ids: Iterable[int] | None = None,
                      preferred_server_id: int | None = None,
                      sync_group_id: str | None = None) -> LbDomain:
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
                connection.execute("BEGIN IMMEDIATE")
                # group_name remains a compatibility adapter: when explicitly
                # supplied without candidates, take one snapshot and discard
                # the live group relationship.
                snapshot_ids = selected_ids
                if snapshot_ids is None and clean_group:
                    resolved_name, group_id = _resolve_group(connection, clean_group)
                    snapshot_ids = _group_server_ids(connection, group_id, resolved_name)
                resolved_sync_id, _ = _resolve_sync_group(
                    connection, sync_group_id if sync_group_id is not None else (clean_group or None), clean_name
                )
                # Keep legacy compatibility columns detached; sync_group_id is
                # the stable owner for future domain-member group synchronization.
                resolved_name, group_id = "", None
                cursor = connection.execute(
                    "INSERT INTO lb_domains (name, zone_id, zone_name, group_name, group_id, sync_group_id, ttl, sync_mode, "
                    "interval_seconds, enabled, preferred_server_id, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (clean_name, zone_id.strip(), validate_domain_name(zone_name),
                     resolved_name, group_id, resolved_sync_id, ttl, sync_mode, interval_seconds,
                     1 if enabled else 0, preferred_server_id, now_iso()),
                )
                domain_id = int(cursor.lastrowid)
                if snapshot_ids:
                    _validate_existing_servers(connection, snapshot_ids)
                    _assert_domain_members_available(connection, domain_id, snapshot_ids)
                    connection.executemany(
                        "INSERT INTO lb_domain_servers(domain_id, server_id) VALUES (?, ?)",
                        [(domain_id, server_id) for server_id in snapshot_ids],
                    )
                    connection.execute(
                        "UPDATE probe_servers SET server_group = (SELECT name FROM probe_groups WHERE id = ?), "
                        "group_id = ? WHERE id IN (SELECT server_id FROM lb_domain_servers WHERE domain_id = ?)",
                        (resolved_sync_id, resolved_sync_id, domain_id),
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
                      sync_group_id: str | None | object = _UNSET,
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
            connection.execute("BEGIN IMMEDIATE")
            _require_domain(connection, domain_id)
            if new_preferred is not None:
                _validate_existing_servers(connection, [new_preferred])
            sync_group_changed = sync_group_id is not _UNSET
            resolved_sync_id = domain.sync_group_id
            if sync_group_changed:
                _assert_domain_has_no_legacy_overlap(connection, domain_id)
                resolved_sync_id, _ = _resolve_sync_group(connection, sync_group_id, domain.name)
            # An explicit legacy group edit replaces the candidate snapshot;
            # ordinary domain edits leave membership untouched.
            replacement_ids = None
            if group_name is not None:
                _assert_domain_has_no_legacy_overlap(connection, domain_id)
                new_group = (group_name or "").strip()
                if new_group:
                    resolved_name, group_id = _resolve_group(connection, new_group)
                    replacement_ids = _group_server_ids(connection, group_id, resolved_name)
                else:
                    resolved_name, group_id = "", None
                _validate_existing_servers(connection, replacement_ids or [])
                _assert_domain_members_available(connection, domain_id, replacement_ids or [])
                connection.execute(
                    "UPDATE probe_servers SET server_group = '', group_id = NULL "
                    "WHERE id IN (SELECT server_id FROM lb_domain_servers WHERE domain_id = ?) "
                    "AND group_id = (SELECT sync_group_id FROM lb_domains WHERE id = ?)",
                    (domain_id, domain_id),
                )
            active_sync_id = resolved_sync_id
            active_sync_name = connection.execute(
                "SELECT name FROM probe_groups WHERE id = ?", (active_sync_id,)
            ).fetchone()[0]
            connection.execute(
                "UPDATE lb_domains SET group_name = ?, group_id = ?, sync_group_id = ?, ttl = ?, sync_mode = ?, "
                "interval_seconds = ?, enabled = ?, preferred_server_id = ? WHERE id = ?",
                ("", None, resolved_sync_id, new_ttl, new_mode, new_interval,
                 1 if new_enabled else 0, new_preferred, domain_id),
            )
            if sync_group_changed and group_name is None:
                connection.execute(
                    "UPDATE probe_servers SET server_group = (SELECT name FROM probe_groups WHERE id = ?), "
                    "group_id = ? WHERE id IN (SELECT server_id FROM lb_domain_servers WHERE domain_id = ?)",
                    (resolved_sync_id, resolved_sync_id, domain_id),
                )
            if group_name is not None:
                connection.execute("DELETE FROM lb_domain_servers WHERE domain_id = ?", (domain_id,))
                if replacement_ids:
                    connection.executemany(
                        "INSERT INTO lb_domain_servers(domain_id, server_id) VALUES (?, ?)",
                        [(domain_id, server_id) for server_id in replacement_ids],
                    )
                    connection.execute(
                        "UPDATE probe_servers SET server_group = ?, group_id = ? "
                        "WHERE id IN (SELECT server_id FROM lb_domain_servers WHERE domain_id = ?)",
                        (active_sync_name, active_sync_id, domain_id),
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
            domain_row = connection.execute(
                "SELECT d.sync_group_id, g.name AS sync_group FROM lb_domains d "
                "LEFT JOIN probe_groups g ON g.id = d.sync_group_id WHERE d.id = ?", (domain_id,)
            ).fetchone()
            _assert_domain_members_available(connection, domain_id, ids)
            before = connection.total_changes
            connection.executemany(
                "INSERT OR IGNORE INTO lb_domain_servers(domain_id, server_id) VALUES (?, ?)",
                [(domain_id, server_id) for server_id in ids],
            )
            added = connection.total_changes - before
            if ids:
                connection.executemany(
                    "UPDATE probe_servers SET server_group = ?, group_id = ? WHERE id = ?",
                    [(domain_row["sync_group"], domain_row["sync_group_id"], server_id)
                     for server_id in ids],
                )
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
            if ids:
                # Clear only servers still in this domain's sync group and still
                # present in its membership set. Retries cannot disturb outsiders.
                connection.executemany(
                    "UPDATE probe_servers SET server_group = '', group_id = NULL "
                    "WHERE id = ? "
                    "AND group_id = (SELECT sync_group_id FROM lb_domains WHERE id = ?) "
                    "AND EXISTS (SELECT 1 FROM lb_domain_servers m "
                    "WHERE m.domain_id = ? AND m.server_id = probe_servers.id) "
                    "AND NOT EXISTS (SELECT 1 FROM lb_domain_servers other "
                    "WHERE other.server_id = probe_servers.id AND other.domain_id != ?)",
                    [(server_id, domain_id, domain_id, domain_id) for server_id in ids],
                )
            before = connection.total_changes
            connection.executemany(
                "DELETE FROM lb_domain_servers WHERE domain_id = ? AND server_id = ?",
                [(domain_id, server_id) for server_id in ids],
            )
            removed = connection.total_changes - before
            connection.execute(
                "UPDATE lb_domains SET preferred_server_id = NULL WHERE id = ? "
                "AND preferred_server_id IS NOT NULL AND NOT EXISTS ("
                "SELECT 1 FROM lb_domain_servers m WHERE m.domain_id = lb_domains.id "
                "AND m.server_id = lb_domains.preferred_server_id)",
                (domain_id,),
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
            connection.execute("DELETE FROM lb_port_alerts WHERE domain_id = ?", (domain_id,))
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

    # ---- 部署节点实例业务端口映射 ----

    def replace_node_instance_ports(self, node_id: int, node_name: str, items: Iterable[dict]) -> None:
        timestamp = now_iso()
        rows_to_insert: list[tuple] = []
        for item in items:
            inst_name = str(item.get("name", "")).strip()
            if not inst_name:
                continue
            display_name = str(item.get("displayName") or inst_name).strip()
            enabled = 1 if item.get("enabled", True) else 0
            runtime = item.get("runtime") if isinstance(item.get("runtime"), dict) else {}
            running = 1 if runtime.get("state") == "running" else 0
            summary = item.get("summary") if isinstance(item.get("summary"), dict) else {}
            raw_addr = str(summary.get("serverAddr") or "").strip().lower().rstrip(".")
            server_port = summary.get("serverPort")
            if isinstance(server_port, bool) or not isinstance(server_port, int):
                server_port = None
            raw_ports = summary.get("tcpRemotePorts")
            if raw_ports is None:
                raw_ports = summary.get("remotePorts") or []
            clean_ports = sorted({
                int(p) for p in raw_ports
                if not isinstance(p, bool) and isinstance(p, int) and 1 <= p <= 65535
            })
            rows_to_insert.append((
                int(node_id), inst_name, str(node_name or ""), display_name,
                enabled, running, raw_addr, server_port, json.dumps(clean_ports), timestamp,
            ))

        def write(connection):
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM lb_instance_ports WHERE node_id = ?", (int(node_id),))
            if rows_to_insert:
                connection.executemany(
                    "INSERT INTO lb_instance_ports ("
                    "node_id, instance_name, node_name, display_name, enabled, running, "
                    "server_addr, server_port, remote_ports, updated_at"
                    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rows_to_insert,
                )
            connection.commit()

        self._with_connection(write)

    def delete_node_instance_ports(self, node_id: int, instance_name: str | None = None) -> None:
        def write(connection):
            if instance_name is None:
                connection.execute("DELETE FROM lb_instance_ports WHERE node_id = ?", (int(node_id),))
            else:
                connection.execute(
                    "DELETE FROM lb_instance_ports WHERE node_id = ? AND instance_name = ?",
                    (int(node_id), str(instance_name)),
                )
            connection.commit()

        self._with_connection(write)

    def domain_business_ports(self, domain_name: str) -> list[dict]:
        """Return ordered TCP business ports bound to ``domain_name`` by running enabled instances."""
        clean_domain = (domain_name or "").strip().lower().rstrip(".")
        if not clean_domain:
            return []

        def read(connection):
            rows = connection.execute(
                "SELECT node_id, node_name, instance_name, display_name, remote_ports "
                "FROM lb_instance_ports "
                "WHERE server_addr = ? AND enabled = 1 AND running = 1 "
                "ORDER BY node_id, instance_name",
                (clean_domain,),
            ).fetchall()
            by_port: dict[int, list[dict]] = {}
            for row in rows:
                try:
                    ports = json.loads(row["remote_ports"] or "[]")
                except (TypeError, ValueError):
                    ports = []
                ref = {
                    "nodeId": int(row["node_id"]),
                    "nodeName": row["node_name"] or f"Node #{row['node_id']}",
                    "instanceName": row["instance_name"],
                    "displayName": row["display_name"] or row["instance_name"],
                }
                for port in ports:
                    if not isinstance(port, bool) and isinstance(port, int) and 1 <= port <= 65535:
                        by_port.setdefault(port, []).append(ref)
            return [{"port": port, "instances": by_port[port]} for port in sorted(by_port)]

        return self._with_connection(read)

    # ---- GFW 防火墙屏蔽隔离状态 ----

    def gfw_blocked_ips(self) -> set[str]:
        def read(connection):
            rows = connection.execute("SELECT ip FROM lb_gfw_blocks").fetchall()
            return {str(row["ip"]) for row in rows}

        return self._with_connection(read)

    def list_gfw_blocks(self) -> list[dict]:
        def read(connection):
            rows = connection.execute(
                "SELECT * FROM lb_gfw_blocks ORDER BY last_checked_at DESC, ip ASC"
            ).fetchall()
            return [{
                "ip": row["ip"],
                "domainId": row["domain_id"],
                "domainName": row["domain_name"],
                "blockedPort": int(row["blocked_port"]),
                "primaryNodeId": row["primary_node_id"],
                "primaryNodeName": row["primary_node_name"],
                "primaryDetail": row["primary_detail"],
                "backupNodeId": row["backup_node_id"],
                "backupNodeName": row["backup_node_name"],
                "backupDetail": row["backup_detail"],
                "blockedAt": row["blocked_at"],
                "lastCheckedAt": row["last_checked_at"],
            } for row in rows]

        return self._with_connection(read)

    def mark_gfw_blocked(
        self,
        *,
        ip: str,
        domain_id: int | None,
        domain_name: str,
        blocked_port: int,
        primary_node_id: str,
        primary_node_name: str,
        primary_detail: str,
        backup_node_id: str,
        backup_node_name: str,
        backup_detail: str,
    ) -> None:
        clean_ip = (ip or "").strip()
        if not clean_ip:
            raise ValueError("IP 不能为空")
        timestamp = now_iso()

        def write(connection):
            connection.execute(
                "INSERT INTO lb_gfw_blocks ("
                "ip, domain_id, domain_name, blocked_port, primary_node_id, primary_node_name, "
                "primary_detail, backup_node_id, backup_node_name, backup_detail, blocked_at, last_checked_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(ip) DO UPDATE SET "
                "domain_id = excluded.domain_id, domain_name = excluded.domain_name, "
                "blocked_port = excluded.blocked_port, primary_node_id = excluded.primary_node_id, "
                "primary_node_name = excluded.primary_node_name, primary_detail = excluded.primary_detail, "
                "backup_node_id = excluded.backup_node_id, backup_node_name = excluded.backup_node_name, "
                "backup_detail = excluded.backup_detail, last_checked_at = excluded.last_checked_at",
                (
                    clean_ip, domain_id, domain_name or "", int(blocked_port),
                    primary_node_id or "", primary_node_name or "", (primary_detail or "")[:200],
                    backup_node_id or "", backup_node_name or "", (backup_detail or "")[:200],
                    timestamp, timestamp,
                ),
            )
            connection.commit()

        self._with_connection(write)

    def clear_gfw_block(self, ip: str) -> bool:
        clean_ip = (ip or "").strip()
        timestamp = now_iso()

        def write(connection):
            connection.execute("BEGIN IMMEDIATE")
            removed = connection.execute(
                "DELETE FROM lb_gfw_blocks WHERE ip = ?", (clean_ip,)
            ).rowcount > 0
            connection.execute(
                "UPDATE lb_port_alerts SET status = 'resolved', resolved_at = ? "
                "WHERE ip = ? AND kind = 'gfw_blocked' AND status = 'active'",
                (timestamp, clean_ip),
            )
            connection.commit()
            return removed

        return self._with_connection(write)

    # ---- 业务端口与屏蔽异常告警 ----

    @staticmethod
    def _alert_view(row) -> dict:
        try:
            instances = json.loads(row["instances_json"] or "[]")
        except (TypeError, ValueError):
            instances = []
        return {
            "id": int(row["id"]),
            "alertKey": row["alert_key"],
            "kind": row["kind"],
            "severity": row["severity"],
            "status": row["status"],
            "domainId": int(row["domain_id"]),
            "domainName": row["domain_name"],
            "ip": row["ip"],
            "port": int(row["port"]),
            "instances": instances,
            "primaryNodeId": row["primary_node_id"],
            "primaryNodeName": row["primary_node_name"],
            "primaryDetail": row["primary_detail"],
            "backupNodeId": row["backup_node_id"],
            "backupNodeName": row["backup_node_name"],
            "backupDetail": row["backup_detail"],
            "switched": bool(row["switched"]),
            "switchedToIp": row["switched_to_ip"],
            "message": row["message"],
            "firstSeenAt": row["first_seen_at"],
            "lastCheckedAt": row["last_checked_at"],
            "resolvedAt": row["resolved_at"],
        }

    def upsert_port_alert(
        self,
        *,
        alert_key: str,
        kind: str,
        severity: str,
        domain_id: int,
        domain_name: str,
        ip: str,
        port: int,
        instances: list[dict] | None = None,
        primary_node_id: str = "",
        primary_node_name: str = "",
        primary_detail: str = "",
        backup_node_id: str = "",
        backup_node_name: str = "",
        backup_detail: str = "",
        switched: bool = False,
        switched_to_ip: str | None = None,
        message: str = "",
    ) -> dict:
        timestamp = now_iso()
        instances_text = json.dumps(instances or [], ensure_ascii=False)

        def write(connection):
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT id, status, first_seen_at FROM lb_port_alerts WHERE alert_key = ?",
                (alert_key,),
            ).fetchone()
            first_seen = (
                existing["first_seen_at"]
                if existing is not None and existing["status"] == "active"
                else timestamp
            )
            connection.execute(
                "INSERT INTO lb_port_alerts ("
                "alert_key, kind, severity, status, domain_id, domain_name, ip, port, "
                "instances_json, primary_node_id, primary_node_name, primary_detail, "
                "backup_node_id, backup_node_name, backup_detail, switched, switched_to_ip, "
                "message, first_seen_at, last_checked_at, resolved_at"
                ") VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) "
                "ON CONFLICT(alert_key) DO UPDATE SET "
                "kind = excluded.kind, severity = excluded.severity, status = 'active', "
                "domain_id = excluded.domain_id, domain_name = excluded.domain_name, "
                "ip = excluded.ip, port = excluded.port, instances_json = excluded.instances_json, "
                "primary_node_id = excluded.primary_node_id, primary_node_name = excluded.primary_node_name, "
                "primary_detail = excluded.primary_detail, backup_node_id = excluded.backup_node_id, "
                "backup_node_name = excluded.backup_node_name, backup_detail = excluded.backup_detail, "
                "switched = excluded.switched, switched_to_ip = excluded.switched_to_ip, "
                "message = excluded.message, first_seen_at = ?, last_checked_at = excluded.last_checked_at, "
                "resolved_at = NULL",
                (
                    alert_key, kind, severity, int(domain_id), domain_name, ip, int(port),
                    instances_text, primary_node_id, primary_node_name, (primary_detail or "")[:200],
                    backup_node_id, backup_node_name, (backup_detail or "")[:200],
                    1 if switched else 0, switched_to_ip, (message or "")[:500],
                    first_seen, timestamp, first_seen,
                ),
            )
            row = connection.execute(
                "SELECT * FROM lb_port_alerts WHERE alert_key = ?", (alert_key,)
            ).fetchone()
            connection.commit()
            return self._alert_view(row)

        return self._with_connection(write)

    def resolve_domain_port_alerts(self, domain_id: int, *, kind: str | None = "port_unreachable",
                                   keep_keys: set[str] | None = None) -> int:
        timestamp = now_iso()
        keep = set(keep_keys or ())

        def write(connection):
            sql = "SELECT id, alert_key FROM lb_port_alerts WHERE domain_id = ? AND status = 'active'"
            params: list[object] = [int(domain_id)]
            if kind is not None:
                sql += " AND kind = ?"
                params.append(kind)
            rows = connection.execute(sql, params).fetchall()
            to_resolve = [int(r["id"]) for r in rows if r["alert_key"] not in keep]
            if not to_resolve:
                return 0
            placeholders = ",".join("?" for _ in to_resolve)
            connection.execute(
                f"UPDATE lb_port_alerts SET status = 'resolved', resolved_at = ? WHERE id IN ({placeholders})",
                [timestamp, *to_resolve],
            )
            connection.commit()
            return len(to_resolve)

        return self._with_connection(write)

    def dismiss_port_alert(self, alert_id: int) -> bool:
        timestamp = now_iso()

        def write(connection):
            updated = connection.execute(
                "UPDATE lb_port_alerts SET status = 'resolved', resolved_at = ? "
                "WHERE id = ? AND status = 'active'",
                (timestamp, int(alert_id)),
            ).rowcount > 0
            connection.commit()
            return updated

        return self._with_connection(write)

    def list_port_alerts(self, *, status: str = "active", limit: int = 100) -> list[dict]:
        bounded = min(max(int(limit), 1), 500)

        def read(connection):
            if status == "all":
                rows = connection.execute(
                    "SELECT * FROM lb_port_alerts ORDER BY (status = 'active') DESC, last_checked_at DESC, id DESC LIMIT ?",
                    (bounded,),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM lb_port_alerts WHERE status = ? ORDER BY last_checked_at DESC, id DESC LIMIT ?",
                    (status, bounded),
                ).fetchall()
            return [self._alert_view(row) for row in rows]

        return self._with_connection(read)
