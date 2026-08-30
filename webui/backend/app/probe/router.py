"""/api/probe/*：frps 穿透测试（服务器库 / 测试任务 / 历史 / 统计）。

测试在 Console 进程内执行（runner 后台线程），不经 Agent。
变更类操作照 control.router 的惯例写审计日志（probe_* 动作前缀）。
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel

from ..auth import require_auth
from ..settings import settings
from .discover import discover_runner
from .engine import ProbeOptions
from .persistence import DiscoverPersistenceError, DiscoverScanCoordinator
from .route import load_route_nodes, route_hub, save_route_nodes
from .runner import MODES, ProbeRunner
from .store import DiscoverPageQuery, ProbeStore, ServerPageQuery, validate_probe_addr

router = APIRouter(prefix="/api/probe", dependencies=[Depends(require_auth)])

# 路由测试节点专用（Token 鉴权，不走面板登录）：claim / report
node_router = APIRouter(prefix="/api/probe/route")


def probe_store() -> ProbeStore:
    return ProbeStore(settings.database_path)


def audit(username: str, action: str, *, success: bool = True, message: str = "") -> None:
    from ..control.audit_store import AuditStore

    AuditStore(settings.database_path).create_log(
        username=username, action=action, success=success, message=message,
    )


# 模块级单例：与进程同生命周期；store 每次 start 时重建（跟随 DATABASE_PATH）
runner = ProbeRunner(probe_store)


def _enqueue_discovered_route(ip: str) -> bool:
    return route_hub.enqueue(ip)


discover_scans = DiscoverScanCoordinator(discover_runner, probe_store, _enqueue_discovered_route)

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
def list_servers(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, alias="pageSize", ge=1, le=200),
    q: str = "",
    group: str | None = None,
    label: str | None = None,
    conn: Literal["all", "pass", "partial", "fail", "untested"] = "all",
    sort: Literal["ip", "group", "conn", "speed", "time"] = "group",
    order: Literal["asc", "desc"] = "asc",
):
    result = probe_store().query_servers(ServerPageQuery(
        page=page, page_size=page_size, q=q, group=group, label=label,
        conn=conn, sort=sort, order=order,
    ))
    return {
        "items": [_public_server(row) for row in result["items"]],
        "page": result["page"], "pageSize": result["pageSize"],
        "total": result["total"], "sort": result["sort"], "order": result["order"],
    }


@router.get("/servers/facets")
def server_facets():
    return probe_store().server_facets()


@router.get("/servers/groups")
def list_server_groups():
    return probe_store().list_groups_with_colors()


class GroupCreate(BaseModel):
    name: str
    color: str = ""


@router.post("/servers/groups")
def create_server_group(payload: GroupCreate, user: Annotated[str, Depends(require_auth)]):
    try:
        name = probe_store().create_group(payload.name, payload.color)
    except ValueError as exc:
        audit(user, "probe_create_group", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(user, "probe_create_group", message=name)
    return {"ok": True, "name": name}


class GroupColor(BaseModel):
    name: str
    color: str


@router.patch("/servers/groups/color")
def set_server_group_color(payload: GroupColor, user: Annotated[str, Depends(require_auth)]):
    try:
        color = probe_store().set_group_color(payload.name, payload.color)
    except ValueError as exc:
        audit(user, "probe_set_group_color", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(user, "probe_set_group_color", message=f"{payload.name} → {color or '无色'}")
    return {"ok": True, "color": color}


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
    autoRoute: bool = False


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
    try:
        discover_scans.start(params, auto_route=payload.autoRoute)
    except DiscoverPersistenceError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        audit(user, "probe_discover_start", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(user, "probe_discover_start",
          message=f"目标 {payload.targets.strip()[:120]} 端口 {port} 并发 {payload.concurrency}"
                  + (" · 自动路由追踪" if payload.autoRoute else ""))
    return discover_scans.status()


@router.get("/discover/status")
def discover_status():
    return discover_scans.status()


@router.post("/discover/stop")
def discover_stop(user: Annotated[str, Depends(require_auth)]):
    stopped = discover_scans.stop()
    audit(user, "probe_discover_stop", success=stopped,
          message="已下发停止" if stopped else "当前没有运行中的扫描")
    return {"stopped": stopped}


@router.get("/discover/results")
def discover_results(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, alias="pageSize", ge=1, le=200),
    q: str = "",
    group: str | None = None,
    label: str | None = None,
    library: Literal["all", "imported", "new"] = "all",
    sort: Literal["discoveredAt", "ip", "latency"] = "discoveredAt",
    order: Literal["asc", "desc"] = "desc",
):
    store_sort = "time" if sort == "discoveredAt" else sort
    result = probe_store().query_discover_results(DiscoverPageQuery(
        page=page, page_size=page_size, q=q, group=group, label=label,
        library=library, sort=store_sort, order=order,
    ))
    items = [{
        "id": row["id"],
        "ip": row["ip"],
        "port": row["port"],
        "latencyMs": round(row["latency_ms"], 1),
        "group": row["server_group"],
        "label": row["label"],
        "inLibrary": bool(row["in_library"]),
        "discoveredAt": row["discovered_at"],
    } for row in result["items"]]
    return {
        "items": items, "page": result["page"], "pageSize": result["pageSize"],
        "total": result["total"], "sort": sort, "order": result["order"],
    }


@router.get("/discover/facets")
def discover_facets():
    return probe_store().discover_facets()


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
    selected_count, inserted, skipped = probe_store().import_discover_results(
        payload.ids, group=payload.group
    )
    if selected_count == 0:
        raise HTTPException(status_code=400, detail="所选记录不存在")
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


# ---------------------------------------------------------------------------
# CN2 路由追踪（节点轮询模型：claim / report + 面板管理）
# ---------------------------------------------------------------------------
class RouteReport(BaseModel):
    taskId: int
    ok: bool = True
    isCn2: bool = False
    error: str = ""


class RouteStart(BaseModel):
    ids: list[int]


class RouteNodeCreate(BaseModel):
    name: str


def _route_node_by_token(token: str) -> dict | None:
    import hmac as _hmac

    for node in load_route_nodes(probe_store()):
        if node.get("token") and _hmac.compare_digest(node["token"], token):
            return node
    return None


def _mask_route_token(token: str) -> str:
    if len(token) <= 8:
        return "*" * len(token)
    return f"{token[:4]}…{token[-4:]}"


def _require_route_node(x_route_token: str) -> dict:
    node = _route_node_by_token(x_route_token or "")
    if node is None:
        raise HTTPException(status_code=401, detail="路由节点 Token 无效")
    from .route import route_hub
    route_hub.touch(node["name"])
    return node


@node_router.post("/claim")
def route_claim(x_route_token: str = Header(default="")):
    """测试节点轮询领任务（原子领取；掉线超时任务已自动回收重派）。"""
    node = _require_route_node(x_route_token)
    task = route_hub.claim(node["name"])
    if task is None:
        return {"task": None}
    return {"task": task}


@node_router.post("/report")
def route_report(payload: RouteReport, x_route_token: str = Header(default="")):
    """测试节点回报结果 → 写入发现行保留标签（CN2/非CN2/未路由测试）。"""
    from .route import route_label, route_hub

    node = _require_route_node(x_route_token)
    task = route_hub.report(payload.taskId, ok=payload.ok, is_cn2=payload.isCn2)
    if task is None:
        return {"ok": True, "applied": False}  # 未知/已完成任务幂等接受
    label = route_label(payload.ok, payload.isCn2)
    probe_store().set_route_label(task.ip, label)
    return {"ok": True, "applied": True, "ip": task.ip, "label": label}


@router.get("/route/status")
def route_status_view():
    from .route import route_hub
    return route_hub.status()


@router.post("/route/stop")
def route_stop(user: Annotated[str, Depends(require_auth)]):
    from .route import route_hub
    cleared = route_hub.stop()
    audit(user, "probe_route_stop", message=f"清除待测任务 {cleared} 个")
    return {"cleared": cleared}


@router.post("/route/start")
def route_start(payload: RouteStart, user: Annotated[str, Depends(require_auth)]):
    from .route import route_hub

    if not payload.ids:
        raise HTTPException(status_code=400, detail="请勾选要测试的记录")
    rows = probe_store().get_discover_results_by_ids(payload.ids)
    enqueued = sum(1 for row in rows if route_hub.enqueue(row["ip"]))
    audit(user, "probe_route_start", message=f"入队 {enqueued} 台（勾选 {len(payload.ids)}）")
    return {"enqueued": enqueued}


@router.get("/route/nodes")
def route_nodes_list():
    from .route import route_hub

    return [{
        "name": node["name"],
        "tokenMasked": _mask_route_token(node.get("token", "")),
        "online": route_hub.is_online(node["name"]),
    } for node in load_route_nodes(probe_store())]


@router.post("/route/nodes")
def route_nodes_create(payload: RouteNodeCreate, user: Annotated[str, Depends(require_auth)]):
    from .route import generate_node_token

    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="节点名称不能为空")
    if len(name) > 64:
        raise HTTPException(status_code=400, detail="节点名称过长（最多 64 字符）")
    store = probe_store()
    nodes = load_route_nodes(store)
    if any(node["name"] == name for node in nodes):
        raise HTTPException(status_code=400, detail=f"节点「{name}」已存在")
    token = generate_node_token()
    nodes.append({"name": name, "token": token})
    save_route_nodes(store, nodes)
    audit(user, "probe_route_node_create", message=name)
    # Token 只在创建时完整返回一次
    return {"name": name, "token": token}


@router.delete("/route/nodes/{name}")
def route_nodes_delete(name: str, user: Annotated[str, Depends(require_auth)]):
    store = probe_store()
    nodes = load_route_nodes(store)
    remaining = [node for node in nodes if node["name"] != name]
    if len(remaining) == len(nodes):
        raise HTTPException(status_code=404, detail=f"节点「{name}」不存在")
    save_route_nodes(store, remaining)
    audit(user, "probe_route_node_delete", message=name)
    return {"ok": True}
