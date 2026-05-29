from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class NodeRecord:
    id: int
    name: str
    base_url: str
    token: str
    status: str
    last_seen_at: str | None
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class AuditLogRecord:
    id: int
    username: str
    action: str
    node_id: int | None
    instance_name: str | None
    success: bool
    message: str
    created_at: str
