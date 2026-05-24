from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from .instance_store import validate_instance_name


class DockerService:
    def __init__(self, project_dir: Path):
        self.project_dir = Path(project_dir)

    def _run(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            args,
            cwd=self.project_dir,
            check=False,
            text=True,
            capture_output=True,
        )

    def compose(self, *args: str) -> subprocess.CompletedProcess[str]:
        base = ["docker", "compose", "-f", "compose.yaml", "-f", "compose.generated.yaml"]
        return self._run(base + list(args))

    def service_name(self, instance_name: str) -> str:
        return f"frpc-{validate_instance_name(instance_name)}"

    def ps(self) -> subprocess.CompletedProcess[str]:
        return self.compose("ps", "-a", "--format", "json")

    def stats(self) -> subprocess.CompletedProcess[str]:
        return self._run(
            [
                "docker",
                "stats",
                "--no-stream",
                "--format",
                "{{json .}}",
            ]
        )

    def inspect(self, container_id: str) -> subprocess.CompletedProcess[str]:
        return self._run(["docker", "inspect", container_id])

    def logs(self, instance_name: str, tail: int = 300) -> subprocess.CompletedProcess[str]:
        service = self.service_name(instance_name)
        safe_tail = str(max(1, min(int(tail), 1000)))
        return self.compose("logs", "--no-color", "--tail", safe_tail, service)

    def logs_follow_args(self, instance_name: str, tail: int = 100) -> list[str]:
        """Return the full ``docker compose`` argv for ``logs -f --tail N`` of one service."""
        service = self.service_name(instance_name)
        safe_tail = str(max(0, min(int(tail), 1000)))
        return [
            "docker",
            "compose",
            "-f",
            "compose.yaml",
            "-f",
            "compose.generated.yaml",
            "logs",
            "--no-color",
            "--no-log-prefix",
            "--follow",
            "--tail",
            safe_tail,
            service,
        ]

    def start(self, instance_name: str) -> subprocess.CompletedProcess[str]:
        return self.compose("up", "-d", self.service_name(instance_name))

    def stop(self, instance_name: str) -> subprocess.CompletedProcess[str]:
        return self.compose("stop", self.service_name(instance_name))

    def restart(self, instance_name: str) -> subprocess.CompletedProcess[str]:
        return self.compose("restart", self.service_name(instance_name))

    def recreate(self, instance_name: str) -> subprocess.CompletedProcess[str]:
        return self.compose("up", "-d", "--no-deps", "--force-recreate", self.service_name(instance_name))

    def collect_status(self) -> dict[str, Any]:
        ps_result = self.ps()
        stats_result = self.stats()

        available = ps_result.returncode == 0
        error_message = ""
        if not available:
            error_message = (ps_result.stderr or ps_result.stdout or "").strip()

        ps_entries: list[dict[str, Any]] = []
        if available and ps_result.stdout.strip():
            stdout = ps_result.stdout.strip()
            if stdout.startswith("["):
                try:
                    ps_entries = json.loads(stdout)
                except json.JSONDecodeError:
                    ps_entries = []
            else:
                for line in stdout.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ps_entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue

        stats_by_name: dict[str, dict[str, Any]] = {}
        if stats_result.returncode == 0 and stats_result.stdout.strip():
            for line in stats_result.stdout.strip().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                container_name = payload.get("Name") or payload.get("Container") or ""
                if container_name:
                    stats_by_name[container_name] = payload

        containers: dict[str, dict[str, Any]] = {}
        for entry in ps_entries:
            service = entry.get("Service") or ""
            container_name = entry.get("Name") or ""
            container_id = entry.get("ID") or entry.get("Id") or ""
            if not service.startswith("frpc-") or service == "frpc-webui":
                continue
            instance = service[len("frpc-"):]
            stat = stats_by_name.get(container_name) or {}
            restarts = self._inspect_restart_count(container_id) if container_id else 0
            containers[instance] = {
                "service": service,
                "containerName": container_name,
                "containerId": container_id,
                "state": (entry.get("State") or "").lower(),
                "status": entry.get("Status") or "",
                "health": entry.get("Health") or "",
                "exitCode": entry.get("ExitCode"),
                "cpuPercent": stat.get("CPUPerc") or "",
                "memUsage": stat.get("MemUsage") or "",
                "memPercent": stat.get("MemPerc") or "",
                "netIO": stat.get("NetIO") or "",
                "blockIO": stat.get("BlockIO") or "",
                "pids": stat.get("PIDs") or "",
                "restartCount": restarts,
            }
        return {"available": available, "error": error_message, "containers": containers}

    def _inspect_restart_count(self, container_id: str) -> int:
        result = self.inspect(container_id)
        if result.returncode != 0 or not result.stdout.strip():
            return 0
        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError:
            return 0
        if not data:
            return 0
        first = data[0] if isinstance(data, list) else data
        state = first.get("State", {}) if isinstance(first, dict) else {}
        return int(state.get("RestartCount", 0) or 0)
