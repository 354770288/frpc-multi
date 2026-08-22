"""定时调度（单 A 主备模式）：daemon 线程每轮做三件事。

1. 池内 IP 健康探测：到期（默认 60s/IP）即 tcping 其 frps 端口，
   连续失败达阈值判不健康（lb.health.PoolHealthMonitor）。
2. 到期同步：scheduled 且启用的域名按同步间隔触发 sync_domain。
3. 故障切换：任一启用域名的最优健康 IP 变化（≠ current_ip）立即同步，
   不受同步模式/间隔限制——「A 记录永远指向最优健康 IP」的核心保障。

手动同步由 API 触发，与定时共用 syncer 的全局锁，不会并发互踩。
"""

from __future__ import annotations

import threading
from datetime import datetime
from typing import Callable

from ..control.audit_store import AuditStore
from ..probe.store import ProbeStore
from ..settings import Settings
from .cloudflare import CloudflareClient
from .health import PoolHealthMonitor, best_ip_for_domain, pool_health
from .store import LbDomain, LbStore
from .syncer import sync_domain

_SCAN_INTERVAL_SECONDS = 30


def due_domains(store: LbStore, *, now: datetime | None = None) -> list[LbDomain]:
    """计算当前到期待同步的域名（从未同步过的 scheduled 域名立即到期）。"""
    moment = now or datetime.now().astimezone()
    due: list[LbDomain] = []
    for domain in store.list_domains():
        if not domain.enabled or domain.sync_mode != "scheduled":
            continue
        if domain.last_sync_at is None:
            due.append(domain)
            continue
        try:
            last = datetime.fromisoformat(domain.last_sync_at)
        except ValueError:
            due.append(domain)
            continue
        if (moment - last).total_seconds() >= domain.interval_seconds:
            due.append(domain)
    return due


def run_due_syncs(store: LbStore, probe_store: ProbeStore, settings: Settings,
                  *, now: datetime | None = None, monitor: PoolHealthMonitor | None = None,
                  cf_factory: Callable[[str], CloudflareClient] | None = None) -> int:
    """健康探测 + 到期同步 + 故障切换，返回发生同步的域名数。"""
    monitor = monitor or pool_health
    monitor.run_due_checks(store, probe_store, settings)

    to_sync: dict[int, LbDomain] = {domain.id: domain for domain in due_domains(store, now=now)}
    failovers: dict[int, str] = {}
    for domain in store.list_domains():
        if not domain.enabled:
            continue
        best = best_ip_for_domain(domain, probe_store, monitor)
        if best is not None and best != domain.current_ip:
            # 最优健康 IP 变化：立即切换（含从未同步过的域名首次收敛）
            to_sync[domain.id] = domain
            if domain.current_ip:
                failovers[domain.id] = best

    if not to_sync:
        return 0
    token = store.cloudflare_token()
    if not token:
        return 0
    audit = AuditStore(settings.database_path)
    factory = cf_factory or (lambda value: CloudflareClient(value))
    with factory(token) as cf:
        for domain in to_sync.values():
            result = sync_domain(domain, probe_store, store, cf, monitor)
            action = "lb_failover" if domain.id in failovers else "lb_sync_domain"
            audit.create_log(
                username="scheduler",
                action=action,
                success=result.ok,
                message=f"{domain.name}: {result.message}",
            )
    return len(to_sync)


def start_scheduler(settings: Settings) -> threading.Event:
    """启动调度线程，返回停止事件（lifespan 退出时 set）。"""
    stop_event = threading.Event()

    def loop() -> None:
        while not stop_event.wait(_SCAN_INTERVAL_SECONDS):
            try:
                run_due_syncs(
                    LbStore(settings.database_path),
                    ProbeStore(settings.database_path),
                    settings,
                )
            except Exception as exc:  # noqa: BLE001 - 调度线程不能因单轮异常退出
                print(f"[frpc-multi] 负载均衡定时同步异常: {exc}", flush=True)

    thread = threading.Thread(target=loop, daemon=True, name="lb-scheduler")
    thread.start()
    return stop_event
