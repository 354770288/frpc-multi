"""穿透测试数据存储：服务器清单 + 连通性/速率结果，落 Console 的 console.db。

表结构见 control/database.py 的 SCHEMA（probe_* 三张表），
访问模式照 AuditStore：每次操作短连接，避免跨线程共享 sqlite 连接。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TypeVar

from ..models import now_iso
from ..control.database import connect_database
from .engine import speed_mbs, speed_mbps

T = TypeVar("T")

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


@dataclass
class ProbeServer:
    id: int
    ip: str
    label: str
    server_group: str
    created_at: str


def _server_from_row(row) -> ProbeServer:
    return ProbeServer(
        id=int(row["id"]),
        ip=row["ip"],
        label=row["label"],
        server_group=row["server_group"],
        created_at=row["created_at"],
    )


class ProbeStore:
    def __init__(self, database_path: Path):
        self.database_path = database_path
        self._with_connection(lambda connection: None)

    def _with_connection(self, callback: Callable, *args) -> T:
        connection = connect_database(self.database_path)
        try:
            return callback(connection, *args)
        finally:
            connection.close()

    # ---- 服务器清单 ----

    def list_servers(self) -> list[ProbeServer]:
        def read(connection):
            rows = connection.execute(
                "SELECT * FROM probe_servers ORDER BY server_group, ip"
            ).fetchall()
            return [_server_from_row(row) for row in rows]

        return self._with_connection(read)

    def create_server(self, *, ip: str, label: str = "", server_group: str = "") -> ProbeServer:
        addr = validate_probe_addr(ip)
        created_at = now_iso()

        def write(connection):
            try:
                cursor = connection.execute(
                    "INSERT INTO probe_servers (ip, label, server_group, created_at) VALUES (?, ?, ?, ?)",
                    (addr, (label or "").strip(), (server_group or "").strip(), created_at),
                )
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
        label: str | None = None,
        server_group: str | None = None,
    ) -> ProbeServer:
        server = self.get_server(server_id)
        new_ip = validate_probe_addr(ip) if ip is not None else server.ip
        new_label = (label or "").strip() if label is not None else server.label
        new_group = (server_group or "").strip() if server_group is not None else server.server_group

        def write(connection):
            connection.execute(
                "UPDATE probe_servers SET ip = ?, label = ?, server_group = ? WHERE id = ?",
                (new_ip, new_label, new_group, server_id),
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

    def import_servers(self, items: list[dict]) -> tuple[int, int]:
        """批量导入 [{ip, label?, group?}]。已存在的 IP 跳过。返回 (新增, 跳过)。"""
        cleaned: list[tuple[str, str, str]] = []
        for item in items:
            addr = validate_probe_addr(str(item.get("ip", "")))
            cleaned.append((
                addr,
                str(item.get("label", "") or "").strip(),
                str(item.get("group", "") or "").strip(),
            ))
        if not cleaned:
            return 0, 0
        created_at = now_iso()

        def write(connection):
            cursor = connection.executemany(
                "INSERT OR IGNORE INTO probe_servers (ip, label, server_group, created_at) VALUES (?, ?, ?, ?)",
                [(ip, label, group, created_at) for ip, label, group in cleaned],
            )
            connection.commit()
            inserted = cursor.rowcount if cursor.rowcount >= 0 else 0
            return inserted

        inserted = self._with_connection(write)
        return inserted, len(cleaned) - inserted

    def list_groups(self) -> list[str]:
        """预创建分组 ∪ 服务器上实际使用的分组。"""

        def read(connection):
            predefined = {
                row[0] for row in connection.execute("SELECT name FROM probe_groups").fetchall()
            }
            in_use = {
                row[0] for row in connection.execute(
                    "SELECT DISTINCT server_group FROM probe_servers WHERE server_group != ''"
                ).fetchall()
            }
            return sorted(predefined | in_use)

        return self._with_connection(read)

    def create_group(self, name: str) -> str:
        value = (name or "").strip()
        if not value:
            raise ValueError("分组名不能为空")
        if len(value) > 64:
            raise ValueError("分组名过长（最多 64 字符）")

        def write(connection):
            connection.execute(
                "INSERT OR IGNORE INTO probe_groups (name, created_at) VALUES (?, ?)",
                (value, now_iso()),
            )
            connection.commit()

        self._with_connection(write)
        return value

    def delete_group(self, name: str) -> bool:
        """删除预创建分组记录；服务器行上的分组值不受影响。"""

        def write(connection):
            cursor = connection.execute("DELETE FROM probe_groups WHERE name = ?", (name,))
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
            exists = connection.execute(
                "SELECT 1 FROM probe_groups WHERE name = ?", (new_value,)
            ).fetchone()
            if exists:
                raise ValueError(f"分组「{new_value}」已存在")
            connection.execute("UPDATE probe_groups SET name = ? WHERE name = ?",
                               (new_value, old_value))
            connection.execute("UPDATE probe_servers SET server_group = ? WHERE server_group = ?",
                               (new_value, old_value))
            connection.execute("UPDATE probe_discover_results SET server_group = ? WHERE server_group = ?",
                               (new_value, old_value))
            connection.execute("UPDATE lb_domains SET group_name = ? WHERE group_name = ?",
                               (new_value, old_value))
            connection.commit()

        self._with_connection(write)
        return new_value

    def list_labels(self) -> list[dict]:
        """服务器 + 网段发现结果的 distinct 标签及计数（标签云数据源）。"""

        def read(connection):
            rows = connection.execute(
                """
                SELECT label, COUNT(*) AS count FROM (
                    SELECT label FROM probe_servers WHERE label != ''
                    UNION ALL
                    SELECT label FROM probe_discover_results WHERE label != ''
                ) GROUP BY label ORDER BY count DESC, label
                """
            ).fetchall()
            return [{"label": row[0], "count": row[1]} for row in rows]

        return self._with_connection(read)

    # ---- 网段发现结果 ----

    def upsert_discover_result(self, ip: str, port: int, latency_ms: float,
                               frps_version: str = "") -> None:
        """扫描命中入库：重复命中只更新延迟/版本与时间，保留已改的分组/标签。"""

        def write(connection):
            connection.execute(
                "INSERT INTO probe_discover_results (ip, port, latency_ms, frps_version, discovered_at) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(ip, port) DO UPDATE SET latency_ms = excluded.latency_ms, "
                "frps_version = excluded.frps_version, discovered_at = excluded.discovered_at",
                (ip, port, latency_ms, frps_version, now_iso()),
            )
            connection.commit()

        self._with_connection(write)

    def list_discover_results(self) -> list[dict]:
        """发现结果 + 是否已在服务器库（按 ip 关联）。"""

        def read(connection):
            rows = connection.execute(
                """
                SELECT d.id, d.ip, d.port, d.latency_ms, d.frps_version, d.server_group, d.label,
                       d.discovered_at, (s.id IS NOT NULL) AS in_library
                FROM probe_discover_results d
                LEFT JOIN probe_servers s ON s.ip = d.ip
                ORDER BY d.discovered_at DESC, d.ip
                """
            ).fetchall()
            return [dict(row) for row in rows]

        return self._with_connection(read)

    def update_discover_batch(self, ids: list[int], *, group: str | None, label: str | None) -> int:
        """批量覆盖发现结果的分组/标签，返回更新行数。"""
        if group is None and label is None:
            raise ValueError("至少提供分组或标签之一")
        clean_group = (group or "").strip() if group is not None else None
        if group is not None and not clean_group:
            raise ValueError("分组不能为空")
        clean_label = (label or "").strip() if label is not None else None

        def write(connection):
            cursor = connection.execute(
                "UPDATE probe_discover_results SET server_group = COALESCE(?, server_group), "
                "label = COALESCE(?, label) WHERE id IN (%s)" % ",".join("?" * len(ids)),
                (clean_group, clean_label, *ids),
            )
            connection.commit()
            return cursor.rowcount

        return self._with_connection(write)

    def delete_discover_results(self, ids: list[int] | None = None) -> int:
        """删除勾选的发现结果；ids 为空表示清空全部。"""

        def write(connection):
            if ids:
                cursor = connection.execute(
                    "DELETE FROM probe_discover_results WHERE id IN (%s)"
                    % ",".join("?" * len(ids)),
                    ids,
                )
            else:
                cursor = connection.execute("DELETE FROM probe_discover_results")
            connection.commit()
            return cursor.rowcount

        return self._with_connection(write)

    def update_servers_batch(self, ids: list[int], *, group: str | None, label: str | None) -> int:
        """批量覆盖服务器的分组/标签，返回更新行数。"""
        if group is None and label is None:
            raise ValueError("至少提供分组或标签之一")
        clean_group = (group or "").strip() if group is not None else None
        if group is not None and not clean_group:
            raise ValueError("分组不能为空")
        clean_label = (label or "").strip() if label is not None else None

        def write(connection):
            cursor = connection.execute(
                "UPDATE probe_servers SET server_group = COALESCE(?, server_group), "
                "label = COALESCE(?, label) WHERE id IN (%s)" % ",".join("?" * len(ids)),
                (clean_group, clean_label, *ids),
            )
            connection.commit()
            return cursor.rowcount

        return self._with_connection(write)

    def list_servers_with_status(self) -> list[dict]:
        """服务器清单 + 每 IP 最新的连通性/速率结果（相关子查询取最新一条）。"""

        def read(connection):
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
                    ON c.id = (
                        SELECT id FROM probe_connectivity_results
                        WHERE server_ip = s.ip ORDER BY id DESC LIMIT 1
                    )
                LEFT JOIN probe_speed_results p
                    ON p.id = (
                        SELECT id FROM probe_speed_results
                        WHERE server_ip = s.ip ORDER BY id DESC LIMIT 1
                    )
                ORDER BY s.server_group, s.ip
                """
            ).fetchall()
            return [dict(row) for row in rows]

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
            connection.commit()

        self._with_connection(write)

    def list_connectivity_history(self, *, ip: str | None = None, limit: int = 200) -> list[dict]:
        bounded = min(max(limit, 1), 1000)

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
            return {row["key"]: row["value"] for row in rows}

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
                        (SELECT dl_speed_mbps FROM probe_speed_results
                         WHERE server_ip = s.ip AND dl_ok = 1 ORDER BY id DESC LIMIT 1) AS dl_speed_mbps,
                        (SELECT ul_speed_mbps FROM probe_speed_results
                         WHERE server_ip = s.ip AND ul_ok = 1 ORDER BY id DESC LIMIT 1) AS ul_speed_mbps
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
