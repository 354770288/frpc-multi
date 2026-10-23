"""Shared, bounded server-library saved views."""
from __future__ import annotations

import json
import uuid
from pathlib import Path

from ..control.database import connect_database, initialize_database
from ..models import now_iso
from .store import ServerPageQuery

MAX_SERVER_VIEW_NAME_LENGTH = 64
MAX_SERVER_VIEW_PAYLOAD_BYTES = 16_384
SERVER_VIEW_COLUMNS = (
    "ip", "group", "tags", "route", "connectivity", "speed", "lastTestTime",
)
DEFAULT_SERVER_VIEW_COLUMNS = list(SERVER_VIEW_COLUMNS)
FILTER_KEYS = {
    "q", "group", "label", "tagId", "groupIds", "includeTagIds",
    "excludeTagIds", "tagMode", "conn",
}
SORT_KEYS = {"ip", "group", "conn", "speed", "time"}
ORDER_KEYS = {"asc", "desc"}


class ServerViewNameConflictError(ValueError):
    """A shared view name is already in use, ignoring case and outer spaces."""


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class ServerViewStore:
    """CRUD owner for Console-shared saved server-library views."""

    def __init__(self, database_path: Path):
        self.database_path = Path(database_path)
        initialize_database(self.database_path)

    def _db(self):
        connection = connect_database(self.database_path)
        connection.execute("BEGIN IMMEDIATE")
        return connection

    @staticmethod
    def _name(value):
        if not isinstance(value, str):
            raise ValueError("视图名称必须是文本")
        value = value.strip()
        if not value or len(value) > MAX_SERVER_VIEW_NAME_LENGTH:
            raise ValueError(f"视图名称长度须为 1-{MAX_SERVER_VIEW_NAME_LENGTH} 个字符")
        return value, value.casefold()

    @staticmethod
    def _filters(value):
        if value is None:
            value = {}
        if not isinstance(value, dict):
            raise ValueError("filters 必须是对象")
        if not all(isinstance(key, str) for key in value):
            raise ValueError("filters 键必须是文本")
        unknown = set(value) - FILTER_KEYS
        if unknown:
            raise ValueError("不支持的筛选字段: " + ", ".join(sorted(unknown)))

        def text(key, default=None, max_length=512):
            result = value.get(key, default)
            if result is not None and not isinstance(result, str):
                raise ValueError(f"筛选字段 {key} 必须是文本")
            if result is not None and len(result) > max_length:
                raise ValueError(f"筛选字段 {key} 超出长度上限")
            return result.strip() if result is not None else None

        def string_list(key):
            result = value.get(key, [])
            if not isinstance(result, (list, tuple)) or not all(isinstance(item, str) for item in result):
                raise ValueError(f"筛选字段 {key} 必须是字符串列表")
            return list(dict.fromkeys(item.strip() for item in result if item.strip()))

        q = text("q", "") or ""
        group = text("group")
        label = text("label")
        tag_id = text("tagId", max_length=256)
        group_ids = string_list("groupIds")
        include_ids = string_list("includeTagIds")
        exclude_ids = string_list("excludeTagIds")
        tag_mode = value.get("tagMode", "any")
        conn = value.get("conn", "all")
        if not isinstance(tag_mode, str):
            raise ValueError("筛选字段 tagMode 必须是文本")
        if not isinstance(conn, str):
            raise ValueError("筛选字段 conn 必须是文本")
        # Reuse the same shape and size validation as server listing/counting.
        ServerPageQuery(
            q=q, group=group, label=label, tag_id=tag_id,
            group_ids=tuple(group_ids), include_tag_ids=tuple(include_ids),
            exclude_tag_ids=tuple(exclude_ids), tag_mode=tag_mode, conn=conn,
        )
        return {
            "q": q, "group": group, "label": label, "tagId": tag_id,
            "groupIds": group_ids, "includeTagIds": include_ids,
            "excludeTagIds": exclude_ids, "tagMode": tag_mode, "conn": conn,
        }

    @staticmethod
    def _columns(value):
        if value is None:
            value = DEFAULT_SERVER_VIEW_COLUMNS
        if not isinstance(value, (list, tuple)) or not all(isinstance(item, str) for item in value):
            raise ValueError("visibleColumns 必须是字符串列表")
        columns = list(value)
        if not columns:
            raise ValueError("visibleColumns 至少包含一列")
        if len(columns) > len(SERVER_VIEW_COLUMNS):
            raise ValueError("visibleColumns 包含过多列")
        unknown = sorted(set(columns) - set(SERVER_VIEW_COLUMNS))
        if unknown:
            raise ValueError("不支持的列: " + ", ".join(unknown))
        if len(set(columns)) != len(columns):
            raise ValueError("visibleColumns 不能包含重复列")
        return columns

    @staticmethod
    def _sort_order(sort, order):
        if not isinstance(sort, str) or sort not in SORT_KEYS:
            raise ValueError("sort 无效")
        if not isinstance(order, str) or order not in ORDER_KEYS:
            raise ValueError("order 无效")
        ServerPageQuery(sort=sort, order=order)
        return sort, order

    @staticmethod
    def _view(row):
        return {
            "id": row["id"], "name": row["name"], "filters": json.loads(row["filters"]),
            "sort": row["sort"], "order": row["sort_order"],
            "visibleColumns": json.loads(row["visible_columns"]),
            "createdAt": row["created_at"], "updatedAt": row["updated_at"],
        }

    @staticmethod
    def _check_size(name, filters, sort, order, columns):
        payload = {"name": name, "filters": filters, "sort": sort,
                   "order": order, "visibleColumns": columns}
        if len(_json(payload).encode("utf-8")) > MAX_SERVER_VIEW_PAYLOAD_BYTES:
            raise ValueError(f"保存视图内容不能超过 {MAX_SERVER_VIEW_PAYLOAD_BYTES} 字节")

    def list(self):
        connection = connect_database(self.database_path)
        try:
            return [self._view(row) for row in connection.execute(
                "SELECT * FROM probe_server_views ORDER BY name_key,id"
            )]
        finally:
            connection.close()

    def create(self, *, name, filters=None, sort="group", order="asc", visible_columns=None):
        name, name_key = self._name(name)
        filters = self._filters(filters)
        sort, order = self._sort_order(sort, order)
        columns = self._columns(visible_columns)
        self._check_size(name, filters, sort, order, columns)
        view_id = str(uuid.uuid4())
        stamp = now_iso()
        connection = self._db()
        try:
            if connection.execute("SELECT 1 FROM probe_server_views WHERE name_key=?", (name_key,)).fetchone():
                raise ServerViewNameConflictError("同名视图已存在")
            connection.execute(
                "INSERT INTO probe_server_views(id,name,name_key,filters,sort,sort_order,visible_columns,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (view_id, name, name_key, _json(filters), sort, order, _json(columns), stamp, stamp),
            )
            row = connection.execute("SELECT * FROM probe_server_views WHERE id=?", (view_id,)).fetchone()
            result = self._view(row)
            connection.commit()
            return result
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def update(self, view_id, changes):
        if not isinstance(changes, dict) or not changes:
            raise ValueError("PATCH 至少需要一个可更新字段")
        allowed = {"name", "filters", "sort", "order", "visibleColumns"}
        unknown = set(changes) - allowed
        if unknown:
            raise ValueError("不支持的字段: " + ", ".join(sorted(unknown)))
        connection = self._db()
        try:
            row = connection.execute("SELECT * FROM probe_server_views WHERE id=?", (view_id,)).fetchone()
            if row is None:
                raise KeyError(view_id)
            current = self._view(row)
            name, name_key = self._name(changes.get("name", current["name"]))
            filters = self._filters(changes.get("filters", current["filters"]))
            sort, order = self._sort_order(changes.get("sort", current["sort"]),
                                           changes.get("order", current["order"]))
            columns = self._columns(changes.get("visibleColumns", current["visibleColumns"]))
            self._check_size(name, filters, sort, order, columns)
            conflict = connection.execute(
                "SELECT 1 FROM probe_server_views WHERE name_key=? AND id!=?", (name_key, view_id)
            ).fetchone()
            if conflict:
                raise ServerViewNameConflictError("同名视图已存在")
            connection.execute(
                "UPDATE probe_server_views SET name=?,name_key=?,filters=?,sort=?,sort_order=?,visible_columns=?,updated_at=? WHERE id=?",
                (name, name_key, _json(filters), sort, order, _json(columns), now_iso(), view_id),
            )
            updated = connection.execute("SELECT * FROM probe_server_views WHERE id=?", (view_id,)).fetchone()
            result = self._view(updated)
            connection.commit()
            return result
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def delete(self, view_id):
        connection = self._db()
        try:
            deleted = connection.execute("DELETE FROM probe_server_views WHERE id=?", (view_id,)).rowcount
            if not deleted:
                raise KeyError(view_id)
            connection.commit()
            return {"ok": True}
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
