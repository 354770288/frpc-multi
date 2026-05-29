from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .auth import (
    change_credentials,
    create_token,
    current_username,
    require_auth,
    require_auth_query,
    verify_credentials,
)
from .config_defaults import render_default_config
from .agent.router import router as agent_router
from .agent.service import LocalAgentService, stream_process_lines
from .control.agent_client import AgentClient
from .control.audit_store import AuditStore
from .control.node_store import NodeStore
from .control.router import audit_router, create_agent_client, router as control_router
from .models import now_iso
from .settings import settings

app = FastAPI(title="frpc 多实例管理面板", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8081", "http://localhost:8081"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

console_router = APIRouter()


class InstanceCreate(BaseModel):
    name: str = Field(..., min_length=3, max_length=40)
    displayName: str = ""
    description: str = ""
    configText: str
    enabled: bool = True
    startAfterCreate: bool = False


class ConfigUpdate(BaseModel):
    configText: str
    restartAfterSave: bool = False


class InstancePatch(BaseModel):
    displayName: str | None = None
    description: str | None = None
    enabled: bool | None = None
    applyImmediately: bool = True


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    currentUsername: str
    currentPassword: str
    newUsername: str
    newPassword: str


@console_router.post("/api/auth/login")
def login(payload: LoginRequest):
    if not verify_credentials(payload.username, payload.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")
    return create_token(current_username())


@console_router.get("/api/auth/me")
def whoami(user: Annotated[str, Depends(require_auth)]):
    return {"username": user, "tokenTtlSeconds": settings.token_ttl_seconds}


@console_router.post("/api/auth/change-password")
def change_password(
    payload: ChangePasswordRequest,
    _: Annotated[str, Depends(require_auth)],
):
    try:
        new_user = change_credentials(
            payload.currentUsername,
            payload.currentPassword,
            payload.newUsername,
            payload.newPassword,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return create_token(new_user)


def local_agent() -> LocalAgentService:
    return LocalAgentService(settings.project_dir)


def record_local_instance_action(
    *,
    username: str,
    action: str,
    instance_name: str | None,
    message: str = "",
) -> None:
    AuditStore(settings.database_path).create_log(
        username=username,
        action=action,
        node_id=None,
        instance_name=instance_name,
        success=True,
        message=message,
    )


@console_router.get("/api/system")
def get_system(
    user: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    return agent.get_system(username=user)


@console_router.get("/api/instances")
def list_instances(
    _: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    return agent.list_instances()


@console_router.post("/api/instances")
def create_instance(
    payload: InstanceCreate,
    user: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    result = agent.create_instance(
        name=payload.name,
        display_name=payload.displayName,
        config_text=payload.configText,
        enabled=payload.enabled,
        description=payload.description,
        start_after_create=payload.startAfterCreate,
    )
    record_local_instance_action(
        username=user,
        action="create_instance",
        instance_name=result.get("name") or payload.name,
    )
    return result


@console_router.get("/api/instances/{name}")
def get_instance(
    name: str,
    _: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    return agent.get_instance(name)


@console_router.delete("/api/instances/{name}")
def delete_instance(
    name: str,
    user: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    result = agent.delete_instance(name)
    record_local_instance_action(
        username=user,
        action="delete_instance",
        instance_name=name,
    )
    return result


@console_router.patch("/api/instances/{name}")
def patch_instance(
    name: str,
    payload: InstancePatch,
    user: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    result = agent.patch_instance(
        name,
        display_name=payload.displayName,
        description=payload.description,
        enabled=payload.enabled,
        apply_immediately=payload.applyImmediately,
    )
    record_local_instance_action(
        username=user,
        action="patch_instance",
        instance_name=name,
    )
    return result


@console_router.get("/api/instances/{name}/config")
def get_config(
    name: str,
    _: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    return agent.get_config(name)


@console_router.put("/api/instances/{name}/config")
def update_config(
    name: str,
    payload: ConfigUpdate,
    user: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    result = agent.update_config(name, payload.configText, payload.restartAfterSave)
    record_local_instance_action(
        username=user,
        action="update_config",
        instance_name=name,
    )
    return result


@console_router.post("/api/instances/{name}/config/validate")
async def validate_config(
    name: str,
    request: Request,
    _: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    body = await request.body()
    return agent.validate_config(name, body.decode("utf-8"))


@console_router.get("/api/config/default")
def default_config(_: Annotated[str, Depends(require_auth)], name: str | None = None):
    try:
        text = render_default_config(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"configText": text}


@console_router.get("/api/instances/{name}/logs")
def get_logs(
    name: str,
    _: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
    tail: int = Query(default=300, ge=1, le=1000),
    keyword: str = "",
):
    return agent.get_logs(name, tail, keyword)


@console_router.get("/api/instances/{name}/logs/stream")
async def stream_logs(
    name: str,
    request: Request,
    _: Annotated[str, Depends(require_auth_query)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
    tail: int = Query(default=100, ge=0, le=1000),
    keyword: str = "",
):
    argv = agent.logs_follow_args(name, tail)
    return StreamingResponse(
        stream_process_lines(request, argv, settings.project_dir, keyword),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@console_router.post("/api/instances/{name}/start")
def start_instance(
    name: str,
    user: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    result = agent.start_instance(name)
    record_local_instance_action(
        username=user,
        action="start_instance",
        instance_name=name,
    )
    return result


@console_router.post("/api/instances/{name}/stop")
def stop_instance(
    name: str,
    user: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    result = agent.stop_instance(name)
    record_local_instance_action(
        username=user,
        action="stop_instance",
        instance_name=name,
    )
    return result


@console_router.post("/api/instances/{name}/restart")
def restart_instance(
    name: str,
    user: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    result = agent.restart_instance(name)
    record_local_instance_action(
        username=user,
        action="restart_instance",
        instance_name=name,
    )
    return result


@console_router.post("/api/instances/{name}/recreate")
def recreate_instance(
    name: str,
    user: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    result = agent.recreate_instance(name)
    record_local_instance_action(
        username=user,
        action="recreate_instance",
        instance_name=name,
    )
    return result


@console_router.get("/api/stats")
def get_stats(
    _: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    return agent.get_stats()


@console_router.post("/api/compose/regenerate")
def regenerate(
    _: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    return agent.regenerate_compose()


@console_router.get("/api/summary")
def summary(
    _: Annotated[str, Depends(require_auth)],
    agent: Annotated[LocalAgentService, Depends(local_agent)],
    agent_client_factory: Annotated[type[AgentClient], Depends(create_agent_client)],
):
    store = NodeStore(settings.database_path)
    nodes = store.list_nodes()
    if not nodes:
        return agent.get_summary()

    totals = {"total": 0, "running": 0, "stopped": 0, "error": 0}
    instances: list[dict] = []
    node_summaries: list[dict] = []

    for node in nodes:
        client = agent_client_factory(node.base_url, node.token)
        try:
            data = client.summary()
        except Exception as exc:
            updated = store.update_node(node.id, status="offline") or node
            node_summaries.append(
                {
                    "id": updated.id,
                    "name": updated.name,
                    "baseUrl": updated.base_url,
                    "status": "offline",
                    "lastSeenAt": updated.last_seen_at,
                    "error": str(exc),
                    "total": 0,
                    "running": 0,
                    "stopped": 0,
                    "errorCount": 0,
                }
            )
            continue

        updated = store.update_node(node.id, status="online", last_seen_at=now_iso()) or node
        for key in totals:
            totals[key] += int(data.get(key, 0) or 0)
        for item in data.get("instances", []):
            instances.append({**item, "nodeId": node.id, "nodeName": node.name})
        node_summaries.append(
            {
                "id": updated.id,
                "name": updated.name,
                "baseUrl": updated.base_url,
                "status": "online",
                "lastSeenAt": updated.last_seen_at,
                "total": int(data.get("total", 0) or 0),
                "running": int(data.get("running", 0) or 0),
                "stopped": int(data.get("stopped", 0) or 0),
                "errorCount": int(data.get("error", 0) or 0),
            }
        )

    return {
        **totals,
        "dockerAvailable": all(node["status"] == "online" for node in node_summaries),
        "dockerError": "" if all(node["status"] == "online" for node in node_summaries) else "部分节点离线",
        "instances": instances,
        "nodes": node_summaries,
    }


@console_router.get("/api/health")
def health(_: Annotated[str, Depends(require_auth)]):
    return {"ok": True}


if settings.include_console_api:
    app.include_router(console_router)
    app.include_router(control_router)
    app.include_router(audit_router)

if settings.include_agent_api:
    app.include_router(agent_router)

static_dir = Path(__file__).resolve().parents[1] / "static"
if settings.serve_frontend and static_dir.exists():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
