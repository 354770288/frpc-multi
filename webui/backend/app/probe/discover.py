"""Discover frps endpoints across explicitly supplied IPv4 targets."""

from __future__ import annotations

import asyncio
import ipaddress
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from numbers import Real
from typing import Callable, Iterator

from ..models import now_iso

MAX_TARGET_IPS = 10_000_000
RECENT_HITS_LIMIT = 100
DEFAULT_CONCURRENCY = 500
DEFAULT_TIMEOUT_SECONDS = 1.5
MIN_CONCURRENCY, MAX_CONCURRENCY = 1, 2000
MIN_TIMEOUT, MAX_TIMEOUT = 0.5, 10.0


@dataclass(frozen=True)
class DiscoverParams:
    targets: list[str]
    exclude: list[str]
    port: int
    concurrency: int = DEFAULT_CONCURRENCY
    timeout: float = DEFAULT_TIMEOUT_SECONDS


@dataclass(frozen=True)
class DiscoverHit:
    ip: str
    port: int
    latency_ms: float

    def to_view(self) -> dict:
        return {"ip": self.ip, "port": self.port, "latencyMs": round(self.latency_ms, 1)}


@dataclass(frozen=True, order=True)
class IPv4Interval:
    """Inclusive IPv4 address interval, stored without expanding addresses."""

    start: int
    end: int

    def __post_init__(self) -> None:
        if not (0 <= self.start <= self.end <= (1 << 32) - 1):
            raise ValueError("无效 IPv4 地址区间")

    @property
    def size(self) -> int:
        return self.end - self.start + 1

    def __iter__(self) -> Iterator[str]:
        for value in range(self.start, self.end + 1):
            yield str(ipaddress.IPv4Address(value))


@dataclass(frozen=True)
class TargetPlan:
    """Canonical disjoint target intervals with lazy string iteration."""

    intervals: tuple[IPv4Interval, ...]
    total: int

    def __iter__(self) -> Iterator[str]:
        for interval in self.intervals:
            yield from interval

    def __len__(self) -> int:
        return self.total


def _ipv4_address(text: str) -> ipaddress.IPv4Address:
    try:
        address = ipaddress.ip_address(text)
    except ValueError as exc:
        raise ValueError(f"无效 IPv4 地址: {text}") from exc
    if not isinstance(address, ipaddress.IPv4Address):
        raise ValueError(f"仅支持 IPv4 地址: {text}")
    return address


def parse_target_item(item: str) -> IPv4Interval | None:
    """Parse one CIDR/range/single target directly into an inclusive interval."""
    text = item.strip()
    if not text:
        return None
    if "-" in text:
        raw_start, separator, raw_end = text.partition("-")
        if not separator or "-" in raw_end:
            raise ValueError(f"无效目标: {text}")
        raw_start, raw_end = raw_start.strip(), raw_end.strip()
        start = _ipv4_address(raw_start)
        if "." in raw_end:
            end = _ipv4_address(raw_end)
        else:
            if not raw_end.isdigit() or "." not in raw_start:
                raise ValueError(f"无效目标: {text}")
            end = _ipv4_address(f"{raw_start.rsplit('.', 1)[0]}.{raw_end}")
        if int(end) < int(start):
            raise ValueError(f"目标段起始大于结束: {text}")
        return IPv4Interval(int(start), int(end))
    if "/" in text:
        try:
            network = ipaddress.ip_network(text, strict=False)
        except ValueError as exc:
            raise ValueError(f"无效 IPv4 网段: {text}") from exc
        if not isinstance(network, ipaddress.IPv4Network):
            raise ValueError(f"仅支持 IPv4 网段: {text}")
        start = int(network.network_address)
        if network.prefixlen <= 30:
            return IPv4Interval(start + 1, int(network.broadcast_address) - 1)
        # Preserve the existing /31 rule: network address only. /32 is its sole address.
        return IPv4Interval(start, start)
    address = _ipv4_address(text)
    return IPv4Interval(int(address), int(address))


def _merge_intervals(intervals: list[IPv4Interval]) -> tuple[IPv4Interval, ...]:
    if not intervals:
        return ()
    ordered = sorted(intervals)
    merged: list[IPv4Interval] = [ordered[0]]
    for interval in ordered[1:]:
        previous = merged[-1]
        if interval.start <= previous.end + 1:
            merged[-1] = IPv4Interval(previous.start, max(previous.end, interval.end))
        else:
            merged.append(interval)
    return tuple(merged)


def _subtract_intervals(
    targets: tuple[IPv4Interval, ...], excludes: tuple[IPv4Interval, ...]
) -> tuple[IPv4Interval, ...]:
    result: list[IPv4Interval] = []
    exclude_index = 0
    for target in targets:
        cursor = target.start
        while exclude_index < len(excludes) and excludes[exclude_index].end < cursor:
            exclude_index += 1
        index = exclude_index
        while index < len(excludes) and excludes[index].start <= target.end:
            exclusion = excludes[index]
            if exclusion.start > cursor:
                result.append(IPv4Interval(cursor, min(target.end, exclusion.start - 1)))
            cursor = max(cursor, exclusion.end + 1)
            if cursor > target.end:
                break
            index += 1
        if cursor <= target.end:
            result.append(IPv4Interval(cursor, target.end))
    return tuple(result)


def _split_items(text: str) -> list[str]:
    return [part.strip() for part in text.replace("\n", ",").split(",") if part.strip()]


def parse_targets(targets_text: str, exclude_text: str = "") -> TargetPlan:
    """Build a deduplicated, excluded IPv4 plan without expanding addresses."""
    target_items = _split_items(targets_text)
    if not target_items:
        raise ValueError("至少填写一个目标网段")
    targets = _merge_intervals([interval for item in target_items if (interval := parse_target_item(item))])
    excludes = _merge_intervals([
        interval for item in _split_items(exclude_text) if (interval := parse_target_item(item))
    ])
    intervals = _subtract_intervals(targets, excludes)
    total = sum(interval.size for interval in intervals)
    if total > MAX_TARGET_IPS:
        raise ValueError(f"目标 IP 总数超过上限 {MAX_TARGET_IPS}")
    return TargetPlan(intervals, total)


@dataclass
class DiscoverState:
    params: DiscoverParams
    total: int = 0
    scanned: int = 0
    running: bool = True
    started_at: str = field(default_factory=now_iso)
    finished_at: str | None = None
    error: str = ""
    found_count: int = 0
    recent_hits: deque[DiscoverHit] = field(
        default_factory=lambda: deque(maxlen=RECENT_HITS_LIMIT)
    )


class _CallbackFailure(Exception):
    """Carry callback BaseException failures safely across the asyncio loop."""

    def __init__(self, cause: BaseException):
        message = str(cause).strip()
        self.detail = f"{type(cause).__name__}: {message}" if message else type(cause).__name__
        super().__init__(self.detail)


class DiscoverRunner:
    """Single-scan runner using one producer and a fixed worker pool."""

    def __init__(self):
        self._lock = threading.Lock()
        self._state: DiscoverState | None = None
        self._cancel = threading.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._scan_task: asyncio.Task | None = None
        self._thread: threading.Thread | None = None
        self._resetting = False

    @staticmethod
    def _validate_params(params: DiscoverParams) -> None:
        if not isinstance(params.targets, list) or not all(isinstance(x, str) for x in params.targets):
            raise ValueError("targets 必须是字符串列表")
        if not isinstance(params.exclude, list) or not all(isinstance(x, str) for x in params.exclude):
            raise ValueError("exclude 必须是字符串列表")
        if isinstance(params.port, bool) or not isinstance(params.port, int) or not 1 <= params.port <= 65535:
            raise ValueError("端口必须在 1 到 65535 之间")
        if (isinstance(params.concurrency, bool) or not isinstance(params.concurrency, int)
                or not MIN_CONCURRENCY <= params.concurrency <= MAX_CONCURRENCY):
            raise ValueError(f"并发数必须在 {MIN_CONCURRENCY} 到 {MAX_CONCURRENCY} 之间")
        if (isinstance(params.timeout, bool) or not isinstance(params.timeout, Real)
                or not MIN_TIMEOUT <= float(params.timeout) <= MAX_TIMEOUT):
            raise ValueError(f"超时必须在 {MIN_TIMEOUT} 到 {MAX_TIMEOUT} 秒之间")

    def start(self, params: DiscoverParams, on_hit: Callable | None = None) -> DiscoverState:
        """Validate and atomically reserve the one active scan lifecycle."""
        with self._lock:
            if self._resetting:
                raise RuntimeError("扫描器正在重置")
            if self._state and self._state.running:
                raise RuntimeError("已有扫描在进行中")
            self._validate_params(params)
            plan = parse_targets(",".join(params.targets), ",".join(params.exclude))
            if not plan.total:
                raise ValueError("排除后没有可扫描的 IP")
            state = DiscoverState(params=params, total=plan.total)
            self._cancel.clear()
            self._state = state
            self._loop = None
            self._scan_task = None
            thread = threading.Thread(
                target=self._run, args=(state, plan, on_hit), daemon=True,
                name="probe-discover",
            )
            self._thread = thread
            thread.start()
            return state

    @staticmethod
    def _cancel_task(loop: asyncio.AbstractEventLoop, task: asyncio.Task) -> None:
        """Cancel safely when finalization closes the loop before publication catches up."""
        try:
            loop.call_soon_threadsafe(task.cancel)
        except RuntimeError:
            # is_closed() is checked after the failed call so the check/call race
            # cannot leak "Event loop is closed" from stop/reset callers.
            if not loop.is_closed():
                raise

    def stop(self) -> bool:
        with self._lock:
            state = self._state
            if not state or not state.running:
                return False
            self._cancel.set()
            loop, task = self._loop, self._scan_task
        if loop is not None and task is not None:
            self._cancel_task(loop, task)
        return True

    def _run(self, state: DiscoverState, plan: TargetPlan, on_hit: Callable | None) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        task = loop.create_task(self._scan(state, plan, on_hit))
        with self._lock:
            self._loop, self._scan_task = loop, task
            cancelled_early = self._cancel.is_set()
        if cancelled_early:
            loop.call_soon(task.cancel)
        try:
            loop.run_until_complete(task)
        except asyncio.CancelledError:
            pass
        except BaseException as exc:
            detail = exc.detail if isinstance(exc, _CallbackFailure) else (
                f"{type(exc).__name__}: {str(exc).strip()}" if str(exc).strip()
                else type(exc).__name__
            )
            with self._lock:
                state.error = detail
        finally:
            pending = asyncio.all_tasks(loop)
            for pending_task in pending:
                pending_task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.close()
            finish_callback = getattr(on_hit, "finish", None)
            if finish_callback is not None:
                try:
                    finish_callback()
                except BaseException as exc:
                    detail = str(exc).strip()
                    with self._lock:
                        state.error = (
                            f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
                        )
            with self._lock:
                state.running = False
                state.finished_at = now_iso()
                if self._state is state:
                    self._loop = None
                    self._scan_task = None
                    self._thread = None

    async def _scan(self, state: DiscoverState, plan: TargetPlan, on_hit: Callable | None) -> None:
        queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=state.params.concurrency)

        async def producer() -> None:
            for ip in plan:
                if self._cancel.is_set():
                    break
                await queue.put(ip)
            for _ in range(state.params.concurrency):
                await queue.put(None)

        async def worker() -> None:
            while True:
                ip = await queue.get()
                try:
                    if ip is None:
                        return
                    if self._cancel.is_set():
                        return
                    started = time.monotonic()
                    try:
                        try:
                            _reader, writer = await asyncio.wait_for(
                                asyncio.open_connection(ip, state.params.port),
                                timeout=float(state.params.timeout),
                            )
                        except (OSError, asyncio.TimeoutError, ValueError):
                            continue

                        latency = (time.monotonic() - started) * 1000
                        writer.close()
                        if hasattr(writer, "wait_closed"):
                            await writer.wait_closed()
                        hit = DiscoverHit(ip, state.params.port, latency)
                        with self._lock:
                            state.found_count += 1
                            state.recent_hits.append(hit)
                        if on_hit is not None:
                            try:
                                on_hit(ip, state.params.port, latency)
                            except BaseException as exc:
                                # SystemExit/KeyboardInterrupt cannot safely escape an
                                # asyncio callback: run_forever intercepts them before
                                # run_until_complete can clean up the task graph.
                                raise _CallbackFailure(exc) from None
                    finally:
                        # Entering the connection attempt owns exactly one count,
                        # including cancellation while wait_for is in flight.
                        with self._lock:
                            state.scanned += 1
                finally:
                    queue.task_done()

        tasks = [asyncio.create_task(producer(), name="discover-producer")]
        tasks.extend(
            asyncio.create_task(worker(), name=f"discover-worker-{index}")
            for index in range(state.params.concurrency)
        )
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    def status(self) -> dict:
        with self._lock:
            state = self._state
            if state is None:
                return {
                    "running": False, "params": None, "total": 0, "scanned": 0,
                    "foundCount": 0, "recentHits": [], "startedAt": None,
                    "finishedAt": None, "error": "",
                }
            params = state.params
            return {
                "running": state.running,
                "params": {
                    "targets": list(params.targets),
                    "exclude": list(params.exclude),
                    "port": params.port,
                    "concurrency": params.concurrency,
                    "timeout": params.timeout,
                },
                "total": state.total,
                "scanned": state.scanned,
                "foundCount": state.found_count,
                "recentHits": [hit.to_view() for hit in state.recent_hits],
                "startedAt": state.started_at,
                "finishedAt": state.finished_at,
                "error": state.error,
            }

    def reset(self) -> None:
        """Atomically exclude starts while stopping, joining, and clearing state."""
        with self._lock:
            thread = self._thread
            if thread is threading.current_thread():
                raise RuntimeError("不能从扫描线程重置扫描器")
            if self._resetting:
                raise RuntimeError("扫描器正在重置")
            self._resetting = True
            state = self._state
            if state and state.running:
                self._cancel.set()
                loop, task = self._loop, self._scan_task
            else:
                loop = task = None
        try:
            if loop is not None and task is not None:
                self._cancel_task(loop, task)
            if thread is not None and thread is not threading.current_thread():
                thread.join()
            with self._lock:
                self._state = None
                self._loop = None
                self._scan_task = None
                self._thread = None
                self._cancel.clear()
        finally:
            with self._lock:
                self._resetting = False


discover_runner = DiscoverRunner()
