"""同步引擎：把候选域名绑定分组内的服务器 IP 集合，收敛为 Cloudflare 上
该域名的托管 A 记录集合。

只碰带托管标记（comment=frpc-multi-lb）的灰云 A 记录；用户手动添加的
DNS 记录原样保留并在结果中提示。Cloudflare API 非事务，逐条执行、
失败收集不中断。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from ..models import now_iso
from ..probe.store import ProbeStore
from .cloudflare import CloudflareClient, CloudflareError
from .store import LbDomain, LbStore

# 同步很快（每条记录一个 API 调用），全局锁串行避免手动 + 定时并发互踩
_sync_lock = threading.Lock()


@dataclass
class SyncResult:
    ok: bool
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    kept: int = 0
    pool_size: int = 0
    unmanaged_count: int = 0
    errors: list[str] = field(default_factory=list)
    message: str = ""


def sync_domain(domain: LbDomain, probe_store: ProbeStore, lb_store: LbStore,
                cf: CloudflareClient) -> SyncResult:
    with _sync_lock:
        servers = [s for s in probe_store.list_servers() if s.server_group == domain.group_name]
        target_ips = {s.ip for s in servers}

        try:
            records = cf.list_a_records(domain.zone_id, domain.name)
        except CloudflareError as exc:
            result = SyncResult(ok=False, pool_size=len(target_ips),
                                errors=[f"读取 DNS 记录失败: {exc}"])
            _finish(lb_store, domain, result)
            return result

        managed = [record for record in records if record.managed]
        unmanaged_count = len(records) - len(managed)
        managed_ips = {record.content for record in managed}
        to_add = sorted(target_ips - managed_ips)
        to_remove = [record for record in managed if record.content not in target_ips]

        added: list[str] = []
        removed: list[str] = []
        errors: list[str] = []
        for ip in to_add:
            try:
                cf.create_a_record(domain.zone_id, domain.name, ip, domain.ttl)
                added.append(ip)
            except CloudflareError as exc:
                errors.append(f"新增 {ip} 失败: {exc}")
        for record in to_remove:
            try:
                cf.delete_a_record(domain.zone_id, record.id)
                removed.append(record.content)
            except CloudflareError as exc:
                errors.append(f"移除 {record.content} 失败: {exc}")

        kept = len(managed) - len(removed)
        result = SyncResult(
            ok=not errors,
            added=added,
            removed=removed,
            kept=kept,
            pool_size=len(target_ips),
            unmanaged_count=unmanaged_count,
            errors=errors,
        )
        _finish(lb_store, domain, result)
        return result


def _finish(lb_store: LbStore, domain: LbDomain, result: SyncResult) -> None:
    parts = [f"池 {result.pool_size} 台"]
    if result.added:
        parts.append(f"新增 {len(result.added)}（{'、'.join(result.added[:5])}{'…' if len(result.added) > 5 else ''}）")
    if result.removed:
        parts.append(f"移除 {len(result.removed)}（{'、'.join(result.removed[:5])}{'…' if len(result.removed) > 5 else ''}）")
    if result.kept:
        parts.append(f"保留 {result.kept}")
    if result.pool_size == 0:
        parts.append("警告：绑定分组内没有服务器")
    if result.unmanaged_count:
        parts.append(f"另有 {result.unmanaged_count} 条非托管记录未改动")
    if result.errors:
        parts.append("；".join(result.errors))
    result.message = "；".join(parts)
    lb_store.mark_sync_result(
        domain.id, ok=result.ok, message=result.message,
        added=result.added, removed=result.removed, kept=result.kept,
    )


def summarize(result: SyncResult) -> dict:
    """API 返回视图（camelCase）。"""
    return {
        "ok": result.ok,
        "added": result.added,
        "removed": result.removed,
        "kept": result.kept,
        "poolSize": result.pool_size,
        "unmanagedCount": result.unmanaged_count,
        "errors": result.errors,
        "message": result.message,
        "syncedAt": now_iso(),
    }
