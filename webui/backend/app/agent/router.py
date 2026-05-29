from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..settings import settings
from .auth import require_agent_auth
from .service import LocalAgentService, stream_process_lines

router = APIRouter(prefix="/agent", dependencies=[Depends(require_agent_auth)])


class AgentInstanceCreate(BaseModel):
    name: str = Field(..., min_length=3, max_length=40)
    displayName: str = ""
    description: str = ""
    configText: str
    enabled: bool = True
    startAfterCreate: bool = False


class AgentConfigUpdate(BaseModel):
    configText: str
    restartAfterSave: bool = False


class AgentInstancePatch(BaseModel):
    displayName: str | None = None
    description: str | None = None
    enabled: bool | None = None
    applyImmediately: bool = True


def local_agent() -> LocalAgentService:
    return LocalAgentService(settings.project_dir)


@router.get("/health")
def health(_: Annotated[None, Depends(require_agent_auth)]):
    return {"ok": True}


@router.get("/system")
def get_system(agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.get_system()


@router.get("/instances")
def list_instances(agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.list_instances()


@router.post("/instances")
def create_instance(
    payload: AgentInstanceCreate,
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    return agent.create_instance(
        name=payload.name,
        display_name=payload.displayName,
        config_text=payload.configText,
        enabled=payload.enabled,
        description=payload.description,
        start_after_create=payload.startAfterCreate,
    )


@router.get("/instances/{name}")
def get_instance(name: str, agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.get_instance(name)


@router.delete("/instances/{name}")
def delete_instance(name: str, agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.delete_instance(name)


@router.patch("/instances/{name}")
def patch_instance(
    name: str,
    payload: AgentInstancePatch,
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    return agent.patch_instance(
        name,
        display_name=payload.displayName,
        description=payload.description,
        enabled=payload.enabled,
        apply_immediately=payload.applyImmediately,
    )


@router.get("/instances/{name}/config")
def get_config(name: str, agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.get_config(name)


@router.put("/instances/{name}/config")
def update_config(
    name: str,
    payload: AgentConfigUpdate,
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    return agent.update_config(name, payload.configText, payload.restartAfterSave)


@router.post("/instances/{name}/config/validate")
async def validate_config(
    name: str,
    request: Request,
    agent: Annotated[LocalAgentService, Depends(local_agent)],
):
    body = await request.body()
    return agent.validate_config(name, body.decode("utf-8"))


@router.get("/instances/{name}/logs")
def get_logs(
    name: str,
    agent: Annotated[LocalAgentService, Depends(local_agent)],
    tail: int = Query(default=300, ge=1, le=1000),
    keyword: str = "",
):
    return agent.get_logs(name, tail, keyword)


@router.get("/instances/{name}/logs/stream")
async def stream_logs(
    name: str,
    request: Request,
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


@router.post("/instances/{name}/start")
def start_instance(name: str, agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.start_instance(name)


@router.post("/instances/{name}/stop")
def stop_instance(name: str, agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.stop_instance(name)


@router.post("/instances/{name}/restart")
def restart_instance(name: str, agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.restart_instance(name)


@router.post("/instances/{name}/recreate")
def recreate_instance(name: str, agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.recreate_instance(name)


@router.get("/stats")
def get_stats(agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.get_stats()


@router.post("/compose/regenerate")
def regenerate(agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.regenerate_compose()


@router.get("/summary")
def summary(agent: Annotated[LocalAgentService, Depends(local_agent)]):
    return agent.get_summary()
