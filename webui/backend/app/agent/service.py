from __future__ import annotations

import asyncio
import os
import secrets
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


AGENT_UPGRADE_HELPER = r"""
import json
import subprocess
import sys
import time


def run(args):
    subprocess.run(args, check=True)


target = sys.argv[1]
time.sleep(1.5)
info = json.loads(subprocess.check_output(["docker", "inspect", target], text=True))[0]
config = info.get("Config") or {}
host_config = info.get("HostConfig") or {}
image = config.get("Image")
name = (info.get("Name") or target).lstrip("/")
if not image or not name:
    raise SystemExit("missing image or container name")

run(["docker", "pull", image])

args = ["docker", "run", "-d", "--name", name]
restart = host_config.get("RestartPolicy") or {}
restart_name = restart.get("Name") or ""
retry_count = int(restart.get("MaximumRetryCount") or 0)
if restart_name and restart_name != "no":
    value = f"{restart_name}:{retry_count}" if restart_name == "on-failure" and retry_count else restart_name
    args.extend(["--restart", value])

network_mode = (host_config.get("NetworkMode") or "").strip()
if network_mode and network_mode not in {"default", "bridge"}:
    args.extend(["--network", network_mode])

for item in config.get("Env") or []:
    args.extend(["-e", item])

for key, value in (config.get("Labels") or {}).items():
    args.extend(["--label", f"{key}={value}"])

for mount in info.get("Mounts") or []:
    source = mount.get("Source")
    destination = mount.get("Destination")
    if not source or not destination:
        continue
    mode = mount.get("Mode") or ""
    if not mode and not mount.get("RW", True):
        mode = "ro"
    volume = f"{source}:{destination}" + (f":{mode}" if mode else "")
    args.extend(["-v", volume])

working_dir = config.get("WorkingDir") or ""
if working_dir:
    args.extend(["-w", working_dir])

args.append(image)
run(["docker", "rm", "-f", target])
run(args)
"""


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

    def ensure_ready(self) -> None:
        """Agent 启动时确保运行所需的文件就绪。

        纯镜像部署（named volume 为空、无源码）时，``/opt/frpc-multi`` 里既没有 base
        ``compose.yaml`` 也没有 ``compose.generated.yaml``。此时即使还没有任何实例，
        心跳/概要里的 ``docker compose ps`` 也会因缺文件失败。这里先把目录、base
        compose 和（基于现有 instances 的）generated compose 都铺好。
        """
        self.store.ensure_dirs()
        self._regenerate_compose()

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
        # 优先读进程环境变量：一键 docker run 装的 Agent 没有 .env 文件，FRP_IMAGE 等靠 -e 注入。
        env_value = os.getenv(key, "").strip()
        if env_value:
            return env_value
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

    def _current_agent_image(self, container: str) -> str:
        try:
            result = subprocess.run(
                ["docker", "inspect", "--format", "{{.Config.Image}}", container],
                check=False,
                text=True,
                capture_output=True,
                timeout=10,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(status_code=500, detail=f"读取 Agent 容器镜像失败: {exc}") from exc
        image = (result.stdout or "").strip()
        if result.returncode != 0 or not image:
            detail = (result.stderr or result.stdout or "无法读取当前 Agent 容器镜像").strip()
            raise HTTPException(status_code=500, detail=detail)
        return image

    def schedule_agent_upgrade(self) -> dict[str, Any]:
        """发起 docker run 模式的 Agent 自升级。

        前端一键安装命令创建的 Agent 容器不归 compose.agent.yaml 管理，因此升级不能走
        docker compose。这里启动一个临时 helper 容器，由 helper 通过宿主 docker.sock
        inspect 当前 Agent，拉取同镜像标签最新版，并用原 env/volume/restart policy 重建同名容器。
        """
        target = os.getenv("HOSTNAME", "").strip()
        if not target:
            raise HTTPException(status_code=500, detail="无法识别当前 Agent 容器")
        image = self._current_agent_image(target)
        helper_name = f"frpc-agent-upgrader-{secrets.token_hex(4)}"
        argv = [
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            helper_name,
            "-v",
            "/var/run/docker.sock:/var/run/docker.sock",
            image,
            "python",
            "-c",
            AGENT_UPGRADE_HELPER,
            target,
        ]
        try:
            subprocess.Popen(  # noqa: S603 - argv is fixed; only Docker executes the helper container.
                argv,
                cwd=str(self.project_dir),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=500, detail="docker 命令不可用") from exc
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"启动升级 helper 失败: {exc}") from exc
        return {
            "accepted": True,
            "mode": "docker-run",
            "targetContainer": target,
            "helperContainer": helper_name,
            "image": image,
        }

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

    def decommission(self) -> dict[str, Any]:
        """注销本节点：停掉并移除所有 frpc 实例容器，删除全部实例配置目录。

        删节点时由 Console 下发。容器自毁（docker rm 掉 agent 自身）由调用方（AgentWsClient）
        在本方法返回后处理，因为那需要操作 agent 自己的容器。
        """
        # 1. 停掉并移除所有 frpc 实例容器（compose down 会按 generated 里的服务清理）。
        self.docker.compose("down", "--remove-orphans")
        # 2. 删除所有实例配置目录。
        removed: list[str] = []
        store = self.store
        for record in store.list_instances():
            try:
                store.delete_instance(record.name)
                removed.append(record.name)
            except (ValueError, FileNotFoundError):
                continue
        # 3. 重新生成空的 generated compose。
        self._regenerate_compose(store)
        return {"removedInstances": removed}
