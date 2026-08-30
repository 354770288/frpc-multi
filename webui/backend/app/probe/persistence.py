"""Bounded, single-writer persistence lifecycle for discovery scans."""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable

from .discover import DiscoverParams, DiscoverRunner, DiscoverState
from .store import ProbeStore

HIT_QUEUE_SIZE = 1000
HIT_BATCH_SIZE = 100
HIT_BATCH_INTERVAL_SECONDS = 0.25
_STOP = object()


class DiscoverPersistenceError(RuntimeError):
    pass


class _HitWriter:
    def __init__(
        self,
        store_factory: Callable[[], ProbeStore],
        *,
        auto_route: bool,
        enqueue_route: Callable[[str], bool],
        stop_scan: Callable[[], bool],
        queue_size: int = HIT_QUEUE_SIZE,
        batch_size: int = HIT_BATCH_SIZE,
        batch_interval: float = HIT_BATCH_INTERVAL_SECONDS,
    ) -> None:
        self._store_factory = store_factory
        self._auto_route = auto_route
        self._enqueue_route = enqueue_route
        self._stop_scan = stop_scan
        self._queue: queue.Queue[tuple[str, int, float] | object] = queue.Queue(maxsize=queue_size)
        self._batch_size = batch_size
        self._batch_interval = batch_interval
        self._failure: BaseException | None = None
        self._failure_lock = threading.Lock()
        self._initialized = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="probe-discover-writer")

    def start(self) -> None:
        """Start the owner thread and prove its store initialized before returning."""
        self._thread.start()
        self._initialized.wait()
        try:
            self._raise_if_failed()
        except DiscoverPersistenceError:
            self._thread.join()
            raise

    def enqueue(self, ip: str, port: int, latency_ms: float) -> None:
        """Apply bounded backpressure only; all SQLite work belongs to the writer."""
        hit = (ip, port, latency_ms)
        while True:
            self._raise_if_failed()
            try:
                self._queue.put(hit, timeout=0.05)
                return
            except queue.Full:
                continue

    def finish(self) -> None:
        if self._thread is threading.current_thread():
            raise RuntimeError("writer cannot finish itself")
        while self._thread.is_alive():
            with self._failure_lock:
                failed = self._failure is not None
            if failed:
                break
            try:
                self._queue.put(_STOP, timeout=0.05)
                break
            except queue.Full:
                continue
        self._thread.join()
        self._raise_if_failed()

    def abort(self) -> None:
        """Stop a writer whose scanner reservation failed."""
        self.finish()

    def _raise_if_failed(self) -> None:
        with self._failure_lock:
            failure = self._failure
        if failure is not None:
            detail = str(failure).strip()
            message = f"发现结果持久化失败: {type(failure).__name__}"
            if detail:
                message += f": {detail}"
            raise DiscoverPersistenceError(message) from failure

    def _persist(self, store: ProbeStore, batch: list[tuple[str, int, float]]) -> None:
        # The transactional UPSERT completes before any route task becomes visible.
        eligible = store.upsert_discover_results_batch(batch)
        if self._auto_route:
            for ip in eligible:
                self._enqueue_route(ip)

    def _run(self) -> None:
        initialized = False
        try:
            store = self._store_factory()
            initialized = True
            self._initialized.set()
            batch: list[tuple[str, int, float]] = []
            deadline = time.monotonic() + self._batch_interval
            stopping = False
            while not stopping:
                timeout = max(0.0, deadline - time.monotonic())
                try:
                    item = self._queue.get(timeout=timeout)
                except queue.Empty:
                    item = None
                if item is _STOP:
                    stopping = True
                elif item is not None:
                    batch.append(item)
                if batch and (stopping or len(batch) >= self._batch_size or time.monotonic() >= deadline):
                    self._persist(store, batch)
                    batch = []
                    deadline = time.monotonic() + self._batch_interval
                elif not batch and time.monotonic() >= deadline:
                    deadline = time.monotonic() + self._batch_interval
        except BaseException as exc:
            with self._failure_lock:
                self._failure = exc
            self._initialized.set()
            if initialized:
                self._stop_scan()


class DiscoverScanCoordinator:
    """Own exactly one scanner/writer pair from reservation through final drain."""

    def __init__(
        self,
        runner: DiscoverRunner,
        store_factory: Callable[[], ProbeStore],
        enqueue_route: Callable[[str], bool],
    ) -> None:
        self._runner = runner
        self._store_factory = store_factory
        self._enqueue_route = enqueue_route
        self._lock = threading.Lock()
        self._writer: _HitWriter | None = None
        self._starting = False
        self._stop_requested = False
        self._startup_error = ""

    def start(self, params: DiscoverParams, *, auto_route: bool) -> DiscoverState:
        with self._lock:
            if self._writer is not None:
                raise RuntimeError("已有扫描在进行中")
            writer = _HitWriter(
                self._store_factory,
                auto_route=auto_route,
                enqueue_route=self._enqueue_route,
                stop_scan=self._runner.stop,
            )
            self._writer = writer
            self._starting = True
            self._stop_requested = False
        try:
            writer.start()
        except BaseException as exc:
            detail = str(exc).strip()
            with self._lock:
                self._startup_error = (
                    f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
                )
                if self._writer is writer:
                    self._writer = None
                    self._starting = False
                    self._stop_requested = False
            raise

        def finish_writer() -> None:
            try:
                writer.finish()
            finally:
                with self._lock:
                    if self._writer is writer:
                        self._writer = None

        def persist_hit(ip: str, port: int, latency_ms: float) -> None:
            writer.enqueue(ip, port, latency_ms)

        persist_hit.finish = finish_writer  # type: ignore[attr-defined]
        try:
            state = self._runner.start(params, on_hit=persist_hit)
            with self._lock:
                self._starting = False
                stop_requested = self._stop_requested
                self._stop_requested = False
                self._startup_error = ""
            if stop_requested:
                self._runner.stop()
            return state
        except BaseException:
            try:
                writer.abort()
            finally:
                with self._lock:
                    if self._writer is writer:
                        self._writer = None
                        self._starting = False
                        self._stop_requested = False
            raise

    def status(self) -> dict:
        status = self._runner.status()
        with self._lock:
            startup_error = self._startup_error
        if startup_error and not status["running"]:
            status["error"] = startup_error
        return status

    def stop(self) -> bool:
        with self._lock:
            if self._starting and self._writer is not None:
                self._stop_requested = True
                return True
        return self._runner.stop()
