from __future__ import annotations

import subprocess
from pathlib import Path

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
        return self.compose("ps", "--format", "json")

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

    def logs(self, instance_name: str, tail: int = 300) -> subprocess.CompletedProcess[str]:
        service = self.service_name(instance_name)
        safe_tail = str(max(1, min(int(tail), 1000)))
        return self.compose("logs", "--no-color", "--tail", safe_tail, service)

    def start(self, instance_name: str) -> subprocess.CompletedProcess[str]:
        return self.compose("up", "-d", self.service_name(instance_name))

    def stop(self, instance_name: str) -> subprocess.CompletedProcess[str]:
        return self.compose("stop", self.service_name(instance_name))

    def restart(self, instance_name: str) -> subprocess.CompletedProcess[str]:
        return self.compose("restart", self.service_name(instance_name))

    def recreate(self, instance_name: str) -> subprocess.CompletedProcess[str]:
        return self.compose("up", "-d", "--no-deps", "--force-recreate", self.service_name(instance_name))

