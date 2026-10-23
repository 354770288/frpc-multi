"""穿透测试数据存储：服务器清单 + 连通性/速率结果，落 Console 的 console.db。

表结构见 control/database.py 的 SCHEMA（probe_* 三张表），
访问模式照 AuditStore：每次操作短连接，避免跨线程共享 sqlite 连接。
"""

from __future__ import annotations

import ipaddress
import uuid
import re
import sqlite3
import base64
import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Iterable, Literal, NamedTuple, Sequence, TypeVar

from ..models import now_iso
from ..control.database import connect_database, initialize_database
from .constants import PROBE_TEST_PORT
from .engine import speed_mbs, speed_mbps

T = TypeVar("T")
ChunkItem = TypeVar("ChunkItem")

DiscoverLibrary = Literal["all", "new", "imported"]
DiscoverSort = Literal["time", "ip", "latency"]
ServerConn = Literal["all", "pass", "partial", "fail", "untested"]
ServerSort = Literal["ip", "group", "conn", "speed", "time"]
SortOrder = Literal["asc", "desc"]
_SQL_VARIABLE_HEADROOM = 8
MAX_TAG_FACET_PAGE = 1_000_000
_TAG_UUID_NAMESPACE = uuid.UUID("895bfb47-4ce4-4b5f-a8fd-266ef7129031")
SERVER_IMPORT_BATCH_SIZE = 500
MAX_SERVER_IMPORT_ITEMS = 5_000
MAX_SERVER_IMPORT_TEXT_BYTES = 1_048_576


class ServerImportLimitError(ValueError):
    """A synchronous server import exceeded its bounded request limits."""


class DiscoverImportResult(NamedTuple):
    """Atomic discovery-import outcome; tuple-compatible for existing callers."""

    selected_count: int
    inserted: int
    skipped: int


@dataclass(frozen=True)
class DiscoverPageQuery:
    page: int = 1
    page_size: int = 50
    q: str = ""
    group: str | None = None
    label: str | None = None
    library: DiscoverLibrary = "all"
    sort: DiscoverSort = "time"
    order: SortOrder = "desc"

    def __post_init__(self) -> None:
        if self.page < 1:
            raise ValueError("page 必须大于等于 1")
        if not 1 <= self.page_size <= 200:
            raise ValueError("page_size 必须在 1-200")
        if self.library not in {"all", "new", "imported"}:
            raise ValueError("library 必须是 all/new/imported")
        if self.sort not in {"time", "ip", "latency"}:
            raise ValueError("sort 必须是 time/ip/latency")
        if self.order not in {"asc", "desc"}:
            raise ValueError("order 必须是 asc/desc")


def _ipv4_sort_key(ip: str) -> int:
    address = ipaddress.ip_address(ip)
    if address.version != 4:
        raise ValueError("发现结果仅支持 IPv4")
    return int(address)


def _ip_sort_for(addr: str) -> int | None:
    """服务器地址 → 数值排序键；仅 IPv4 给 int，域名/IPv6/解析失败 → NULL（null-last 兜底）。"""
    try:
        address = ipaddress.ip_address(addr)
    except ValueError:
        return None
    return int(address) if address.version == 4 else None


def _normalize_labels(labels: Iterable[str]) -> list[str]:
    """归一化标签：拆逗号、去空白、去重、保序。"""
    out: list[str] = []
    for raw in labels:
        for part in str(raw).split(","):
            value = part.strip()
            if value and value not in out:
                out.append(value)
    return out


def _pack_labels(labels: Iterable[str]) -> str:
    """标签列表 → 哨兵格式存储（`,a,b,`）；空集 = 空串。"""
    parts = _normalize_labels(labels)
    return "," + ",".join(parts) + "," if parts else ""


def _asset_labels(labels: Iterable[str]) -> list[str]:
    """Normalize manual asset labels without inferring their provenance."""
    return _normalize_labels(labels)


def _clean_tag_name(name: str) -> str:
    clean = str(name or "").strip()
    if not clean:
        raise ValueError("标签名称不能为空")
    if "," in clean:
        raise ValueError("标签名称不能包含逗号")
    return clean


def _other_category_id(connection: sqlite3.Connection) -> str:
    category_id = str(uuid.uuid5(_TAG_UUID_NAMESPACE, "probe-tag-category:other"))
    category = connection.execute(
        "SELECT id FROM probe_tag_categories WHERE id = ?", (category_id,)
    ).fetchone()
    if category is not None:
        return category["id"]
    connection.execute(
        "INSERT OR IGNORE INTO probe_tag_categories (id, name, created_at) VALUES (?, 'other', ?)",
        (category_id, now_iso()),
    )
    category = connection.execute(
        "SELECT id FROM probe_tag_categories WHERE id = ?", (category_id,)
    ).fetchone()
    if category is not None:
        return category["id"]
    # A database initialized before the stable category ID existed may already
    # have a user-created `other`; retain that canonical unique-name row.
    category = connection.execute(
        "SELECT id FROM probe_tag_categories WHERE name = 'other'"
    ).fetchone()
    if category is None:
        raise RuntimeError("default tag category could not be resolved")
    return category["id"]


def _sync_server_tags_many(connection: sqlite3.Connection,
                           entries: Sequence[tuple[int, Sequence[str]]], *,
                           preserve_existing: bool = True) -> None:
    """Batch relation/projection replacement, preserving category IDs for retained names."""
    if not entries:
        return
    category_id = _other_category_id(connection)
    normalized = [(server_id, _asset_labels(labels)) for server_id, labels in entries]
    existing: dict[int, dict[str, list[str]]] = {server_id: {} for server_id, _ in normalized}
    if preserve_existing:
        for chunk in _chunks(connection, [server_id for server_id, _ in normalized]):
            placeholders = ",".join("?" for _ in chunk)
            for row in connection.execute(
                "SELECT st.server_id, st.tag_id, t.name FROM probe_server_tags st "
                "JOIN probe_tags t ON t.id = st.tag_id "
                f"WHERE st.server_id IN ({placeholders})", chunk
            ):
                existing[row["server_id"]].setdefault(row["name"], []).append(row["tag_id"])

    tags: dict[str, str] = {}
    relation_rows: list[tuple[int, str]] = []
    for server_id, labels in normalized:
        for label in labels:
            preserved_ids = existing[server_id].get(label, [])
            if preserved_ids:
                relation_rows.extend((server_id, tag_id) for tag_id in preserved_ids)
            else:
                tag_id = tags.setdefault(label, str(uuid.uuid5(
                    _TAG_UUID_NAMESPACE, f"probe-tag:{category_id}:{label}"
                )))
                relation_rows.append((server_id, tag_id))
    connection.executemany(
        "DELETE FROM probe_server_tags WHERE server_id = ?",
        [(server_id,) for server_id, _ in normalized],
    )
    created_at = now_iso()
    if tags:
        connection.executemany(
            "INSERT OR IGNORE INTO probe_tags (id, category_id, name, created_at) VALUES (?, ?, ?, ?)",
            [(tag_id, category_id, label, created_at) for label, tag_id in tags.items()],
        )
    connection.executemany(
        "INSERT OR IGNORE INTO probe_server_tags (server_id, tag_id) VALUES (?, ?)",
        relation_rows,
    )
    connection.executemany(
        "UPDATE probe_servers SET label = ? WHERE id = ?",
        [(_pack_labels(labels), server_id) for server_id, labels in normalized],
    )


def _sync_server_tags(connection: sqlite3.Connection, server_id: int,
                      labels: Iterable[str]) -> list[str]:
    """Replace one server's normalized tags and compatibility projection atomically."""
    normalized = _asset_labels(labels)
    _sync_server_tags_many(connection, [(server_id, normalized)])
    return normalized


def _server_labels_from_relation(connection: sqlite3.Connection, server_id: int) -> list[str]:
    return [row["name"] for row in connection.execute(
        "SELECT t.name FROM probe_server_tags st JOIN probe_tags t ON t.id = st.tag_id "
        "WHERE st.server_id = ? GROUP BY t.name ORDER BY t.name", (server_id,)
    )]


def _tag_ids(connection: sqlite3.Connection, values: Iterable[str]) -> list[str]:
    ids = list(dict.fromkeys(str(value).strip() for value in values if str(value).strip()))
    if not ids:
        return []
    found: set[str] = set()
    for chunk in _chunks(connection, ids):
        placeholders = ",".join("?" for _ in chunk)
        found.update(row["id"] for row in connection.execute(
            f"SELECT id FROM probe_tags WHERE id IN ({placeholders})", chunk
        ))
    missing = [tag_id for tag_id in ids if tag_id not in found]
    if missing:
        raise ValueError(f"标签不存在: {', '.join(missing)}")
    return ids


def _refresh_server_projections(connection: sqlite3.Connection,
                                server_ids: Iterable[int]) -> None:
    ids = list(dict.fromkeys(int(server_id) for server_id in server_ids))
    for chunk in _chunks(connection, ids):
        placeholders = ",".join("?" for _ in chunk)
        rows = connection.execute(
            "SELECT st.server_id, t.name FROM probe_server_tags st "
            "JOIN probe_tags t ON t.id=st.tag_id "
            f"WHERE st.server_id IN ({placeholders}) ORDER BY st.server_id, t.name", chunk
        ).fetchall()
        labels: dict[int, list[str]] = {server_id: [] for server_id in chunk}
        for row in rows:
            labels[row["server_id"]].append(row["name"])
        connection.executemany(
            "UPDATE probe_servers SET label=? WHERE id=?",
            [(_pack_labels(dict.fromkeys(values)), server_id) for server_id, values in labels.items()],
        )


def _capture_tag_servers(connection: sqlite3.Connection, tag_ids: Sequence[str]) -> None:
    connection.execute(
        "CREATE TEMP TABLE IF NOT EXISTS _probe_tag_projection_refresh "
        "(server_id INTEGER PRIMARY KEY)"
    )
    connection.execute("DELETE FROM _probe_tag_projection_refresh")
    for chunk in _chunks(connection, list(tag_ids)):
        placeholders = ",".join("?" for _ in chunk)
        connection.execute(
            "INSERT OR IGNORE INTO _probe_tag_projection_refresh(server_id) "
            "SELECT server_id FROM probe_server_tags "
            f"WHERE tag_id IN ({placeholders})", chunk
        )


def _refresh_captured_server_projections(connection: sqlite3.Connection) -> None:
    last_id = 0
    while True:
        batch = connection.execute(
            "SELECT server_id FROM _probe_tag_projection_refresh "
            "WHERE server_id > ? ORDER BY server_id LIMIT ?",
            (last_id, SERVER_IMPORT_BATCH_SIZE),
        ).fetchall()
        if not batch:
            break
        ids = [row["server_id"] for row in batch]
        last_id = ids[-1]
        _refresh_server_projections(connection, ids)


def _refresh_tag_projection(connection: sqlite3.Connection, tag_ids: Sequence[str]) -> None:
    if not tag_ids:
        return
    _capture_tag_servers(connection, tag_ids)
    _refresh_captured_server_projections(connection)


def _assign_server_tag_ids(connection: sqlite3.Connection, server_id: int,
                           tag_ids: Iterable[str], *, replace: bool = False) -> None:
    ids = _tag_ids(connection, tag_ids)
    if replace:
        connection.execute("DELETE FROM probe_server_tags WHERE server_id=?", (server_id,))
    if ids:
        connection.executemany(
            "INSERT OR IGNORE INTO probe_server_tags(server_id,tag_id) VALUES(?,?)",
            [(server_id, tag_id) for tag_id in ids],
        )
    _refresh_server_projections(connection, [server_id])


def _unpack_labels(packed: str) -> list[str]:
    """哨兵格式 → 标签列表（兼容 legacy 未打包值）。"""
    if not packed:
        return []
    return [part for part in packed.strip(",").split(",") if part]


unpack_labels = _unpack_labels  # 公开别名：router 序列化用


def _label_like_pattern(label: str) -> str:
    """哨兵格式的 LIKE 匹配模式（转义 %/_）。"""
    escaped = label.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%,{escaped},%"


def _aggregate_labels(packed_values: Iterable[str]) -> list[dict]:
    """把哨兵格式 label 列聚合为 [{label, count}]（计数=包含该标签的行数）。"""
    counts: dict[str, int] = {}
    for packed in packed_values:
        for label in _unpack_labels(packed):
            counts[label] = counts.get(label, 0) + 1
    return [{"label": label, "count": count}
            for label, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


@dataclass(frozen=True)
class ServerPageQuery:
    page: int = 1
    page_size: int = 50
    q: str = ""
    group: str | None = None
    label: str | None = None
    tag_id: str | None = None
    conn: ServerConn = "all"
    sort: ServerSort = "group"
    order: SortOrder = "asc"
    group_ids: tuple[str, ...] = ()
    include_tag_ids: tuple[str, ...] = ()
    exclude_tag_ids: tuple[str, ...] = ()
    tag_mode: Literal["any", "all"] = "any"

    def __post_init__(self) -> None:
        if self.page < 1:
            raise ValueError("page 必须大于等于 1")
        if not 1 <= self.page_size <= 200:
            raise ValueError("page_size 必须在 1-200")
        if self.conn not in {"all", "pass", "partial", "fail", "untested"}:
            raise ValueError("conn 必须是 all/pass/partial/fail/untested")
        if self.sort not in {"ip", "group", "conn", "speed", "time"}:
            raise ValueError("sort 必须是 ip/group/conn/speed/time")
        if self.order not in {"asc", "desc"}:
            raise ValueError("order 必须是 asc/desc")
        if self.tag_mode not in {"any", "all"}:
            raise ValueError("tag_mode 必须是 any/all")
        for name, values in (("group_ids", self.group_ids), ("include_tag_ids", self.include_tag_ids),
                             ("exclude_tag_ids", self.exclude_tag_ids)):
            normalized = {str(value).strip() for value in values if str(value).strip()}
            if len(normalized) > 100:
                raise ValueError(f"{name} 最多支持 100 个 ID")
        if (len({str(value).strip() for value in self.group_ids if str(value).strip()}) +
                len({str(value).strip() for value in self.include_tag_ids if str(value).strip()}) +
                len({str(value).strip() for value in self.exclude_tag_ids if str(value).strip()}) > 300):
            raise ValueError("ID 筛选总数不能超过 300")


def _normalize_ids(ids: Iterable[int]) -> list[int]:
    return list(dict.fromkeys(int(row_id) for row_id in ids))


def _assert_bulk_lease(connection: sqlite3.Connection, lease_guard: tuple[str, str] | None) -> None:
    if lease_guard is None:
        return
    import time
    owner, token = lease_guard
    row = connection.execute(
        "SELECT 1 FROM probe_server_bulk_lease WHERE id=1 AND owner=? AND token=? AND lease_until>?",
        (owner, token, time.time()),
    ).fetchone()
    if row is None:
        raise RuntimeError("bulk worker lease lost")


def _chunks(
    connection: sqlite3.Connection, items: Sequence[ChunkItem], *, headroom: int = 0
) -> Iterable[Sequence[ChunkItem]]:
    limit = connection.getlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER)
    size = max(1, limit - _SQL_VARIABLE_HEADROOM - headroom)
    for start in range(0, len(items), size):
        yield items[start:start + size]


# 分组颜色标记：给不同情况的分组做视觉区分（'' = 无色）
GROUP_COLORS = {"red", "yellow", "blue", "green"}

# 路由测试系统保留标签（承载 CN2 结论；新发现行默认「未路由测试」）
ROUTE_LABEL_UNTESTED = "未路由测试"
ROUTE_LABEL_CN2 = "CN2"
ROUTE_LABEL_NON_CN2 = "非CN2"


def _clean_group_color(color: str) -> str:
    value = (color or "").strip()
    if value not in GROUP_COLORS and value != "":
        raise ValueError("分组颜色必须是 red/yellow/blue/green 或留空")
    return value


def _ensure_group_id(connection, name: str) -> str | None:
    """Resolve a legacy display name to its canonical ID in the caller's transaction."""
    value = (name or "").strip()
    if not value:
        return None
    by_id = connection.execute("SELECT id, name FROM probe_groups WHERE id = ?", (value,)).fetchone()
    if by_id is not None:
        return str(by_id["id"])
    connection.execute(
        "INSERT OR IGNORE INTO probe_groups (id, name, color, created_at) VALUES (?, ?, '', ?)",
        (str(uuid.uuid4()), value, now_iso()),
    )
    row = connection.execute("SELECT id FROM probe_groups WHERE name = ?", (value,)).fetchone()
    return str(row["id"])


def _canonical_group_name(connection, value: str) -> str:
    clean = (value or "").strip()
    if not clean:
        return ""
    row = connection.execute(
        "SELECT name FROM probe_groups WHERE id = ? OR name = ? LIMIT 1", (clean, clean)
    ).fetchone()
    return str(row["name"]) if row else clean


def _group_row(connection, value: str):
    clean = (value or "").strip()
    return connection.execute(
        "SELECT id, name FROM probe_groups WHERE id = ? OR name = ? LIMIT 1", (clean, clean)
    ).fetchone()

# 服务器地址会嵌入生成的 frpc TOML（serverAddr = "<addr>"），
# 只放行 IPv4/IPv6/域名的安全字符，杜绝引号等注入 TOML 的可能。
_SAFE_ADDR = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9._:-]{0,253}[A-Za-z0-9])?$")

# 面板可调的测试配置项：key（snake，入库）→ (校验函数, 中文说明)
# 生效值 = 环境变量默认 ← 数据库覆盖
def _port_value(raw: str) -> int:
    value = int(raw)
    if not 1 <= value <= 65535:
        raise ValueError("端口必须在 1-65535")
    return value


def _seconds_value(raw: str, low: float = 1, high: float = 300) -> float:
    value = float(raw)
    if not low <= value <= high:
        raise ValueError(f"秒数必须在 {low}-{high}")
    return value


def _int_value(raw: str, low: int, high: int) -> int:
    value = int(raw)
    if not low <= value <= high:
        raise ValueError(f"取值必须在 {low}-{high}")
    return value


PROBE_CONFIG_FIELDS: dict[str, tuple] = {
    "frps_port": (lambda v: _port_value(v), "frps 服务端口"),
    "base_port": (lambda v: _port_value(v), "测试端口组起始（连通性=x，下载=x+1，上传=x+2）"),
    "tcping_timeout": (lambda v: _seconds_value(v, 1, 60), "tcping 超时秒数"),
    "tcping_retries": (lambda v: _int_value(v, 1, 5), "tcping 重试次数"),
    "tunnel_wait": (lambda v: _seconds_value(v, 1, 60), "等待隧道建立秒数"),
    "speed_duration": (lambda v: _seconds_value(v, 5, 120), "速率测试时长秒数"),
    "conn_concurrency": (lambda v: _int_value(v, 1, 16), "连通性并行数"),
    "speed_concurrency": (lambda v: _int_value(v, 1, 8), "速率并行数"),
}


def validate_probe_addr(addr: str) -> str:
    value = (addr or "").strip()
    if not value:
        raise ValueError("服务器地址不能为空")
    if not _SAFE_ADDR.match(value):
        raise ValueError("服务器地址只允许字母、数字、点、冒号、连字符（IP 或域名）")
    return value


def split_probe_endpoint(value, default_port=PROBE_TEST_PORT):
    value=validate_probe_addr(value)
    try:
        ipaddress.ip_address(value)
        return value,int(default_port)
    except ValueError:
        if value.count(':')==1:
            host,raw=value.rsplit(':',1)
            if raw.isdigit():
                port=int(raw)
                if not 1<=port<=65535:raise ValueError('端口必须在1-65535')
                return validate_probe_addr(host),port
        return value,int(default_port)


@dataclass
class ProbeServer:
    id: int
    ip: str
    label: str
    server_group: str
    created_at: str

    @property
    def labels(self) -> list[str]:
        return _unpack_labels(self.label)


def _server_from_row(row) -> ProbeServer:
    return ProbeServer(
        id=int(row["id"]),
        ip=row["ip"],
        label=row["label"],
        server_group=row["server_group"],
        created_at=row["created_at"],
    )


class ProbeStore:
    def __init__(self, database_path: Path, node_id: str | None = None):
        self.database_path = database_path
        self.node_id = node_id
        initialize_database(database_path)

    def _with_connection(self, callback: Callable, *args) -> T:
        connection = connect_database(self.database_path)
        try:
            if self.node_id is not None:
                self._source_views(connection)
            return callback(connection, *args)
        finally:
            connection.close()

    def _source_views(self, connection):
        """Expose unified current results to server views; discovery stays node-scoped."""
        default_port = PROBE_TEST_PORT
        connection.create_function('probe_endpoint_host', 1, lambda value: split_probe_endpoint(value, default_port)[0])
        connection.create_function('probe_endpoint_port', 1, lambda value: split_probe_endpoint(value, default_port)[1])
        for kind, table, fields in [
            ('connectivity', 'probe_connectivity_results', ['frps_reachable','tunnel_established','firewall_open','detail']),
            ('speed', 'probe_speed_results', ['frps_reachable','tunnel_ok','dl_ok','dl_bytes','dl_sec','ul_ok','ul_bytes','ul_sec','detail']),
        ]:
            columns = ['r.source_result_id AS id', 'a.ip AS server_ip', 'r.test_time']
            columns.extend(
                "COALESCE(json_extract(r.data,'$." + field + "')," + ("''" if field in {'detail','error','hops'} else '0') + ") AS " + field
                for field in fields
            )
            if kind == 'speed':
                for prefix in ('dl','ul'):
                    columns.extend([
                        f"COALESCE(json_extract(r.data,'$.{prefix}_speed_bps'),0)*8.0/1048576 AS {prefix}_speed_mbps",
                        f"COALESCE(json_extract(r.data,'$.{prefix}_speed_bps'),0)/1048576.0 AS {prefix}_speed_mbs",
                    ])
            projection = ','.join(columns)
            # Keep this as a view over the durable, indexed current projection.
            # Materializing every asset/result into a TEMP table made a 50-row
            # server page pay for the entire asset/current-result population.
            connection.execute(
                f"CREATE TEMP VIEW {table} AS SELECT {projection} "
                "FROM main.probe_servers a JOIN main.probe_current_results r "
                "ON r.server_ip=probe_endpoint_host(a.ip) "
                f"WHERE r.kind='{kind}' AND r.port={PROBE_TEST_PORT} "
                f"AND probe_endpoint_port(a.ip)={PROBE_TEST_PORT}"
            )
        def source_labels(packed, route_json):
            import json
            labels=_unpack_labels(packed)
            legacy=any(x in {ROUTE_LABEL_CN2,ROUTE_LABEL_NON_CN2} for x in labels)
            labels=[x for x in labels if x not in {ROUTE_LABEL_CN2,ROUTE_LABEL_NON_CN2,ROUTE_LABEL_UNTESTED}]
            if route_json:
                route=json.loads(route_json)
                label=(ROUTE_LABEL_CN2 if route.get('isCn2') else ROUTE_LABEL_NON_CN2) if route.get('ok') else ROUTE_LABEL_UNTESTED
            else:
                label='路由来源未知' if legacy else ROUTE_LABEL_UNTESTED
            return _pack_labels([*labels,label])
        connection.create_function('probe_source_labels',2,source_labels)
        if self.node_id is not None:
            node = "'" + self.node_id.replace("'", "''") + "'"
            connection.execute(f"""CREATE TEMP VIEW probe_discover_results AS
                SELECT d.id,d.ip,d.ip_sort,d.port,o.latency_ms,d.server_group,d.group_id,
                probe_source_labels(d.label,(SELECT data FROM main.probe_current_results r WHERE r.kind='route' AND r.server_ip=probe_endpoint_host(d.ip) AND r.port=d.port LIMIT 1)) AS label,o.discovered_at
                FROM main.probe_discover_results d JOIN main.probe_discover_observations o
                ON o.ip=d.ip AND o.port=d.port WHERE o.node_id={node}""")

    # ---- 服务器清单 ----

    def list_servers(self) -> list[ProbeServer]:
        def read(connection):
            rows = connection.execute(
                "SELECT * FROM probe_servers ORDER BY server_group, ip"
            ).fetchall()
            return [_server_from_row(row) for row in rows]

        return self._with_connection(read)

    def create_server(self, *, ip: str, labels: Sequence[str] = (), server_group: str = "",
                      tag_ids: Sequence[str] = ()) -> ProbeServer:
        addr = validate_probe_addr(ip)
        clean_labels = _asset_labels(labels)
        created_at = now_iso()
        ip_sort = _ip_sort_for(addr)

        def write(connection):
            group_name = _canonical_group_name(connection, server_group)
            try:
                cursor = connection.execute(
                    "INSERT INTO probe_servers (ip, ip_sort, label, server_group, group_id, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (addr, ip_sort, _pack_labels(clean_labels), group_name,
                     _ensure_group_id(connection, group_name), created_at),
                )
                _sync_server_tags(connection, int(cursor.lastrowid), clean_labels)
                if tag_ids:
                    _assign_server_tag_ids(connection, int(cursor.lastrowid), tag_ids)
            except Exception as exc:
                if "UNIQUE" in str(exc):
                    raise ValueError(f"服务器已存在: {addr}") from exc
                raise
            connection.commit()
            return int(cursor.lastrowid)

        server_id = self._with_connection(write)
        return self.get_server(server_id)

    def get_server(self, server_id: int) -> ProbeServer:
        def read(connection):
            return connection.execute(
                "SELECT * FROM probe_servers WHERE id = ?", (server_id,)
            ).fetchone()

        row = self._with_connection(read)
        if row is None:
            raise KeyError(f"服务器不存在: {server_id}")
        return _server_from_row(row)

    def update_server(
        self,
        server_id: int,
        *,
        ip: str | None = None,
        labels: Sequence[str] | None = None,
        server_group: str | None = None,
        tag_ids: Sequence[str] | None = None,
    ) -> ProbeServer:
        def write(connection):
            connection.execute("BEGIN IMMEDIATE")
            server = connection.execute(
                "SELECT * FROM probe_servers WHERE id = ?", (server_id,)
            ).fetchone()
            if server is None:
                raise KeyError(f"服务器不存在: {server_id}")
            new_ip = validate_probe_addr(ip) if ip is not None else server["ip"]
            new_labels = _asset_labels(labels) if labels is not None else _server_labels_from_relation(connection, server_id)
            new_group = (server_group or "").strip() if server_group is not None else server["server_group"]
            new_ip_sort = _ip_sort_for(new_ip)
            resolved_group = _canonical_group_name(connection, new_group)
            connection.execute(
                "UPDATE probe_servers SET ip = ?, ip_sort = ?, label = ?, server_group = ?, group_id = ? WHERE id = ?",
                (new_ip, new_ip_sort, _pack_labels(new_labels), resolved_group,
                 _ensure_group_id(connection, resolved_group), server_id),
            )
            if labels is not None:
                _sync_server_tags(connection, server_id, new_labels)
            if tag_ids is not None:
                _assign_server_tag_ids(
                    connection, server_id, tag_ids, replace=labels is None
                )
            connection.commit()

        self._with_connection(write)
        return self.get_server(server_id)

    def delete_server(self, server_id: int) -> None:
        self.get_server(server_id)

        def write(connection):
            connection.execute("DELETE FROM probe_servers WHERE id = ?", (server_id,))
            connection.commit()

        self._with_connection(write)

    def delete_servers_batch(self, ids: Sequence[int], *, lease_guard: tuple[str, str] | None = None) -> int:
        """Delete a bounded server chunk in one immediate transaction.

        Missing IDs are naturally idempotent; normalized tag relations and other
        dependent rows are removed by SQLite's configured foreign-key cascades.
        """
        normalized = _normalize_ids(ids)
        if not normalized:
            return 0
        def write(connection):
            affected = 0
            connection.execute("BEGIN IMMEDIATE")
            _assert_bulk_lease(connection, lease_guard)
            for chunk in _chunks(connection, normalized):
                placeholders = ",".join("?" for _ in chunk)
                affected += connection.execute(
                    f"DELETE FROM probe_servers WHERE id IN ({placeholders})", chunk
                ).rowcount
            connection.commit()
            return affected
        return self._with_connection(write)

    def import_servers(self, items: list[dict]) -> tuple[int, int]:
        """Atomically import bounded input chunks; very large imports need the async job slice."""
        if len(items) > MAX_SERVER_IMPORT_ITEMS:
            raise ServerImportLimitError(
                f"同步导入最多 {MAX_SERVER_IMPORT_ITEMS} 条，请拆分为多个较小批次导入"
            )
        if not items:
            return 0, 0
        created_at = now_iso()

        def write(connection):
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                inserted = 0
                group_ids: dict[str, tuple[str, str | None]] = {}
                for offset in range(0, len(items), SERVER_IMPORT_BATCH_SIZE):
                    candidates: dict[str, tuple[int | None, list[str], str]] = {}
                    for item in items[offset:offset + SERVER_IMPORT_BATCH_SIZE]:
                        ip = validate_probe_addr(str(item.get("ip", "")))
                        group = str(item.get("group", "") or "").strip()
                        candidates.setdefault(
                            ip, (_ip_sort_for(ip), _asset_labels([str(item.get("label", "") or "")]), group)
                        )
                    for _, _, group in candidates.values():
                        if group not in group_ids:
                            canonical = _canonical_group_name(connection, group)
                            group_ids[group] = (canonical, _ensure_group_id(connection, canonical))
                    ips = list(candidates)
                    placeholders = ",".join("?" for _ in ips)
                    existing = {row["ip"] for row in connection.execute(
                        f"SELECT ip FROM probe_servers WHERE ip IN ({placeholders})", ips
                    )}
                    cursor = connection.executemany(
                        "INSERT OR IGNORE INTO probe_servers "
                        "(ip, ip_sort, label, server_group, group_id, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        [(ip, candidates[ip][0], _pack_labels(candidates[ip][1]),
                          group_ids[candidates[ip][2]][0], group_ids[candidates[ip][2]][1], created_at)
                         for ip in ips],
                    )
                    inserted += max(cursor.rowcount, 0)
                    imported_ips = [ip for ip in ips if ip not in existing]
                    if imported_ips:
                        entries: list[tuple[int, Sequence[str]]] = []
                        imported_placeholders = ",".join("?" for _ in imported_ips)
                        rows = connection.execute(
                            f"SELECT id, ip FROM probe_servers WHERE ip IN ({imported_placeholders})", imported_ips
                        ).fetchall()
                        entries.extend((row["id"], candidates[row["ip"]][1]) for row in rows)
                        _sync_server_tags_many(connection, entries, preserve_existing=False)
                return inserted

        inserted = self._with_connection(write)
        return inserted, len(items) - inserted

    def import_servers_chunk(self, connection: sqlite3.Connection, items: list[dict]) -> set[str]:
        """Insert one bounded async-import page inside the caller's lease transaction."""
        if len(items) > 250:
            raise ValueError("async import chunk exceeds 250 items")
        if not items:
            return set()
        created_at = now_iso()
        candidates = {}
        groups = {}
        for item in items:
            ip = validate_probe_addr(str(item.get("ip", "")))
            group = str(item.get("group", "") or "").strip()
            candidates.setdefault(ip, (_ip_sort_for(ip), _asset_labels([str(item.get("label", "") or "")]), group))
        ips = list(candidates)
        placeholders = ",".join("?" for _ in ips)
        before = {row["ip"] for row in connection.execute(
            f"SELECT ip FROM probe_servers WHERE ip IN ({placeholders})", ips
        )}
        for _, _, group in candidates.values():
            if group not in groups:
                canonical = _canonical_group_name(connection, group)
                groups[group] = (canonical, _ensure_group_id(connection, canonical))
        connection.executemany(
            "INSERT OR IGNORE INTO probe_servers (ip,ip_sort,label,server_group,group_id,created_at) VALUES (?,?,?,?,?,?)",
            [(ip, candidates[ip][0], _pack_labels(candidates[ip][1]), groups[candidates[ip][2]][0],
              groups[candidates[ip][2]][1], created_at) for ip in ips],
        )
        inserted = set(ips) - before
        if inserted:
            inserted_placeholders = ",".join("?" for _ in inserted)
            rows = connection.execute(
                f"SELECT id,ip FROM probe_servers WHERE ip IN ({inserted_placeholders})", list(inserted)
            ).fetchall()
            _sync_server_tags_many(connection, [(row["id"], candidates[row["ip"]][1]) for row in rows], preserve_existing=False)
        return inserted

    def list_tag_categories(self) -> list[dict]:
        def read(connection):
            return [dict(row) for row in connection.execute(
                "SELECT c.id, c.name, c.created_at AS createdAt, COUNT(t.id) AS tagCount "
                "FROM probe_tag_categories c LEFT JOIN probe_tags t ON t.category_id=c.id "
                "GROUP BY c.id, c.name, c.created_at ORDER BY c.name"
            )]
        return self._with_connection(read)

    def create_tag_category(self, name: str) -> dict:
        clean = str(name or "").strip()
        if not clean:
            raise ValueError("分类名称不能为空")
        category_id, created_at = str(uuid.uuid4()), now_iso()

        def write(connection):
            try:
                connection.execute(
                    "INSERT INTO probe_tag_categories(id,name,created_at) VALUES(?,?,?)",
                    (category_id, clean, created_at),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"分类已存在: {clean}") from exc
            connection.commit()
        self._with_connection(write)
        return next(category for category in self.list_tag_categories()
                    if category["id"] == category_id)

    def rename_tag_category(self, category_id: str, name: str) -> dict:
        clean = str(name or "").strip()
        if not clean:
            raise ValueError("分类名称不能为空")

        def write(connection):
            row = connection.execute(
                "SELECT id FROM probe_tag_categories WHERE id=?", (category_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"分类不存在: {category_id}")
            try:
                connection.execute(
                    "UPDATE probe_tag_categories SET name=? WHERE id=?", (clean, category_id)
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"分类已存在: {clean}") from exc
            connection.commit()
        self._with_connection(write)
        return next(category for category in self.list_tag_categories()
                    if category["id"] == category_id)

    def list_tags(self, category_id: str | None = None) -> list[dict]:
        def read(connection):
            where = "WHERE t.category_id=?" if category_id is not None else ""
            params = (category_id,) if category_id is not None else ()
            return [dict(row) for row in connection.execute(
                "SELECT t.id, t.category_id AS categoryId, c.name AS category, t.name, "
                "t.created_at AS createdAt, COUNT(DISTINCT st.server_id) AS serverCount "
                "FROM probe_tags t JOIN probe_tag_categories c ON c.id=t.category_id "
                "LEFT JOIN probe_server_tags st ON st.tag_id=t.id "
                f"{where} GROUP BY t.id, t.category_id, c.name, t.name, t.created_at "
                "ORDER BY c.name, t.name", params
            )]
        return self._with_connection(read)

    def create_tag(self, category_id: str, name: str) -> dict:
        clean = _clean_tag_name(name)
        tag_id, created_at = str(uuid.uuid4()), now_iso()

        def write(connection):
            if connection.execute(
                "SELECT 1 FROM probe_tag_categories WHERE id=?", (category_id,)
            ).fetchone() is None:
                raise KeyError(f"分类不存在: {category_id}")
            try:
                connection.execute(
                    "INSERT INTO probe_tags(id,category_id,name,created_at) VALUES(?,?,?,?)",
                    (tag_id, category_id, clean, created_at),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"该分类下标签已存在: {clean}") from exc
            connection.commit()
        self._with_connection(write)
        return next(tag for tag in self.list_tags() if tag["id"] == tag_id)

    def update_tag(self, tag_id: str, *, name: str | None = None,
                   category_id: str | None = None) -> dict:
        if name is None and category_id is None:
            raise ValueError("至少提供标签名称或分类")
        clean = _clean_tag_name(name) if name is not None else None

        def write(connection):
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT id, name, category_id FROM probe_tags WHERE id=?", (tag_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"标签不存在: {tag_id}")
            next_name = clean if clean is not None else row["name"]
            next_category = category_id if category_id is not None else row["category_id"]
            if connection.execute(
                "SELECT 1 FROM probe_tag_categories WHERE id=?", (next_category,)
            ).fetchone() is None:
                raise KeyError(f"分类不存在: {next_category}")
            try:
                connection.execute(
                    "UPDATE probe_tags SET name=?, category_id=? WHERE id=?",
                    (next_name, next_category, tag_id),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError("目标分类中已存在同名标签") from exc
            if next_name != row["name"]:
                _refresh_tag_projection(connection, [tag_id])
            connection.commit()
        self._with_connection(write)
        return next(tag for tag in self.list_tags() if tag["id"] == tag_id)

    def delete_tag(self, tag_id: str) -> int:
        def write(connection):
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM probe_tags WHERE id=?", (tag_id,)).fetchone() is None:
                raise KeyError(f"标签不存在: {tag_id}")
            _capture_tag_servers(connection, [tag_id])
            affected = connection.execute(
                "SELECT COUNT(*) FROM _probe_tag_projection_refresh"
            ).fetchone()[0]
            connection.execute("DELETE FROM probe_tags WHERE id=?", (tag_id,))
            _refresh_captured_server_projections(connection)
            connection.commit()
            return affected
        return self._with_connection(write)

    def merge_tags(self, source_id: str, target_id: str) -> dict:
        if source_id == target_id:
            raise ValueError("来源标签与目标标签必须不同")

        def write(connection):
            connection.execute("BEGIN IMMEDIATE")
            source = connection.execute(
                "SELECT id FROM probe_tags WHERE id=?", (source_id,)
            ).fetchone()
            target = connection.execute(
                "SELECT id FROM probe_tags WHERE id=?", (target_id,)
            ).fetchone()
            if source is None:
                raise KeyError(f"标签不存在: {source_id}")
            if target is None:
                raise KeyError(f"标签不存在: {target_id}")
            _capture_tag_servers(connection, [source_id])
            affected = connection.execute(
                "SELECT COUNT(*) FROM _probe_tag_projection_refresh"
            ).fetchone()[0]
            connection.execute(
                "INSERT OR IGNORE INTO probe_server_tags(server_id,tag_id) "
                "SELECT server_id,? FROM probe_server_tags WHERE tag_id=?",
                (target_id, source_id),
            )
            connection.execute("DELETE FROM probe_tags WHERE id=?", (source_id,))
            _refresh_captured_server_projections(connection)
            connection.commit()
            return {"tagId": target_id, "mergedServers": affected}
        return self._with_connection(write)

    def list_groups(self) -> list[str]:
        """预创建分组 ∪ 服务器上实际使用的分组（仅名称）。"""
        return [item["name"] for item in self.list_groups_with_colors()]

    def list_groups_with_colors(self) -> list[dict]:
        """预创建分组（含颜色）∪ 服务器上实际使用的分组（未预创建的颜色为空）。"""

        def read(connection):
            predefined = {
                row["name"]: (row["id"], row["color"] or "")
                for row in connection.execute("SELECT id, name, color FROM probe_groups").fetchall()
            }
            in_use = {
                row[0] for row in connection.execute(
                    "SELECT DISTINCT server_group FROM probe_servers WHERE server_group != ''"
                ).fetchall()
            }
            names = sorted(set(predefined) | in_use)
            return [{"id": predefined[name][0] if name in predefined else None,
                     "name": name, "color": predefined.get(name, (None, ""))[1]} for name in names]

        return self._with_connection(read)

    def create_group(self, name: str, color: str = "") -> str:
        value = (name or "").strip()
        if not value:
            raise ValueError("分组名不能为空")
        if len(value) > 64:
            raise ValueError("分组名过长（最多 64 字符）")
        clean_color = _clean_group_color(color)

        def write(connection):
            connection.execute(
                "INSERT OR IGNORE INTO probe_groups (id, name, color, created_at) VALUES (?, ?, ?, ?)",
                (str(uuid.uuid4()), value, clean_color, now_iso()),
            )
            connection.commit()

        self._with_connection(write)
        return value

    def set_group_color(self, name: str, color: str) -> str:
        """设置分组颜色；分组尚不存在（仅服务器在用）时自动补预创建记录。"""
        value = (name or "").strip()
        if not value:
            raise ValueError("分组名不能为空")
        clean_color = _clean_group_color(color)

        def write(connection):
            existing = _group_row(connection, value)
            actual_name = existing["name"] if existing else value
            connection.execute(
                "INSERT OR IGNORE INTO probe_groups (id, name, color, created_at) VALUES (?, ?, ?, ?)",
                (str(uuid.uuid4()), actual_name, clean_color, now_iso()),
            )
            connection.execute(
                "UPDATE probe_groups SET color = ? WHERE name = ?", (clean_color, actual_name))
            connection.commit()

        self._with_connection(write)
        return clean_color

    def delete_group(self, name: str) -> bool:
        """Delete an unused group; all consumer references are protected."""

        def write(connection):
            group = _group_row(connection, name)
            if group is None:
                return False
            references = connection.execute(
                "SELECT EXISTS(SELECT 1 FROM probe_servers WHERE group_id = ?) OR "
                "EXISTS(SELECT 1 FROM probe_discover_results WHERE group_id = ?) OR "
                "EXISTS(SELECT 1 FROM lb_domains WHERE group_id = ?)",
                (group["id"], group["id"], group["id"]),
            ).fetchone()[0]
            if references:
                raise ValueError("分组仍被服务器、发现结果或负载均衡域名引用")
            cursor = connection.execute("DELETE FROM probe_groups WHERE id = ?", (group["id"],))
            connection.commit()
            return cursor.rowcount > 0

        return self._with_connection(write)

    def rename_group(self, old: str, new: str) -> str:
        """重命名分组：预创建记录、服务器、网段发现结果、负载均衡域名绑定一并级联。"""
        old_value = (old or "").strip()
        new_value = (new or "").strip()
        if not old_value:
            raise ValueError("原分组名不能为空")
        if not new_value:
            raise ValueError("新分组名不能为空")
        if len(new_value) > 64:
            raise ValueError("分组名过长（最多 64 字符）")
        if old_value == new_value:
            return new_value

        def write(connection):
            exists = _group_row(connection, new_value)
            if exists:
                raise ValueError(f"分组「{new_value}」已存在")
            group = _group_row(connection, old_value)
            if group is None:
                raise ValueError(f"分组「{old_value}」不存在")
            connection.execute("UPDATE probe_groups SET name = ? WHERE id = ?", (new_value, group["id"]))
            connection.execute("UPDATE probe_servers SET server_group = ? WHERE group_id = ?",
                               (new_value, group["id"]))
            connection.execute("UPDATE probe_discover_results SET server_group = ? WHERE group_id = ?",
                               (new_value, group["id"]))
            connection.execute("UPDATE lb_domains SET group_name = ? WHERE group_id = ?",
                               (new_value, group["id"]))
            connection.commit()

        self._with_connection(write)
        return new_value


    def upsert_discover_results_batch(
        self, hits: Iterable[tuple[str, int, float]]
    ) -> list[str]:
        """UPSERT scanner hits atomically and return de-duplicated IPs still needing route tests."""
        timestamp = now_iso()
        cleaned = [
            (str(ip), _ipv4_sort_key(str(ip)), int(port), float(latency), timestamp)
            for ip, port, latency in hits
        ]
        if not cleaned:
            return []

        def write(connection):
            with connection:
                connection.executemany(
                    "INSERT INTO probe_discover_results "
                    "(ip, ip_sort, port, latency_ms, label, discovered_at) "
                    "VALUES (?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(ip, port) DO UPDATE SET ip_sort = excluded.ip_sort, "
                    "latency_ms = excluded.latency_ms, discovered_at = excluded.discovered_at",
                    [(*row[:4], _pack_labels([ROUTE_LABEL_UNTESTED]), row[4]) for row in cleaned],
                )
                connection.executemany(
                    "INSERT INTO probe_discover_observations(node_id,ip,port,latency_ms,discovered_at) VALUES('console',?,?,?,?) "
                    "ON CONFLICT(node_id,ip,port) DO UPDATE SET latency_ms=excluded.latency_ms,discovered_at=excluded.discovered_at",
                    [(row[0],row[2],row[3],row[4]) for row in cleaned],
                )
                eligible: set[str] = set()
                unique_ips = list(dict.fromkeys(row[0] for row in cleaned))
                for chunk in _chunks(connection, unique_ips, headroom=1):
                    placeholders = ",".join("?" for _ in chunk)
                    rows = connection.execute(
                        "SELECT DISTINCT ip FROM probe_discover_results "
                        f"WHERE ip IN ({placeholders}) AND (label = '' OR label LIKE ?)",
                        (*chunk, _label_like_pattern(ROUTE_LABEL_UNTESTED)),
                    ).fetchall()
                    eligible.update(row["ip"] for row in rows)
            return [ip for ip in unique_ips if ip in eligible]

        return self._with_connection(write)

    def set_route_label(self, ip: str, label: str) -> int:
        """路由测试结论写回该 IP 的全部发现行标签（多标签语义：剥掉旧结论、追加新结论）。"""

        # 结论标签三兄弟全部剥掉，避免残留矛盾结论
        stripped = "REPLACE(REPLACE(REPLACE(label, ',未路由测试,', ','), ',非CN2,', ','), ',CN2,', ',')"

        def write(connection):
            cursor = connection.execute(
                f"UPDATE probe_discover_results SET label = CASE WHEN {stripped} = '' "
                f"THEN ? ELSE {stripped} || ? END WHERE ip = ?",
                (_pack_labels([label]), f"{label},", ip))
            connection.commit()
            return cursor.rowcount

        return self._with_connection(write)

    def discover_row_needs_route(self, ip: str) -> bool:
        """该 IP 是否存在待路由测试的发现行（无结论标签：空或仅有「未路由测试」）。"""

        def read(connection):
            row = connection.execute(
                "SELECT 1 FROM probe_discover_results "
                "WHERE ip = ? AND (label = '' OR label LIKE ?) LIMIT 1",
                (ip, _label_like_pattern(ROUTE_LABEL_UNTESTED)),
            ).fetchone()
            return row is not None

        return self._with_connection(read)

    def get_setting(self, key: str) -> str | None:
        def read(connection):
            row = connection.execute(
                "SELECT value FROM probe_settings WHERE key = ?", (key,)).fetchone()
            return row[0] if row else None

        return self._with_connection(read)

    def set_setting(self, key: str, value: str) -> None:
        def write(connection):
            connection.execute(
                "INSERT INTO probe_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
            connection.commit()

        self._with_connection(write)

    def query_discover_results(self, query: DiscoverPageQuery) -> dict:
        """Return one globally filtered/sorted discovery page and its metadata."""
        where = []
        params: list[object] = []
        q = query.q.strip()
        if q:
            escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where.append(
                "(d.ip LIKE ? ESCAPE '\\' OR d.server_group LIKE ? ESCAPE '\\' "
                "OR d.label LIKE ? ESCAPE '\\')"
            )
            params.extend([f"%{escaped}%"] * 3)
        if query.group is not None:
            where.append(
                "(d.group_id = (SELECT id FROM probe_groups WHERE id = ? OR name = ? LIMIT 1) "
                "OR d.server_group = ?)"
            )
            params.extend([query.group, query.group, query.group])
        if query.label is not None:
            # 空串 = 无标签；非空 = 标签集合包含该标签（哨兵 LIKE，转义 %/_）
            if query.label == "":
                where.append("d.label = ''")
            else:
                where.append("d.label LIKE ? ESCAPE '\\'")
                params.append(_label_like_pattern(query.label))
        library_exists = "EXISTS (SELECT 1 FROM probe_servers s WHERE s.ip = d.ip)"
        if query.library == "imported":
            where.append(library_exists)
        elif query.library == "new":
            where.append(f"NOT {library_exists}")
        where_sql = " WHERE " + " AND ".join(where) if where else ""
        direction = query.order.upper()
        if query.sort == "ip":
            order_sql = (
                f"(d.ip_sort IS NULL) ASC, d.ip_sort {direction}, d.id {direction}"
            )
        else:
            column = "d.discovered_at" if query.sort == "time" else "d.latency_ms"
            order_sql = f"{column} {direction}, d.id {direction}"

        def read(connection):
            total = connection.execute(
                "SELECT COUNT(*) FROM probe_discover_results d" + where_sql, params
            ).fetchone()[0]
            rows = connection.execute(
                "SELECT d.id, d.ip, d.port, d.latency_ms, d.server_group, d.label, "
                f"d.discovered_at, {library_exists} AS in_library "
                "FROM probe_discover_results d" + where_sql +
                f" ORDER BY {order_sql} LIMIT ? OFFSET ?",
                (*params, query.page_size, (query.page - 1) * query.page_size),
            ).fetchall()
            return {
                "items": [dict(row) for row in rows],
                "page": query.page,
                "pageSize": query.page_size,
                "total": total,
                "sort": query.sort,
                "order": query.order,
            }

        return self._with_connection(read)

    def discover_facets(self) -> dict:
        """Return global discovery facets, independent of any current page/filter."""
        def read(connection):
            packed = [row["label"] for row in connection.execute(
                "SELECT label FROM probe_discover_results WHERE label != ''")]
            groups = connection.execute(
                "SELECT server_group, COUNT(*) AS count FROM probe_discover_results "
                "WHERE server_group != '' GROUP BY server_group ORDER BY count DESC, server_group"
            ).fetchall()
            counts = connection.execute(
                "SELECT COUNT(*) AS total, "
                "SUM(CASE WHEN EXISTS (SELECT 1 FROM probe_servers s WHERE s.ip = d.ip) "
                "THEN 1 ELSE 0 END) AS imported "
                "FROM probe_discover_results d"
            ).fetchone()
            imported = counts["imported"] or 0
            return {
                "labels": _aggregate_labels(packed),
                "groups": [{"group": row["server_group"], "count": row["count"]} for row in groups],
                "imported": imported,
                "new": counts["total"] - imported,
            }

        return self._with_connection(read)

    def get_discover_results_by_ids(self, ids: Iterable[int]) -> list[dict]:
        """Fetch only selected discovery rows, preserving normalized request order."""
        normalized = _normalize_ids(ids)
        if not normalized:
            return []

        def read(connection):
            found = {}
            for chunk in _chunks(connection, normalized):
                placeholders = ",".join("?" for _ in chunk)
                rows = connection.execute(
                    "SELECT d.id, d.ip, d.port, d.latency_ms, d.server_group, d.label, "
                    "d.discovered_at, EXISTS (SELECT 1 FROM probe_servers s WHERE s.ip = d.ip) "
                    "AS in_library FROM probe_discover_results d "
                    f"WHERE d.id IN ({placeholders})",
                    chunk,
                ).fetchall()
                found.update((row["id"], dict(row)) for row in rows)
            return [found[row_id] for row_id in normalized if row_id in found]

        return self._with_connection(read)

    def import_discover_results(
        self, ids: Iterable[int], *, group: str = ""
    ) -> DiscoverImportResult:
        """Atomically return selected, inserted, and skipped row counts."""
        normalized = _normalize_ids(ids)
        if not normalized:
            return DiscoverImportResult(0, 0, 0)
        override = group.strip()

        def write(connection):
            with connection:
                # Reserve the write transaction before selecting so selected_count
                # and the inserts are decided against one atomic database state.
                connection.execute("BEGIN IMMEDIATE")
                resolved_override = _canonical_group_name(connection, override)
                selected = {}
                for chunk in _chunks(connection, normalized):
                    placeholders = ",".join("?" for _ in chunk)
                    rows = connection.execute(
                        "SELECT id, ip, server_group, label FROM probe_discover_results "
                        f"WHERE id IN ({placeholders})", chunk
                    ).fetchall()
                    selected.update((row["id"], row) for row in rows)
                candidates = {}
                existing_selected = 0
                timestamp = now_iso()
                for row_id in normalized:
                    row = selected.get(row_id)
                    if row is None:
                        continue
                    existing_selected += 1
                    if row["ip"] not in candidates:
                        candidates[row["ip"]] = (
                            row["ip"], _ip_sort_for(row["ip"]),
                            _asset_labels(_unpack_labels(row["label"])),
                            resolved_override or row["server_group"], timestamp
                        )
                if not candidates:
                    return DiscoverImportResult(existing_selected, 0, 0)
                inserted = 0
                imported_labels: dict[str, list[str]] = {}
                ips = list(candidates)
                group_ids: dict[str, tuple[str, str | None]] = {}
                for _, _, _, server_group, _ in candidates.values():
                    if server_group not in group_ids:
                        group_name = _canonical_group_name(connection, server_group)
                        group_ids[server_group] = (group_name, _ensure_group_id(connection, group_name))
                for chunk in _chunks(connection, ips):
                    placeholders = ",".join("?" for _ in chunk)
                    existing = {row["ip"] for row in connection.execute(
                        f"SELECT ip FROM probe_servers WHERE ip IN ({placeholders})", chunk
                    )}
                    values = []
                    for ip in chunk:
                        _, ip_sort, labels, server_group, created_at = candidates[ip]
                        group_name, group_id = group_ids[server_group]
                        values.append((ip, ip_sort, _pack_labels(labels), group_name,
                                       group_id, created_at))
                    cursor = connection.executemany(
                        "INSERT OR IGNORE INTO probe_servers "
                        "(ip, ip_sort, label, server_group, group_id, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?)", values,
                    )
                    inserted += max(cursor.rowcount, 0)
                    imported_labels.update(
                        (ip, candidates[ip][2]) for ip in chunk if ip not in existing
                    )
                if imported_labels:
                    entries: list[tuple[int, Sequence[str]]] = []
                    for chunk in _chunks(connection, list(imported_labels)):
                        placeholders = ",".join("?" for _ in chunk)
                        rows = connection.execute(
                            f"SELECT id, ip FROM probe_servers WHERE ip IN ({placeholders})", chunk
                        ).fetchall()
                        entries.extend((row["id"], imported_labels[row["ip"]]) for row in rows)
                    _sync_server_tags_many(connection, entries, preserve_existing=False)
                return DiscoverImportResult(
                    existing_selected, inserted, existing_selected - inserted
                )

        return self._with_connection(write)

    def discover_labels_for_ids(self, ids: list[int]) -> list[dict]:
        """聚合所选发现行已贴的标签（跨页批量标签弹窗用）。"""
        normalized = _normalize_ids(ids)
        if not normalized:
            return []

        def read(connection):
            packed: list[str] = []
            for chunk in _chunks(connection, normalized):
                placeholders = ",".join("?" for _ in chunk)
                rows = connection.execute(
                    "SELECT label FROM probe_discover_results "
                    f"WHERE id IN ({placeholders}) AND label != ''", chunk
                ).fetchall()
                packed.extend(row["label"] for row in rows)
            return _aggregate_labels(packed)

        return self._with_connection(read)

    def servers_labels_for_ids(self, ids: list[int]) -> list[dict]:
        """聚合所选服务器已贴的标签。"""
        normalized = _normalize_ids(ids)
        if not normalized:
            return []

        def read(connection):
            counts: dict[str, int] = {}
            for chunk in _chunks(connection, normalized):
                placeholders = ",".join("?" for _ in chunk)
                rows = connection.execute(
                    "SELECT t.name AS label, COUNT(DISTINCT st.server_id) AS count "
                    "FROM probe_server_tags st JOIN probe_tags t ON t.id = st.tag_id "
                    f"WHERE st.server_id IN ({placeholders}) GROUP BY t.name", chunk
                ).fetchall()
                for row in rows:
                    counts[row["label"]] = counts.get(row["label"], 0) + row["count"]
            return [{"label": label, "count": count}
                    for label, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))]

        return self._with_connection(read)

    def update_discover_batch(
        self, ids: list[int], *, group: str | None = None,
        add_labels: Sequence[str] = (), remove_labels: Sequence[str] = (),
    ) -> int:
        """批量更新发现结果：分组覆盖 + 标签增/删（多标签语义），返回更新行数。"""
        if group is None and not add_labels and not remove_labels:
            raise ValueError("至少提供分组或标签之一")
        clean_group = (group or "").strip() if group is not None else None
        if group is not None and not clean_group:
            raise ValueError("分组不能为空")
        adds = _normalize_labels(add_labels)
        removes = _normalize_labels(remove_labels)

        normalized = _normalize_ids(ids)
        if not normalized:
            return 0

        def write(connection):
            affected = 0
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                group_for_update = (_canonical_group_name(connection, clean_group)
                                    if clean_group is not None else None)
                for chunk in _chunks(connection, normalized, headroom=4):
                    placeholders = ",".join("?" for _ in chunk)
                    # 纯标签操作没有可靠的 rowcount 语义，按 chunk 基数计数
                    affected += connection.execute(
                        f"SELECT COUNT(*) FROM probe_discover_results WHERE id IN ({placeholders})",
                        chunk,
                    ).fetchone()[0]
                    if group_for_update is not None:
                        group_id = _ensure_group_id(connection, group_for_update)
                        connection.execute(
                            "UPDATE probe_discover_results SET server_group = ?, group_id = ? "
                            f"WHERE id IN ({placeholders})",
                            (group_for_update, group_id, *chunk),
                        )
                    for label in removes:
                        cursor = connection.execute(
                            "UPDATE probe_discover_results SET label = CASE "
                            "WHEN REPLACE(label, ?, ',') = ',' THEN '' "
                            "ELSE REPLACE(label, ?, ',') END "
                            f"WHERE id IN ({placeholders})",
                            (f",{label},", f",{label},", *chunk),
                        )
                    for label in adds:
                        pattern = _label_like_pattern(label)
                        cursor = connection.execute(
                            "UPDATE probe_discover_results SET label = CASE "
                            "WHEN label = '' THEN ? "
                            "WHEN label LIKE ? ESCAPE '\\' THEN label "
                            "ELSE label || ? END "
                            f"WHERE id IN ({placeholders})",
                            (f",{label},", pattern, f"{label},", *chunk),
                        )
            return affected

        return self._with_connection(write)

    def delete_discover_results(self, ids: list[int] | None = None) -> int:
        """Delete selected unique IDs; only ids=None clears the whole result table."""
        normalized = None if ids is None else _normalize_ids(ids)
        if normalized == []:
            return 0

        def write(connection):
            with connection:
                if normalized is None:
                    return connection.execute("DELETE FROM probe_discover_results").rowcount
                affected = 0
                for chunk in _chunks(connection, normalized):
                    placeholders = ",".join("?" for _ in chunk)
                    affected += connection.execute(
                        f"DELETE FROM probe_discover_results WHERE id IN ({placeholders})", chunk
                    ).rowcount
                return affected

        return self._with_connection(write)

    def update_servers_batch(
        self, ids: list[int], *, group: str | None = None,
        add_labels: Sequence[str] = (), remove_labels: Sequence[str] = (),
        add_tag_ids: Sequence[str] = (), remove_tag_ids: Sequence[str] = (),
        lease_guard: tuple[str, str] | None = None, return_ids: bool = False,
    ) -> int | set[int]:
        """批量更新服务器：分组覆盖 + 标签增/删（多标签语义），返回更新行数。"""
        if group is None and not add_labels and not remove_labels and not add_tag_ids and not remove_tag_ids:
            raise ValueError("至少提供分组或标签之一")
        clean_group = (group or "").strip() if group is not None else None
        if group is not None and not clean_group:
            raise ValueError("分组不能为空")
        adds = _normalize_labels(add_labels)
        removes = _normalize_labels(remove_labels)

        normalized = _normalize_ids(ids)
        if not normalized:
            return set() if return_ids else 0

        def write(connection):
            affected = 0
            existing_ids: set[int] = set()
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                _assert_bulk_lease(connection, lease_guard)
                group_for_update = (_canonical_group_name(connection, clean_group)
                                    if clean_group is not None else None)
                add_ids = _tag_ids(connection, add_tag_ids)
                remove_ids = _tag_ids(connection, remove_tag_ids)
                for chunk in _chunks(connection, normalized, headroom=4):
                    placeholders = ",".join("?" for _ in chunk)
                    rows = connection.execute(
                        f"SELECT id FROM probe_servers WHERE id IN ({placeholders})", chunk
                    ).fetchall()
                    affected += len(rows)
                    existing_ids.update(int(row["id"]) for row in rows)
                    if group_for_update is not None:
                        group_id = _ensure_group_id(connection, group_for_update)
                        connection.execute(
                            "UPDATE probe_servers SET server_group = ?, group_id = ? "
                            f"WHERE id IN ({placeholders})",
                            (group_for_update, group_id, *chunk),
                        )
                    if adds or removes:
                        server_ids = [row["id"] for row in rows]
                        tag_labels: dict[int, list[str]] = {server_id: [] for server_id in server_ids}
                        if server_ids:
                            tag_placeholders = ",".join("?" for _ in server_ids)
                            for tag in connection.execute(
                                "SELECT st.server_id, t.name FROM probe_server_tags st "
                                "JOIN probe_tags t ON t.id = st.tag_id "
                                f"WHERE st.server_id IN ({tag_placeholders}) ORDER BY t.name",
                                server_ids,
                            ):
                                tag_labels[tag["server_id"]].append(tag["name"])
                        entries = []
                        for server_id in server_ids:
                            labels = [label for label in tag_labels[server_id] if label not in removes]
                            entries.append((server_id, _normalize_labels([*labels, *adds])))
                        _sync_server_tags_many(connection, entries)
                    if add_tag_ids or remove_tag_ids:
                        for server_chunk in _chunks(connection, [row["id"] for row in rows], headroom=2):
                            if remove_ids:
                                for tag_chunk in _chunks(connection, remove_ids, headroom=1):
                                    tag_placeholders = ",".join("?" for _ in tag_chunk)
                                    server_placeholders = ",".join("?" for _ in server_chunk)
                                    connection.execute(
                                        "DELETE FROM probe_server_tags "
                                        f"WHERE server_id IN ({server_placeholders}) "
                                        f"AND tag_id IN ({tag_placeholders})",
                                        (*server_chunk, *tag_chunk),
                                    )
                            if add_ids:
                                for tag_chunk in _chunks(connection, add_ids):
                                    connection.executemany(
                                        "INSERT OR IGNORE INTO probe_server_tags(server_id,tag_id) VALUES(?,?)",
                                        [(server_id, tag_id) for server_id in server_chunk for tag_id in tag_chunk],
                                    )
                            _refresh_server_projections(connection, server_chunk)
            return existing_ids if return_ids else affected

        return self._with_connection(write)


    def list_servers_with_status(self) -> list[dict]:
        """服务器清单 + unified current connectivity/speed projection."""

        def read(connection):
            if self.node_id is None:
                self._source_views(connection)
            rows = connection.execute(
                """
                SELECT s.*,
                    c.frps_reachable AS c_frps_reachable,
                    c.tunnel_established AS c_tunnel_established,
                    c.firewall_open AS c_firewall_open,
                    c.detail AS c_detail,
                    c.test_time AS c_test_time,
                    p.dl_ok AS s_dl_ok,
                    p.ul_ok AS s_ul_ok,
                    p.dl_speed_mbps AS s_dl_speed_mbps,
                    p.ul_speed_mbps AS s_ul_speed_mbps,
                    p.test_time AS s_test_time
                FROM probe_servers s
                LEFT JOIN probe_connectivity_results c
                    ON c.server_ip = s.ip AND c.id = (
                        SELECT id FROM probe_connectivity_results
                        WHERE server_ip = s.ip ORDER BY id DESC LIMIT 1
                    )
                LEFT JOIN probe_speed_results p
                    ON p.server_ip = s.ip AND p.id = (
                        SELECT id FROM probe_speed_results
                        WHERE server_ip = s.ip ORDER BY id DESC LIMIT 1
                    )
                ORDER BY s.server_group, s.ip
                """
            ).fetchall()
            return [dict(row) for row in rows]

        return self._with_connection(read)

    def _server_where(self, query: ServerPageQuery) -> tuple[str, list[object]]:
        where: list[str] = []
        params: list[object] = []
        q = query.q.strip()
        if q:
            escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where.append("(s.ip LIKE ? ESCAPE '\\' OR s.server_group LIKE ? ESCAPE '\\' OR s.label LIKE ? ESCAPE '\\')")
            params.extend([f"%{escaped}%"] * 3)
        if query.group is not None:
            where.append("(s.group_id = (SELECT id FROM probe_groups WHERE id = ? OR name = ? LIMIT 1) OR s.server_group = ?)")
            params.extend([query.group, query.group, query.group])
        group_ids = tuple(dict.fromkeys(str(value).strip() for value in query.group_ids if str(value).strip()))
        if group_ids:
            where.append(f"s.group_id IN ({','.join('?' for _ in group_ids)})")
            params.extend(group_ids)
        if query.label is not None:
            if query.label == "":
                where.append("NOT EXISTS (SELECT 1 FROM probe_server_tags st WHERE st.server_id = s.id)")
            else:
                where.append("EXISTS (SELECT 1 FROM probe_server_tags st JOIN probe_tags t ON t.id = st.tag_id WHERE st.server_id = s.id AND t.name = ? COLLATE BINARY)")
                params.append(query.label.strip())
        include_ids = tuple(dict.fromkeys(str(value).strip() for value in query.include_tag_ids if str(value).strip()))
        if query.tag_id is not None and query.tag_id.strip() and query.tag_id.strip() not in include_ids:
            include_ids = (*include_ids, query.tag_id.strip())
        if include_ids:
            placeholders = ",".join("?" for _ in include_ids)
            if query.tag_mode == "all":
                where.append(f"(SELECT COUNT(DISTINCT st.tag_id) FROM probe_server_tags st WHERE st.server_id=s.id AND st.tag_id IN ({placeholders})) = ?")
                params.extend(include_ids)
                params.append(len(include_ids))
            else:
                where.append(f"EXISTS (SELECT 1 FROM probe_server_tags st WHERE st.server_id=s.id AND st.tag_id IN ({placeholders}))")
                params.extend(include_ids)
        exclude_ids = tuple(dict.fromkeys(str(value).strip() for value in query.exclude_tag_ids if str(value).strip()))
        if exclude_ids:
            where.append(f"NOT EXISTS (SELECT 1 FROM probe_server_tags st WHERE st.server_id=s.id AND st.tag_id IN ({','.join('?' for _ in exclude_ids)}))")
            params.extend(exclude_ids)
        if query.conn != "all":
            score = "s.conn_score"
            where.append({"pass": f"{score} = 4", "partial": f"{score} IN (2, 3)",
                          "fail": f"{score} BETWEEN 1 AND 3", "untested": f"{score} = 0"}[query.conn])
        return (" WHERE " + " AND ".join(where) if where else ""), params

    def _server_order_terms(self, query: ServerPageQuery) -> list[tuple[str, str]]:
        direction = query.order.upper()
        if query.sort == "ip":
            return [("(s.ip_sort IS NULL)", "ASC"), ("s.ip_sort", direction), ("s.id", direction)]
        if query.sort == "group":
            return [("s.server_group", direction), ("(s.ip_sort IS NULL)", "ASC"),
                    ("s.ip_sort", direction), ("s.id", direction)]
        if query.sort == "conn":
            return [("s.conn_score", direction), ("s.id", direction)]
        if query.sort == "speed":
            return [("s.speed_sort", direction), ("s.id", direction)]
        return [("(s.time_sort IS NULL)", "ASC"), ("s.time_sort", direction), ("s.id", direction)]

    @staticmethod
    def _server_from_sql(ip_index: str | None = None) -> str:
        indexed = f" INDEXED BY {ip_index}" if ip_index else ""
        return f"""FROM probe_servers s{indexed}
            LEFT JOIN main.probe_current_results c ON c.server_ip=probe_endpoint_host(s.ip)
                AND c.kind='connectivity' AND c.port={PROBE_TEST_PORT}
                AND probe_endpoint_port(s.ip)={PROBE_TEST_PORT}
            LEFT JOIN main.probe_current_results p ON p.server_ip=probe_endpoint_host(s.ip)
                AND p.kind='speed' AND p.port={PROBE_TEST_PORT}
                AND probe_endpoint_port(s.ip)={PROBE_TEST_PORT}"""

    @staticmethod
    def _server_count_from_sql(query: ServerPageQuery) -> str:
        return "FROM probe_servers s"

    @staticmethod
    def _server_select_sql() -> str:
        return """SELECT s.*, c.test_time AS c_test_time,
            CASE WHEN c.server_ip IS NULL THEN NULL ELSE COALESCE(json_extract(c.data,'$.frps_reachable'),0) END AS c_frps_reachable,
            CASE WHEN c.server_ip IS NULL THEN NULL ELSE COALESCE(json_extract(c.data,'$.tunnel_established'),0) END AS c_tunnel_established,
            CASE WHEN c.server_ip IS NULL THEN NULL ELSE COALESCE(json_extract(c.data,'$.firewall_open'),0) END AS c_firewall_open,
            CASE WHEN c.server_ip IS NULL THEN NULL ELSE COALESCE(json_extract(c.data,'$.detail'),'') END AS c_detail,
            CASE WHEN p.server_ip IS NULL THEN NULL ELSE COALESCE(json_extract(p.data,'$.dl_ok'),0) END AS s_dl_ok,
            CASE WHEN p.server_ip IS NULL THEN NULL ELSE COALESCE(json_extract(p.data,'$.ul_ok'),0) END AS s_ul_ok,
            CASE WHEN p.server_ip IS NULL THEN NULL ELSE COALESCE(json_extract(p.data,'$.dl_speed_bps'),0)*8.0/1048576 END AS s_dl_speed_mbps,
            CASE WHEN p.server_ip IS NULL THEN NULL ELSE COALESCE(json_extract(p.data,'$.ul_speed_bps'),0)*8.0/1048576 END AS s_ul_speed_mbps,
            p.test_time AS s_test_time"""

    @staticmethod
    def _cursor_binding(query: ServerPageQuery) -> str:
        clean = lambda values: sorted({str(value).strip() for value in values if str(value).strip()})
        normalized = {"q": query.q.strip(), "group": query.group, "groups": clean(query.group_ids),
                      "label": query.label.strip() if query.label else query.label,
                      "tagId": query.tag_id.strip() if query.tag_id else query.tag_id,
                      "include": clean(query.include_tag_ids), "exclude": clean(query.exclude_tag_ids),
                      "tagMode": query.tag_mode, "conn": query.conn, "sort": query.sort, "order": query.order,
                      "pageSize": query.page_size}
        return hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    @staticmethod
    def _cursor_secret(connection: sqlite3.Connection) -> bytes:
        row = connection.execute("SELECT value FROM probe_settings WHERE key='probe_server_cursor_secret'").fetchone()
        if row is None:
            candidate = secrets.token_urlsafe(48)
            connection.execute(
                "INSERT OR IGNORE INTO probe_settings(key,value) VALUES('probe_server_cursor_secret',?)",
                (candidate,),
            )
            connection.commit()
            row = connection.execute(
                "SELECT value FROM probe_settings WHERE key='probe_server_cursor_secret'"
            ).fetchone()
        if row is None or not row[0]:
            raise RuntimeError("server cursor secret could not be initialized")
        return str(row[0]).encode("utf-8")

    @classmethod
    def _encode_server_cursor(cls, connection: sqlite3.Connection, payload: dict) -> str:
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        signature = hmac.new(cls._cursor_secret(connection), body, hashlib.sha256).hexdigest()
        envelope = json.dumps({"p": payload, "s": signature}, sort_keys=True, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(envelope).decode().rstrip("=")

    @classmethod
    def _decode_server_cursor(cls, connection: sqlite3.Connection, cursor: str, binding: str) -> tuple[int | None, int]:
        try:
            encoded = cursor.encode("ascii")
            envelope = json.loads(base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4)))
            if not isinstance(envelope, dict):
                raise ValueError
            payload = envelope.get("p")
            signature = envelope.get("s")
            if not isinstance(payload, dict) or not isinstance(signature, str):
                raise ValueError
            body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
            expected = hmac.new(cls._cursor_secret(connection), body, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                raise ValueError
            keys = payload.get("k")
            if (payload.get("v") != 1 or payload.get("f") != binding or
                    not isinstance(keys, list) or len(keys) != 2):
                raise ValueError
            ip_sort, server_id = keys
            if ((ip_sort is not None and (isinstance(ip_sort, bool) or not isinstance(ip_sort, int))) or
                    isinstance(server_id, bool) or not isinstance(server_id, int) or server_id < 0):
                raise ValueError
            return ip_sort, server_id
        except (ValueError, TypeError, KeyError, json.JSONDecodeError, UnicodeError) as exc:
            raise ValueError("cursor 无效、已损坏或与当前筛选条件不匹配") from exc

    def count_servers(self, query: ServerPageQuery) -> int:
        def read(connection):
            if self.node_id is None:
                self._source_views(connection)
            where_sql, params = self._server_where(query)
            # Counts only need the connectivity projection when connectivity is filtered.
            sql = f"SELECT COUNT(*) {self._server_count_from_sql(query)}" + where_sql
            return int(connection.execute(sql, params).fetchone()[0])
        return self._with_connection(read)

    def query_servers(self, query: ServerPageQuery) -> dict:
        """Legacy offset page, kept compatible for existing clients."""
        def read(connection):
            if self.node_id is None:
                self._source_views(connection)
            where_sql, params = self._server_where(query)
            terms = self._server_order_terms(query)
            order_sql = ", ".join(f"{expr} {direction}" for expr, direction in terms)
            total_sql = f"SELECT COUNT(*) {self._server_count_from_sql(query)}" + where_sql
            total = int(connection.execute(total_sql, params).fetchone()[0])
            rows = connection.execute(self._server_select_sql() + " " + self._server_from_sql() + where_sql + f" ORDER BY {order_sql} LIMIT ? OFFSET ?",
                (*params, query.page_size, (query.page - 1) * query.page_size)).fetchall()
            return {"items": [dict(row) for row in rows], "page": query.page,
                    "pageSize": query.page_size, "total": total, "sort": query.sort, "order": query.order}
        return self._with_connection(read)

    def query_servers_cursor(self, query: ServerPageQuery, cursor: str | None = None) -> dict:
        """Return the IP-indexed keyset page without a total-count scan."""
        if query.sort != "ip":
            raise ValueError("cursor 分页当前只支持 sort=ip；其他排序请使用 /servers offset API")
        def read(connection):
            if self.node_id is None:
                self._source_views(connection)
            where_sql, params = self._server_where(query)
            binding = self._cursor_binding(query)
            boundary = None
            if cursor:
                boundary = self._decode_server_cursor(connection, cursor, binding)
            direction = query.order.upper()
            ip_direction = "ASC" if direction == "ASC" else "DESC"
            ip_index = "idx_probe_servers_ip_sort_id"
            id_op = ">" if direction == "ASC" else "<"
            range_order_sql = f"s.ip_sort {ip_direction}, s.id {ip_direction}"
            tail_order_sql = f"s.id {ip_direction}"
            batch_limit = query.page_size + 1

            def page_query(condition: str, condition_params: Sequence[object], limit: int, order_sql: str):
                suffix = (" AND " if where_sql else " WHERE ") + condition
                return connection.execute(
                    self._server_select_sql() + " " + self._server_from_sql(ip_index) + where_sql + suffix +
                    f" ORDER BY {order_sql} LIMIT ?",
                    (*params, *condition_params, limit),
                ).fetchall()

            if boundary is not None and boundary[0] is None:
                rows = page_query(f"s.ip_sort IS NULL AND s.id {id_op} ?", (boundary[1],), batch_limit, tail_order_sql)
            else:
                range_condition = "s.ip_sort IS NOT NULL"
                range_params: tuple[object, ...] = ()
                if boundary is not None:
                    range_condition += f" AND (s.ip_sort, s.id) {id_op} (?, ?)"
                    range_params = boundary
                rows = page_query(range_condition, range_params, batch_limit, range_order_sql)
                # NULL IPs are always the final stable range, independent of direction.
                if len(rows) < batch_limit:
                    tail = page_query(
                        "s.ip_sort IS NULL",
                        (),
                        batch_limit - len(rows),
                        tail_order_sql,
                    )
                    rows = [*rows, *tail]

            has_more = len(rows) > query.page_size
            page_rows = rows[:query.page_size]
            items = []
            for row in page_rows:
                items.append(dict(row))
            next_cursor = None
            if has_more and page_rows:
                last = page_rows[-1]
                next_cursor = self._encode_server_cursor(
                    connection, {"v": 1, "f": binding, "k": [last["ip_sort"], last["id"]]}
                )
            return {"items": items, "nextCursor": next_cursor, "hasMore": has_more}
        return self._with_connection(read)

    def server_facets(self, query: ServerPageQuery | None = None, *, tag_search: str = "",
                      tag_page: int | None = None, tag_page_size: int | None = None) -> dict:
        """Return group counts contextualized without group filters and tag counts
        contextualized without tag filters. Tag candidates are searched and paged
        independently; their counts use the full contextual server set.
        """
        tag_search = str(tag_search or "").strip()
        paged = bool(tag_search) or tag_page is not None or tag_page_size is not None
        if paged:
            tag_page = 1 if tag_page is None else int(tag_page)
            tag_page_size = 50 if tag_page_size is None else int(tag_page_size)
            if tag_page < 1:
                raise ValueError("tag_page 必须大于等于 1")
            if tag_page > MAX_TAG_FACET_PAGE:
                raise ValueError(f"tag_page 不能超过 {MAX_TAG_FACET_PAGE}")
            if not 1 <= tag_page_size <= 100:
                raise ValueError("tag_page_size 必须在 1-100")
        escaped_search = tag_search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        search_pattern = f"%{escaped_search}%"
        query = query or ServerPageQuery()
        group_query = replace(query, group=None, group_ids=())
        tag_query = replace(query, label=None, tag_id=None, include_tag_ids=(),
                            exclude_tag_ids=(), tag_mode="any")

        def read(connection):
            connection.create_function(
                "probe_endpoint_host", 1,
                lambda value: split_probe_endpoint(value, PROBE_TEST_PORT)[0],
            )
            connection.create_function(
                "probe_endpoint_port", 1,
                lambda value: split_probe_endpoint(value, PROBE_TEST_PORT)[1],
            )

            group_where, group_params = self._server_where(group_query)
            group_source = self._server_count_from_sql(group_query)
            group_suffix = (" AND " if group_where else " WHERE ") + "s.server_group != ''"
            groups = connection.execute(
                "SELECT s.server_group, COUNT(*) AS count " + group_source + group_where + group_suffix +
                " GROUP BY s.server_group ORDER BY s.server_group",
                group_params,
            ).fetchall()

            tag_where, tag_params = self._server_where(tag_query)
            tag_source = self._server_count_from_sql(tag_query)
            tag_page_limit = " LIMIT ? OFFSET ?" if paged else ""
            tag_page_params = (tag_page_size, (tag_page - 1) * tag_page_size) if paged else ()
            # One aggregate statement yields the bounded, stable candidate page,
            # total candidate count, and legacy name projection.
            tag_rows = connection.execute(
                "WITH facet_servers AS MATERIALIZED (SELECT s.id " + tag_source + tag_where + "), "
                "tag_counts AS ("
                "SELECT t.id AS tag_id,c.id AS category_id,c.name AS category,t.name AS name,"
                "COUNT(*) AS count "
                "FROM facet_servers fs CROSS JOIN probe_server_tags st ON st.server_id=fs.id "
                "JOIN probe_tags t ON t.id=st.tag_id "
                "JOIN probe_tag_categories c ON c.id=t.category_id "
                "WHERE (?='' OR c.name LIKE ? ESCAPE '\\' COLLATE NOCASE "
                "OR t.name LIKE ? ESCAPE '\\' COLLATE NOCASE) "
                "GROUP BY t.id,c.id,c.name,t.name), "
                "tag_page AS (SELECT * FROM tag_counts "
                "ORDER BY category COLLATE BINARY,name COLLATE BINARY,tag_id COLLATE BINARY" + tag_page_limit + "), "
                "tag_total AS (SELECT COUNT(*) AS total FROM tag_counts), "
                "legacy_server_names AS ("
                "SELECT fs.id AS server_id,t.name AS name "
                "FROM facet_servers fs CROSS JOIN probe_server_tags st ON st.server_id=fs.id "
                "JOIN probe_tags t ON t.id=st.tag_id GROUP BY fs.id,t.name), "
                "legacy_labels AS (SELECT name,COUNT(*) AS count FROM legacy_server_names GROUP BY name) "
                "SELECT 'tag' AS facet,p.tag_id,p.category_id,p.category,p.name,p.count,total.total AS tag_total "
                "FROM tag_total total LEFT JOIN tag_page p ON 1=1 "
                "UNION ALL "
                "SELECT 'label' AS facet,NULL AS tag_id,NULL AS category_id,NULL AS category,"
                "labels.name,labels.count,NULL AS tag_total FROM legacy_labels labels "
                "ORDER BY facet,category,name",
                (*tag_params, tag_search, search_pattern, search_pattern, *tag_page_params),
            ).fetchall()
            labels = [{"label": row["name"], "count": row["count"]}
                      for row in tag_rows if row["facet"] == "label"]
            labels.sort(key=lambda row: (-row["count"], row["label"]))
            tag_items = [{"tagId": row["tag_id"], "categoryId": row["category_id"],
                          "category": row["category"], "name": row["name"],
                          "count": row["count"]}
                         for row in tag_rows if row["facet"] == "tag" and row["tag_id"] is not None]
            tag_total = next((int(row["tag_total"]) for row in tag_rows if row["facet"] == "tag"), 0)
            result = {
                "labels": labels,
                "tagItems": tag_items,
                "groups": [{"group": row["server_group"], "count": row["count"]} for row in groups],
            }
            if paged:
                result.update(tagPage=tag_page, tagPageSize=tag_page_size, tagTotal=tag_total)
            return result

        return self._with_connection(read)

    # ---- 测试结果 ----

    def add_connectivity_result(self, result: dict) -> None:
        test_time = now_iso()

        def write(connection):
            connection.execute(
                """
                INSERT INTO probe_connectivity_results
                    (server_ip, frps_reachable, tunnel_established, firewall_open, detail, test_time)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    result["server_ip"],
                    1 if result.get("frps_reachable") else 0,
                    1 if result.get("tunnel_established") else 0,
                    1 if result.get("firewall_open") else 0,
                    str(result.get("detail", "") or "")[:500],
                    test_time,
                ),
            )
            self._snapshot_local_result(connection,"connectivity",result,test_time)
            connection.commit()

        self._with_connection(write)

    def add_speed_result(self, result: dict) -> None:
        test_time = now_iso()

        def write(connection):
            connection.execute(
                """
                INSERT INTO probe_speed_results
                    (server_ip, frps_reachable, tunnel_ok,
                     dl_ok, dl_speed_mbps, dl_speed_mbs, dl_bytes, dl_sec,
                     ul_ok, ul_speed_mbps, ul_speed_mbs, ul_bytes, ul_sec,
                     detail, test_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    result["server_ip"],
                    1 if result.get("frps_reachable") else 0,
                    1 if result.get("tunnel_ok") else 0,
                    1 if result.get("dl_ok") else 0,
                    speed_mbps(result.get("dl_speed_bps", 0.0)),
                    speed_mbs(result.get("dl_speed_bps", 0.0)),
                    int(result.get("dl_bytes", 0)),
                    float(result.get("dl_sec", 0.0)),
                    1 if result.get("ul_ok") else 0,
                    speed_mbps(result.get("ul_speed_bps", 0.0)),
                    speed_mbs(result.get("ul_speed_bps", 0.0)),
                    int(result.get("ul_bytes", 0)),
                    float(result.get("ul_sec", 0.0)),
                    str(result.get("detail", "") or "")[:500],
                    test_time,
                ),
            )
            self._snapshot_local_result(connection,"speed",result,test_time)
            connection.commit()

        self._with_connection(write)

    def _snapshot_local_result(self, connection, kind, result, test_time):
        import json
        from ..settings import settings
        row_id=connection.execute('SELECT last_insert_rowid()').fetchone()[0]
        configured=connection.execute("SELECT value FROM probe_settings WHERE key='frps_port'").fetchone()
        default_port=int(configured[0]) if configured else settings.probe_options().frps_port
        host,port=split_probe_endpoint(result['server_ip'],default_port)
        connection.execute(
            "INSERT OR IGNORE INTO probe_results(task_id,job_id,node_id,kind,server_ip,port,test_time,data) VALUES(?,'','console',?,?,?,?,?)",
            ('legacy-'+kind+'-'+str(row_id),kind,host,port,test_time,json.dumps(result)),
        )

    def list_connectivity_history(self, *, ip: str | None = None, limit: int = 200) -> list[dict]:
        bounded = min(max(limit, 1), 1000)
        if self.node_id is not None:
            from .jobs import ProbeJobStore
            return ProbeJobStore(self.database_path).history(self.node_id, 'connectivity', ip, bounded)

        def read(connection):
            if ip:
                rows = connection.execute(
                    "SELECT * FROM probe_connectivity_results WHERE server_ip = ? ORDER BY id DESC LIMIT ?",
                    (ip, bounded),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM probe_connectivity_results ORDER BY id DESC LIMIT ?",
                    (bounded,),
                ).fetchall()
            return [dict(row) for row in rows]

        return self._with_connection(read)

    def list_speed_history(self, *, ip: str | None = None, limit: int = 200) -> list[dict]:
        bounded = min(max(limit, 1), 1000)
        if self.node_id is not None:
            from .jobs import ProbeJobStore
            return ProbeJobStore(self.database_path).history(self.node_id, 'speed', ip, bounded)

        def read(connection):
            if ip:
                rows = connection.execute(
                    "SELECT * FROM probe_speed_results WHERE server_ip = ? ORDER BY id DESC LIMIT ?",
                    (ip, bounded),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM probe_speed_results ORDER BY id DESC LIMIT ?",
                    (bounded,),
                ).fetchall()
            return [dict(row) for row in rows]

        return self._with_connection(read)

    def clear_history(self, kind: str) -> int:
        if kind not in {"connectivity", "speed"}:
            raise ValueError("kind 必须是 connectivity 或 speed")
        table = "probe_connectivity_results" if kind == "connectivity" else "probe_speed_results"

        def write(connection):
            cursor = connection.execute(f"DELETE FROM {table}")
            connection.commit()
            return cursor.rowcount

        return self._with_connection(write)

    # ---- 面板可调配置（probe_settings 表，key-value） ----

    def get_config_overrides(self) -> dict:
        def read(connection):
            rows = connection.execute("SELECT key, value FROM probe_settings").fetchall()
            return {row["key"]: row["value"] for row in rows if row["key"] in PROBE_CONFIG_FIELDS}

        return self._with_connection(read)

    def update_config_overrides(self, values: dict) -> dict:
        """写入并校验配置覆盖。全部校验通过才落库，返回合法化后的值。"""
        cleaned: dict[str, str] = {}
        errors: list[str] = []
        for key, raw in values.items():
            if key not in PROBE_CONFIG_FIELDS:
                errors.append(f"未知配置项: {key}")
                continue
            validator, label = PROBE_CONFIG_FIELDS[key]
            try:
                cleaned[key] = str(validator(str(raw)))
            except (ValueError, TypeError) as exc:
                errors.append(f"{label}: {exc}")
        if errors:
            raise ValueError("；".join(errors))

        def write(connection):
            for key, value in cleaned.items():
                connection.execute(
                    "INSERT INTO probe_settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (key, value),
                )
            connection.commit()

        self._with_connection(write)
        return cleaned

    # ---- 统计 ----

    def dashboard(self) -> dict:
        def read(connection):
            if self.node_id is None:
                self._source_views(connection)
            servers = connection.execute(
                "SELECT COUNT(*) AS total FROM probe_servers"
            ).fetchone()["total"]
            conn = connection.execute(
                """
                SELECT
                    COUNT(frps_reachable) AS tested,
                    SUM(frps_reachable) AS reachable,
                    SUM(tunnel_established) AS tunnels,
                    SUM(firewall_open) AS firewalls
                FROM (
                    SELECT s.ip,
                        (SELECT frps_reachable FROM probe_connectivity_results
                         WHERE server_ip = s.ip ORDER BY id DESC LIMIT 1) AS frps_reachable,
                        (SELECT tunnel_established FROM probe_connectivity_results
                         WHERE server_ip = s.ip ORDER BY id DESC LIMIT 1) AS tunnel_established,
                        (SELECT firewall_open FROM probe_connectivity_results
                         WHERE server_ip = s.ip ORDER BY id DESC LIMIT 1) AS firewall_open
                    FROM probe_servers s
                ) latest
                """
            ).fetchone()
            speed = connection.execute(
                """
                SELECT
                    COUNT(tested_at) AS tested,
                    AVG(dl_speed_mbps) AS avg_dl,
                    AVG(ul_speed_mbps) AS avg_ul,
                    MAX(dl_speed_mbps) AS max_dl
                FROM (
                    SELECT s.ip,
                        (SELECT test_time FROM probe_speed_results
                         WHERE server_ip = s.ip ORDER BY id DESC LIMIT 1) AS tested_at,
                        (SELECT CASE WHEN dl_ok=1 THEN dl_speed_mbps ELSE NULL END FROM probe_speed_results
                         WHERE server_ip = s.ip ORDER BY id DESC LIMIT 1) AS dl_speed_mbps,
                        (SELECT CASE WHEN ul_ok=1 THEN ul_speed_mbps ELSE NULL END FROM probe_speed_results
                         WHERE server_ip = s.ip ORDER BY id DESC LIMIT 1) AS ul_speed_mbps
                    FROM probe_servers s
                ) latest
                """
            ).fetchone()
            return {
                "servers": servers,
                "connectivity": {
                    "tested": conn["tested"],
                    "reachable": conn["reachable"] or 0,
                    "tunnels": conn["tunnels"] or 0,
                    "firewallOpen": conn["firewalls"] or 0,
                },
                "speed": {
                    "tested": speed["tested"],
                    "avgDownloadMbps": round(speed["avg_dl"], 2) if speed["avg_dl"] is not None else None,
                    "avgUploadMbps": round(speed["avg_ul"], 2) if speed["avg_ul"] is not None else None,
                    "maxDownloadMbps": round(speed["max_dl"], 2) if speed["max_dl"] is not None else None,
                },
            }

        return self._with_connection(read)
