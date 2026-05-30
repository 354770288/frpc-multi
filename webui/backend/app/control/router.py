from __future__ import annotations

from typing import Annotated, Any, Awaitable, Callable

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth import require_auth, require_auth_query
from ..models import now_iso
from ..settings import settings
from . import wsproto
from .audit_store import AuditStore
from .hub import AgentOfflineError, AgentRpcError, AgentTimeoutError, hub
from .models import AuditLogRecord, NodeRecord
from .node_store import NodeStore

router = APIRouter(prefix="/api/nodes", dependencies=[Depends(require_auth)])
audit_router = APIRouter(prefix="/api/audit-logs", dependencies=[Depends(require_auth)])


class NodeCreate(BaseModel):
    name: str


class NodePatch(BaseModel):
    name: str | None = None


def node_store() -> NodeStore:
    return NodeStore(settings.database_path)


def audit_store() -> AuditStore:
    return AuditStore(settings.database_path)


# ---------------------------------------------------------------------------
# 序列化
# ---------------------------------------------------------------------------
def _public_node(record: NodeRecord) -> dict:
    return {
        "id": record.id,
        "name": record.name,
        "uuid": record.uuid,
        "status": "online" if hub.is_online(record.uuid) else record.status,
        "online": hub.is_online(record.uuid),
        "lastSeenAt": record.last_seen_at,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
    }


def _public_audit_log(record: AuditLogRecord) -> dict:
    return {
        "id": record.id,
        "username": record.username,
        "action": record.action,
        "nodeId": record.node_id,
        "instanceName": record.instance_name,
        "success": record.success,
        "message": record.message,
        "createdAt": record.created_at,
    }


def _install_info(record: NodeRecord, *, include_secret: bool) -> dict:
    """构造一键安装信息。Agent 出站连回主控，因此只需主控可达地址 + uuid + secret。"""
    host = settings.console_public_host or "<主控地址:端口>"
    tls_flag = "true" if settings.console_tls else "false"
    secret = record.secret if include_secret else ""
    env = {
        "AGENT_SERVER": host,
        "AGENT_UUID": record.uuid,
        "AGENT_SECRET": secret,
        "AGENT_TLS": tls_flag,
    }
    if settings.agent_install_url:
        install_command = (
            f"curl -fsSL {settings.agent_install_url} -o frpc-agent-install.sh && "
            f"AGENT_SERVER={host} AGENT_UUID={record.uuid} AGENT_SECRET={secret} "
            f"AGENT_TLS={tls_flag} bash frpc-agent-install.sh"
        )
    else:
        install_command = (
            "docker run -d --name frpc-agent --restart unless-stopped "
            "-v /var/run/docker.sock:/var/run/docker.sock "
            "-v frpc-agent-data:/opt/frpc-multi "
            "-e FRPC_MULTI_ROLE=agent "
            f"-e AGENT_SERVER={host} -e AGENT_UUID={record.uuid} "
            f"-e AGENT_SECRET={secret} -e AGENT_TLS={tls_flag} "
            f"{settings.agent_image}"
        )
    return {
        "server": host,
        "serverConfigured": bool(settings.console_public_host),
        "tls": settings.console_tls,
        "uuid": record.uuid,
        "image": settings.agent_image,
        "env": env,
        "installCommand": install_command,
    }


# ---------------------------------------------------------------------------
# 错误映射
# ---------------------------------------------------------------------------
def _hub_error(exc: Exception) -> HTTPException:
    if isinstance(exc, AgentOfflineError):
        return HTTPException(status_code=502, detail="节点未在线")
    if isinstance(exc, AgentTimeoutError):
        return HTTPException(status_code=504, detail="Agent 请求超时")
    if isinstance(exc, AgentRpcError):
        return HTTPException(status_code=exc.status_code, detail=exc.detail)
    return HTTPException(status_code=502, detail=str(exc))


def _get_node(node_id: int, store: NodeStore) -> NodeRecord:
    try:
        return store.get_node(node_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


async def _node_call(node_id: int, store: NodeStore, method: str, params: dict | None = None, *, timeout: float = 15.0) -> Any:
    """只读式节点 RPC：把 hub 错误直接映射为 HTTP 错误（不写审计）。"""
    node = _get_node(node_id, store)
    try:
        connection = hub.get(node.uuid)
        return await connection.call(method, params or {}, timeout=timeout)
    except (AgentRpcError, AgentOfflineError, AgentTimeoutError) as exc:
        raise _hub_error(exc) from exc


async def _run_node_action(
    store: AuditStore,
    *,
    username: str,
    action: str,
    node_id: int,
    instance_name: str | None,
    factory: Callable[[], Awaitable[Any]],
) -> Any:
    """变更式节点 RPC：成功与失败都写审计；失败映射为 HTTP 错误抛出。"""
    try:
        result = await factory()
    except (AgentRpcError, AgentOfflineError, AgentTimeoutError) as exc:
        store.create_log(
            username=username,
            action=action,
            node_id=node_id,
            instance_name=instance_name,
            success=False,
            message=str(exc) or exc.__class__.__name__,
        )
        raise _hub_error(exc) from exc
    store.create_log(
        username=username,
        action=action,
        node_id=node_id,
        instance_name=instance_name,
        success=True,
    )
    return result


# ---------------------------------------------------------------------------
# 审计
# ---------------------------------------------------------------------------
@audit_router.get("")
def list_audit_logs(
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[AuditStore, Depends(audit_store)],
    limit: int = Query(default=100, ge=1, le=500),
):
    return [_public_audit_log(record) for record in store.list_logs(limit=limit)]


# ---------------------------------------------------------------------------
# 节点 CRUD
# ---------------------------------------------------------------------------
@router.get("")
def list_nodes(
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    return [_public_node(record) for record in store.list_nodes()]


@router.post("")
def create_node(
    payload: NodeCreate,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    try:
        record = store.create_node(name=payload.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 创建即返回 secret + 安装命令（明文仅此一次随响应给出，便于前端展示一键命令）。
    return {**_public_node(record), "install": _install_info(record, include_secret=True)}


@router.get("/{node_id}")
def get_node(
    node_id: int,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    return _public_node(_get_node(node_id, store))


@router.get("/{node_id}/install")
def get_node_install(
    node_id: int,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    """重新获取节点的一键安装命令（含 secret，登录后可见）。"""
    record = _get_node(node_id, store)
    return _install_info(record, include_secret=True)


@router.post("/{node_id}/rotate-secret")
def rotate_node_secret(
    node_id: int,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    record = store.rotate_secret(node_id)
    if record is None:
        raise HTTPException(status_code=404, detail="节点不存在")
    return {**_public_node(record), "install": _install_info(record, include_secret=True)}


@router.patch("/{node_id}")
def patch_node(
    node_id: int,
    payload: NodePatch,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    try:
        record = store.update_node(node_id, name=payload.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if record is None:
        raise HTTPException(status_code=404, detail="节点不存在")
    return _public_node(record)


@router.delete("/{node_id}")
def delete_node(
    node_id: int,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    if not store.delete_node(node_id):
        raise HTTPException(status_code=404, detail="节点不存在")
    return {"deleted": True}


@router.post("/{node_id}/ping")
def ping_node(
    node_id: int,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    """反转模型下没有主动拨号；在线与否取决于 Agent 是否已连回主控。"""
    record = _get_node(node_id, store)
    online = hub.is_online(record.uuid)
    if online:
        record = store.update_node(node_id, status="online", last_seen_at=now_iso()) or record
    return {"ok": online, "node": _public_node(record)}


# ---------------------------------------------------------------------------
# 节点系统信息
# ---------------------------------------------------------------------------
@router.get("/{node_id}/system")
async def get_node_system(
    node_id: int,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    return await _node_call(node_id, store, wsproto.M_GET_SYSTEM)


# ---------------------------------------------------------------------------
# 节点实例
# ---------------------------------------------------------------------------
@router.get("/{node_id}/instances")
async def list_node_instances(
    node_id: int,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    return await _node_call(node_id, store, wsproto.M_LIST_INSTANCES)


@router.post("/{node_id}/instances")
async def create_node_instance(
    node_id: int,
    payload: dict[str, Any],
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
):
    node = _get_node(node_id, store)

    async def factory():
        connection = hub.get(node.uuid)
        return await connection.call(wsproto.M_CREATE_INSTANCE, payload, timeout=60.0)

    return await _run_node_action(
        audits,
        username=user,
        action="create_instance",
        node_id=node_id,
        instance_name=payload.get("name"),
        factory=factory,
    )


@router.get("/{node_id}/instances/{name}")
async def get_node_instance(
    node_id: int,
    name: str,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    return await _node_call(node_id, store, wsproto.M_GET_INSTANCE, {"name": name})


@router.delete("/{node_id}/instances/{name}")
async def delete_node_instance(
    node_id: int,
    name: str,
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
):
    node = _get_node(node_id, store)

    async def factory():
        connection = hub.get(node.uuid)
        return await connection.call(wsproto.M_DELETE_INSTANCE, {"name": name}, timeout=60.0)

    return await _run_node_action(
        audits,
        username=user,
        action="delete_instance",
        node_id=node_id,
        instance_name=name,
        factory=factory,
    )


@router.patch("/{node_id}/instances/{name}")
async def patch_node_instance(
    node_id: int,
    name: str,
    payload: dict[str, Any],
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
):
    node = _get_node(node_id, store)

    async def factory():
        connection = hub.get(node.uuid)
        return await connection.call(
            wsproto.M_PATCH_INSTANCE, {"name": name, "patch": payload}, timeout=60.0
        )

    return await _run_node_action(
        audits,
        username=user,
        action="patch_instance",
        node_id=node_id,
        instance_name=name,
        factory=factory,
    )


@router.get("/{node_id}/instances/{name}/config")
async def get_node_instance_config(
    node_id: int,
    name: str,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    return await _node_call(node_id, store, wsproto.M_GET_CONFIG, {"name": name})


@router.put("/{node_id}/instances/{name}/config")
async def update_node_instance_config(
    node_id: int,
    name: str,
    payload: dict[str, Any],
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
):
    node = _get_node(node_id, store)

    async def factory():
        connection = hub.get(node.uuid)
        return await connection.call(
            wsproto.M_UPDATE_CONFIG, {"name": name, **payload}, timeout=60.0
        )

    return await _run_node_action(
        audits,
        username=user,
        action="update_config",
        node_id=node_id,
        instance_name=name,
        factory=factory,
    )


@router.post("/{node_id}/instances/{name}/config/validate")
async def validate_node_instance_config(
    node_id: int,
    name: str,
    request: Request,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    body = await request.body()
    return await _node_call(
        node_id,
        store,
        wsproto.M_VALIDATE_CONFIG,
        {"name": name, "configText": body.decode("utf-8")},
    )


@router.get("/{node_id}/instances/{name}/logs")
async def get_node_instance_logs(
    node_id: int,
    name: str,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    tail: int = Query(default=300, ge=1, le=1000),
    keyword: str = "",
):
    return await _node_call(
        node_id, store, wsproto.M_LOGS, {"name": name, "tail": tail, "keyword": keyword}
    )


def _sse(event: str, data: str) -> bytes:
    return f"event: {event}\ndata: {data}\n\n".encode("utf-8")


@router.get("/{node_id}/instances/{name}/logs/stream")
async def stream_node_instance_logs(
    node_id: int,
    name: str,
    _: Annotated[str, Depends(require_auth_query)],
    store: Annotated[NodeStore, Depends(node_store)],
    tail: int = Query(default=100, ge=0, le=1000),
    keyword: str = "",
):
    record = _get_node(node_id, store)

    async def generate():
        try:
            connection = hub.get(record.uuid)
        except AgentOfflineError:
            yield _sse("error", "节点未在线")
            yield _sse("end", "")
            return
        stream_id, queue = await connection.open_stream(
            wsproto.M_LOGS_STREAM, {"name": name, "tail": tail, "keyword": keyword}
        )
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield item.encode("utf-8") if isinstance(item, str) else item
        finally:
            await connection.cancel_stream(stream_id)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{node_id}/instances/{name}/start")
async def start_node_instance(
    node_id: int,
    name: str,
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
):
    node = _get_node(node_id, store)

    async def factory():
        connection = hub.get(node.uuid)
        return await connection.call(wsproto.M_START, {"name": name}, timeout=60.0)

    return await _run_node_action(
        audits,
        username=user,
        action="start_instance",
        node_id=node_id,
        instance_name=name,
        factory=factory,
    )


@router.post("/{node_id}/instances/{name}/stop")
async def stop_node_instance(
    node_id: int,
    name: str,
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
):
    node = _get_node(node_id, store)

    async def factory():
        connection = hub.get(node.uuid)
        return await connection.call(wsproto.M_STOP, {"name": name}, timeout=60.0)

    return await _run_node_action(
        audits,
        username=user,
        action="stop_instance",
        node_id=node_id,
        instance_name=name,
        factory=factory,
    )


@router.post("/{node_id}/instances/{name}/restart")
async def restart_node_instance(
    node_id: int,
    name: str,
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
):
    node = _get_node(node_id, store)

    async def factory():
        connection = hub.get(node.uuid)
        return await connection.call(wsproto.M_RESTART, {"name": name}, timeout=60.0)

    return await _run_node_action(
        audits,
        username=user,
        action="restart_instance",
        node_id=node_id,
        instance_name=name,
        factory=factory,
    )


@router.post("/{node_id}/instances/{name}/recreate")
async def recreate_node_instance(
    node_id: int,
    name: str,
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
):
    node = _get_node(node_id, store)

    async def factory():
        connection = hub.get(node.uuid)
        return await connection.call(wsproto.M_RECREATE, {"name": name}, timeout=60.0)

    return await _run_node_action(
        audits,
        username=user,
        action="recreate_instance",
        node_id=node_id,
        instance_name=name,
        factory=factory,
    )
