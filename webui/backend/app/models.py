from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


@dataclass(frozen=True)
class InstanceMeta:
    name: str
    displayName: str
    createdAt: str
    updatedAt: str
    enabled: bool = True
    description: str = ""


@dataclass(frozen=True)
class InstanceRecord:
    name: str
    display_name: str
    enabled: bool
    description: str
    config_path: Path
    meta_path: Path
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class ValidationResult:
    valid: bool
    errors: list[str]
    warnings: list[str]
    summary: dict

