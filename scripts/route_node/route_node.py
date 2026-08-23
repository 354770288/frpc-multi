#!/usr/bin/env python3
"""frpc-multi 路由测试节点（国内服务器部署，无需公网 IP）。

轮询主控领任务 → 本机 mtr 测试去程路由 → 判定是否 CN2（任一跳 59.43.*）→ 回报。
仅依赖 Python 3 标准库 + mtr（apt install mtr）。多节点部署：面板各自生成
Token，每台机器用各自 Token 启动即可；节点掉线后其领取的任务会被主控
自动回收重派给其他节点。

环境变量：
  CONSOLE_URL    主控地址，如 http://23.19.228.204:8081
  ROUTE_TOKEN    面板「路由节点」里为该节点生成的 Token（必填）
  POLL_INTERVAL  轮询间隔秒数（默认 3）
  MTR_COUNT      mtr 探测次数（默认 5）
  MTR_TIMEOUT    单次 mtr 超时秒数（默认 60）
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONSOLE_URL = os.environ.get("CONSOLE_URL", "").rstrip("/")
ROUTE_TOKEN = os.environ.get("ROUTE_TOKEN", "")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "3"))
MTR_COUNT = os.environ.get("MTR_COUNT", "5")
MTR_TIMEOUT = float(os.environ.get("MTR_TIMEOUT", "60"))

CN2_PREFIX = "59.43."


def log(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def post(path: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload or {}).encode()
    request = urllib.request.Request(
        CONSOLE_URL + path, data=data,
        headers={"Content-Type": "application/json", "X-Route-Token": ROUTE_TOKEN},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def mtr_trace(ip: str) -> dict:
    """执行 mtr 并判定 CN2；返回 {ok, isCn2, error, hops}。"""
    try:
        result = subprocess.run(
            ["mtr", "--json", "--no-dns", "-c", MTR_COUNT, ip],
            capture_output=True, text=True, timeout=MTR_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "isCn2": False, "error": f"mtr 超时（{MTR_TIMEOUT}s）", "hops": []}
    except FileNotFoundError:
        return {"ok": False, "isCn2": False, "error": "未安装 mtr（apt install mtr）", "hops": []}
    if result.returncode != 0:
        return {"ok": False, "isCn2": False,
                "error": f"mtr 退出码 {result.returncode}: {result.stderr.strip()[:200]}", "hops": []}
    try:
        report = json.loads(result.stdout).get("report", {})
    except ValueError:
        return {"ok": False, "isCn2": False, "error": "mtr 输出解析失败", "hops": []}

    hops = []
    is_cn2 = False
    # mtr JSON 的跳数组键名是 "hubs"（mtr 内部把 hop 叫 hub），兼容个别版本的 "hops"
    for hop in report.get("hubs") or report.get("hops") or []:
        host = str(hop.get("host", ""))
        if host.startswith(CN2_PREFIX):
            is_cn2 = True
        hops.append({"hop": hop.get("count"), "host": host,
                     "loss": hop.get("Loss%"), "avg": hop.get("Avg")})
    if not hops:
        # 成功的 mtr 至少有目标本身一跳；0 跳说明 JSON 结构变了，按失败回报而非误判非 CN2
        return {"ok": False, "isCn2": False, "error": "mtr 输出无跳数（JSON 结构异常）", "hops": []}
    return {"ok": True, "isCn2": is_cn2, "error": "", "hops": hops}


def main() -> int:
    if not CONSOLE_URL or not ROUTE_TOKEN:
        print("缺少 CONSOLE_URL 或 ROUTE_TOKEN 环境变量", file=sys.stderr)
        return 2
    log(f"路由测试节点启动：主控 {CONSOLE_URL}，轮询 {POLL_INTERVAL}s")
    while True:
        try:
            claimed = post("/api/probe/route/claim")
            task = claimed.get("task")
            if not task:
                time.sleep(POLL_INTERVAL)
                continue
            ip = task["ip"]
            log(f"领取任务 #{task['taskId']} → {ip}，开始 mtr…")
            result = mtr_trace(ip)
            if result["ok"]:
                log(f"{ip}: {'CN2 线路' if result['isCn2'] else '非 CN2 线路'}（{len(result['hops'])} 跳）")
            else:
                log(f"{ip}: 测试失败 {result['error']}")
            post("/api/probe/route/report", {
                "taskId": task["taskId"],
                "ok": result["ok"],
                "isCn2": result["isCn2"],
                "error": result["error"],
            })
        except urllib.error.URLError as exc:
            log(f"连接主控失败：{exc}，{POLL_INTERVAL}s 后重试")
            time.sleep(POLL_INTERVAL)
        except Exception as exc:  # noqa: BLE001 - 常驻进程不能退出
            log(f"异常：{exc}，{POLL_INTERVAL}s 后重试")
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
