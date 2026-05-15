from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path

from .instance_store import validate_instance_name


class BackupService:
    def __init__(self, project_dir: Path):
        self.project_dir = Path(project_dir)
        self.backups_dir = self.project_dir / "backups"

    def backup_config(self, instance_name: str) -> Path:
        name = validate_instance_name(instance_name)
        source = self.project_dir / "instances" / name / "frpc.toml"
        if not source.exists():
            raise FileNotFoundError(f"配置不存在: {source}")
        target_dir = self.backups_dir / name
        target_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        target = target_dir / f"{name}-{stamp}.toml"
        shutil.copy2(source, target)
        return target

    def list_backups(self, instance_name: str | None = None) -> list[dict]:
        root = self.backups_dir / validate_instance_name(instance_name) if instance_name else self.backups_dir
        if not root.exists():
            return []
        backups: list[dict] = []
        for path in sorted(root.rglob("*.toml"), reverse=True):
            stat = path.stat()
            backups.append(
                {
                    "id": str(path.relative_to(self.backups_dir)),
                    "instance": path.parent.name,
                    "path": str(path),
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                }
            )
        return backups

