from __future__ import annotations

import json
import re
from pathlib import Path

from .models import InstanceRecord, now_iso

INSTANCE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$")

# frpc 实例容器跑在独立 bridge 网络里，容器内的 127.0.0.1 是容器自身而非宿主机；
# compose 已为容器注入 host.docker.internal → host-gateway（宿主机网关，与网段无关）。
# 写入配置时把回环 localIP 统一改写为 host.docker.internal，用户填的「本机」即宿主机。
HOST_LOCAL_IP = "host.docker.internal"
LOOPBACK_LOCAL_IPS = frozenset({"127.0.0.1", "localhost", "::1"})
_LOCAL_IP_LINE_RE = re.compile(
    r'^(?P<prefix>\s*localIP\s*=\s*)(?P<quote>["\']?)(?P<value>[^"\'\s#]+)(?P=quote)(?P<suffix>.*)$',
    re.MULTILINE,
)


def rewrite_loopback_local_ip(config_text: str) -> str:
    """把回环 localIP（127.0.0.1 / localhost / ::1）改写为 host.docker.internal。"""

    def replace(match: re.Match) -> str:
        if match.group("value") not in LOOPBACK_LOCAL_IPS:
            return match.group(0)
        return f'{match.group("prefix")}"{HOST_LOCAL_IP}"{match.group("suffix")}'

    return _LOCAL_IP_LINE_RE.sub(replace, config_text)


def validate_instance_name(name: str) -> str:
    normalized = name.strip()
    if not INSTANCE_RE.fullmatch(normalized):
        raise ValueError("实例名只能包含小写字母、数字和短横线，长度 3-40，且不能以短横线开头或结尾")
    return normalized


class InstanceStore:
    def __init__(self, project_dir: Path):
        self.project_dir = Path(project_dir)
        self.instances_dir = self.project_dir / "instances"

    def ensure_dirs(self) -> None:
        self.instances_dir.mkdir(parents=True, exist_ok=True)
        (self.project_dir / "backups").mkdir(parents=True, exist_ok=True)

    def instance_dir(self, name: str) -> Path:
        return self.instances_dir / validate_instance_name(name)

    def get_instance(self, name: str) -> InstanceRecord:
        instance_dir = self.instance_dir(name)
        meta_path = instance_dir / "meta.json"
        config_path = instance_dir / "frpc.toml"
        if not meta_path.exists() or not config_path.exists():
            raise FileNotFoundError(f"实例不存在: {name}")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return InstanceRecord(
            name=meta["name"],
            display_name=meta.get("displayName") or meta["name"],
            enabled=bool(meta.get("enabled", True)),
            description=meta.get("description", ""),
            config_path=config_path,
            meta_path=meta_path,
            created_at=meta.get("createdAt", ""),
            updated_at=meta.get("updatedAt", ""),
        )

    def list_instances(self) -> list[InstanceRecord]:
        self.ensure_dirs()
        records: list[InstanceRecord] = []
        for meta_path in sorted(self.instances_dir.glob("*/meta.json")):
            try:
                records.append(self.get_instance(meta_path.parent.name))
            except (FileNotFoundError, json.JSONDecodeError, KeyError, ValueError):
                continue
        return records

    def create_instance(
        self,
        name: str,
        display_name: str,
        config_text: str,
        enabled: bool = True,
        description: str = "",
    ) -> InstanceRecord:
        name = validate_instance_name(name)
        self.ensure_dirs()
        instance_dir = self.instance_dir(name)
        if instance_dir.exists():
            raise FileExistsError(f"实例已存在: {name}")

        instance_dir.mkdir(parents=True)
        timestamp = now_iso()
        display_name = display_name.strip() or name
        meta = {
            "name": name,
            "displayName": display_name,
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "enabled": enabled,
            "description": description,
        }
        (instance_dir / "frpc.toml").write_text(
            rewrite_loopback_local_ip(config_text), encoding="utf-8")
        (instance_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return self.get_instance(name)

    def update_config(self, name: str, config_text: str) -> InstanceRecord:
        record = self.get_instance(name)
        record.config_path.write_text(rewrite_loopback_local_ip(config_text), encoding="utf-8")
        meta = json.loads(record.meta_path.read_text(encoding="utf-8"))
        meta["updatedAt"] = now_iso()
        record.meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return self.get_instance(name)

    def update_meta(
        self,
        name: str,
        *,
        display_name: str | None = None,
        description: str | None = None,
        enabled: bool | None = None,
    ) -> InstanceRecord:
        record = self.get_instance(name)
        meta = json.loads(record.meta_path.read_text(encoding="utf-8"))
        if display_name is not None:
            stripped = display_name.strip()
            meta["displayName"] = stripped or meta["name"]
        if description is not None:
            meta["description"] = description
        if enabled is not None:
            meta["enabled"] = bool(enabled)
        meta["updatedAt"] = now_iso()
        record.meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return self.get_instance(name)

    def delete_instance(self, name: str) -> None:
        instance_dir = self.instance_dir(name)
        if not instance_dir.exists():
            raise FileNotFoundError(f"实例不存在: {name}")
        for path in sorted(instance_dir.rglob("*"), reverse=True):
            if path.is_file() or path.is_symlink():
                path.unlink()
            elif path.is_dir():
                path.rmdir()
        instance_dir.rmdir()

