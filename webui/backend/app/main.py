from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .auth import create_token, require_auth, verify_credentials
from .backup_service import BackupService
from .compose_generator import write_generated_compose
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
    backupBeforeSave: bool = True
    recreateAfterSave: bool = False


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
def login(payload: LoginRequest):
    if not verify_credentials(payload.username, payload.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")
    return create_token(payload.username)


@app.get("/api/auth/me")
def whoami(user: Annotated[str, Depends(require_auth)]):
    return {"username": user, "tokenTtlSeconds": settings.token_ttl_seconds}


def store() -> InstanceStore:
    return InstanceStore(settings.project_dir)


def docker() -> DockerService:
    return DockerService(settings.project_dir)


def backups() -> BackupService:
    return BackupService(settings.project_dir)


def regenerate_compose(instance_store: InstanceStore) -> None:
    write_generated_compose(settings.project_dir, instance_store.list_instances())


def command_response(result):
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail={"stdout": result.stdout, "stderr": result.stderr})
    return {"stdout": result.stdout, "stderr": result.stderr}


@app.get("/api/system")
def get_system(_: Annotated[str, Depends(require_auth)]):
    stat = shutil.disk_usage(settings.project_dir if settings.project_dir.exists() else "/")
    return {
        "projectDir": str(settings.project_dir),
        "webuiHost": settings.webui_host,
        "webuiPort": settings.webui_port,
        "version": "0.1.0",
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
    if payload.backupBeforeSave:
        backups().backup_config(name)
    try:
        record = instance_store.update_config(name, payload.configText)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    regenerate_compose(instance_store)
    if payload.recreateAfterSave:
        command_response(docker().recreate(name))
    return {"configPath": str(record.config_path), "validation": validation.__dict__}


@app.post("/api/instances/{name}/config/validate")
async def validate_config(name: str, request: Request, _: Annotated[str, Depends(require_auth)]):
    validate_instance_name(name)
    body = await request.body()
    return validate_config_text(body.decode("utf-8")).__dict__


@app.post("/api/instances/{name}/config/backup")
def backup_config(name: str, _: Annotated[str, Depends(require_auth)]):
    path = backups().backup_config(name)
    return {"path": str(path)}


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


@app.get("/api/backups")
def list_backups(_: Annotated[str, Depends(require_auth)], instance: str | None = None):
    return backups().list_backups(instance)


@app.post("/api/compose/regenerate")
def regenerate(_: Annotated[str, Depends(require_auth)]):
    regenerate_compose(store())
    return {"path": str(settings.project_dir / "compose.generated.yaml")}


@app.get("/api/summary")
def summary(_: Annotated[str, Depends(require_auth)]):
    instances = list_instances(_)
    running = 0
    stopped = 0
    error = 0
    return {
        "total": len(instances),
        "running": running,
        "stopped": stopped,
        "error": error,
        "instances": instances,
    }


@app.get("/api/health")
def health(_: Annotated[str, Depends(require_auth)]):
    return {"ok": True}


static_dir = Path(__file__).resolve().parents[1] / "static"
if static_dir.exists():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

