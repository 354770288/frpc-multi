"""网段发现：扫描自有网段内开放 frps 端口的设备（整合自 portpilot 的 Scan 模块）。

与 Go 版 portpilot 的差异：容器内无 raw socket 权限，主机探活只用 TCP Connect
（其默认推荐模式）；单端口扫描下「探活 + 扫端口」与「直接 connect」等价。
目标语法对齐 portpilot：CIDR / IP 段（a.b.c.d-e.f.g.h）/ 尾段（a.b.c.d-254）/
单 IP，逗号或换行混合；exclude 同语法。

仅供扫描自己有权管理的网段（内网 / 自有 VPS 段）。
"""

from __future__ import annotations

import asyncio
import ipaddress
import threading
import time
from dataclasses import dataclass, field

from ..models import now_iso

# 误输入保护：/18 个 /16 也够任何内网资产发现场景
MAX_TARGET_IPS = 262_144
DEFAULT_CONCURRENCY = 500
DEFAULT_TIMEOUT_SECONDS = 1.5
MIN_CONCURRENCY, MAX_CONCURRENCY = 1, 2000
MIN_TIMEOUT, MAX_TIMEOUT = 0.5, 10.0


@dataclass
class DiscoverParams:
    targets: list[str]
    exclude: list[str]
    port: int
    concurrency: int = DEFAULT_CONCURRENCY
    timeout: float = DEFAULT_TIMEOUT_SECONDS


@dataclass
class DiscoverHit:
    ip: str
    port: int
    latency_ms: float

    def to_view(self) -> dict:
        return {"ip": self.ip, "port": self.port, "latencyMs": round(self.latency_ms, 1)}


@dataclass
class DiscoverState:
    params: DiscoverParams
    total: int = 0
    scanned: int = 0
    running: bool = True
    started_at: str = field(default_factory=now_iso)
    finished_at: str | None = None
    error: str = ""
    found: list[DiscoverHit] = field(default_factory=list)


def _iter_range(start: int, end: int):
    for value in range(start, end + 1):
        yield ipaddress.ip_address(value)


def parse_target_item(item: str):
    """单个目标 → IP 迭代器。支持 CIDR / 段 / 尾段 / 单 IP。"""
    text = item.strip()
    if not text:
        return iter(())
    if "-" in text:
        raw_start, _, raw_end = text.partition("-")
        raw_start = raw_start.strip()
        raw_end = raw_end.strip()
        start = ipaddress.ip_address(raw_start)
        if "." in raw_end:  # 完整 IP 段 a.b.c.d-e.f.g.h
            end = ipaddress.ip_address(raw_end)
        else:  # 尾段 a.b.c.d-254
            if not raw_end.isdigit():
                raise ValueError(f"无效目标: {text}")
            end = ipaddress.ip_address(f"{raw_start.rsplit('.', 1)[0]}.{raw_end}")
        if start.version != end.version:
            raise ValueError(f"目标段协议版本不一致: {text}")
        if int(end) < int(start):
            raise ValueError(f"目标段起始大于结束: {text}")
        return _iter_range(int(start), int(end))
    if "/" in text:
        network = ipaddress.ip_network(text, strict=False)
        return network.hosts() if network.num_addresses > 2 else iter([network.network_address])
    return iter([ipaddress.ip_address(text)])


def parse_targets(targets_text: str, exclude_text: str = "") -> tuple[list[str], int]:
    """解析目标与排除 → 去重排序后的 IP 列表 + 总数（超上限抛 ValueError）。"""
    items = [part for part in targets_text.replace("\n", ",").split(",") if part.strip()]
    if not items:
        raise ValueError("至少填写一个目标网段")
    exclude_items = [part for part in exclude_text.replace("\n", ",").split(",") if part.strip()]

    excluded: set[int] = set()
    for item in exclude_items:
        for ip in parse_target_item(item):
            excluded.add(int(ip))

    result: set[int] = set()
    total_before_exclude = 0
    for item in items:
        for ip in parse_target_item(item):
            total_before_exclude += 1
            if total_before_exclude > MAX_TARGET_IPS:
                raise ValueError(f"目标 IP 总数超过上限 {MAX_TARGET_IPS}")
            value = int(ip)
            if value not in excluded:
                result.add(value)
    return sorted(str(ipaddress.ip_address(value)) for value in result), total_before_exclude


class DiscoverRunner:
    """模块级单例：一次一个扫描任务，后台线程跑独立事件循环。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._state: DiscoverState | None = None
        self._cancel = threading.Event()

    # ---- 控制 ----

    def start(self, params: DiscoverParams) -> DiscoverState:
        with self._lock:
            if self._state and self._state.running:
                raise RuntimeError("已有扫描在进行中")
        ips, total = parse_targets(",".join(params.targets), ",".join(params.exclude))
        if not ips:
            raise ValueError("排除后没有可扫描的 IP")
        state = DiscoverState(params=params, total=len(ips))
        self._cancel.clear()
        self._state = state
        threading.Thread(target=self._run, args=(state, ips), daemon=True,
                         name="probe-discover").start()
        return state

    def stop(self) -> bool:
        if not self._state or not self._state.running:
            return False
        self._cancel.set()
        return True

    # ---- 执行 ----

    def _run(self, state: DiscoverState, ips: list[str]) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._scan(state, ips))
        except Exception as exc:  # noqa: BLE001 - 后台线程不能静默吞异常
            state.error = str(exc)
        finally:
            state.running = False
            state.finished_at = now_iso()
            loop.close()

    async def _scan(self, state: DiscoverState, ips: list[str]) -> None:
        semaphore = asyncio.Semaphore(state.params.concurrency)

        async def probe(ip: str) -> None:
            if self._cancel.is_set():
                return
            async with semaphore:
                if self._cancel.is_set():
                    state.scanned += 1
                    return
                started = time.monotonic()
                try:
                    reader, writer = await asyncio.wait_for(
                        asyncio.open_connection(ip, state.params.port),
                        timeout=state.params.timeout,
                    )
                    latency = (time.monotonic() - started) * 1000
                    writer.close()
                    state.found.append(DiscoverHit(ip, state.params.port, latency))
                except (OSError, asyncio.TimeoutError, ValueError):
                    pass
                finally:
                    state.scanned += 1

        await asyncio.gather(*(probe(ip) for ip in ips))

    # ---- 查询 ----

    def status(self) -> dict:
        state = self._state
        if state is None:
            return {"running": False, "params": None, "total": 0, "scanned": 0,
                    "found": [], "startedAt": None, "finishedAt": None, "error": ""}
        return {
            "running": state.running,
            "params": {
                "targets": state.params.targets,
                "exclude": state.params.exclude,
                "port": state.params.port,
                "concurrency": state.params.concurrency,
                "timeout": state.params.timeout,
            },
            "total": state.total,
            "scanned": state.scanned,
            "found": [hit.to_view() for hit in state.found],
            "startedAt": state.started_at,
            "finishedAt": state.finished_at,
            "error": state.error,
        }

    def found_ips(self) -> set[str]:
        """当前扫描结果中的 IP 集合（导入校验用）。"""
        state = self._state
        return {hit.ip for hit in state.found} if state else set()

    def reset(self) -> None:
        """测试用：清空单例状态。"""
        with self._lock:
            self._state = None
            self._cancel.clear()


discover_runner = DiscoverRunner()
