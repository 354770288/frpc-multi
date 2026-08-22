"""批量测试任务运行器：线程池并行 + 状态快照 + 协作取消（跳过/停止）。

并行模型：每个并发 worker 从端口槽池领取独立本地端口组
（local_base_port + slot*3），远端映射端口不变——批量测试中每台
frps 同一时刻只被一个 worker 连接，服务器之间天然无端口冲突。
连通性探测并发较高（无带宽占用）；速率测试并发刻意压低，避免
本机出口带宽竞争导致测速失真。

跳过语义：并行下「跳过」丢弃所有进行中的 IP 并继续后续任务
（世代计数实现，见 _skip_generation）。
"""

from __future__ import annotations

import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from typing import Callable

from .engine import ProbeOptions, run_connectivity_probe, run_speed_probe
from .store import ProbeStore

MODES = {"connectivity", "speed", "full"}

_RECENT_LIMIT = 30


def _idle_state() -> dict:
    return {
        "running": False,
        "mode": "",
        "phase": "",
        "workers": [],
        "done": 0,
        "total": 0,
        "startedAt": None,
        "finishedAt": None,
        "stopped": False,
        "recent": [],
    }


class ProbeRunner:
    def __init__(self, store_factory: Callable[[], ProbeStore]):
        self._store_factory = store_factory
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        # 每次「跳过」自增：worker 持有的世代落后即视为被取消
        self._skip_generation = 0
        self._state = _idle_state()

    # ---- 状态 ----

    def status(self) -> dict:
        with self._lock:
            return {**self._state, "workers": list(self._state["workers"]),
                    "recent": list(self._state["recent"])}

    def _update(self, **changes) -> None:
        with self._lock:
            self._state.update(changes)

    def _append_recent(self, entry: dict) -> None:
        with self._lock:
            self._state["recent"].append(entry)
            del self._state["recent"][:-_RECENT_LIMIT]

    def _worker_upsert(self, ip: str, **changes) -> None:
        with self._lock:
            workers = self._state["workers"]
            for item in workers:
                if item["ip"] == ip:
                    item.update(changes)
                    break
            else:
                workers.append({"ip": ip, "step": "", "text": "", **changes})

    def _worker_remove(self, ip: str) -> None:
        with self._lock:
            self._state["workers"] = [item for item in self._state["workers"] if item["ip"] != ip]

    # ---- 控制 ----

    def start(self, mode: str, ips: list[str], options: ProbeOptions) -> tuple[bool, str]:
        if mode not in MODES:
            return False, f"未知测试模式: {mode}"
        if not ips:
            return False, "没有可测试的服务器"
        with self._lock:
            if self._state["running"]:
                return False, "已有测试任务在运行"
            self._state = _idle_state()
            self._state.update(
                running=True, mode=mode, phase="connectivity" if mode != "speed" else "speed",
                total=len(ips), startedAt=time.strftime("%Y-%m-%dT%H:%M:%S"),
            )
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._execute, args=(mode, list(ips), options), daemon=True,
            name="probe-runner",
        )
        self._thread.start()
        return True, ""

    def skip_current(self) -> bool:
        if not self.status()["running"]:
            return False
        with self._lock:
            self._skip_generation += 1
        return True

    def stop(self) -> bool:
        if not self.status()["running"]:
            return False
        self._stop.set()
        return True

    def _cancelled_for(self, generation: int) -> Callable[[], bool]:
        """属于某世代的取消回调：全局停止，或该 worker 已被跳过。"""
        def check() -> bool:
            if self._stop.is_set():
                return True
            with self._lock:
                return self._skip_generation != generation
        return check

    # ---- 任务主体 ----

    def _execute(self, mode: str, ips: list[str], options: ProbeOptions) -> None:
        store = self._store_factory()
        passed: list[str] = []
        try:
            if mode in {"connectivity", "full"}:
                passed = self._run_batch(
                    store, ips, options, phase="connectivity",
                    runner=run_connectivity_probe,
                )
            if mode in {"speed", "full"}:
                speed_ips = ips if mode == "speed" else passed
                if mode == "full" and not speed_ips:
                    self._append_recent({
                        "ip": "—", "kind": "connectivity", "skipped": True, "ok": False,
                        "summary": "没有连通性通过的服务器，跳过速率测试",
                    })
                else:
                    self._run_batch(store, speed_ips, options, phase="speed", runner=run_speed_probe)
        finally:
            with self._lock:
                self._state["running"] = False
                self._state["workers"] = []
                self._state["stopped"] = self._stop.is_set()
                self._state["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")

    def _run_batch(self, store: ProbeStore, ips: list[str], options: ProbeOptions, *,
                   phase: str, runner: Callable) -> list[str]:
        concurrency = max(1, options.conn_concurrency if phase == "connectivity" else options.speed_concurrency)
        self._update(phase=phase, done=0, total=len(ips), workers=[])

        slots: queue.Queue[int] = queue.Queue()
        for index in range(concurrency):
            slots.put(index)
        collected: list[str] = []
        collected_lock = threading.Lock()

        def classify(result: dict) -> tuple[bool, str]:
            """(是否通过, 摘要)"""
            if phase == "connectivity":
                ok = bool(result["frps_reachable"] and result["tunnel_established"] and result["firewall_open"])
                summary = "连通性通过" if ok else (result.get("detail") or "未通过")[:80]
            else:
                ok = bool(result["dl_ok"] or result["ul_ok"])
                if result["dl_ok"] and result["ul_ok"]:
                    summary = f"↓ {result['dl_speed_str']}  ↑ {result['ul_speed_str']}"
                elif result["dl_ok"]:
                    summary = f"↓ {result['dl_speed_str']}（上传失败）"
                elif result["ul_ok"]:
                    summary = f"↑ {result['ul_speed_str']}（下载失败）"
                else:
                    summary = (result.get("detail") or "速率测试未通过")[:80]
            return ok, summary

        def work(ip: str) -> None:
            if self._stop.is_set():
                return
            with self._lock:
                generation = self._skip_generation
            slot = slots.get()
            try:
                worker_options = replace(options, local_base_port=options.local_base_port + slot * 3)
                self._worker_upsert(ip)
                result = runner(
                    ip, worker_options,
                    on_step=lambda msg, _ip=ip: self._worker_upsert(_ip, step=msg),
                    on_progress=lambda msg, _ip=ip: self._worker_upsert(_ip, text=msg),
                    cancel=self._cancelled_for(generation),
                )
                skipped = self._cancelled_for(generation)()
                if self._stop.is_set():
                    return
                if not skipped:
                    if phase == "connectivity":
                        store.add_connectivity_result(result)
                    else:
                        store.add_speed_result(result)
                    ok, summary = classify(result)
                    if phase == "connectivity" and ok:
                        with collected_lock:
                            collected.append(ip)
                else:
                    ok, summary = False, ""
                self._append_recent({
                    "ip": ip, "kind": phase, "skipped": skipped, "ok": ok, "summary": summary,
                })
                with self._lock:
                    self._state["done"] += 1
            finally:
                self._worker_remove(ip)
                slots.put(slot)

        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="probe-worker") as pool:
            list(pool.map(work, ips))
        return collected
