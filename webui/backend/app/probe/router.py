"""/api/probe/*：frps 穿透测试（服务器库 / 测试任务 / 历史 / 统计）。

测试在 Console 进程内执行（runner 后台线程），不经 Agent。
变更类操作照 control.router 的惯例写审计日志（probe_* 动作前缀）。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import replace
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel

from ..auth import require_auth
from ..settings import settings
from .discover import discover_runner
from .engine import ProbeOptions
from .constants import PROBE_TEST_PORT
from .jobs import ProbeJobStore, CAPABILITIES
from .adapters import LegacyProbeAdapter, LegacyDiscoverAdapter, serial_options
from .persistence import DiscoverPersistenceError, DiscoverScanCoordinator
from .route import load_route_nodes, route_hub, save_route_nodes
from .runner import MODES, ProbeRunner
from .store import (
    DiscoverPageQuery, ProbeStore, ServerPageQuery, unpack_labels, validate_probe_addr,
)

router = APIRouter(prefix="/api/probe", dependencies=[Depends(require_auth)])

# 路由测试节点专用（Token 鉴权，不走面板登录）：claim / report
node_router = APIRouter(prefix="/api/probe")


def probe_store() -> ProbeStore:
    return ProbeStore(settings.database_path)


def _enrich_source(items, node_id):
    store=job_store()
    try:name=store.get_node(node_id)['name']
    except KeyError:name=node_id
    routes=store.latest_results(node_id,'route')
    from .jobs import split_endpoint
    default_port=PROBE_TEST_PORT
    lookup={(r['server_ip'],r['port']):r for r in routes}
    fallback={r['server_ip']:r for r in routes}
    return [{**item,'nodeId':node_id,'nodeName':name,'port':item.get('port',split_endpoint(item['ip'],default_port)[1]),'latestRoute':lookup.get((item['ip'],item['port'])) if 'port' in item else lookup.get(split_endpoint(item['ip'],default_port))} for item in items]


def audit(username: str, action: str, *, success: bool = True, message: str = "") -> None:
    from ..control.audit_store import AuditStore

    AuditStore(settings.database_path).create_log(
        username=username, action=action, success=success, message=message,
    )


# 模块级单例：与进程同生命周期；store 每次 start 时重建（跟随 DATABASE_PATH）
def job_store():
    return ProbeJobStore(settings.database_path)


def source_store(node_id):
    job_store()  # initialize provenance migration before reading the scoped views
    return ProbeStore(settings.database_path, node_id=node_id)


runner = LegacyProbeAdapter(job_store)


def _enqueue_discovered_route(ip: str) -> bool:
    return route_hub.enqueue(ip)


discover_scans = LegacyDiscoverAdapter(job_store, lambda: _effective_options())

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
        "labels": unpack_labels(row["label"]),
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
    labels: list[str] = []
    group: str = ""


class ServerPatch(BaseModel):
    ip: str | None = None
    labels: list[str] | None = None
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
    nodeId: str = "console",
):
    result = source_store(nodeId).query_servers(ServerPageQuery(
        page=page, page_size=page_size, q=q, group=group, label=label,
        conn=conn, sort=sort, order=order,
    ))
    return {
        "items": _enrich_source([_public_server(row) for row in result["items"]], nodeId),
        "page": result["page"], "pageSize": result["pageSize"],
        "total": result["total"], "sort": result["sort"], "order": result["order"],
    }


@router.get("/servers/facets")
def server_facets(nodeId: str = "console"):
    return source_store(nodeId).server_facets()


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
    addLabels: list[str] = []
    removeLabels: list[str] = []


@router.post("/servers/batch-update")
def batch_update_servers(payload: ServerBatchUpdate, user: Annotated[str, Depends(require_auth)]):
    if not payload.ids:
        raise HTTPException(status_code=400, detail="没有选择服务器")
    store = probe_store()
    try:
        updated = store.update_servers_batch(
            payload.ids, group=payload.group,
            add_labels=payload.addLabels, remove_labels=payload.removeLabels)
    except ValueError as exc:
        audit(user, "probe_batch_update_servers", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    changes = []
    if payload.group is not None:
        changes.append(f"分组 → {payload.group.strip()}")
    if payload.addLabels:
        changes.append(f"加标签 {payload.addLabels}")
    if payload.removeLabels:
        changes.append(f"去标签 {payload.removeLabels}")
    audit(user, "probe_batch_update_servers", message=f"{updated} 台：{'，'.join(changes)}")
    return {"updated": updated}


@router.post("/servers")
def create_server(payload: ServerCreate, user: Annotated[str, Depends(require_auth)]):
    store = probe_store()
    try:
        server = store.create_server(ip=payload.ip, labels=payload.labels, server_group=payload.group)
    except ValueError as exc:
        audit(user, "probe_create_server", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    labels_text = ", ".join(server.labels)
    audit(user, "probe_create_server", message=f"{server.ip} {labels_text}".strip())
    return {"id": server.id, "ip": server.ip, "labels": server.labels, "group": server.server_group}


@router.patch("/servers/{server_id}")
def update_server(server_id: int, payload: ServerPatch, user: Annotated[str, Depends(require_auth)]):
    store = probe_store()
    try:
        server = store.update_server(
            server_id,
            ip=payload.ip, labels=payload.labels, server_group=payload.group,
        )
    except ValueError as exc:
        audit(user, "probe_update_server", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    labels_text = ", ".join(server.labels)
    audit(user, "probe_update_server", message=f"{server.ip} {labels_text}".strip())
    return {"id": server.id, "ip": server.ip, "labels": server.labels, "group": server.server_group}


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
    nodeIds: list[str] | None = None


@router.post("/test")
def start_test(payload: TestStart, user: Annotated[str, Depends(require_auth)]):
    if payload.mode not in MODES:
        raise HTTPException(status_code=400, detail=f"mode 必须是 {'/'.join(sorted(MODES))}")
    if (not payload.nodeIds or 'console' in payload.nodeIds) and not Path(settings.probe_frpc_bin).exists():
        raise HTTPException(400,'未找到 frpc 二进制，请设置 PROBE_FRPC_BIN')
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
    if payload.nodeIds:
        try:
            job = job_store().create_job(payload.mode, payload.nodeIds, ips=ips, port=PROBE_TEST_PORT, options=serial_options(_effective_options()))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"ok": True, "mode": payload.mode, "count": len(ips), "jobId": job["id"]}
    try:
        ok, err = runner.start(payload.mode, ips, _effective_options())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
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
    nodeId: str = "console",
):
    if kind == "route":
        return job_store().history(nodeId, kind, ip, limit)
    rows=job_store().history(nodeId,kind,ip,limit)
    if kind == "connectivity":
        return [{**_public_conn(row),"nodeId":nodeId,"port":row["port"]} for row in rows]
    if kind == "speed":
        return [{**_public_speed(row),"nodeId":nodeId,"port":row["port"]} for row in rows]
    raise HTTPException(status_code=404, detail="history 类型必须是 connectivity 或 speed")


@router.get('/history/{kind}/page')
def history_page(kind: Literal['route','connectivity','speed'],nodeId: str='console',page: int=Query(default=1,ge=1),pageSize: int=Query(default=50,ge=1,le=200),ip: str | None=None,port: int | None=Query(default=None,ge=1,le=65535),jobId: str | None=None,fromTime: str | None=None,toTime: str | None=None):
    return job_store().history_page(nodeId,kind,page,pageSize,ip=ip,port=port,job_id=jobId,from_time=fromTime,to_time=toTime)


@router.delete("/history/{kind}")
def clear_history(kind: str, user: Annotated[str, Depends(require_auth)], nodeId: str="console"):
    if kind not in {"connectivity", "speed"}:
        raise HTTPException(status_code=404, detail="history 类型必须是 connectivity 或 speed")
    deleted = job_store().clear_history(nodeId,kind)
    audit(user, "probe_clear_history", message=f"{kind} × {deleted}")
    return {"deleted": deleted}


# ---------------------------------------------------------------------------
# 统计
# ---------------------------------------------------------------------------
@router.get("/dashboard")
def dashboard(nodeId: str = "console"):
    return source_store(nodeId).dashboard()


# ---------------------------------------------------------------------------
# 网段发现（整合自 portpilot）：扫描自有网段内开放 frps 端口的设备
# ---------------------------------------------------------------------------
class DiscoverStart(BaseModel):
    targets: str
    exclude: str = ""
    sourceUrl: str = ""
    port: int | None = None
    concurrency: int = 500
    timeout: float = 1.5
    autoRoute: bool = False
    autoFull: bool = False
    nodeIds: list[str] | None = None


def _fetch_targets_from_url(url: str) -> str:
    """下载网段订阅（txt，一行一个网段/CIDR/IP），返回换行分隔的文本。

    仅允许 http/https；限制 2MB 与 15s 超时；空行和 # 注释行由下游解析忽略。
    """
    cleaned = url.strip()
    if not cleaned.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="订阅链接必须是 http/https 地址")
    request = urllib.request.Request(cleaned, headers={"User-Agent": "frpc-multi-discover"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            data = response.read(2 * 1024 * 1024 + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status_code=400, detail=f"订阅链接下载失败: {exc}") from exc
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="订阅文件超过 2MB 上限")
    text = data.decode("utf-8", errors="replace")
    if not text.strip():
        raise HTTPException(status_code=400, detail="订阅文件为空")
    return text


class DiscoverImport(BaseModel):
    ids: list[int]
    group: str = ""


class DiscoverBatchUpdate(BaseModel):
    ids: list[int]
    group: str | None = None
    addLabels: list[str] = []
    removeLabels: list[str] = []


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

    targets_text = payload.targets
    if payload.sourceUrl.strip():
        # 订阅内容追加在手工目标之前；两者都可为空时由下方统一校验拦截
        targets_text = _fetch_targets_from_url(payload.sourceUrl) + (
            "\n" + targets_text if targets_text.strip() else "")
    if not targets_text.strip():
        raise HTTPException(status_code=400, detail="至少填写一个目标网段或订阅链接")
    if not MIN_CONCURRENCY <= payload.concurrency <= MAX_CONCURRENCY:
        raise HTTPException(status_code=400, detail=f"并发需在 {MIN_CONCURRENCY}-{MAX_CONCURRENCY}")
    if not MIN_TIMEOUT <= payload.timeout <= MAX_TIMEOUT:
        raise HTTPException(status_code=400, detail=f"超时需在 {MIN_TIMEOUT}-{MAX_TIMEOUT} 秒")
    if payload.port is not None and payload.port != PROBE_TEST_PORT:
        raise HTTPException(status_code=400, detail=f"探测任务端口固定为 {PROBE_TEST_PORT}")
    port = PROBE_TEST_PORT
    params = DiscoverParams(
        targets=[part.strip() for part in targets_text.replace("\n", ",").split(",") if part.strip()],
        exclude=[part.strip() for part in payload.exclude.replace("\n", ",").split(",") if part.strip()],
        port=port,
        concurrency=payload.concurrency,
        timeout=payload.timeout,
    )
    try:
        if payload.nodeIds or payload.autoFull:
            job = job_store().create_job("discover", payload.nodeIds or ["console"], targets=params.targets, exclude=params.exclude, port=port, auto_route=payload.autoRoute, auto_full=payload.autoFull, concurrency=params.concurrency, timeout=params.timeout, options=serial_options(_effective_options()))
            return {"running": True, "jobId": job["id"], "total": job["options"]["total"]}
        discover_scans.start(params, auto_route=payload.autoRoute)
    except DiscoverPersistenceError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        audit(user, "probe_discover_start", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(user, "probe_discover_start",
          message=f"目标 {(targets_text.strip())[:120]} 端口 {port} 并发 {payload.concurrency}"
                  + (f" · 订阅 {payload.sourceUrl.strip()[:80]}" if payload.sourceUrl.strip() else "")
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
    nodeId: str = "console",
):
    store_sort = "time" if sort == "discoveredAt" else sort
    result = source_store(nodeId).query_discover_results(DiscoverPageQuery(
        page=page, page_size=page_size, q=q, group=group, label=label,
        library=library, sort=store_sort, order=order,
    ))
    items = [{
        "id": row["id"],
        "ip": row["ip"],
        "port": row["port"],
        "latencyMs": round(row["latency_ms"], 1),
        "group": row["server_group"],
        "labels": unpack_labels(row["label"]),
        "inLibrary": bool(row["in_library"]),
        "discoveredAt": row["discovered_at"],
    } for row in result["items"]]
    return {
        "items": _enrich_source(items, nodeId), "page": result["page"], "pageSize": result["pageSize"],
        "total": result["total"], "sort": sort, "order": result["order"],
    }


@router.get("/discover/facets")
def discover_facets(nodeId: str = "console"):
    return source_store(nodeId).discover_facets()


class IdsPayload(BaseModel):
    ids: list[int]


@router.post("/discover/labels-preview")
def discover_labels_preview(payload: IdsPayload, user: Annotated[str, Depends(require_auth)]):
    return {"labels": probe_store().discover_labels_for_ids(payload.ids)}


@router.post("/servers/labels-preview")
def servers_labels_preview(payload: IdsPayload, user: Annotated[str, Depends(require_auth)]):
    return {"labels": probe_store().servers_labels_for_ids(payload.ids)}


@router.patch("/discover/results/batch")
def discover_results_batch(payload: DiscoverBatchUpdate, user: Annotated[str, Depends(require_auth)]):
    if not payload.ids:
        raise HTTPException(status_code=400, detail="请勾选要修改的记录")
    try:
        updated = probe_store().update_discover_batch(
            payload.ids, group=payload.group,
            add_labels=payload.addLabels, remove_labels=payload.removeLabels)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    changes = []
    if payload.group is not None:
        changes.append(f"分组 → {payload.group.strip()}")
    if payload.addLabels:
        changes.append(f"加标签 {payload.addLabels}")
    if payload.removeLabels:
        changes.append(f"去标签 {payload.removeLabels}")
    audit(user, "probe_update_discover", message=f"{updated} 条：{'，'.join(changes)}")
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
    taskId: str | int
    ok: bool = True
    isCn2: bool = False
    error: str = ""
    hops: list[dict] = []


class RouteStart(BaseModel):
    ids: list[int]


class RouteNodeCreate(BaseModel):
    name: str


def _route_node_by_token(token: str) -> dict | None:
    try:
        return job_store().authenticate(token)
    except ValueError:
        return None


def _mask_route_token(token: str) -> str:
    return token[:4]+"…"+token[-4:] if len(token)>8 else "*"*len(token)


def _require_route_node(x_route_token: str) -> dict:
    node = _route_node_by_token(x_route_token)
    if node is None:
        raise HTTPException(401,"节点 Token 无效")
    job_store().heartbeat(node['id'],node['version'],['route'],[])
    return node


@node_router.post("/route/claim")
def route_claim(x_route_token: str = Header(default="")):
    node=_require_route_node(x_route_token)
    task=job_store().claim(node['id'],['route'])
    # The old script only echoes taskId. Encode the attempt into that opaque ID,
    # preserving fencing even though legacy nodes have no heartbeat protocol.
    if task:
        task={**task,'taskId':task['taskId']+':'+task['attemptId']}
    return {'task':task}


@node_router.post("/route/report")
def route_report(payload: RouteReport, x_route_token: str = Header(default="")):
    node=_require_route_node(x_route_token)
    task,separator,attempt=str(payload.taskId).partition(':')
    if not separator:return {'ok':True,'applied':False}
    return job_store().report(node['id'],task,attempt,result={'ok':payload.ok,'isCn2':payload.isCn2,'error':payload.error,'hops':payload.hops})


@router.get("/route/status")
def route_status_view():
    return job_store().stage_status('route')


@router.post("/route/stop")
def route_stop(user: Annotated[str, Depends(require_auth)]):
    return {'cleared':job_store().stop_stage('route')}


@router.post("/route/start")
def route_start(payload: RouteStart, user: Annotated[str, Depends(require_auth)]):
    rows=probe_store().get_discover_results_by_ids(payload.ids)
    if not rows:raise HTTPException(400,'请勾选要测试的记录')
    nodes=[n['id'] for n in job_store().list_nodes() if n['kind']!='console' and 'route' in n['capabilities']] or ['console']
    try:
        job=job_store().create_job('route',nodes,ips=[r['ip'] for r in rows],port=PROBE_TEST_PORT)
    except ValueError as exc:
        raise HTTPException(400,str(exc)) from exc
    audit(user,'probe_route_start',message=job['id'])
    return {'enqueued':len(rows)*len(nodes)}


@router.get("/route/nodes")
def route_nodes_list():
    return [n for n in job_store().list_nodes() if n['kind']!='console']


@router.post("/route/nodes")
def route_nodes_create(payload: RouteNodeCreate, user: Annotated[str, Depends(require_auth)]):
    try:
        node=job_store().create_node(payload.name,kind='legacy')
        audit(user,'probe_route_node_create',message=payload.name)
        return node
    except Exception as exc:
        import sqlite3
        if isinstance(exc,(ValueError,sqlite3.IntegrityError)):raise HTTPException(400,str(exc)) from exc
        raise


@router.delete("/route/nodes/{name}")
def route_nodes_delete(name: str, user: Annotated[str, Depends(require_auth)]):
    node=next((n for n in job_store().list_nodes() if n['name']==name),None)
    if not node:raise HTTPException(404,'节点不存在')
    job_store().delete_node(node['id']);return {'ok':True}


class NodeCreate(BaseModel):
    name: str


class JobCreate(BaseModel):
    mode: Literal['discover','route','connectivity','speed','full']
    nodeIds: list[str]
    ips: list[str] | None = None
    targetScope: Literal['explicit','all'] | None = None
    targets: str | list[str] | None = None
    sourceUrl: str = ""
    exclude: str | list[str] | None = None
    port: int | None = None
    autoRoute: bool = False
    autoFull: bool = False
    concurrency: int = 6
    timeout: float = 1.5


class JobAction(BaseModel):
    taskIds: list[str] | None = None


def _installer_command(url: str, token: str | None = None) -> str:
    import shlex
    command = 'curl -fsSL ' + shlex.quote(url + '/api/probe/worker/install.sh') + ' -o /tmp/frpc-probe-install.sh && sudo '
    if token is not None:
        command += 'env CONSOLE_URL=' + shlex.quote(url) + ' PROBE_TOKEN=' + shlex.quote(token) + ' '
    return command + 'bash /tmp/frpc-probe-install.sh'


@router.get('/nodes')
def nodes_list(request: Request):
    nodes = job_store().list_nodes()
    for node in nodes:
        if node['id'] != 'console':
            node['installCommand'] = _installer_command(str(request.base_url).rstrip('/'))
    return {'items': nodes}


@router.post('/nodes')
def nodes_create(payload: NodeCreate, request: Request):
    import sqlite3
    try:
        node=job_store().create_node(payload.name)
        url=str(request.base_url).rstrip('/')
        node['installCommand'] = _installer_command(url, node['token'])
        return node
    except (ValueError,sqlite3.IntegrityError) as exc:raise HTTPException(400,str(exc)) from exc


@router.delete('/nodes/{node_id}')
def nodes_delete(node_id: str):
    try:job_store().delete_node(node_id)
    except KeyError as exc:raise HTTPException(404,'节点不存在') from exc
    except ValueError as exc:raise HTTPException(400,str(exc)) from exc
    return {'ok':True}


@router.post('/jobs')
def jobs_create(payload: JobCreate):
    if payload.port is not None and payload.port != PROBE_TEST_PORT:
        raise HTTPException(400, detail=f'探测任务端口固定为 {PROBE_TEST_PORT}')
    if payload.mode != 'discover' and payload.targetScope == 'explicit' and not payload.ips:
        raise HTTPException(400, '明确目标不能为空')
    if payload.mode != 'discover' and payload.targetScope == 'all' and (payload.ips or payload.targets):
        raise HTTPException(400, '全库目标不能同时指定端点')
    if payload.mode=='discover' and payload.sourceUrl.strip():
        manual=payload.targets if isinstance(payload.targets,str) else ','.join(payload.targets or [])
        payload.targets=_fetch_targets_from_url(payload.sourceUrl)+'\n'+manual
    ips=payload.ips
    if payload.mode!='discover' and not ips and not payload.targets:
        ips=[s.ip for s in probe_store().list_servers()]
    try:
        return job_store().create_job(payload.mode,payload.nodeIds,ips=ips,targets=payload.targets,exclude=payload.exclude,port=PROBE_TEST_PORT,auto_route=payload.autoRoute,auto_full=payload.autoFull,concurrency=payload.concurrency,timeout=payload.timeout,options=serial_options(_effective_options()))
    except ValueError as exc:raise HTTPException(400,str(exc)) from exc


@router.get('/jobs')
def jobs_list(page: int | None = Query(default=None,ge=1),pageSize: int=Query(default=20,ge=1,le=100),mode: str | None=None,state: str | None=None,nodeId: str | None=None,target: str | None=None,fromTime: str | None=None,toTime: str | None=None):
    if page is None:return {'items':job_store().list_jobs()}
    return job_store().query_jobs(page,pageSize,mode=mode,state=state,node_id=nodeId,target=target,from_time=fromTime,to_time=toTime)


@router.get('/jobs/{job_id}')
def jobs_detail(job_id: str,page: int=Query(default=1,ge=1),pageSize: int=Query(default=200,ge=1,le=500),nodeId: str | None=None,stage: str | None=None,state: str | None=None,target: str | None=None):
    try:return job_store().get_job(job_id,page,pageSize,node_id=nodeId,stage=stage,state=state,target=target)
    except KeyError as exc:raise HTTPException(404,'任务不存在') from exc


@router.post('/jobs/{job_id}/{action}')
def jobs_action(job_id: str,action: Literal['stop','skip','retry'],payload: JobAction = JobAction()):
    try:return job_store().action(job_id,action,payload.taskIds)
    except KeyError as exc:raise HTTPException(404,'任务不存在') from exc


@router.get('/results/{kind}')
def results_latest(kind: Literal['route','connectivity','speed'],nodeId: str='console',ip: str | None=None):
    items=job_store().latest_results(nodeId,kind)
    return {'items':[r for r in items if ip is None or r['server_ip']==ip]}


@router.get('/compare')
def results_compare(ip: str,port: int=7000):
    items=[]
    for node in job_store().list_nodes():
        values={kind:next((r for r in job_store().latest_results(node['id'],kind) if r['server_ip']==ip and r['port']==port),None) for kind in ('route','connectivity','speed')}
        with job_store()._db() as c:
            observation=c.execute('SELECT latency_ms,discovered_at FROM probe_discover_observations WHERE node_id=? AND ip=? AND port=?',(node['id'],ip,port)).fetchone()
        items.append({'node':node,'discovery':dict(observation) if observation else None,**values})
    return {'items':items}


def _worker_node(token):
    try:return job_store().authenticate(token)
    except ValueError as exc:raise HTTPException(401,str(exc)) from exc


class WorkerHeartbeat(BaseModel):
    version: str = ''
    capabilities: list[str] = []
    attempts: list[dict[str,str]] = []


class WorkerProgress(BaseModel):
    taskId: str
    attemptId: str
    seq: int
    hits: list[dict] = []
    progress: dict = {}


class WorkerReport(BaseModel):
    taskId: str
    attemptId: str
    result: dict | None = None
    infraError: str | None = None


@node_router.post('/worker/heartbeat')
def worker_heartbeat(payload: WorkerHeartbeat,x_probe_token: str=Header(default='')):
    node=_worker_node(x_probe_token)
    return job_store().heartbeat(node['id'],payload.version,payload.capabilities,payload.attempts)


@node_router.post('/worker/claim')
def worker_claim(x_probe_token: str=Header(default='')):
    node=_worker_node(x_probe_token)
    return {'task':job_store().claim(node['id'])}


@node_router.post('/worker/progress')
def worker_progress(payload: WorkerProgress,x_probe_token: str=Header(default='')):
    node=_worker_node(x_probe_token)
    try:return job_store().progress(node['id'],payload.taskId,payload.attemptId,payload.seq,hits=payload.hits,progress=payload.progress)
    except (ValueError,KeyError,TypeError) as exc:raise HTTPException(400,str(exc)) from exc


@node_router.post('/worker/report')
def worker_report(payload: WorkerReport,x_probe_token: str=Header(default='')):
    node=_worker_node(x_probe_token)
    return job_store().report(node['id'],payload.taskId,payload.attemptId,result=payload.result,infra_error=payload.infraError)


@node_router.get('/worker/bundle.tar.gz')
def worker_bundle_download():
    from fastapi.responses import Response
    from .package import worker_bundle
    return Response(worker_bundle(),media_type='application/gzip')


@node_router.get('/worker/install.sh')
def worker_install_download():
    from fastapi.responses import Response
    return Response(Path(__file__).with_name('install.sh').read_text(),media_type='text/x-shellscript')


@node_router.get('/worker/bundle.sha256')
def worker_bundle_checksum():
    import hashlib
    from fastapi.responses import Response
    from .package import worker_bundle
    return Response(hashlib.sha256(worker_bundle()).hexdigest()+'  worker.tar.gz\n',media_type='text/plain')
