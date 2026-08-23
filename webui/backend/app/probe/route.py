"""CN2 路由追踪：任务队列 + 测试节点注册表（多节点轮询、领取超时自动重派）。

国内路由测试节点无公网 IP，采用节点 → 主控轮询模型：
- 节点凭独立 Token 调 /route/claim 原子领取任务（多节点天然负载均衡）；
- 领取超过 CLAIM_TIMEOUT_SECONDS 未回报视为节点掉线，任务重回队首由
  其他节点接手（故障切换零人工）；
- /route/report 幂等：未知/已完成任务静默接受；
- 结论以系统保留标签写入发现行：CN2 / 非CN2 / 未路由测试（失败回退）。
"""

from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field

from ..models import now_iso
from .store import ROUTE_LABEL_CN2, ROUTE_LABEL_NON_CN2, ROUTE_LABEL_UNTESTED, ProbeStore

CLAIM_TIMEOUT_SECONDS = 120
ONLINE_WINDOW_SECONDS = 30


@dataclass
class RouteTask:
    id: int
    ip: str
    state: str = "pending"  # pending | running | done | failed
    claimed_by: str = ""
    claimed_at: float = 0.0
    created_at: str = field(default_factory=now_iso)


def route_label(ok: bool, is_cn2: bool) -> str:
    """测试结论 → 保留标签；失败回退「未路由测试」。"""
    if not ok:
        return ROUTE_LABEL_UNTESTED
    return ROUTE_LABEL_CN2 if is_cn2 else ROUTE_LABEL_NON_CN2


class RouteHub:
    """模块级单例：任务队列与节点心跳（节点名单持久化在 probe_settings KV）。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._tasks: list[RouteTask] = []
        self._next_id = 0
        self._last_seen: dict[str, float] = {}

    # ---- 节点管理（持久化部分由 router 经 store 完成，这里管心跳）----

    def touch(self, node_name: str) -> None:
        with self._lock:
            self._last_seen[node_name] = time.monotonic()

    def is_online(self, node_name: str) -> bool:
        with self._lock:
            seen = self._last_seen.get(node_name)
        return seen is not None and time.monotonic() - seen <= ONLINE_WINDOW_SECONDS

    # ---- 任务队列 ----

    def enqueue(self, ip: str) -> bool:
        """入队；同 IP 已有待处理任务则跳过。返回是否新增。"""
        with self._lock:
            if any(task.ip == ip and task.state in {"pending", "running"} for task in self._tasks):
                return False
            self._next_id += 1
            self._tasks.append(RouteTask(id=self._next_id, ip=ip))
            return True

    def _requeue_expired(self) -> None:
        now = time.monotonic()
        for task in self._tasks:
            if task.state == "running" and now - task.claimed_at > CLAIM_TIMEOUT_SECONDS:
                task.state = "pending"
                task.claimed_by = ""
                task.claimed_at = 0.0

    def claim(self, node_name: str) -> dict | None:
        """原子领取队首待处理任务；无任务返回 None。"""
        with self._lock:
            self._requeue_expired()
            for task in self._tasks:
                if task.state == "pending":
                    task.state = "running"
                    task.claimed_by = node_name
                    task.claimed_at = time.monotonic()
                    return {"taskId": task.id, "ip": task.ip}
        return None

    def report(self, task_id: int, *, ok: bool, is_cn2: bool) -> RouteTask | None:
        """回报结果；返回对应任务（调用方据此写标签），未知/已完成返回 None（幂等）。"""
        with self._lock:
            self._requeue_expired()
            for task in self._tasks:
                if task.id == task_id and task.state == "running":
                    task.state = "done" if ok else "failed"
                    return task
        return None

    def stop(self) -> int:
        """清空待处理队列（进行中的回报仍被接受），返回清除数量。"""
        with self._lock:
            before = len(self._tasks)
            self._tasks = [task for task in self._tasks if task.state != "pending"]
            return before - len(self._tasks)

    def reset(self) -> None:
        """测试用：清空队列与心跳。"""
        with self._lock:
            self._tasks.clear()
            self._last_seen.clear()

    def status(self) -> dict:
        with self._lock:
            self._requeue_expired()
            counts = {"pending": 0, "running": 0, "done": 0, "failed": 0}
            running = []
            for task in self._tasks:
                counts[task.state] += 1
                if task.state == "running":
                    running.append({"taskId": task.id, "ip": task.ip, "node": task.claimed_by})
            # 终态任务只保留最近 500 条，防长期增长
            if len(self._tasks) > 500:
                finished = [t for t in self._tasks if t.state in {"done", "failed"}]
                keep = {t.id for t in finished[-500:]}
                self._tasks = [t for t in self._tasks if t.state not in {"done", "failed"} or t.id in keep]
            return {"active": counts["pending"] + counts["running"] > 0,
                    "pending": counts["pending"], "running": counts["running"],
                    "done": counts["done"], "failed": counts["failed"], "runningTasks": running}


# 模块级单例：与进程同生命周期
route_hub = RouteHub()


def generate_node_token() -> str:
    return secrets.token_hex(16)


def load_route_nodes(store: ProbeStore) -> list[dict]:
    import json

    raw = store.get_setting("route_nodes")
    try:
        nodes = json.loads(raw) if raw else []
    except ValueError:
        nodes = []
    return nodes if isinstance(nodes, list) else []


def save_route_nodes(store: ProbeStore, nodes: list[dict]) -> None:
    import json

    store.set_setting("route_nodes", json.dumps(nodes, ensure_ascii=False))
