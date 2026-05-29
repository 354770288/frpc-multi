from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..auth import require_auth
from ..models import now_iso
from ..settings import settings
from .audit_store import AuditStore
from .agent_client import (
    AgentAuthError,
    AgentClient,
    AgentClientError,
    AgentConnectionError,
    AgentNotFoundError,
    AgentServerError,
    AgentTimeoutError,
)
from .models import AuditLogRecord, NodeRecord
from .node_store import NodeStore

router = APIRouter(prefix="/api/nodes", dependencies=[Depends(require_auth)])
audit_router = APIRouter(prefix="/api/audit-logs", dependencies=[Depends(require_auth)])


class NodeCreate(BaseModel):
    name: str
    base_url: str = Field(alias="baseUrl")
    token: str


class NodePatch(BaseModel):
    name: str | None = None
    base_url: str | None = Field(default=None, alias="baseUrl")
    token: str | None = None
    status: str | None = None


def node_store() -> NodeStore:
    return NodeStore(settings.database_path)


def audit_store() -> AuditStore:
    return AuditStore(settings.database_path)


def create_agent_client():
    return AgentClient


def _public_node(record: NodeRecord) -> dict:
    return {
        "id": record.id,
        "name": record.name,
        "baseUrl": record.base_url,
        "status": record.status,
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


def _audit_instance_action(
    store: AuditStore,
    *,
    username: str,
    action: str,
    node_id: int,
    instance_name: str | None,
    message: str = "",
) -> None:
    store.create_log(
        username=username,
        action=action,
        node_id=node_id,
        instance_name=instance_name,
        success=True,
        message=message,
    )


def _agent_error(exc: AgentClientError) -> HTTPException:
    if isinstance(exc, AgentAuthError):
        return HTTPException(status_code=502, detail="Agent token 无效")
    if isinstance(exc, AgentNotFoundError):
        return HTTPException(status_code=404, detail="Agent 资源不存在")
    if isinstance(exc, AgentTimeoutError):
        return HTTPException(status_code=504, detail="Agent 请求超时")
    if isinstance(exc, AgentConnectionError):
        return HTTPException(status_code=502, detail="Agent 连接失败")
    if isinstance(exc, AgentServerError):
        return HTTPException(status_code=502, detail="Agent 服务错误")
    return HTTPException(status_code=502, detail=str(exc))


def _agent_for_node(
    node_id: int,
    store: NodeStore,
    agent_client_factory: type[AgentClient],
) -> AgentClient:
    try:
        node = store.get_node(node_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return agent_client_factory(node.base_url, node.token)


@audit_router.get("")
def list_audit_logs(
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[AuditStore, Depends(audit_store)],
    limit: int = Query(default=100, ge=1, le=500),
):
    return [_public_audit_log(record) for record in store.list_logs(limit=limit)]


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
        record = store.create_node(name=payload.name, base_url=payload.base_url, token=payload.token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _public_node(record)


@router.get("/{node_id}")
def get_node(
    node_id: int,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    try:
        record = store.get_node(node_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _public_node(record)


@router.patch("/{node_id}")
def patch_node(
    node_id: int,
    payload: NodePatch,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
):
    try:
        record = store.update_node(
            node_id,
            name=payload.name,
            base_url=payload.base_url,
            token=payload.token,
            status=payload.status,
        )
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
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    try:
        node = store.get_node(node_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    client = agent_client_factory(node.base_url, node.token)
    try:
        agent_response = client.ping()
    except Exception as exc:
        store.update_node(node_id, status="offline")
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    record = store.update_node(node_id, status="online", last_seen_at=now_iso())
    return {"ok": True, "node": _public_node(record), "agent": agent_response}


@router.get("/{node_id}/instances")
def list_node_instances(
    node_id: int,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        return client.list_instances()
    except AgentClientError as exc:
        raise _agent_error(exc) from exc


@router.post("/{node_id}/instances")
def create_node_instance(
    node_id: int,
    payload: dict[str, Any],
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        result = client.create_instance(payload)
    except AgentClientError as exc:
        raise _agent_error(exc) from exc
    _audit_instance_action(
        audits,
        username=user,
        action="create_instance",
        node_id=node_id,
        instance_name=payload.get("name") or result.get("name"),
    )
    return result


@router.get("/{node_id}/instances/{name}")
def get_node_instance(
    node_id: int,
    name: str,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        return client.get_instance(name)
    except AgentClientError as exc:
        raise _agent_error(exc) from exc


@router.delete("/{node_id}/instances/{name}")
def delete_node_instance(
    node_id: int,
    name: str,
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        result = client.delete_instance(name)
    except AgentClientError as exc:
        raise _agent_error(exc) from exc
    _audit_instance_action(
        audits,
        username=user,
        action="delete_instance",
        node_id=node_id,
        instance_name=name,
    )
    return result


@router.patch("/{node_id}/instances/{name}")
def patch_node_instance(
    node_id: int,
    name: str,
    payload: dict[str, Any],
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        result = client.patch_instance(name, payload)
    except AgentClientError as exc:
        raise _agent_error(exc) from exc
    _audit_instance_action(
        audits,
        username=user,
        action="patch_instance",
        node_id=node_id,
        instance_name=name,
    )
    return result


@router.get("/{node_id}/instances/{name}/config")
def get_node_instance_config(
    node_id: int,
    name: str,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        return client.get_config(name)
    except AgentClientError as exc:
        raise _agent_error(exc) from exc


@router.put("/{node_id}/instances/{name}/config")
def update_node_instance_config(
    node_id: int,
    name: str,
    payload: dict[str, Any],
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        result = client.update_config(name, payload)
    except AgentClientError as exc:
        raise _agent_error(exc) from exc
    _audit_instance_action(
        audits,
        username=user,
        action="update_config",
        node_id=node_id,
        instance_name=name,
    )
    return result


@router.post("/{node_id}/instances/{name}/config/validate")
async def validate_node_instance_config(
    node_id: int,
    name: str,
    request: Request,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    body = await request.body()
    try:
        return client.validate_config(name, body.decode("utf-8"))
    except AgentClientError as exc:
        raise _agent_error(exc) from exc


@router.get("/{node_id}/instances/{name}/logs")
def get_node_instance_logs(
    node_id: int,
    name: str,
    _: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
    tail: int = Query(default=300, ge=1, le=1000),
    keyword: str = "",
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        return client.logs(name, tail, keyword)
    except AgentClientError as exc:
        raise _agent_error(exc) from exc


@router.post("/{node_id}/instances/{name}/start")
def start_node_instance(
    node_id: int,
    name: str,
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        result = client.start(name)
    except AgentClientError as exc:
        raise _agent_error(exc) from exc
    _audit_instance_action(
        audits,
        username=user,
        action="start_instance",
        node_id=node_id,
        instance_name=name,
    )
    return result


@router.post("/{node_id}/instances/{name}/recreate")
def recreate_node_instance(
    node_id: int,
    name: str,
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        result = client.recreate(name)
    except AgentClientError as exc:
        raise _agent_error(exc) from exc
    _audit_instance_action(
        audits,
        username=user,
        action="recreate_instance",
        node_id=node_id,
        instance_name=name,
    )
    return result


@router.post("/{node_id}/instances/{name}/stop")
def stop_node_instance(
    node_id: int,
    name: str,
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        result = client.stop(name)
    except AgentClientError as exc:
        raise _agent_error(exc) from exc
    _audit_instance_action(
        audits,
        username=user,
        action="stop_instance",
        node_id=node_id,
        instance_name=name,
    )
    return result


@router.post("/{node_id}/instances/{name}/restart")
def restart_node_instance(
    node_id: int,
    name: str,
    user: Annotated[str, Depends(require_auth)],
    store: Annotated[NodeStore, Depends(node_store)],
    audits: Annotated[AuditStore, Depends(audit_store)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    client = _agent_for_node(node_id, store, agent_client_factory)
    try:
        result = client.restart(name)
    except AgentClientError as exc:
        raise _agent_error(exc) from exc
    _audit_instance_action(
        audits,
        username=user,
        action="restart_instance",
        node_id=node_id,
        instance_name=name,
    )
    return result
