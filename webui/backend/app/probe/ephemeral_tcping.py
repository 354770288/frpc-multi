"""Ephemeral, zero-persistence TCP port prober over probe workers and Console.

Used by LB business-port / GFW block health checks to execute fast single-(IP, port)
tcping checks from the configured primary (domestic) and backup (external / Console)
test nodes without polluting ``probe_jobs``, ``probe_tasks``, ``probe_results``, or
``probe_discover_results``, and without requiring external workers to reinstall a
new protocol binary (reuses the worker's existing 1-IP ``discover`` TCP connector).
"""

from __future__ import annotations

import ipaddress
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

from .engine import tcping

TASK_PREFIX = "lb-tcping:"
DEFAULT_TCP_TIMEOUT = 2.5
DEFAULT_CLAIM_TIMEOUT = 10.0


@dataclass
class _PendingProbe:
    task_id: str
    attempt_id: str
    node_id: str
    ip: str
    ip_int: int
    port: int
    timeout: float
    created_at: float
    expires_at: float
    done: threading.Event = field(default_factory=threading.Event)
    claimed: bool = False
    seq: int = 0
    hit_latency_ms: float | None = None
    ok: bool | None = None
    detail: str = ""


class EphemeralTcpingBroker:
    """Thread-safe in-memory broker for short-lived worker TCP port checks."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._queues: dict[str, deque[_PendingProbe]] = {}
        self._tasks: dict[str, _PendingProbe] = {}

    def is_ephemeral_task(self, task_id: str | None) -> bool:
        return isinstance(task_id, str) and task_id.startswith(TASK_PREFIX)

    def _prune_expired_locked(self, now: float) -> None:
        expired_ids = [tid for tid, item in self._tasks.items() if item.expires_at <= now]
        for tid in expired_ids:
            item = self._tasks.pop(tid, None)
            if item and not item.done.is_set():
                item.ok = None
                item.detail = "等待测试节点响应超时"
                item.done.set()
        for node_id in list(self._queues):
            queue = self._queues[node_id]
            while queue and (queue[0].expires_at <= now or queue[0].task_id not in self._tasks):
                queue.popleft()
            if not queue:
                self._queues.pop(node_id, None)

    def claim_for_node(self, node_id: str) -> dict | None:
        now = time.monotonic()
        with self._lock:
            self._prune_expired_locked(now)
            queue = self._queues.get(node_id)
            while queue:
                item = queue.popleft()
                if item.task_id not in self._tasks or item.done.is_set():
                    continue
                item.claimed = True
                return {
                    "taskId": item.task_id,
                    "attemptId": item.attempt_id,
                    "generation": 0,
                    "jobId": "lb-ephemeral",
                    "nodeId": item.node_id,
                    "stage": "discover",
                    "ip": item.ip,
                    "port": item.port,
                    "options": {"concurrency": 1, "timeout": item.timeout},
                    "payload": {"chunk": [[item.ip_int, item.ip_int]]},
                    "leaseSeconds": 30,
                }
        return None

    def touch_heartbeat(self, node_id: str, task_id: str, attempt_id: str) -> bool:
        now = time.monotonic()
        with self._lock:
            self._prune_expired_locked(now)
            item = self._tasks.get(task_id)
            if item is None or item.node_id != node_id or item.attempt_id != attempt_id or item.done.is_set():
                return False
            item.expires_at = max(item.expires_at, now + 20.0)
            return True

    def record_progress(self, node_id: str, task_id: str, attempt_id: str, seq: int, *,
                        hits: list[dict] | tuple = ()) -> dict:
        with self._lock:
            item = self._tasks.get(task_id)
            if item is None or item.node_id != node_id or item.attempt_id != attempt_id or item.done.is_set():
                return {"ok": True, "accepted": False, "cancel": True}
            if seq <= item.seq:
                return {"ok": True, "accepted": True, "seq": item.seq}
            if seq != item.seq + 1:
                return {"ok": False, "accepted": False, "seq": item.seq}
            item.seq = seq
            for hit in hits:
                if str(hit.get("ip", "")) == item.ip and int(hit.get("port", item.port)) == item.port:
                    try:
                        item.hit_latency_ms = float(hit.get("latencyMs", hit.get("latency_ms", 0.0)))
                    except (TypeError, ValueError):
                        item.hit_latency_ms = 0.0
            return {"ok": True, "accepted": True, "seq": item.seq}

    def record_report(self, node_id: str, task_id: str, attempt_id: str, *,
                      result: dict | None = None, infra_error: str | None = None) -> dict:
        with self._lock:
            item = self._tasks.pop(task_id, None)
            if item is None or item.node_id != node_id or item.attempt_id != attempt_id:
                return {"ok": True, "applied": False, "accepted": True}
            if infra_error:
                item.ok = None
                item.detail = f"探测节点执行异常: {str(infra_error)[:200]}"
            elif isinstance(result, dict) and result.get("cancelled"):
                item.ok = None
                item.detail = "探测任务已取消"
            else:
                found = int((result or {}).get("foundCount", 0) or 0)
                if found > 0 or item.hit_latency_ms is not None:
                    item.ok = True
                    ms = item.hit_latency_ms if item.hit_latency_ms is not None else 0.0
                    item.detail = f"{ms:.0f}ms" if ms > 0 else "tcp ok"
                else:
                    item.ok = False
                    item.detail = "tcping timeout/refused"
            item.done.set()
            return {"ok": True, "applied": True, "accepted": True}

    def _run_worker_once(self, node_id: str, ip: str, ip_int: int, port: int, *,
                         timeout: float, claim_timeout: float) -> tuple[bool | None, str]:
        now = time.monotonic()
        wait_window = max(claim_timeout, timeout + 3.0)
        entry = _PendingProbe(
            task_id=f"{TASK_PREFIX}{uuid.uuid4().hex}",
            attempt_id=uuid.uuid4().hex,
            node_id=node_id,
            ip=ip,
            ip_int=ip_int,
            port=int(port),
            timeout=float(timeout),
            created_at=now,
            expires_at=now + wait_window + 2.0,
        )
        with self._lock:
            self._prune_expired_locked(now)
            self._tasks[entry.task_id] = entry
            self._queues.setdefault(node_id, deque()).append(entry)
        try:
            if not entry.done.wait(wait_window):
                with self._lock:
                    self._tasks.pop(entry.task_id, None)
                return None, "等待测试节点响应超时"
            return entry.ok, entry.detail
        finally:
            with self._lock:
                self._tasks.pop(entry.task_id, None)

    def probe_tcp(
        self,
        job_store,
        node_id: str,
        ip: str,
        port: int,
        *,
        timeout: float = DEFAULT_TCP_TIMEOUT,
        retries: int = 2,
        claim_timeout: float = DEFAULT_CLAIM_TIMEOUT,
        local_prober: Callable[[str, int, float], tuple[bool, str]] | None = None,
    ) -> tuple[bool | None, str]:
        """Execute a bounded tcping from ``node_id`` to ``(ip, port)``.

        Returns ``(True, detail)`` when reachable, ``(False, detail)`` when confirmed
        unreachable, or ``(None, reason)`` when the probing node itself is offline or
        encountered an infrastructure timeout/error.
        """
        attempts = max(1, int(retries))
        if node_id == "console":
            prober = local_prober or (lambda host, p, t: tcping(host, p, t))
            last_detail = "tcping failed"
            for idx in range(attempts):
                ok, detail = prober(ip, int(port), float(timeout))
                if ok:
                    return True, detail
                last_detail = detail
                if idx + 1 < attempts:
                    time.sleep(0.15)
            return False, last_detail

        try:
            node = job_store.get_node(node_id)
        except KeyError:
            return None, f"测试节点不存在: {node_id}"
        if not node.get("online"):
            return None, f"测试节点离线: {node.get('name') or node_id}"
        if "discover" not in (node.get("capabilities") or []):
            return None, f"测试节点不支持 TCP 探测: {node.get('name') or node_id}"

        try:
            parsed = ipaddress.IPv4Address(ip)
        except ipaddress.AddressValueError:
            return None, f"非 IPv4 目标暂不支持外部节点探测: {ip}"

        ip_int = int(parsed)
        last_detail = "tcping timeout/refused"
        for idx in range(attempts):
            ok, detail = self._run_worker_once(
                node_id, str(parsed), ip_int, int(port),
                timeout=timeout, claim_timeout=claim_timeout,
            )
            if ok is True:
                return True, detail
            if ok is None:
                return None, detail
            last_detail = detail
            if idx + 1 < attempts:
                time.sleep(0.2)
        return False, last_detail

    def reset(self) -> None:
        with self._lock:
            for item in self._tasks.values():
                item.ok = None
                item.detail = "reset"
                item.done.set()
            self._tasks.clear()
            self._queues.clear()


ephemeral_tcping_broker = EphemeralTcpingBroker()
