from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .auth import (
    change_credentials,
    create_token,
    current_username,
    require_auth,
    verify_credentials,
)
from .config_defaults import render_default_config
from .control import wsproto
from .control.audit_store import AuditStore
from .control.hub import hub
from .control.node_store import NodeStore
from .control.router import audit_router, router as control_router
from .control.ws_router import ws_router
from .models import now_iso
from .settings import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Agent 角色：启动出站 WS 客户端连回主控。Console 角色：无后台任务。"""
    agent_task: asyncio.Task | None = None
    agent_client = None
    if settings.is_agent:
        from .agent.client import AgentWsClient

        agent_client = AgentWsClient()
        agent_task = asyncio.create_task(agent_client.run_forever())
    try:
        yield
    finally:
        if agent_client is not None:
            agent_client.stop()
        if agent_task is not None:
            agent_task.cancel()
            with suppress(asyncio.CancelledError):
                await agent_task


app = FastAPI(title="frpc 多实例管理面板", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

console_router = APIRouter()


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


@console_router.get("/api/config/default")
def default_config(_: Annotated[str, Depends(require_auth)], name: str | None = None):
    try:
        text = render_default_config(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"configText": text}


@console_router.get("/api/summary")
async def summary(
    _: Annotated[str, Depends(require_auth)],
):
    """跨所有节点聚合概要。反转模型下没有本机执行，全部来自在线 Agent 的上报。"""
    store = NodeStore(settings.database_path)
    nodes = store.list_nodes()

    totals = {"total": 0, "running": 0, "stopped": 0, "error": 0}
    instances: list[dict] = []
    node_summaries: list[dict] = []

    for node in nodes:
        online = hub.is_online(node.uuid)
        if not online:
            node_summaries.append(
                {
                    "id": node.id,
                    "name": node.name,
                    "uuid": node.uuid,
                    "status": node.status if node.status in {"pending", "offline"} else "offline",
                    "lastSeenAt": node.last_seen_at,
                    "total": 0,
                    "running": 0,
                    "stopped": 0,
                    "errorCount": 0,
                }
            )
            continue
        try:
            data = await hub.get(node.uuid).call(wsproto.M_SUMMARY, timeout=10.0)
        except Exception as exc:  # noqa: BLE001
            store.update_node(node.id, status="offline")
            node_summaries.append(
                {
                    "id": node.id,
                    "name": node.name,
                    "uuid": node.uuid,
                    "status": "offline",
                    "lastSeenAt": node.last_seen_at,
                    "error": str(exc),
                    "total": 0,
                    "running": 0,
                    "stopped": 0,
                    "errorCount": 0,
                }
            )
            continue

        store.update_node(node.id, status="online", last_seen_at=now_iso())
        for key in totals:
            totals[key] += int(data.get(key, 0) or 0)
        for item in data.get("instances", []):
            instances.append({**item, "nodeId": node.id, "nodeName": node.name})
        node_summaries.append(
            {
                "id": node.id,
                "name": node.name,
                "uuid": node.uuid,
                "status": "online",
                "lastSeenAt": now_iso(),
                "total": int(data.get("total", 0) or 0),
                "running": int(data.get("running", 0) or 0),
                "stopped": int(data.get("stopped", 0) or 0),
                "errorCount": int(data.get("error", 0) or 0),
            }
        )

    online_nodes = [n for n in node_summaries if n["status"] == "online"]
    return {
        **totals,
        "nodeCount": len(nodes),
        "onlineCount": len(online_nodes),
        "dockerAvailable": len(online_nodes) > 0,
        "dockerError": "" if len(online_nodes) == len(nodes) else "部分节点离线",
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
    app.include_router(ws_router)

static_dir = Path(__file__).resolve().parents[1] / "static"
if settings.serve_frontend and static_dir.exists():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
