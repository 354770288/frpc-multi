"""/api/probe/*：frps 穿透测试（服务器库 / 测试任务 / 历史 / 统计）。

测试在 Console 进程内执行（runner 后台线程），不经 Agent。
变更类操作照 control.router 的惯例写审计日志（probe_* 动作前缀）。
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..auth import require_auth
from ..settings import settings
from .engine import ProbeOptions
from .runner import MODES, ProbeRunner
from .store import ProbeStore, validate_probe_addr

router = APIRouter(prefix="/api/probe", dependencies=[Depends(require_auth)])


def probe_store() -> ProbeStore:
    return ProbeStore(settings.database_path)


def audit(username: str, action: str, *, success: bool = True, message: str = "") -> None:
    from ..control.audit_store import AuditStore

    AuditStore(settings.database_path).create_log(
        username=username, action=action, success=success, message=message,
    )


# 模块级单例：与进程同生命周期；store 每次 start 时重建（跟随 DATABASE_PATH）
runner = ProbeRunner(probe_store)

# 面板可调配置：snake（存储/引擎）↔ camel（API/前端）
_CAMEL_KEYS = {
    "frpsPort": "frps_port",
    "basePort": "base_port",
    "tcpingTimeout": "tcping_timeout",
    "tcpingRetries": "tcping_retries",
    "tunnelWait": "tunnel_wait",
    "speedDuration": "speed_duration",
    "connConcurrency": "conn_concurrency",
    "speedConcurrency": "speed_concurrency",
}


_FLOAT_CONFIG_KEYS = {"tcping_timeout", "tunnel_wait", "speed_duration"}


def _effective_options() -> ProbeOptions:
    """环境变量默认值 ← 面板保存的覆盖值。"""
    options = settings.probe_options()
    overrides = probe_store().get_config_overrides()
    if not overrides:
        return options
    valid_keys = set(_CAMEL_KEYS.values())
    changes: dict = {}
    for key, value in overrides.items():
        if key not in valid_keys:
            continue
        typed = float(value) if key in _FLOAT_CONFIG_KEYS else int(value)
        if key == "base_port":
            # 本地与远端端口组同源（连通性=x，下载=x+1，上传=x+2）
            changes["local_base_port"] = typed
            changes["remote_base_port"] = typed
        else:
            changes[key] = typed
    return replace(options, **changes)


# ---------------------------------------------------------------------------
# 测试配置（面板可调，免改环境变量重启）
# ---------------------------------------------------------------------------
@router.get("/config")
def get_probe_config():
    options = _effective_options()
    has_override = bool(probe_store().get_config_overrides())
    return {
        "frpsPort": options.frps_port,
        "basePort": options.local_base_port,
        "tcpingTimeout": options.tcping_timeout,
        "tcpingRetries": options.tcping_retries,
        "tunnelWait": options.tunnel_wait,
        "speedDuration": options.speed_duration,
        "connConcurrency": options.conn_concurrency,
        "speedConcurrency": options.speed_concurrency,
        "hasOverride": has_override,
        "running": runner.status()["running"],
    }


class ConfigUpdate(BaseModel):
    values: dict[str, str | int | float]


@router.post("/config")
def update_probe_config(payload: ConfigUpdate, user: Annotated[str, Depends(require_auth)]):
    if runner.status()["running"]:
        raise HTTPException(status_code=409, detail="测试进行中，请先停止再修改配置")
    snake_values = {}
    for camel, value in payload.values.items():
        if camel not in _CAMEL_KEYS:
            raise HTTPException(status_code=400, detail=f"未知配置项: {camel}")
        snake_values[_CAMEL_KEYS[camel]] = value
    store = probe_store()
    try:
        saved = store.update_config_overrides(snake_values)
    except ValueError as exc:
        audit(user, "probe_update_config", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    summary = ", ".join(f"{key}={value}" for key, value in sorted(saved.items()))
    audit(user, "probe_update_config", message=summary)
    return get_probe_config()


# ---------------------------------------------------------------------------
# 序列化（snake_case → camelCase，与前端 lib/types.ts 约定一致）
# ---------------------------------------------------------------------------
def _public_server(row: dict) -> dict:
    has_conn = row["c_test_time"] is not None
    has_speed = row["s_test_time"] is not None
    return {
        "id": row["id"],
        "ip": row["ip"],
        "label": row["label"],
        "group": row["server_group"],
        "createdAt": row["created_at"],
        "latestConnectivity": {
            "frpsReachable": bool(row["c_frps_reachable"]),
            "tunnelEstablished": bool(row["c_tunnel_established"]),
            "firewallOpen": bool(row["c_firewall_open"]),
            "detail": row["c_detail"],
            "testTime": row["c_test_time"],
        } if has_conn else None,
        "latestSpeed": {
            "downloadOk": bool(row["s_dl_ok"]),
            "uploadOk": bool(row["s_ul_ok"]),
            "downloadMbps": row["s_dl_speed_mbps"],
            "uploadMbps": row["s_ul_speed_mbps"],
            "testTime": row["s_test_time"],
        } if has_speed else None,
    }


def _public_conn(row: dict) -> dict:
    return {
        "id": row["id"],
        "serverIp": row["server_ip"],
        "frpsReachable": bool(row["frps_reachable"]),
        "tunnelEstablished": bool(row["tunnel_established"]),
        "firewallOpen": bool(row["firewall_open"]),
        "detail": row["detail"],
        "testTime": row["test_time"],
    }


def _public_speed(row: dict) -> dict:
    return {
        "id": row["id"],
        "serverIp": row["server_ip"],
        "frpsReachable": bool(row["frps_reachable"]),
        "tunnelOk": bool(row["tunnel_ok"]),
        "downloadOk": bool(row["dl_ok"]),
        "downloadMbps": row["dl_speed_mbps"],
        "downloadMbs": row["dl_speed_mbs"],
        "downloadBytes": row["dl_bytes"],
        "downloadSeconds": row["dl_sec"],
        "uploadOk": bool(row["ul_ok"]),
        "uploadMbps": row["ul_speed_mbps"],
        "uploadMbs": row["ul_speed_mbs"],
        "uploadBytes": row["ul_bytes"],
        "uploadSeconds": row["ul_sec"],
        "detail": row["detail"],
        "testTime": row["test_time"],
    }


# ---------------------------------------------------------------------------
# 服务器库
# ---------------------------------------------------------------------------
class ServerCreate(BaseModel):
    ip: str
    label: str = ""
    group: str = ""


class ServerPatch(BaseModel):
    ip: str | None = None
    label: str | None = None
    group: str | None = None


class ServerBatchImport(BaseModel):
    text: str
    group: str = ""


def _json_entry_to_item(entry: object, default_group: str = "") -> dict | None:
    """JSON 对象/字符串 → 导入条目；不合法返回 None。"""
    if isinstance(entry, str):
        return {"ip": entry, "label": "", "group": default_group}
    if isinstance(entry, dict):
        return {
            "ip": str(entry.get("ip", "")),
            "label": str(entry.get("label", "") or ""),
            "group": str(entry.get("group", "") or "") or default_group,
        }
    return None


def parse_batch_text(text: str, default_group: str = "") -> list[dict]:
    """解析批量导入文本：每行「IP」或「IP 标签」；行内或整体为 JSON 时走 JSON 解析。"""
    stripped = (text or "").lstrip()
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            data = None
        if data is not None:
            if isinstance(data, dict):
                data = data.get("servers", [])
            if isinstance(data, list):
                items = [item for item in (_json_entry_to_item(entry, default_group) for entry in data) if item]
                if items:
                    return items
            # JSON 解析结果为空/结构不符时落到逐行，继续报出具体哪行非法
    items: list[dict] = []
    for line in text.splitlines():
        parts = line.replace(",", " ").replace(";", " ").split()
        if not parts:
            continue
        if parts[0].startswith("{"):
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                entry = None
            if entry is not None:
                item = _json_entry_to_item(entry, default_group)
                if item is not None:
                    items.append(item)
                    continue
        items.append({"ip": parts[0], "label": parts[1] if len(parts) > 1 else "", "group": default_group})
    return items


@router.get("/servers")
def list_servers():
    return [_public_server(row) for row in probe_store().list_servers_with_status()]


@router.get("/servers/groups")
def list_server_groups():
    return probe_store().list_groups()


@router.get("/servers/labels")
def list_server_labels():
    """标签云数据源：服务器 + 网段发现结果的 distinct 标签及计数。"""
    return probe_store().list_labels()


class GroupCreate(BaseModel):
    name: str


@router.post("/servers/groups")
def create_server_group(payload: GroupCreate, user: Annotated[str, Depends(require_auth)]):
    try:
        name = probe_store().create_group(payload.name)
    except ValueError as exc:
        audit(user, "probe_create_group", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(user, "probe_create_group", message=name)
    return {"ok": True, "name": name}


@router.delete("/servers/groups/{name}")
def delete_server_group(name: str, user: Annotated[str, Depends(require_auth)]):
    deleted = probe_store().delete_group(name)
    audit(user, "probe_delete_group", success=deleted, message=name if deleted else f"预创建分组不存在: {name}")
    return {"ok": deleted}


class ServerBatchUpdate(BaseModel):
    ids: list[int]
    group: str | None = None
    label: str | None = None


@router.post("/servers/batch-update")
def batch_update_servers(payload: ServerBatchUpdate, user: Annotated[str, Depends(require_auth)]):
    if not payload.ids:
        raise HTTPException(status_code=400, detail="没有选择服务器")
    store = probe_store()
    try:
        updated = store.update_servers_batch(payload.ids, group=payload.group, label=payload.label)
    except ValueError as exc:
        audit(user, "probe_batch_update_servers", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    changes = []
    if payload.group is not None:
        changes.append(f"分组 → {payload.group.strip()}")
    if payload.label is not None:
        changes.append(f"标签 → {payload.label.strip() or '(空)'}")
    audit(user, "probe_batch_update_servers", message=f"{updated} 台：{'，'.join(changes)}")
    return {"updated": updated}


@router.post("/servers")
def create_server(payload: ServerCreate, user: Annotated[str, Depends(require_auth)]):
    store = probe_store()
    try:
        server = store.create_server(ip=payload.ip, label=payload.label, server_group=payload.group)
    except ValueError as exc:
        audit(user, "probe_create_server", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(user, "probe_create_server", message=f"{server.ip} {server.label}".strip())
    return {"id": server.id, "ip": server.ip, "label": server.label, "group": server.server_group}


@router.patch("/servers/{server_id}")
def update_server(server_id: int, payload: ServerPatch, user: Annotated[str, Depends(require_auth)]):
    store = probe_store()
    try:
        server = store.update_server(
            server_id,
            ip=payload.ip, label=payload.label, server_group=payload.group,
        )
    except ValueError as exc:
        audit(user, "probe_update_server", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    audit(user, "probe_update_server", message=f"{server.ip} {server.label}".strip())
    return {"id": server.id, "ip": server.ip, "label": server.label, "group": server.server_group}


@router.delete("/servers/{server_id}")
def delete_server(server_id: int, user: Annotated[str, Depends(require_auth)]):
    store = probe_store()
    try:
        server = store.get_server(server_id)
        store.delete_server(server_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    audit(user, "probe_delete_server", message=server.ip)
    return {"ok": True}


@router.post("/servers/batch")
def batch_import(payload: ServerBatchImport, user: Annotated[str, Depends(require_auth)]):
    try:
        items = parse_batch_text(payload.text, payload.group)
        items = [item for item in items if str(item.get("ip", "")).strip()]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not items:
        raise HTTPException(status_code=400, detail="没有可导入的服务器")
    store = probe_store()
    try:
        inserted, skipped = store.import_servers(items)
    except ValueError as exc:
        audit(user, "probe_import_servers", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(user, "probe_import_servers", message=f"新增 {inserted} 台，跳过已存在 {skipped} 台")
    return {"inserted": inserted, "skipped": skipped}


# ---------------------------------------------------------------------------
# 测试任务
# ---------------------------------------------------------------------------
class TestStart(BaseModel):
    mode: str = "connectivity"
    ips: list[str] | None = None
    group: str | None = None


@router.post("/test")
def start_test(payload: TestStart, user: Annotated[str, Depends(require_auth)]):
    if payload.mode not in MODES:
        raise HTTPException(status_code=400, detail=f"mode 必须是 {'/'.join(sorted(MODES))}")
    if not Path(settings.probe_frpc_bin).exists():
        raise HTTPException(
            status_code=400,
            detail=(
                f"未找到 frpc 二进制: {settings.probe_frpc_bin}。"
                "容器部署内置 frpc；本地开发请设置 PROBE_FRPC_BIN 指向本机 frpc。"
            ),
        )
    store = probe_store()
    if payload.ips:
        try:
            ips = [validate_probe_addr(ip) for ip in payload.ips]
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        servers = store.list_servers()
        if payload.group:
            ips = [s.ip for s in servers if s.server_group == payload.group]
        else:
            ips = [s.ip for s in servers]
    if not ips:
        raise HTTPException(status_code=400, detail="没有可测试的服务器")
    ok, err = runner.start(payload.mode, ips, _effective_options())
    if not ok:
        raise HTTPException(status_code=409, detail=err)
    audit(user, "probe_start_test", message=f"{payload.mode} × {len(ips)}")
    return {"ok": True, "mode": payload.mode, "count": len(ips)}


@router.get("/test/status")
def test_status():
    return runner.status()


@router.post("/test/skip")
def test_skip():
    return {"ok": runner.skip_current()}


@router.post("/test/stop")
def test_stop(user: Annotated[str, Depends(require_auth)]):
    stopped = runner.stop()
    if stopped:
        audit(user, "probe_stop_test")
    return {"ok": stopped}


# ---------------------------------------------------------------------------
# 历史
# ---------------------------------------------------------------------------
@router.get("/history/{kind}")
def list_history(
    kind: str,
    ip: str | None = None,
    limit: int = Query(default=200, ge=1, le=1000),
):
    store = probe_store()
    if kind == "connectivity":
        return [_public_conn(row) for row in store.list_connectivity_history(ip=ip, limit=limit)]
    if kind == "speed":
        return [_public_speed(row) for row in store.list_speed_history(ip=ip, limit=limit)]
    raise HTTPException(status_code=404, detail="history 类型必须是 connectivity 或 speed")


@router.delete("/history/{kind}")
def clear_history(kind: str, user: Annotated[str, Depends(require_auth)]):
    if kind not in {"connectivity", "speed"}:
        raise HTTPException(status_code=404, detail="history 类型必须是 connectivity 或 speed")
    deleted = probe_store().clear_history(kind)
    audit(user, "probe_clear_history", message=f"{kind} × {deleted}")
    return {"deleted": deleted}


# ---------------------------------------------------------------------------
# 统计
# ---------------------------------------------------------------------------
@router.get("/dashboard")
def dashboard():
    return probe_store().dashboard()


# ---------------------------------------------------------------------------
# 网段发现（整合自 portpilot）：扫描自有网段内开放 frps 端口的设备
# ---------------------------------------------------------------------------
class DiscoverStart(BaseModel):
    targets: str
    exclude: str = ""
    port: int | None = None
    concurrency: int = 500
    timeout: float = 1.5


class DiscoverImport(BaseModel):
    ids: list[int]
    group: str = ""


class DiscoverBatchUpdate(BaseModel):
    ids: list[int]
    group: str | None = None
    label: str | None = None


class DiscoverDelete(BaseModel):
    ids: list[int] | None = None


class GroupRename(BaseModel):
    old: str
    new: str


@router.post("/discover/start")
def discover_start(payload: DiscoverStart, user: Annotated[str, Depends(require_auth)]):
    from .discover import (
        MAX_CONCURRENCY, MAX_TIMEOUT, MIN_CONCURRENCY, MIN_TIMEOUT, DiscoverParams, discover_runner,
    )

    if not payload.targets.strip():
        raise HTTPException(status_code=400, detail="至少填写一个目标网段")
    if not MIN_CONCURRENCY <= payload.concurrency <= MAX_CONCURRENCY:
        raise HTTPException(status_code=400, detail=f"并发需在 {MIN_CONCURRENCY}-{MAX_CONCURRENCY}")
    if not MIN_TIMEOUT <= payload.timeout <= MAX_TIMEOUT:
        raise HTTPException(status_code=400, detail=f"超时需在 {MIN_TIMEOUT}-{MAX_TIMEOUT} 秒")
    port = payload.port or _effective_options().frps_port
    if not 1 <= port <= 65535:
        raise HTTPException(status_code=400, detail="端口必须在 1-65535")
    params = DiscoverParams(
        targets=[part.strip() for part in payload.targets.replace("\n", ",").split(",") if part.strip()],
        exclude=[part.strip() for part in payload.exclude.replace("\n", ",").split(",") if part.strip()],
        port=port,
        concurrency=payload.concurrency,
        timeout=payload.timeout,
    )
    store = probe_store()

    def persist_hit(ip: str, hit_port: int, latency_ms: float) -> None:
        store.upsert_discover_result(ip, hit_port, latency_ms)

    try:
        discover_runner.start(params, on_hit=persist_hit)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        audit(user, "probe_discover_start", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(user, "probe_discover_start",
          message=f"目标 {payload.targets.strip()[:120]} 端口 {port} 并发 {payload.concurrency}")
    return discover_runner.status()


@router.get("/discover/status")
def discover_status():
    from .discover import discover_runner
    return discover_runner.status()


@router.post("/discover/stop")
def discover_stop(user: Annotated[str, Depends(require_auth)]):
    from .discover import discover_runner
    stopped = discover_runner.stop()
    audit(user, "probe_discover_stop", success=stopped,
          message="已下发停止" if stopped else "当前没有运行中的扫描")
    return {"stopped": stopped}


@router.get("/discover/results")
def discover_results():
    store = probe_store()
    items = [{
        "id": row["id"],
        "ip": row["ip"],
        "port": row["port"],
        "latencyMs": round(row["latency_ms"], 1),
        "group": row["server_group"],
        "label": row["label"],
        "inLibrary": bool(row["in_library"]),
        "discoveredAt": row["discovered_at"],
    } for row in store.list_discover_results()]
    return {"items": items, "labels": store.list_labels()}


@router.patch("/discover/results/batch")
def discover_results_batch(payload: DiscoverBatchUpdate, user: Annotated[str, Depends(require_auth)]):
    if not payload.ids:
        raise HTTPException(status_code=400, detail="请勾选要修改的记录")
    try:
        updated = probe_store().update_discover_batch(
            payload.ids, group=payload.group, label=payload.label)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    change = "分组" if payload.group is not None else "标签"
    audit(user, "probe_update_discover", message=f"{change} × {updated}")
    return {"updated": updated}


@router.delete("/discover/results")
def discover_results_delete(payload: DiscoverDelete, user: Annotated[str, Depends(require_auth)]):
    deleted = probe_store().delete_discover_results(payload.ids)
    audit(user, "probe_delete_discover",
          message=f"删除 {deleted} 条" + ("" if payload.ids else "（清空）"))
    return {"deleted": deleted}


@router.post("/discover/import")
def discover_import(payload: DiscoverImport, user: Annotated[str, Depends(require_auth)]):
    if not payload.ids:
        raise HTTPException(status_code=400, detail="请勾选要导入的记录")
    store = probe_store()
    rows = {row["id"]: row for row in store.list_discover_results()}
    group = payload.group.strip()
    items = []
    for row_id in payload.ids:
        row = rows.get(row_id)
        if row is None:
            continue
        items.append({"ip": row["ip"], "group": group or row["server_group"], "label": row["label"]})
    if not items:
        raise HTTPException(status_code=400, detail="所选记录不存在")
    inserted, skipped = store.import_servers(items)
    audit(user, "probe_discover_import",
          message=f"新增 {inserted} 台（跳过已在库 {skipped}）")
    return {"inserted": inserted, "skipped": skipped}


@router.patch("/servers/groups/rename")
def rename_group(payload: GroupRename, user: Annotated[str, Depends(require_auth)]):
    try:
        new_name = probe_store().rename_group(payload.old, payload.new)
    except ValueError as exc:
        audit(user, "probe_rename_group", success=False,
              message=f"{payload.old} → {payload.new}: {exc}")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(user, "probe_rename_group", message=f"{payload.old} → {new_name}（服务器/发现结果/负载均衡绑定已同步）")
    return {"renamed": new_name}
