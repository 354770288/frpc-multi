"""/api/lb/*：负载均衡（Cloudflare DDNS，单 A 主备模式）。

候选域名绑定服务器库分组；同步把该域名收敛为**一条**托管 A 记录，
指向池内最优健康 IP（健康监测见 lb.health）。变更操作写审计（lb_* 前缀）。
"""

from __future__ import annotations

import threading
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..auth import require_auth
from ..probe.store import ProbeStore
from ..settings import settings
from .cloudflare import CloudflareClient, CloudflareError
from .store import LbStore, validate_domain_name
from .syncer import summarize, sync_domain

router = APIRouter(prefix="/api/lb", dependencies=[Depends(require_auth)])


def lb_store() -> LbStore:
    return LbStore(settings.database_path)


def probe_store() -> ProbeStore:
    return ProbeStore(settings.database_path)


def audit(username: str, action: str, *, success: bool = True, message: str = "") -> None:
    from ..control.audit_store import AuditStore

    AuditStore(settings.database_path).create_log(
        username=username, action=action, success=success, message=message,
    )


def _mask_token(token: str) -> str:
    if len(token) <= 8:
        return "*" * len(token)
    return f"{token[:4]}…{token[-4:]}"


def _cf_client(token: str) -> CloudflareClient:
    """测试通过替换此函数注入 fake 客户端。"""
    return CloudflareClient(token)


def _public_domain(domain, store: ProbeStore) -> dict:
    pool = [s for s in store.list_servers() if s.server_group == domain.group_name]
    return {
        "id": domain.id,
        "name": domain.name,
        "zoneId": domain.zone_id,
        "zoneName": domain.zone_name,
        "group": domain.group_name,
        "ttl": domain.ttl,
        "syncMode": domain.sync_mode,
        "intervalSeconds": domain.interval_seconds,
        "enabled": domain.enabled,
        "lastSyncAt": domain.last_sync_at,
        "lastSyncOk": domain.last_sync_ok,
        "lastSyncMessage": domain.last_sync_message,
        "currentIp": domain.current_ip,
        "createdAt": domain.created_at,
        "poolSize": len(pool),
    }


@router.get("/health")
def pool_health_view():
    """池内 IP 健康快照 + 各启用域名的当前指向与最优健康 IP。"""
    from .health import best_ip_for_domain, pool_health

    store = lb_store()
    probe = probe_store()
    states = {item["ip"]: item for item in pool_health.snapshot()}
    domains = []
    for domain in store.list_domains():
        if not domain.enabled:
            continue
        pool = [s.ip for s in probe.list_servers() if s.server_group == domain.group_name]
        domains.append({
            "domainId": domain.id,
            "name": domain.name,
            "group": domain.group_name,
            "currentIp": domain.current_ip,
            "bestIp": best_ip_for_domain(domain, probe, pool_health),
            "poolIps": pool,
        })
    return {"states": list(states.values()), "domains": domains}


# ---------------------------------------------------------------------------
# Cloudflare 凭据
# ---------------------------------------------------------------------------
class CloudflareTokenUpdate(BaseModel):
    token: str


@router.get("/cloudflare")
def get_cloudflare():
    token = lb_store().cloudflare_token()
    return {"configured": bool(token), "tokenMasked": _mask_token(token) if token else ""}


@router.put("/cloudflare")
def update_cloudflare(payload: CloudflareTokenUpdate, user: Annotated[str, Depends(require_auth)]):
    token = payload.token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="API Token 不能为空")
    lb_store().set_cloudflare_token(token)
    audit(user, "lb_update_cloudflare", message=f"token {_mask_token(token)}")
    return {"configured": True, "tokenMasked": _mask_token(token)}


class CloudflareVerify(BaseModel):
    token: str | None = None  # 不传则用已保存的


@router.post("/cloudflare/verify")
def verify_cloudflare(payload: CloudflareVerify, user: Annotated[str, Depends(require_auth)]):
    token = (payload.token or "").strip() or lb_store().cloudflare_token()
    if not token:
        raise HTTPException(status_code=400, detail="请先填写或保存 API Token")
    try:
        with _cf_client(token) as client:
            zones = client.verify()
    except CloudflareError as exc:
        audit(user, "lb_verify_cloudflare", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(user, "lb_verify_cloudflare", message=f"{len(zones)} 个 zone")
    return {"ok": True, "zones": [{"id": z["id"], "name": z["name"]} for z in zones]}


# ---------------------------------------------------------------------------
# 候选域名
# ---------------------------------------------------------------------------
class DomainCreate(BaseModel):
    name: str
    zoneId: str
    zoneName: str
    group: str
    ttl: int = 60
    syncMode: str = "manual"
    intervalSeconds: int = 300
    enabled: bool = True


class DomainPatch(BaseModel):
    group: str | None = None
    ttl: int | None = None
    syncMode: str | None = None
    intervalSeconds: int | None = None
    enabled: bool | None = None


class DomainDelete(BaseModel):
    removeRecords: bool = False


def _check_domain_in_zone(name: str, zone_name: str) -> None:
    clean = validate_domain_name(name)
    zone = validate_domain_name(zone_name)
    if clean != zone and not clean.endswith(f".{zone}"):
        raise ValueError(f"域名 {clean} 不属于 zone {zone}")


@router.get("/domains")
def list_domains():
    store = lb_store()
    probe = probe_store()
    return [_public_domain(domain, probe) for domain in store.list_domains()]


@router.post("/domains")
def create_domain(payload: DomainCreate, user: Annotated[str, Depends(require_auth)]):
    store = lb_store()
    try:
        _check_domain_in_zone(payload.name, payload.zoneName)
        domain = store.create_domain(
            name=payload.name, zone_id=payload.zoneId, zone_name=payload.zoneName,
            group_name=payload.group, ttl=payload.ttl, sync_mode=payload.syncMode,
            interval_seconds=payload.intervalSeconds, enabled=payload.enabled,
        )
    except ValueError as exc:
        audit(user, "lb_create_domain", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(user, "lb_create_domain", message=f"{domain.name} → 分组「{domain.group_name}」")
    return _public_domain(domain, probe_store())


def _get_domain_or_404(domain_id: int, store: LbStore):
    try:
        return store.get_domain(domain_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.patch("/domains/{domain_id}")
def update_domain(domain_id: int, payload: DomainPatch, user: Annotated[str, Depends(require_auth)]):
    store = lb_store()
    try:
        domain = store.update_domain(
            domain_id,
            group_name=payload.group, ttl=payload.ttl, sync_mode=payload.syncMode,
            interval_seconds=payload.intervalSeconds, enabled=payload.enabled,
        )
    except ValueError as exc:
        audit(user, "lb_update_domain", success=False, message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    audit(user, "lb_update_domain", message=domain.name)
    return _public_domain(domain, probe_store())


@router.delete("/domains/{domain_id}")
def delete_domain(domain_id: int, user: Annotated[str, Depends(require_auth)],
                  payload: DomainDelete | None = None):
    store = lb_store()
    domain = _get_domain_or_404(domain_id, store)
    removed_records: list[str] = []
    if payload and payload.removeRecords:
        token = store.cloudflare_token()
        if not token:
            raise HTTPException(status_code=400, detail="未配置 Cloudflare Token，无法清理 DNS 记录")
        try:
            with _cf_client(token) as client:
                for record in client.list_a_records(domain.zone_id, domain.name):
                    if record.managed:
                        client.delete_a_record(domain.zone_id, record.id)
                        removed_records.append(record.content)
        except CloudflareError as exc:
            audit(user, "lb_delete_domain", success=False,
                  message=f"{domain.name}: 清理记录失败 {exc}")
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    store.delete_domain(domain_id)
    audit(user, "lb_delete_domain",
          message=f"{domain.name}（清理 {len(removed_records)} 条托管记录）" if removed_records else domain.name)
    return {"ok": True, "removedRecords": removed_records}


# ---------------------------------------------------------------------------
# 同步
# ---------------------------------------------------------------------------
@router.post("/domains/{domain_id}/sync")
def sync_domain_now(domain_id: int, user: Annotated[str, Depends(require_auth)]):
    store = lb_store()
    domain = _get_domain_or_404(domain_id, store)
    token = store.cloudflare_token()
    if not token:
        raise HTTPException(status_code=400, detail="未配置 Cloudflare API Token")
    try:
        with _cf_client(token) as client:
            result = sync_domain(domain, probe_store(), store, client)
    except CloudflareError as exc:
        audit(user, "lb_sync_domain", success=False, message=f"{domain.name}: {exc}")
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    audit(user, "lb_sync_domain", success=result.ok, message=f"{domain.name}: {result.message}")
    return summarize(result)


@router.get("/domains/{domain_id}/records")
def list_domain_records(domain_id: int):
    store = lb_store()
    domain = _get_domain_or_404(domain_id, store)
    token = store.cloudflare_token()
    if not token:
        raise HTTPException(status_code=400, detail="未配置 Cloudflare API Token")
    try:
        with _cf_client(token) as client:
            records = client.list_a_records(domain.zone_id, domain.name)
    except CloudflareError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return [{
        "id": record.id,
        "ip": record.content,
        "ttl": record.ttl,
        "managed": record.managed,
    } for record in records]


@router.get("/domains/{domain_id}/logs")
def list_domain_logs(domain_id: int, limit: int = Query(default=50, ge=1, le=200)):
    store = lb_store()
    _get_domain_or_404(domain_id, store)
    return store.list_sync_logs(domain_id, limit=limit)
