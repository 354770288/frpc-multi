from __future__ import annotations

import importlib.util
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def _load_script(name: str, rel_path: str):
    path = REPO_ROOT / rel_path
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


rehearse_mod = _load_script("rehearse_restore_script", "scripts/rehearse-restore.py")
dist_mod = _load_script("analyze_probe_distributions_script", "scripts/analyze_probe_distributions.py")


class OpsToolsTests(unittest.TestCase):
    def test_full_restore_rehearsal_and_wal_purge(self) -> None:
        outcome = rehearse_mod.run_full_rehearsal()
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["backupFileMode"], "0o600")
        self.assertTrue(outcome["corruptedArchivedExists"])
        self.assertEqual(outcome["baselineFacts"], outcome["restoredFacts"])

    def test_atomic_restore_purges_stale_wal_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            live = root / "console.db"
            backup = root / "backup.db"
            c = sqlite3.connect(live)
            try:
                c.execute("PRAGMA journal_mode=WAL")
                c.execute("CREATE TABLE items(id INTEGER PRIMARY KEY, val TEXT)")
                c.execute("INSERT INTO items VALUES(1, 'before')")
                c.commit()
            finally:
                c.close()

            rehearse_mod.online_backup_sqlite(live, backup)
            self.assertEqual(oct(backup.stat().st_mode & 0o777), "0o600")

            # 在 WAL 中写入新变更并制造未 checkpoint 的 -wal 文件
            c2 = sqlite3.connect(live)
            try:
                c2.execute("UPDATE items SET val='mutated' WHERE id=1")
                c2.commit()
                rehearse_mod.atomic_restore_sqlite(backup, live)
            finally:
                c2.close()

            check = sqlite3.connect(live)
            try:
                val = check.execute("SELECT val FROM items WHERE id=1").fetchone()[0]
                self.assertEqual(val, "before")
            finally:
                check.close()

    def test_distribution_quantiles_and_synthetic_funnel(self) -> None:
        empty = dist_mod.quantiles([])
        self.assertEqual(empty["count"], 0)
        self.assertIsNone(empty["p50"])

        single = dist_mod.quantiles([42.5])
        self.assertEqual(single["p50"], 42.5)
        self.assertEqual(single["p95"], 42.5)

        report = dist_mod.run_synthetic_self_test()
        self.assertEqual(report["assetCount"], 100)
        self.assertEqual(report["discovery"]["latencyMs"]["count"], 200)
        self.assertEqual(report["connectivity"]["frpsReachableCount"], 85)
        self.assertEqual(report["connectivity"]["tunnelEstablishedCount"], 70)
        self.assertEqual(report["connectivity"]["firewallOpenCount"], 55)
        self.assertEqual(report["connectivity"]["fullPassCount"], 55)
        md = dist_mod.render_markdown(report)
        self.assertIn("穿透连通性三阶段转化漏斗", md)


if __name__ == "__main__":
    unittest.main()
