"""池内 IP 定时健康监测 + 最优 IP 选优。

单 A 主备模式的核心保障：候选域名的 A 记录必须始终指向池内「最优健康」的
一台 frps——frpc 与访问端解析到同一台，命中率 100%；该台故障时自动切换。

- 健康探测：对启用域名绑定分组内的服务器做 tcping（frps 端口），
  连续失败达到阈值才判定不健康（防单次抖动），一次成功立即恢复。
- 选优：健康集合内按（最近穿透测试 frps 可达 > 最新下行速率 > IP 升序）
  排序，取第一。从未探测过的 IP 视为健康（冷启动不空转）。
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from ..probe.engine import tcping
from ..probe.store import ProbeStore
from ..settings import Settings
from .store import LbDomain, LbStore

DEFAULT_CHECK_INTERVAL_SECONDS = 60
DEFAULT_FAIL_THRESHOLD = 2
_PROBE_TIMEOUT_SECONDS = 3.0

Prober = Callable[[str, int], tuple[bool, str]]


def split_addr(addr: str, default_port: int) -> tuple[str, int]:
    """服务器库地址可带 :port；分离出 host 与 port。"""
    value = (addr or "").strip()
    if value.count(":") == 1:
        host, _, port_text = value.partition(":")
        if port_text.isdigit() and host:
            return host, int(port_text)
    return value, default_port


def effective_frps_port(settings: Settings, probe_store: ProbeStore) -> int:
    """健康探测使用的 frps 端口：面板覆盖值 ← 环境默认。"""
    raw = probe_store.get_config_overrides().get("frps_port")
    if raw is not None:
        try:
            return int(float(raw))
        except (TypeError, ValueError):
            pass
    return settings.probe_options().frps_port


@dataclass
class HealthEntry:
    ip: str
    ok: bool | None = None          # None = 从未探测（视为健康）
    consecutive_fail: int = 0
    last_check: str | None = None
    last_ok: str | None = None
    detail: str = ""
    port: int = 0
    checked_at_monotonic: float = field(default=0.0, repr=False)

    def to_view(self) -> dict:
        return {
            "ip": self.ip,
            "ok": self.ok,
            "consecutiveFail": self.consecutive_fail,
            "lastCheck": self.last_check,
            "lastOk": self.last_ok,
            "detail": self.detail,
            "port": self.port,
        }


def select_best_ip(status_rows: list[dict], is_healthy: Callable[[str], bool]) -> str | None:
    """健康集合内选最优：frps 可达 > 下行速率 > IP 升序（确定性）。"""
    candidates = [row for row in status_rows if is_healthy(row["ip"])]
    if not candidates:
        return None
    candidates.sort(key=lambda row: row["ip"])
    candidates.sort(
        key=lambda row: (1 if row.get("c_frps_reachable") else 0,
                         float(row.get("s_dl_speed_mbps") or 0)),
        reverse=True,
    )
    return candidates[0]["ip"]


class PoolHealthMonitor:
    """池内 IP 健康状态机。调度线程单写、API 线程只读。"""

    def __init__(self, *, prober: Prober | None = None,
                 check_interval: float = DEFAULT_CHECK_INTERVAL_SECONDS,
                 fail_threshold: int = DEFAULT_FAIL_THRESHOLD):
        self._prober = prober or (lambda host, port: tcping(host, port, _PROBE_TIMEOUT_SECONDS))
        self._check_interval = check_interval
        self._fail_threshold = fail_threshold
        self._states: dict[str, HealthEntry] = {}
        self._lock = threading.Lock()

    # ---- 探测 ----

    def run_due_checks(self, lb_store: LbStore, probe_store: ProbeStore, settings: Settings,
                       *, force: bool = False) -> list[str]:
        """检查所有启用域名池内、到期未查的 IP；返回本次检查的 IP 列表。"""
        port = effective_frps_port(settings, probe_store)
        groups = {d.group_name for d in lb_store.list_domains() if d.enabled}
        addrs: list[str] = []
        for row in probe_store.list_servers():
            if row.server_group in groups:
                addrs.append(row.ip)

        now = time.monotonic()
        due: list[tuple[str, int]] = []
        for addr in addrs:
            host, addr_port = split_addr(addr, port)
            with self._lock:
                entry = self._states.get(host)
            if (force or entry is None
                    or now - entry.checked_at_monotonic >= self._check_interval):
                due.append((host, addr_port))

        checked: list[str] = []
        for host, addr_port in due:
            ok, detail = self._prober(host, addr_port)
            self._record(host, addr_port, ok, detail)
            checked.append(host)
        return checked

    def _record(self, host: str, port: int, ok: bool, detail: str) -> None:
        from ..models import now_iso

        moment = now_iso()
        with self._lock:
            entry = self._states.setdefault(host, HealthEntry(ip=host))
            entry.port = port
            entry.last_check = moment
            entry.detail = detail[:200]
            entry.checked_at_monotonic = time.monotonic()
            if ok:
                entry.ok = True
                entry.consecutive_fail = 0
                entry.last_ok = moment
            else:
                entry.consecutive_fail += 1
                if entry.consecutive_fail >= self._fail_threshold:
                    entry.ok = False

    # ---- 查询 ----

    def is_healthy(self, host: str) -> bool:
        with self._lock:
            entry = self._states.get(host)
        return True if entry is None or entry.ok is None else entry.ok

    def snapshot(self) -> list[dict]:
        with self._lock:
            entries = sorted(self._states.values(), key=lambda e: e.ip)
            return [entry.to_view() for entry in entries]

    def reset(self) -> None:
        with self._lock:
            self._states.clear()


def best_ip_for_domain(domain: LbDomain, probe_store: ProbeStore, monitor: PoolHealthMonitor) -> str | None:
    """域名池内的最优健康 IP（供 syncer 与 failover 判定共用）。"""
    rows = [row for row in probe_store.list_servers_with_status()
            if row["server_group"] == domain.group_name]
    return select_best_ip(rows, monitor.is_healthy)


# 模块级单例：调度线程写入，API 读取（与 probe runner 相同的模式）
pool_health = PoolHealthMonitor()
