#!/usr/bin/env python3
"""Console SQLite 备份恢复隔离预检与全流程恢复演练工具。

功能：
1. ``--verify-backup <db_path>``：
   将指定备份数据库复制到隔离临时目录（不修改原备份文件），执行：
   - SQLite ``PRAGMA integrity_check`` 与 ``PRAGMA foreign_key_check``；
   - 执行当前代码库的 ``initialize_database`` 迁移幂等校验；
   - 对比迁移前后核心事实表行数、域名指向 IP 与单域名排他索引完整性；
   - 验证关键业务 Store 只读查询正常可用。
2. ``--self-test``：
   在隔离目录构造包含全业务要素的仿真主控库 -> 执行在线热备（0600） ->
   模拟破坏性误操作与残留 WAL -> 执行安全原子恢复（清理 -wal/-shm 并替换） ->
   逐项核验数据 100% 完整还原。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "webui" / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.control.database import initialize_database  # noqa: E402
from app.control.node_store import NodeStore  # noqa: E402
from app.lb.store import LbStore  # noqa: E402
from app.probe.jobs import ProbeJobStore  # noqa: E402
from app.probe.saved_views import ServerViewStore  # noqa: E402
from app.probe.store import ProbeStore, ServerPageQuery  # noqa: E402

CORE_TABLES = (
    "nodes",
    "probe_servers",
    "probe_results",
    "probe_current_results",
    "probe_discover_results",
    "lb_domains",
    "lb_domain_servers",
    "probe_server_views",
)


def online_backup_sqlite(source_db: Path, backup_db: Path) -> None:
    """Create a mode-0600 consistent online backup using SQLite's backup API."""
    backup_db.parent.mkdir(parents=True, exist_ok=True)
    tmp_target = backup_db.with_name(f".{backup_db.name}.tmp.{os.getpid()}")
    src = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True, timeout=30.0)
    dst = sqlite3.connect(tmp_target)
    try:
        src.backup(dst)
        dst.commit()
    finally:
        dst.close()
        src.close()
    os.chmod(tmp_target, 0o600)
    os.replace(tmp_target, backup_db)
    os.chmod(backup_db, 0o600)


def atomic_restore_sqlite(backup_db: Path, target_db: Path, *, archive_current_to: Path | None = None) -> None:
    """Safely restore ``backup_db`` over ``target_db`` while purging stale WAL/SHM sidecars.

    Caller must stop the Console service before restoring a live database.
    Removing ``-wal`` and ``-shm`` prevents SQLite from replaying post-backup WAL frames
    onto the restored snapshot.
    """
    if not backup_db.is_file():
        raise FileNotFoundError(f"Backup file not found: {backup_db}")
    verdict_conn = sqlite3.connect(f"file:{backup_db}?mode=ro", uri=True)
    try:
        verdict = verdict_conn.execute("PRAGMA integrity_check").fetchone()[0]
        if verdict != "ok":
            raise RuntimeError(f"Refusing to restore corrupt backup ({verdict}): {backup_db}")
    finally:
        verdict_conn.close()

    if archive_current_to is not None and target_db.exists():
        online_backup_sqlite(target_db, archive_current_to)

    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(target_db) + suffix)
        if sidecar.exists():
            sidecar.unlink()

    staged = target_db.with_name(f".{target_db.name}.restore.{os.getpid()}")
    shutil.copy2(backup_db, staged)
    os.chmod(staged, 0o600)
    os.replace(staged, target_db)
    os.chmod(target_db, 0o600)


def snapshot_facts(db_path: Path) -> dict[str, Any]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        fk_errors = [dict(r) for r in conn.execute("PRAGMA foreign_key_check").fetchall()]
        existing_tables = {
            r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        counts = {
            table: (
                int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
                if table in existing_tables
                else 0
            )
            for table in CORE_TABLES
        }
        domains = []
        if "lb_domains" in existing_tables:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(lb_domains)").fetchall()}
            pref_expr = "preferred_server_id" if "preferred_server_id" in cols else "NULL AS preferred_server_id"
            curr_expr = "current_ip" if "current_ip" in cols else "NULL AS current_ip"
            for row in conn.execute(
                f"SELECT id, name, {curr_expr}, {pref_expr} FROM lb_domains ORDER BY id"
            ).fetchall():
                domains.append({
                    "id": int(row["id"]),
                    "name": row["name"],
                    "currentIp": row["current_ip"],
                    "preferredServerId": row["preferred_server_id"],
                })
        overlaps = 0
        if "lb_domain_servers" in existing_tables:
            overlaps = int(
                conn.execute(
                    "SELECT COUNT(*) FROM ("
                    "SELECT server_id FROM lb_domain_servers GROUP BY server_id HAVING COUNT(*) > 1"
                    ")"
                ).fetchone()[0]
            )
        has_unique_domain_idx = bool(
            conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_lb_domain_servers_one_domain'"
            ).fetchone()
        )
        return {
            "integrityCheck": integrity,
            "foreignKeyViolations": len(fk_errors),
            "counts": counts,
            "domains": domains,
            "domainCandidateOverlaps": overlaps,
            "hasUniqueDomainServerIndex": has_unique_domain_idx,
        }
    finally:
        conn.close()


def verify_backup_isolated(backup_path: Path) -> dict[str, Any]:
    if not backup_path.is_file():
        raise FileNotFoundError(f"Backup file does not exist: {backup_path}")
    with tempfile.TemporaryDirectory(prefix="frpc-restore-verify-") as tmp_dir:
        isolated_db = Path(tmp_dir) / "restored-console.db"
        shutil.copy2(backup_path, isolated_db)
        os.chmod(isolated_db, 0o600)

        before = snapshot_facts(isolated_db)
        if before["integrityCheck"] != "ok":
            raise RuntimeError(f"Backup integrity_check failed: {before['integrityCheck']}")

        # 执行两轮初始化，验证 Schema 升级与迁移 100% 幂等
        initialize_database(isolated_db)
        initialize_database(isolated_db)
        after = snapshot_facts(isolated_db)
        if after["integrityCheck"] != "ok":
            raise RuntimeError(f"Post-migration integrity_check failed: {after['integrityCheck']}")
        if after["foreignKeyViolations"] != 0:
            raise RuntimeError(f"Foreign key violations detected: {after['foreignKeyViolations']}")

        # 验证核心事实表不丢数据且域名当前指向不漂移
        for table in ("nodes", "probe_servers", "probe_results", "probe_discover_results", "lb_domains"):
            if after["counts"][table] < before["counts"][table]:
                raise RuntimeError(
                    f"Row count decreased in {table}: {before['counts'][table]} -> {after['counts'][table]}"
                )
        if before["domains"] != after["domains"]:
            raise RuntimeError("LB domain pointers or pins drifted during restore migration")

        # 验证应用层只读查询路径
        p_store = ProbeStore(isolated_db)
        l_store = LbStore(isolated_db)
        j_store = ProbeJobStore(isolated_db)
        cursor_page = p_store.query_servers_cursor(ServerPageQuery(page=1, page_size=25, sort="ip"))
        exact_total = p_store.count_servers(ServerPageQuery())
        domain_views = l_store.list_domains()
        policy = j_store.get_execution_policy()

        return {
            "ok": True,
            "verifiedAt": datetime.now(timezone.utc).isoformat(),
            "sourceBackup": str(backup_path),
            "fileModeOctal": oct(isolated_db.stat().st_mode & 0o777),
            "beforeMigration": before,
            "afterMigration": after,
            "readProbes": {
                "cursorPageItems": len(cursor_page["items"]),
                "exactServerCount": exact_total,
                "domainCount": len(domain_views),
                "policyConfigured": bool(policy.get("configured")),
            },
        }


def run_full_rehearsal() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="frpc-restore-rehearsal-") as tmp_dir:
        root = Path(tmp_dir)
        live_db = root / "live" / "console.db"
        live_db.parent.mkdir(parents=True, exist_ok=True)
        backup_db = root / "backups" / "console-before-upgrade.db"
        corrupted_archive = root / "backups" / "console-corrupted-archived.db"

        # 1. 构建全要素仿真生产库
        node_store = NodeStore(live_db)
        deploy_node = node_store.create_node(name="hk-prod-agent")
        probe_store = ProbeStore(live_db)
        job_store = ProbeJobStore(live_db)
        lb_store = LbStore(live_db)
        view_store = ServerViewStore(live_db)

        primary = job_store.create_node("深圳电信主节点")
        standby = job_store.create_node("新加坡备用节点")
        job_store.heartbeat(primary["id"], "v1", ["discover", "route", "connectivity", "speed"], [], ["task-generation-v1"])
        job_store.heartbeat(standby["id"], "v1", ["discover", "route", "connectivity", "speed"], [], ["task-generation-v1"])
        job_store.set_execution_policy(primary["id"], [standby["id"]])

        s1 = probe_store.create_server(ip="198.51.100.11", labels=["HK", "BGP"], server_group="香港1")
        s2 = probe_store.create_server(ip="198.51.100.12", labels=["HK"], server_group="香港1")
        s3 = probe_store.create_server(ip="203.0.113.21", labels=["US"], server_group="美国US1")
        probe_store.upsert_discover_results_batch([
            ("198.51.100.11", 7000, 14.2),
            ("203.0.113.99", 7000, 152.8),
        ])

        # 写入正式测试结果并更新统一当前投影
        job = job_store.create_primary_job("connectivity", ips=["198.51.100.11", "203.0.113.21"])
        claimed = job_store.claim(primary["id"])
        assert claimed is not None
        job_store.report(
            primary["id"],
            claimed["taskId"],
            claimed["attemptId"],
            generation=0,
            result={"frps_reachable": True, "tunnel_established": True, "firewall_open": True, "detail": "ok"},
        )

        lb_store.set_cloudflare_token("cf-rehearsal-token-999999")
        d1 = lb_store.create_domain(
            name="hk1.zmfrp.eu.org",
            zone_id="zone-hk",
            zone_name="zmfrp.eu.org",
            server_ids=[s1.id, s2.id],
            preferred_server_id=s1.id,
            sync_mode="scheduled",
        )
        lb_store.mark_sync_result(
            d1.id,
            ok=True,
            message="pinned healthy",
            added=["198.51.100.11"],
            removed=[],
            kept=1,
            current_ip="198.51.100.11",
            preferred_server_id=s1.id,
        )
        lb_store.replace_node_instance_ports(
            deploy_node.id,
            deploy_node.name,
            [{
                "name": "ssh-hk",
                "displayName": "香港SSH",
                "enabled": True,
                "runtime": {"state": "running"},
                "summary": {"serverAddr": "hk1.zmfrp.eu.org", "serverPort": 7000, "tcpRemotePorts": [22022]},
            }],
        )
        view_store.create(
            name="香港可用服务器",
            filters={"group": "香港1", "conn": "all"},
            sort="ip",
            order="asc",
            visible_columns=["ip", "group", "connectivity", "speed"],
        )

        baseline = snapshot_facts(live_db)

        # 2. 在线热备（模拟停机/升级前快照）
        online_backup_sqlite(live_db, backup_db)
        backup_mode = oct(backup_db.stat().st_mode & 0o777)
        if backup_mode != "0o600":
            raise RuntimeError(f"Expected backup file mode 0o600, got {backup_mode}")

        # 3. 模拟破坏性误改 + 活跃 WAL 残留
        probe_store.delete_server(s3.id)
        lb_store.mark_sync_result(
            d1.id,
            ok=True,
            message="accidental drift",
            added=["198.51.100.12"],
            removed=["198.51.100.11"],
            kept=1,
            current_ip="198.51.100.12",
            preferred_server_id=None,
        )
        mutated = snapshot_facts(live_db)
        assert mutated["counts"]["probe_servers"] == baseline["counts"]["probe_servers"] - 1
        assert mutated["domains"] != baseline["domains"]

        # 4. 执行标准恢复流程（先另存事故现场库，清理 -wal/-shm，再原子替换恢复）
        atomic_restore_sqlite(backup_db, live_db, archive_current_to=corrupted_archive)
        restored = snapshot_facts(live_db)
        if restored != baseline:
            raise RuntimeError(f"Restored snapshot mismatch!\nExpected: {baseline}\nActual: {restored}")

        verification = verify_backup_isolated(live_db)
        return {
            "ok": True,
            "rehearsedAt": datetime.now(timezone.utc).isoformat(),
            "backupFileMode": backup_mode,
            "corruptedArchivedExists": corrupted_archive.is_file(),
            "baselineFacts": baseline,
            "mutatedFacts": {
                "serverCount": mutated["counts"]["probe_servers"],
                "domains": mutated["domains"],
            },
            "restoredFacts": restored,
            "isolatedVerificationReadProbes": verification["readProbes"],
        }


def render_markdown_report(data: dict[str, Any]) -> str:
    lines = [
        "# Console 数据库备份与隔离恢复演练报告",
        "",
        f"- 演练时间：`{data.get('rehearsedAt') or data.get('verifiedAt')}`",
        f"- 结论：`{'PASS' if data.get('ok') else 'FAIL'}`",
    ]
    if "backupFileMode" in data:
        lines.extend([
            f"- 备份权限：`{data['backupFileMode']}`（强制 `0600`）",
            f"- 故障现场归档保留：`{data['corruptedArchivedExists']}`",
            "",
            "## 恢复前后核心事实对照",
            "",
            "| 指标 | 升级/故障前基线 | 模拟误改后 | 原子恢复后 |",
            "| --- | --- | --- | --- |",
            f"| `probe_servers` | {data['baselineFacts']['counts']['probe_servers']} | {data['mutatedFacts']['serverCount']} | {data['restoredFacts']['counts']['probe_servers']} |",
            f"| `probe_results` | {data['baselineFacts']['counts']['probe_results']} | - | {data['restoredFacts']['counts']['probe_results']} |",
            f"| `probe_discover_results` | {data['baselineFacts']['counts']['probe_discover_results']} | - | {data['restoredFacts']['counts']['probe_discover_results']} |",
            f"| `lb_domains` 当前指向 | `{data['baselineFacts']['domains'][0]['currentIp']}` | `{data['mutatedFacts']['domains'][0]['currentIp']}` | `{data['restoredFacts']['domains'][0]['currentIp']}` |",
            f"| `preferred_server_id` | `{data['baselineFacts']['domains'][0]['preferredServerId']}` | `{data['mutatedFacts']['domains'][0]['preferredServerId']}` | `{data['restoredFacts']['domains'][0]['preferredServerId']}` |",
            f"| `integrity_check` | `{data['baselineFacts']['integrityCheck']}` | - | `{data['restoredFacts']['integrityCheck']}` |",
            f"| 单域名唯一索引 | `{data['baselineFacts']['hasUniqueDomainServerIndex']}` | - | `{data['restoredFacts']['hasUniqueDomainServerIndex']}` |",
        ])
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify or rehearse Console SQLite backup restoration.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--verify-backup", type=Path, help="Path to an existing console.db backup to verify in isolation.")
    group.add_argument("--self-test", action="store_true", help="Run an end-to-end isolated backup, corruption, and restore rehearsal.")
    parser.add_argument("--report-md", type=Path, help="Optional path to write a Markdown evidence report.")
    parser.add_argument("--report-json", type=Path, help="Optional path to write a JSON evidence report.")
    args = parser.parse_args(argv)

    result = verify_backup_isolated(args.verify_backup) if args.verify_backup else run_full_rehearsal()
    if args.report_json:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.report_md:
        args.report_md.parent.mkdir(parents=True, exist_ok=True)
        args.report_md.write_text(render_markdown_report(result), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
