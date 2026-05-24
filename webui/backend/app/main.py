from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Annotated, AsyncIterator

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
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
from .compose_generator import write_generated_compose
from .config_defaults import render_default_config
from .config_validator import validate_config_text
from .docker_service import DockerService
from .instance_store import InstanceStore, validate_instance_name
from .settings import settings

app = FastAPI(title="frpc 多实例管理面板", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8081", "http://localhost:8081"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.post("/api/auth/login")
def login(payload: LoginRequest):
    if not verify_credentials(payload.username, payload.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")
    return create_token(current_username())


@app.get("/api/auth/me")
def whoami(user: Annotated[str, Depends(require_auth)]):
    return {"username": user, "tokenTtlSeconds": settings.token_ttl_seconds}


@app.post("/api/auth/change-password")
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


def store() -> InstanceStore:
    return InstanceStore(settings.project_dir)


def docker() -> DockerService:
    return DockerService(settings.project_dir)


def regenerate_compose(instance_store: InstanceStore) -> None:
    write_generated_compose(settings.project_dir, instance_store.list_instances())


def command_response(result):
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail={"stdout": result.stdout, "stderr": result.stderr})
    return {"stdout": result.stdout, "stderr": result.stderr}


def _read_env_value(key: str) -> str:
    env_path = settings.project_dir / ".env"
    if not env_path.exists():
        env_path = settings.project_dir / ".env.example"
    if not env_path.exists():
        return ""
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            if name.strip() == key:
                value = value.strip()
                if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                    value = value[1:-1]
                return value
    except OSError:
        return ""
    return ""


def _docker_version() -> str:
    try:
        result = subprocess.run(
            ["docker", "version", "--format", "{{.Server.Version}}"],
            check=False,
            text=True,
            capture_output=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    if result.returncode != 0:
        return ""
    return (result.stdout or "").strip()


@app.get("/api/system")
def get_system(user: Annotated[str, Depends(require_auth)]):
    stat = shutil.disk_usage(settings.project_dir if settings.project_dir.exists() else "/")
    frp_image = _read_env_value("FRP_IMAGE")
    frp_version = ""
    if frp_image and ":" in frp_image:
        frp_version = frp_image.rsplit(":", 1)[-1]
    return {
        "projectDir": str(settings.project_dir),
        "webuiHost": settings.webui_host,
        "webuiPort": settings.webui_port,
        "version": "0.1.0",
        "username": user,
        "dockerVersion": _docker_version(),
        "frpImage": frp_image,
        "frpVersion": frp_version,
        "disk": {"total": stat.total, "used": stat.used, "free": stat.free},
    }


@app.get("/api/instances")
def list_instances(_: Annotated[str, Depends(require_auth)]):
    instance_store = store()
    records = instance_store.list_instances()
    return [
        {
            "name": record.name,
            "displayName": record.display_name,
            "enabled": record.enabled,
            "description": record.description,
            "configPath": str(record.config_path),
            "createdAt": record.created_at,
            "updatedAt": record.updated_at,
        }
        for record in records
    ]


@app.post("/api/instances")
def create_instance(payload: InstanceCreate, _: Annotated[str, Depends(require_auth)]):
    result = validate_config_text(payload.configText)
    if not result.valid:
        raise HTTPException(status_code=400, detail={"errors": result.errors, "warnings": result.warnings})
    instance_store = store()
    try:
        record = instance_store.create_instance(
            payload.name,
            payload.displayName,
            payload.configText,
            payload.enabled,
            payload.description,
        )
    except (ValueError, FileExistsError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    regenerate_compose(instance_store)
    if payload.startAfterCreate:
        command_response(docker().start(record.name))
    return {"name": record.name, "configPath": str(record.config_path)}


@app.get("/api/instances/{name}")
def get_instance(name: str, _: Annotated[str, Depends(require_auth)]):
    try:
        record = store().get_instance(name)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    validation = validate_config_text(record.config_path.read_text(encoding="utf-8"))
    return {
        "name": record.name,
        "displayName": record.display_name,
        "enabled": record.enabled,
        "description": record.description,
        "configPath": str(record.config_path),
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
        "summary": validation.summary,
        "warnings": validation.warnings,
        "errors": validation.errors,
    }


@app.delete("/api/instances/{name}")
def delete_instance(name: str, _: Annotated[str, Depends(require_auth)]):
    instance_store = store()
    service = docker()
    try:
        service.stop(name)
        instance_store.delete_instance(name)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    regenerate_compose(instance_store)
    return {"deleted": validate_instance_name(name)}


@app.patch("/api/instances/{name}")
def patch_instance(
    name: str,
    payload: InstancePatch,
    _: Annotated[str, Depends(require_auth)],
):
    instance_store = store()
    try:
        previous = instance_store.get_instance(name)
        record = instance_store.update_meta(
            name,
            display_name=payload.displayName,
            description=payload.description,
            enabled=payload.enabled,
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    enabled_changed = payload.enabled is not None and previous.enabled != record.enabled
    if enabled_changed:
        regenerate_compose(instance_store)
        if payload.applyImmediately:
            service = docker()
            if record.enabled:
                command_response(service.start(record.name))
            else:
                command_response(service.stop(record.name))

    return {
        "name": record.name,
        "displayName": record.display_name,
        "description": record.description,
        "enabled": record.enabled,
        "updatedAt": record.updated_at,
    }


@app.get("/api/instances/{name}/config")
def get_config(name: str, _: Annotated[str, Depends(require_auth)]):
    try:
        record = store().get_instance(name)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    text = record.config_path.read_text(encoding="utf-8")
    return {"configText": text, "validation": validate_config_text(text).__dict__}


@app.put("/api/instances/{name}/config")
def update_config(name: str, payload: ConfigUpdate, _: Annotated[str, Depends(require_auth)]):
    validation = validate_config_text(payload.configText)
    if not validation.valid:
        raise HTTPException(status_code=400, detail=validation.__dict__)
    instance_store = store()
    try:
        record = instance_store.update_config(name, payload.configText)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    regenerate_compose(instance_store)
    if payload.restartAfterSave:
        command_response(docker().restart(name))
    return {"configPath": str(record.config_path), "validation": validation.__dict__}


@app.post("/api/instances/{name}/config/validate")
async def validate_config(name: str, request: Request, _: Annotated[str, Depends(require_auth)]):
    validate_instance_name(name)
    body = await request.body()
    return validate_config_text(body.decode("utf-8")).__dict__


@app.get("/api/config/default")
def default_config(_: Annotated[str, Depends(require_auth)], name: str | None = None):
    try:
        text = render_default_config(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"configText": text}


@app.get("/api/instances/{name}/logs")
def get_logs(
    name: str,
    _: Annotated[str, Depends(require_auth)],
    tail: int = Query(default=300, ge=1, le=1000),
    keyword: str = "",
):
    result = docker().logs(name, tail)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr)
    lines = result.stdout.splitlines()
    if keyword:
        lines = [line for line in lines if keyword.lower() in line.lower()]
    return {"lines": lines}


def _sse_pack(event: str, data: str) -> bytes:
    chunks = [f"event: {event}\n"]
    for line in data.splitlines() or [""]:
        chunks.append(f"data: {line}\n")
    chunks.append("\n")
    return "".join(chunks).encode("utf-8")


async def _stream_docker_logs(
    request: Request, argv: list[str], cwd: Path, keyword: str
) -> AsyncIterator[bytes]:
    keyword_lower = keyword.lower() if keyword else ""
    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError:
        yield _sse_pack("error", "docker 命令不可用")
        return
    yield _sse_pack("ready", "")
    assert process.stdout is not None
    try:
        while True:
            if await request.is_disconnected():
                break
            try:
                raw = await asyncio.wait_for(process.stdout.readline(), timeout=15.0)
            except asyncio.TimeoutError:
                yield b": keepalive\n\n"
                continue
            if not raw:
                if process.returncode is not None:
                    break
                continue
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if keyword_lower and keyword_lower not in line.lower():
                continue
            yield _sse_pack("log", line)
    finally:
        if process.returncode is None:
            try:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            except ProcessLookupError:
                pass
        yield _sse_pack("end", "")


@app.get("/api/instances/{name}/logs/stream")
async def stream_logs(
    name: str,
    request: Request,
    _: Annotated[str, Depends(require_auth_query)],
    tail: int = Query(default=100, ge=0, le=1000),
    keyword: str = "",
):
    validate_instance_name(name)
    argv = docker().logs_follow_args(name, tail)
    return StreamingResponse(
        _stream_docker_logs(request, argv, settings.project_dir, keyword),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/instances/{name}/start")
def start_instance(name: str, _: Annotated[str, Depends(require_auth)]):
    return command_response(docker().start(name))


@app.post("/api/instances/{name}/stop")
def stop_instance(name: str, _: Annotated[str, Depends(require_auth)]):
    return command_response(docker().stop(name))


@app.post("/api/instances/{name}/restart")
def restart_instance(name: str, _: Annotated[str, Depends(require_auth)]):
    return command_response(docker().restart(name))


@app.post("/api/instances/{name}/recreate")
def recreate_instance(name: str, _: Annotated[str, Depends(require_auth)]):
    return command_response(docker().recreate(name))


@app.get("/api/stats")
def get_stats(_: Annotated[str, Depends(require_auth)]):
    return docker().collect_status()


@app.post("/api/compose/regenerate")
def regenerate(_: Annotated[str, Depends(require_auth)]):
    regenerate_compose(store())
    return {"path": str(settings.project_dir / "compose.generated.yaml")}


@app.get("/api/summary")
def summary(_: Annotated[str, Depends(require_auth)]):
    instances = list_instances(_)
    status = docker().collect_status()
    containers = status.get("containers", {})
    running = 0
    stopped = 0
    error = 0
    enriched: list[dict] = []
    for item in instances:
        stat = containers.get(item["name"], {})
        state = stat.get("state", "")
        if state == "running":
            running += 1
        elif state in {"exited", "dead", "removing"} and stat.get("exitCode") not in (None, 0):
            error += 1
        else:
            stopped += 1
        enriched.append({**item, "runtime": stat})
    return {
        "total": len(instances),
        "running": running,
        "stopped": stopped,
        "error": error,
        "dockerAvailable": status.get("available", False),
        "dockerError": status.get("error", ""),
        "instances": enriched,
    }


@app.get("/api/health")
def health(_: Annotated[str, Depends(require_auth)]):
    return {"ok": True}


static_dir = Path(__file__).resolve().parents[1] / "static"
if static_dir.exists():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

