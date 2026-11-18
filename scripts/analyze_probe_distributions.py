#!/usr/bin/env python3
"""目标网络响应分布只读统计脚本（Destination-Network Response Distributions）。

在不向外部目标发送任何主动探测流量的前提下，对给定的只读 ``console.db``（或隔离合成评估库）
统计：
1. 网段发现首轮 TCP 握手延迟分位数（P10/P25/P50/P75/P90/P95/P99/Max）与分桶占比；
2. 路由探测（MTR）成功率、CN2 命中率与路由跳数分位数；
3. 穿透连通性三阶段漏斗（frps_reachable -> tunnel_established -> firewall_open）转化率与失败原因分布；
4. 上下行测速成功率与吞吐率（Mbps）分位数；
5. 执行节点观测分布与主备故障接替次数。
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "webui" / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def quantiles(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {
            "count": 0,
            "min": None,
            "p10": None,
            "p25": None,
            "p50": None,
            "p75": None,
            "p90": None,
            "p95": None,
            "p99": None,
            "max": None,
            "mean": None,
        }
    ordered = sorted(float(v) for v in values)
    n = len(ordered)

    def pick(pct: float) -> float:
        if n == 1:
            return round(ordered[0], 2)
        pos = (n - 1) * pct
        lo = int(math.floor(pos))
        hi = int(math.ceil(pos))
        val = ordered[lo] if lo == hi else ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)
        return round(val, 2)

    return {
        "count": n,
        "min": round(ordered[0], 2),
        "p10": pick(0.10),
        "p25": pick(0.25),
        "p50": pick(0.50),
        "p75": pick(0.75),
        "p90": pick(0.90),
        "p95": pick(0.95),
        "p99": pick(0.99),
        "max": round(ordered[-1], 2),
        "mean": round(sum(ordered) / n, 2),
    }


def classify_failure_detail(detail: str) -> str:
    text = (detail or "").strip().lower()
    if not text or text == "ok":
        return "ok"
    if "timeout" in text or "超时" in text:
        return "timeout"
    if "refused" in text or "拒绝" in text:
        return "connection_refused"
    if "login" in text or "token" in text or "auth" in text or "认证" in text:
        return "auth_or_tunnel_rejected"
    if "firewall" in text or "remote" in text or "映射" in text:
        return "remote_port_blocked"
    return "other_error"


def analyze_database(db_path: Path, *, dataset_kind: str = "snapshot") -> dict[str, Any]:
    if not db_path.is_file():
        raise FileNotFoundError(f"Database not found: {db_path}")
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}

        # 1. 网段发现延迟分布
        discover_latencies: list[float] = []
        latency_buckets = Counter({"<50ms": 0, "50-150ms": 0, "150-300ms": 0, ">=300ms": 0})
        if "probe_discover_results" in tables:
            for row in conn.execute("SELECT latency_ms FROM probe_discover_results WHERE latency_ms IS NOT NULL"):
                ms = float(row[0] or 0.0)
                discover_latencies.append(ms)
                if ms < 50:
                    latency_buckets["<50ms"] += 1
                elif ms < 150:
                    latency_buckets["50-150ms"] += 1
                elif ms < 300:
                    latency_buckets["150-300ms"] += 1
                else:
                    latency_buckets[">=300ms"] += 1

        # 2. 正式测试结果（route / connectivity / speed）分布
        route_total = 0
        route_ok = 0
        route_cn2 = 0
        route_hop_counts: list[float] = []

        conn_total = 0
        conn_reachable = 0
        conn_tunnel = 0
        conn_firewall = 0
        conn_full_pass = 0
        conn_failure_reasons: Counter[str] = Counter()

        speed_total = 0
        dl_ok_mbps: list[float] = []
        ul_ok_mbps: list[float] = []
        node_counts: Counter[str] = Counter()

        if "probe_results" in tables:
            for row in conn.execute("SELECT node_id, kind, data FROM probe_results"):
                node_counts[str(row["node_id"] or "unknown")] += 1
                kind = row["kind"]
                try:
                    data = json.loads(row["data"] or "{}")
                except (TypeError, ValueError):
                    data = {}

                if kind == "route":
                    route_total += 1
                    if data.get("ok"):
                        route_ok += 1
                        if data.get("isCn2"):
                            route_cn2 += 1
                        hops = data.get("hops")
                        if isinstance(hops, list):
                            route_hop_counts.append(float(len(hops)))
                elif kind == "connectivity":
                    conn_total += 1
                    r_ok = bool(data.get("frps_reachable"))
                    t_ok = bool(data.get("tunnel_established"))
                    f_ok = bool(data.get("firewall_open"))
                    if r_ok:
                        conn_reachable += 1
                    if t_ok:
                        conn_tunnel += 1
                    if f_ok:
                        conn_firewall += 1
                    if r_ok and t_ok and f_ok:
                        conn_full_pass += 1
                    else:
                        conn_failure_reasons[classify_failure_detail(str(data.get("detail") or ""))] += 1
                elif kind == "speed":
                    speed_total += 1
                    if data.get("dl_ok"):
                        mbps = data.get("dl_speed_mbps")
                        if mbps is None and data.get("dl_speed_bps") is not None:
                            mbps = float(data["dl_speed_bps"]) * 8.0 / (1024 * 1024)
                        if mbps is not None:
                            dl_ok_mbps.append(float(mbps))
                    if data.get("ul_ok"):
                        mbps = data.get("ul_speed_mbps")
                        if mbps is None and data.get("ul_speed_bps") is not None:
                            mbps = float(data["ul_speed_bps"]) * 8.0 / (1024 * 1024)
                        if mbps is not None:
                            ul_ok_mbps.append(float(mbps))

        failover_count = 0
        if "probe_task_transfers" in tables:
            failover_count = int(conn.execute("SELECT COUNT(*) FROM probe_task_transfers").fetchone()[0])

        asset_count = (
            int(conn.execute("SELECT COUNT(*) FROM probe_servers").fetchone()[0])
            if "probe_servers" in tables
            else 0
        )

        return {
            "analyzedAt": datetime.now(timezone.utc).isoformat(),
            "datasetKind": dataset_kind,
            "databasePath": str(db_path),
            "assetCount": asset_count,
            "discovery": {
                "latencyMs": quantiles(discover_latencies),
                "buckets": dict(latency_buckets),
            },
            "route": {
                "total": route_total,
                "okCount": route_ok,
                "cn2Count": route_cn2,
                "hopCount": quantiles(route_hop_counts),
            },
            "connectivity": {
                "total": conn_total,
                "frpsReachableCount": conn_reachable,
                "tunnelEstablishedCount": conn_tunnel,
                "firewallOpenCount": conn_firewall,
                "fullPassCount": conn_full_pass,
                "failureReasons": dict(conn_failure_reasons),
            },
            "speed": {
                "total": speed_total,
                "downloadMbps": quantiles(dl_ok_mbps),
                "uploadMbps": quantiles(ul_ok_mbps),
            },
            "execution": {
                "resultsByNode": dict(node_counts),
                "taskFailoverTransfers": failover_count,
            },
        }
    finally:
        conn.close()


def render_markdown(report: dict[str, Any]) -> str:
    disc = report["discovery"]["latencyMs"]
    conn = report["connectivity"]
    dl = report["speed"]["downloadMbps"]
    ul = report["speed"]["uploadMbps"]
    hop = report["route"]["hopCount"]

    lines = [
        "# 目标网络响应分布统计报告",
        "",
        f"- 生成时间：`{report['analyzedAt']}`",
        f"- 数据集性质：`{report['datasetKind']}`（{ '隔离仿真基准样本，非真实公网硬件承诺' if report['datasetKind'] == 'synthetic_rehearsal' else '只读数据库快照统计' }）",
        f"- 资产总数：`{report['assetCount']}`",
        "",
        "## 1. 网段发现首轮 TCP 延迟分布（ms）",
        "",
        f"- 样本数：`{disc['count']}` · P50：`{disc['p50']}` · P90：`{disc['p90']}` · P95：`{disc['p95']}` · P99：`{disc['p99']}` · Max：`{disc['max']}`",
        f"- 分桶统计：`{json.dumps(report['discovery']['buckets'], ensure_ascii=False)}`",
        "",
        "## 2. 穿透连通性三阶段转化漏斗",
        "",
        "| 阶段 | 数量 | 占总连通性样本比 |",
        "| --- | --- | --- |",
        f"| 总连通性测试 | {conn['total']} | 100.0% |",
        f"| `frps_reachable`（TCP 可达） | {conn['frpsReachableCount']} | {(conn['frpsReachableCount'] / conn['total'] * 100) if conn['total'] else 0:.1f}% |",
        f"| `tunnel_established`（认证与隧道成功） | {conn['tunnelEstablishedCount']} | {(conn['tunnelEstablishedCount'] / conn['total'] * 100) if conn['total'] else 0:.1f}% |",
        f"| `firewall_open`（业务测试端口放行） | {conn['firewallOpenCount']} | {(conn['firewallOpenCount'] / conn['total'] * 100) if conn['total'] else 0:.1f}% |",
        f"| 完整通过（Pass） | {conn['fullPassCount']} | {(conn['fullPassCount'] / conn['total'] * 100) if conn['total'] else 0:.1f}% |",
        "",
        f"- 未通过原因分类：`{json.dumps(conn['failureReasons'], ensure_ascii=False)}`",
        "",
        "## 3. 路由与上下行测速分位数",
        "",
        f"- 路由探测：共 `{report['route']['total']}` 次，成功 `{report['route']['okCount']}` 次，CN2 命中 `{report['route']['cn2Count']}` 次，跳数 P50=`{hop['p50']}` / P95=`{hop['p95']}`",
        f"- 下行速率（Mbps）：有效 `{dl['count']}` 次，P50=`{dl['p50']}` / P90=`{dl['p90']}` / P95=`{dl['p95']}` / Max=`{dl['max']}`",
        f"- 上行速率（Mbps）：有效 `{ul['count']}` 次，P50=`{ul['p50']}` / P90=`{ul['p90']}` / P95=`{ul['p95']}` / Max=`{ul['max']}`",
        f"- 执行节点分布：`{json.dumps(report['execution']['resultsByNode'], ensure_ascii=False)}`（故障接替 `{report['execution']['taskFailoverTransfers']}` 次）",
    ]
    return "\n".join(lines) + "\n"


def run_synthetic_self_test() -> dict[str, Any]:
    from app.control.database import connect_database, initialize_database

    with tempfile.TemporaryDirectory(prefix="frpc-dist-selftest-") as tmp_dir:
        db_path = Path(tmp_dir) / "synthetic.db"
        initialize_database(db_path)
        conn = connect_database(db_path)
        try:
            now = datetime.now(timezone.utc).isoformat()
            # 注入 200 条分层延迟发现样本（亚太低延迟、美西中延迟、欧洲/拥塞高延迟）
            discover_rows = []
            for idx in range(1, 201):
                ip = f"198.51.100.{idx}"
                ms = 18.0 + (idx % 30) if idx <= 80 else (135.0 + (idx % 60) if idx <= 160 else 280.0 + (idx % 150))
                discover_rows.append((ip, idx, 7000, ms, now))
            conn.executemany(
                "INSERT INTO probe_discover_results(ip, ip_sort, port, latency_ms, discovered_at) VALUES (?, ?, ?, ?, ?)",
                discover_rows,
            )
            # 注入多样化连通性、路由与速率历史样本
            results = []
            seq = 0
            for idx in range(1, 101):
                ip = f"198.51.100.{idx}"
                conn.execute("INSERT INTO probe_servers(ip, ip_sort, created_at) VALUES (?, ?, ?)", (ip, idx, now))
                # route
                seq += 1
                is_cn2 = idx <= 25
                hops = [{"hop": h, "host": f"59.43.0.{h}" if (is_cn2 and h == 3) else f"10.0.0.{h}"} for h in range(1, 9 + (idx % 8))]
                results.append((f"t-{seq}", f"a-{seq}", "j-1", "primary-cn", "route", ip, 7000, now, json.dumps({"ok": idx <= 90, "isCn2": is_cn2, "hops": hops if idx <= 90 else []})))
                # connectivity funnel
                seq += 1
                if idx <= 55:
                    cdata = {"frps_reachable": True, "tunnel_established": True, "firewall_open": True, "detail": "ok"}
                elif idx <= 70:
                    cdata = {"frps_reachable": True, "tunnel_established": True, "firewall_open": False, "detail": "remote port firewall timeout"}
                elif idx <= 85:
                    cdata = {"frps_reachable": True, "tunnel_established": False, "firewall_open": False, "detail": "login to server failed: token mismatch"}
                else:
                    cdata = {"frps_reachable": False, "tunnel_established": False, "firewall_open": False, "detail": "tcping connection refused"}
                results.append((f"t-{seq}", f"a-{seq}", "j-1", "primary-cn", "connectivity", ip, 7000, now, json.dumps(cdata)))
                # speed for full-pass nodes
                if idx <= 55:
                    seq += 1
                    sdata = {
                        "dl_ok": True,
                        "ul_ok": idx <= 50,
                        "dl_speed_mbps": round(25.0 + idx * 3.2, 2),
                        "ul_speed_mbps": round(12.0 + idx * 1.8, 2) if idx <= 50 else 0.0,
                    }
                    results.append((f"t-{seq}", f"a-{seq}", "j-1", "primary-cn" if idx <= 45 else "standby-hk", "speed", ip, 7000, now, json.dumps(sdata)))
            conn.executemany(
                "INSERT INTO probe_results(task_id, attempt_id, job_id, node_id, kind, server_ip, port, test_time, data, generation) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
                results,
            )
            conn.commit()
        finally:
            conn.close()

        report = analyze_database(db_path, dataset_kind="synthetic_rehearsal")
        assert report["discovery"]["latencyMs"]["count"] == 200
        assert report["connectivity"]["total"] == 100
        assert report["connectivity"]["fullPassCount"] == 55
        assert report["speed"]["downloadMbps"]["count"] == 55
        return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyze destination-network response distributions from a read-only console.db.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--db", type=Path, help="Read-only path to console.db or backup snapshot.")
    group.add_argument("--self-test", action="store_true", help="Run isolated synthetic distribution verification.")
    parser.add_argument("--report-md", type=Path, help="Optional path to write Markdown report.")
    parser.add_argument("--report-json", type=Path, help="Optional path to write JSON report.")
    args = parser.parse_args(argv)

    report = analyze_database(args.db, dataset_kind="snapshot") if args.db else run_synthetic_self_test()
    if args.report_json:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.report_md:
        args.report_md.parent.mkdir(parents=True, exist_ok=True)
        args.report_md.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
