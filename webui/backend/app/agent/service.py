from __future__ import annotations

import asyncio
import shutil
import subprocess
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import HTTPException, Request

from ..compose_generator import write_generated_compose
from ..config_validator import validate_config_text
from ..docker_service import DockerService
from ..instance_store import InstanceStore, validate_instance_name
from ..settings import settings


def command_response(result: subprocess.CompletedProcess[str]) -> dict[str, str]:
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail={"stdout": result.stdout, "stderr": result.stderr})
    return {"stdout": result.stdout, "stderr": result.stderr}


def sse_pack(event: str, data: str) -> bytes:
    chunks = [f"event: {event}\n"]
    for line in data.splitlines() or [""]:
        chunks.append(f"data: {line}\n")
    chunks.append("\n")
    return "".join(chunks).encode("utf-8")


async def stream_process_lines(
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
        yield sse_pack("error", "docker 命令不可用")
        return
    yield sse_pack("ready", "")
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
            yield sse_pack("log", line)
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
        yield sse_pack("end", "")


class LocalAgentService:
    def __init__(self, project_dir: Path | None = None):
        self.project_dir = Path(project_dir or settings.project_dir)

    @property
    def store(self) -> InstanceStore:
        return InstanceStore(self.project_dir)

    @property
    def docker(self) -> DockerService:
        return DockerService(self.project_dir)

    def _regenerate_compose(self, instance_store: InstanceStore | None = None) -> Path:
        active_store = instance_store or self.store
        return write_generated_compose(self.project_dir, active_store.list_instances())

    def _record_payload(self, record) -> dict[str, Any]:
        return {
            "name": record.name,
            "displayName": record.display_name,
            "enabled": record.enabled,
            "description": record.description,
            "configPath": str(record.config_path),
            "createdAt": record.created_at,
            "updatedAt": record.updated_at,
        }

    def read_env_value(self, key: str) -> str:
        env_path = self.project_dir / ".env"
        if not env_path.exists():
            env_path = self.project_dir / ".env.example"
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
                    if (value.startswith('"') and value.endswith('"')) or (
                        value.startswith("'") and value.endswith("'")
                    ):
                        value = value[1:-1]
                    return value
        except OSError:
            return ""
        return ""

    def docker_version(self) -> str:
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

    def get_system(self, username: str = "") -> dict[str, Any]:
        stat = shutil.disk_usage(self.project_dir if self.project_dir.exists() else "/")
        frp_image = self.read_env_value("FRP_IMAGE")
        frp_version = frp_image.rsplit(":", 1)[-1] if frp_image and ":" in frp_image else ""
        payload = {
            "projectDir": str(self.project_dir),
            "webuiHost": settings.webui_host,
            "webuiPort": settings.webui_port,
            "version": "0.1.0",
            "dockerVersion": self.docker_version(),
            "frpImage": frp_image,
            "frpVersion": frp_version,
            "disk": {"total": stat.total, "used": stat.used, "free": stat.free},
        }
        if username:
            payload["username"] = username
        return payload

    def list_instances(self) -> list[dict[str, Any]]:
        return [self._record_payload(record) for record in self.store.list_instances()]

    def create_instance(
        self,
        *,
        name: str,
        display_name: str,
        config_text: str,
        enabled: bool,
        description: str,
        start_after_create: bool,
    ) -> dict[str, str]:
        result = validate_config_text(config_text)
        if not result.valid:
            raise HTTPException(status_code=400, detail={"errors": result.errors, "warnings": result.warnings})
        instance_store = self.store
        try:
            record = instance_store.create_instance(name, display_name, config_text, enabled, description)
        except (ValueError, FileExistsError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        self._regenerate_compose(instance_store)
        if start_after_create:
            command_response(self.docker.start(record.name))
        return {"name": record.name, "configPath": str(record.config_path)}

    def get_instance(self, name: str) -> dict[str, Any]:
        try:
            record = self.store.get_instance(name)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        validation = validate_config_text(record.config_path.read_text(encoding="utf-8"))
        return {
            **self._record_payload(record),
            "summary": validation.summary,
            "warnings": validation.warnings,
            "errors": validation.errors,
        }

    def delete_instance(self, name: str) -> dict[str, str]:
        instance_store = self.store
        try:
            self.docker.stop(name)
            instance_store.delete_instance(name)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        self._regenerate_compose(instance_store)
        return {"deleted": validate_instance_name(name)}

    def patch_instance(
        self,
        name: str,
        *,
        display_name: str | None,
        description: str | None,
        enabled: bool | None,
        apply_immediately: bool,
    ) -> dict[str, Any]:
        instance_store = self.store
        try:
            previous = instance_store.get_instance(name)
            record = instance_store.update_meta(
                name,
                display_name=display_name,
                description=description,
                enabled=enabled,
            )
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        enabled_changed = enabled is not None and previous.enabled != record.enabled
        if enabled_changed:
            self._regenerate_compose(instance_store)
            if apply_immediately:
                if record.enabled:
                    command_response(self.docker.start(record.name))
                else:
                    command_response(self.docker.stop(record.name))

        return {
            "name": record.name,
            "displayName": record.display_name,
            "description": record.description,
            "enabled": record.enabled,
            "updatedAt": record.updated_at,
        }

    def get_config(self, name: str) -> dict[str, Any]:
        try:
            record = self.store.get_instance(name)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        text = record.config_path.read_text(encoding="utf-8")
        return {"configText": text, "validation": validate_config_text(text).__dict__}

    def update_config(self, name: str, config_text: str, restart_after_save: bool) -> dict[str, Any]:
        validation = validate_config_text(config_text)
        if not validation.valid:
            raise HTTPException(status_code=400, detail=validation.__dict__)
        instance_store = self.store
        try:
            record = instance_store.update_config(name, config_text)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        self._regenerate_compose(instance_store)
        if restart_after_save:
            command_response(self.docker.restart(name))
        return {"configPath": str(record.config_path), "validation": validation.__dict__}

    def validate_config(self, name: str, config_text: str) -> dict[str, Any]:
        validate_instance_name(name)
        return validate_config_text(config_text).__dict__

    def get_logs(self, name: str, tail: int, keyword: str = "") -> dict[str, list[str]]:
        result = self.docker.logs(name, tail)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr)
        lines = result.stdout.splitlines()
        if keyword:
            lines = [line for line in lines if keyword.lower() in line.lower()]
        return {"lines": lines}

    def logs_follow_args(self, name: str, tail: int) -> list[str]:
        validate_instance_name(name)
        return self.docker.logs_follow_args(name, tail)

    def start_instance(self, name: str) -> dict[str, str]:
        return command_response(self.docker.start(name))

    def stop_instance(self, name: str) -> dict[str, str]:
        return command_response(self.docker.stop(name))

    def restart_instance(self, name: str) -> dict[str, str]:
        return command_response(self.docker.restart(name))

    def recreate_instance(self, name: str) -> dict[str, str]:
        return command_response(self.docker.recreate(name))

    def get_stats(self) -> dict[str, Any]:
        return self.docker.collect_status()

    def regenerate_compose(self) -> dict[str, str]:
        path = self._regenerate_compose()
        return {"path": str(path)}

    def get_summary(self) -> dict[str, Any]:
        instances = self.list_instances()
        status = self.docker.collect_status()
        containers = status.get("containers", {})
        running = 0
        stopped = 0
        error = 0
        enriched: list[dict[str, Any]] = []
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
