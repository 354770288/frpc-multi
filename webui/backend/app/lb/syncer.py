"""同步引擎（单 A 主备模式）：把候选域名收敛为**一条**托管 A 记录，
指向池内最优健康 IP。

frp 的代理只注册在 frpc 连接的那台 frps 上；多 A 轮询会让访问端随机命中
没有隧道的机器（1/N 命中率）。单 A 模式下 frpc 与访问端永远解析到同一台，
故障时由健康监测触发切换（换 A 记录 → frpc 重连重新解析）。

只碰带托管标记（comment=frpc-multi-lb）的灰云 A 记录；用户手动添加的
DNS 记录原样保留。Cloudflare API 非事务，逐条执行、失败收集不中断。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from ..models import now_iso
from ..probe.store import ProbeStore
from .cloudflare import CloudflareClient, CloudflareError
from .health import PoolHealthMonitor, best_ip_for_domain, select_best_ip
from .store import LbDomain, LbStore

# 同步很快（每条记录一个 API 调用），全局锁串行避免手动 + 定时并发互踩
_sync_lock = threading.Lock()


@dataclass
class SyncResult:
    ok: bool
    target_ip: str | None = None
    previous_ip: str | None = None
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    switched: bool = False
    pool_size: int = 0
    healthy_size: int = 0
    unmanaged_count: int = 0
    errors: list[str] = field(default_factory=list)
    message: str = ""


def sync_domain(domain: LbDomain, probe_store: ProbeStore, lb_store: LbStore,
                cf: CloudflareClient, monitor: PoolHealthMonitor | None = None) -> SyncResult:
    """收敛该域名的托管 A 记录到一条 = 池内最优健康 IP。

    - 池为空：删除全部托管记录；
    - 池内无健康 IP：保留现有记录不动（避免抖动期 DNS 悬空），标记失败并提示。
    """
    with _sync_lock:
        status_rows = [row for row in probe_store.list_servers_with_status()
                       if row["server_group"] == domain.group_name]
        pool_ips = {row["ip"] for row in status_rows}
        monitor = monitor or _default_monitor()
        target_ip = select_best_ip(status_rows, monitor.is_healthy) if pool_ips else None
        healthy_size = sum(1 for ip in pool_ips if monitor.is_healthy(ip))

        try:
            records = cf.list_a_records(domain.zone_id, domain.name)
        except CloudflareError as exc:
            result = SyncResult(ok=False, pool_size=len(pool_ips),
                                errors=[f"读取 DNS 记录失败: {exc}"])
            _finish(lb_store, domain, result)
            return result

        managed = [record for record in records if record.managed]
        unmanaged_count = len(records) - len(managed)
        managed_ips = {record.content for record in managed}

        errors: list[str] = []
        added: list[str] = []
        removed: list[str] = []
        previous_ip = domain.current_ip

        if not pool_ips:
            # 空池：清掉全部托管记录
            for record in managed:
                try:
                    cf.delete_a_record(domain.zone_id, record.id)
                    removed.append(record.content)
                except CloudflareError as exc:
                    errors.append(f"移除 {record.content} 失败: {exc}")
            target_ip = None
        elif target_ip is None:
            # 有池但全不健康：保留现状，等待恢复或人工处理
            result = SyncResult(
                ok=False, target_ip=previous_ip, previous_ip=previous_ip,
                pool_size=len(pool_ips), healthy_size=0,
                unmanaged_count=unmanaged_count,
                errors=[f"池内 {len(pool_ips)} 台均不健康，保留现有记录 {previous_ip or '（无）'}"],
            )
            _finish(lb_store, domain, result)
            return result
        else:
            # 收敛到单条：缺则补、多则删
            if target_ip not in managed_ips:
                try:
                    cf.create_a_record(domain.zone_id, domain.name, target_ip, domain.ttl)
                    added.append(target_ip)
                except CloudflareError as exc:
                    errors.append(f"写入 {target_ip} 失败: {exc}")
            for record in managed:
                if record.content != target_ip:
                    try:
                        cf.delete_a_record(domain.zone_id, record.id)
                        removed.append(record.content)
                    except CloudflareError as exc:
                        errors.append(f"移除 {record.content} 失败: {exc}")

        switched = bool(previous_ip and target_ip and previous_ip != target_ip)
        result = SyncResult(
            ok=not errors,
            target_ip=target_ip,
            previous_ip=previous_ip,
            added=added,
            removed=removed,
            switched=switched,
            pool_size=len(pool_ips),
            healthy_size=healthy_size,
            unmanaged_count=unmanaged_count,
            errors=errors,
        )
        _finish(lb_store, domain, result)
        return result


def _default_monitor() -> PoolHealthMonitor:
    from .health import pool_health
    return pool_health


def _finish(lb_store: LbStore, domain: LbDomain, result: SyncResult) -> None:
    parts = [f"池 {result.pool_size} 台（健康 {result.healthy_size}）"]
    if result.switched:
        parts.append(f"切换 {result.previous_ip} → {result.target_ip}")
    elif result.target_ip:
        parts.append(f"A 记录 → {result.target_ip}" if result.added else f"保持 {result.target_ip}")
    if result.added:
        parts.append(f"新增 {'、'.join(result.added)}")
    if result.removed:
        parts.append(f"移除 {len(result.removed)} 条（{'、'.join(result.removed[:5])}{'…' if len(result.removed) > 5 else ''}）")
    if result.pool_size == 0:
        parts.append("警告：绑定分组内没有服务器，已清空托管记录")
    if result.unmanaged_count:
        parts.append(f"另有 {result.unmanaged_count} 条非托管记录未改动")
    if result.errors:
        parts.append("；".join(result.errors))
    result.message = "；".join(parts)
    lb_store.mark_sync_result(
        domain.id, ok=result.ok, message=result.message,
        added=result.added, removed=result.removed,
        kept=1 if result.target_ip else 0,
        current_ip=result.target_ip if result.ok else domain.current_ip,
    )


def summarize(result: SyncResult) -> dict:
    """API 返回视图（camelCase）。"""
    return {
        "ok": result.ok,
        "targetIp": result.target_ip,
        "previousIp": result.previous_ip,
        "switched": result.switched,
        "added": result.added,
        "removed": result.removed,
        "poolSize": result.pool_size,
        "healthySize": result.healthy_size,
        "unmanagedCount": result.unmanaged_count,
        "errors": result.errors,
        "message": result.message,
        "syncedAt": now_iso(),
    }
