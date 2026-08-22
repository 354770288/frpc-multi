"""定时同步调度：daemon 线程周期扫描 scheduled 且启用的候选域名，
到期（now - last_sync_at >= interval）即触发同步。手动同步由 API 触发，
与定时共用 syncer 的全局锁，不会并发互踩。
"""

from __future__ import annotations

import threading
from datetime import datetime

from ..control.audit_store import AuditStore
from ..probe.store import ProbeStore
from ..settings import Settings
from .cloudflare import CloudflareClient
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
                  *, now: datetime | None = None) -> int:
    """同步所有到期域名，返回处理数量。供调度线程与测试复用。"""
    due = due_domains(store, now=now)
    if not due:
        return 0
    token = store.cloudflare_token()
    if not token:
        return 0
    with CloudflareClient(token) as cf:
        for domain in due:
            result = sync_domain(domain, probe_store, store, cf)
            AuditStore(settings.database_path).create_log(
                username="scheduler",
                action="lb_sync_domain",
                success=result.ok,
                message=f"{domain.name}: {result.message}",
            )
    return len(due)


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
