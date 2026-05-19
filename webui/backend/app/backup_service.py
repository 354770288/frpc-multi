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

    def _resolve_backup(self, backup_id: str) -> Path:
        if not backup_id or ".." in backup_id.split("/") or backup_id.startswith("/"):
            raise ValueError("备份 ID 非法")
        path = (self.backups_dir / backup_id).resolve()
        backups_root = self.backups_dir.resolve()
        if not str(path).startswith(str(backups_root) + "/") and path != backups_root:
            raise ValueError("备份路径越界")
        if not path.is_file():
            raise FileNotFoundError(f"备份不存在: {backup_id}")
        return path

    def read_backup(self, backup_id: str) -> str:
        return self._resolve_backup(backup_id).read_text(encoding="utf-8")

    def delete_backup(self, backup_id: str) -> None:
        self._resolve_backup(backup_id).unlink()

    def restore_backup(self, instance_name: str, backup_id: str) -> Path:
        name = validate_instance_name(instance_name)
        source = self._resolve_backup(backup_id)
        if source.parent.name != name:
            raise ValueError("备份不属于该实例")
        target = self.project_dir / "instances" / name / "frpc.toml"
        if not target.parent.exists():
            raise FileNotFoundError(f"实例目录不存在: {target.parent}")
        if target.exists():
            self.backup_config(name)
        shutil.copy2(source, target)
        return target

