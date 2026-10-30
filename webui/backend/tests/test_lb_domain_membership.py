"""Focused coverage for explicit LB domain-to-server membership."""

import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.control import database
from app.lb.store import LbStore
from app.probe.store import ProbeStore


class LegacyDomainMembershipMigrationTests(unittest.TestCase):
    def _legacy_connection(self, path: Path) -> sqlite3.Connection:
        connection = sqlite3.connect(path)
        connection.row_factory = sqlite3.Row
        connection.executescript(
            """
            CREATE TABLE lb_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE probe_servers (
                id INTEGER PRIMARY KEY, server_group TEXT NOT NULL DEFAULT '', group_id TEXT
            );
            CREATE TABLE lb_domains (
                id INTEGER PRIMARY KEY, group_name TEXT NOT NULL, group_id TEXT
            );
            CREATE TABLE lb_domain_servers (
                domain_id INTEGER NOT NULL, server_id INTEGER NOT NULL,
                PRIMARY KEY(domain_id,server_id)
            );
            INSERT INTO lb_domains VALUES
                (1, 'legacy-pool', 'group-id'),
                (2, 'name-only-pool', NULL),
                (3, '', NULL);
            INSERT INTO probe_servers VALUES
                (10, 'legacy-pool', 'group-id'),
                (11, 'legacy-pool', 'other-id'),
                (12, 'name-only-pool', NULL),
                (13, 'name-only-pool', 'has-an-id'),
                (14, 'unrelated', NULL);
            """
        )
        return connection

    def test_migration_snapshots_all_members_once_and_detaches_legacy_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.db"
            connection = self._legacy_connection(path)
            try:
                database._migrate_lb_domain_servers(connection)
                members = [tuple(row) for row in connection.execute(
                    "SELECT domain_id, server_id FROM lb_domain_servers ORDER BY domain_id,server_id"
                )]
                self.assertEqual(members, [(1, 10), (2, 12)])
                self.assertEqual(
                    [tuple(row) for row in connection.execute(
                        "SELECT group_name, group_id FROM lb_domains ORDER BY id"
                    )],
                    [("", None), ("", None), ("", None)],
                )

                # Group or asset edits after migration do not change the snapshot.
                connection.execute("UPDATE probe_servers SET server_group='renamed' WHERE id=10")
                connection.execute("DELETE FROM probe_servers WHERE id=12")
                connection.commit()
                database._migrate_lb_domain_servers(connection)
                self.assertEqual(
                    [tuple(row) for row in connection.execute(
                        "SELECT domain_id, server_id FROM lb_domain_servers ORDER BY domain_id,server_id"
                    )],
                    [(1, 10), (2, 12)],
                )
            finally:
                connection.close()

    def test_migration_includes_every_member_beyond_interactive_batch_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            connection = self._legacy_connection(Path(tmp) / 'large-legacy.db')
            try:
                connection.executemany('INSERT INTO probe_servers VALUES (?, ?, ?)',
                                       ((1000 + i, 'legacy-pool', 'group-id') for i in range(10001)))
                connection.commit()
                database._migrate_lb_domain_servers(connection)
                self.assertEqual(connection.execute(
                    'SELECT count(*) FROM lb_domain_servers WHERE domain_id=1').fetchone()[0], 10002)
                self.assertIsNotNone(connection.execute(
                    'SELECT 1 FROM lb_domain_servers WHERE domain_id=1 AND server_id=11000').fetchone())
            finally:
                connection.close()

    def test_migration_failure_rolls_back_members_marker_and_detachment_then_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.db"
            connection = self._legacy_connection(path)
            try:
                connection.execute(
                    "CREATE TRIGGER abort_members BEFORE INSERT ON lb_domain_servers "
                    "BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END"
                )
                connection.commit()
                with self.assertRaises(sqlite3.IntegrityError):
                    database._migrate_lb_domain_servers(connection)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM lb_domain_servers").fetchone()[0], 0)
                self.assertIsNone(connection.execute(
                    "SELECT value FROM lb_settings WHERE key='lb_domain_servers_migrated'"
                ).fetchone())
                self.assertEqual(connection.execute(
                    "SELECT group_name FROM lb_domains WHERE id=1"
                ).fetchone()[0], "legacy-pool")

                connection.execute("DROP TRIGGER abort_members")
                connection.commit()
                database._migrate_lb_domain_servers(connection)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM lb_domain_servers").fetchone()[0], 2)
                self.assertEqual(connection.execute(
                    "SELECT value FROM lb_settings WHERE key='lb_domain_servers_migrated'"
                ).fetchone()[0], "1")
            finally:
                connection.close()


class LbDomainMembershipStoreTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="lb-domain-membership-")
        self.path = Path(self.tempdir.name) / "test.db"
        self.lb = LbStore(self.path)
        self.probe = ProbeStore(self.path)
        self.asset_counter = 1
        self.domain = self.lb.create_domain(
            name="members.example.com", zone_id="z", zone_name="example.com"
        )

    def tearDown(self):
        self.tempdir.cleanup()

    def _add_assets(self, count: int) -> list[int]:
        connection = database.connect_database(self.path)
        try:
            cursor = connection.execute("SELECT COALESCE(MAX(id), 0) FROM probe_servers")
            start = int(cursor.fetchone()[0]) + 1
            ip_start = self.asset_counter
            self.asset_counter += count
            inserted_ids = []
            for i in range(count):
                cursor = connection.execute(
                    "INSERT INTO probe_servers(ip, server_group, group_id, created_at) "
                    "VALUES (?, '', NULL, 'now')",
                    (f"198.51.{(ip_start + i) // 256}.{(ip_start + i) % 256}",),
                )
                inserted_ids.append(int(cursor.lastrowid))
            connection.commit()
            return inserted_ids
        finally:
            connection.close()

    def test_optional_domain_has_no_group_or_candidates(self):
        self.assertEqual(self.domain.group_name, "")
        self.assertIsNone(self.domain.group_id)
        self.assertEqual(self.lb.domain_server_count(self.domain.id), 0)

    def test_legacy_create_group_is_one_time_snapshot(self):
        self.probe.import_servers([
            {"ip": "192.0.2.10", "group": "legacy"},
            {"ip": "192.0.2.11", "group": "other"},
        ])
        domain = self.lb.create_domain(
            name="snapshot.example.com", zone_id="z", zone_name="example.com", group_name="legacy"
        )
        self.assertEqual(domain.group_name, "")
        self.assertEqual(self.lb.domain_server_count(domain.id), 1)
        server_id = self.lb.domain_server_ids(domain.id)[0]
        connection = database.connect_database(self.path)
        try:
            connection.execute("UPDATE probe_servers SET server_group='changed' WHERE id=?", (server_id,))
            connection.commit()
        finally:
            connection.close()
        self.assertEqual(self.lb.domain_server_ids(domain.id), [server_id])
        self.lb.update_domain(domain.id, ttl=90)
        self.assertEqual(self.lb.domain_server_ids(domain.id), [server_id])

    def test_add_remove_validate_all_ids_atomically(self):
        first, second = self._add_assets(2)
        self.assertEqual(self.lb.add_domain_servers(self.domain.id, [first, first, second]), 2)
        self.assertEqual(self.lb.domain_server_ids(self.domain.id), [first, second])
        with self.assertRaises(ValueError):
            self.lb.add_domain_servers(self.domain.id, [first, 999999])
        self.assertEqual(self.lb.domain_server_ids(self.domain.id), [first, second])
        with self.assertRaises(ValueError):
            self.lb.remove_domain_servers(self.domain.id, [first, 999999])
        self.assertEqual(self.lb.domain_server_ids(self.domain.id), [first, second])
        self.assertEqual(self.lb.remove_domain_servers(self.domain.id, [first]), 1)
        self.assertEqual(self.lb.domain_server_ids(self.domain.id), [second])

    def test_candidate_page_search_and_large_iteration_stay_membership_scoped(self):
        ids = self._add_assets(5_002)
        self.lb.add_domain_servers(self.domain.id, ids[:5_000])
        connection = database.connect_database(self.path)
        try:
            connection.execute(
                "INSERT INTO lb_domain_servers(domain_id,server_id) VALUES (?,?)",
                (self.domain.id, ids[5_000]),
            )
            connection.execute(
                "INSERT INTO lb_domain_servers(domain_id,server_id) VALUES (?,?)",
                (self.domain.id, ids[5_001]),
            )
            connection.commit()
        finally:
            connection.close()

        page = self.lb.domain_candidate_page(self.domain.id, page=2, page_size=100, q="198.51.")
        self.assertEqual((page["page"], page["pageSize"], page["total"]), (2, 100, 5_002))
        self.assertEqual(len(page["items"]), 100)
        self.assertEqual(self.lb.domain_candidate_rows(self.domain.id, limit=5_002),
                         self.lb.domain_candidate_rows(self.domain.id, limit=5_000))
        streamed = list(self.lb.iter_domain_candidate_rows(self.domain.id, batch_size=333))
        self.assertEqual(len(streamed), 5_002)
        self.assertEqual([row["id"] for row in streamed], ids)
        self.assertEqual(self.lb.domain_candidate_page(self.domain.id, page=1, page_size=10,
                                                       q="not-an-ip")["total"], 0)
        self.assertEqual(self.lb.domain_candidate_page(self.domain.id, q="%")["total"], 0)

    def test_preferred_server_is_domain_scoped_and_cleared_on_removal(self):
        first, second = self._add_assets(2)
        self.lb.add_domain_servers(self.domain.id, [first, second])
        updated = self.lb.update_domain(self.domain.id, preferred_server_id=first)
        self.assertEqual(updated.preferred_server_id, first)
        with self.assertRaises(ValueError):
            self.lb.update_domain(self.domain.id, preferred_server_id=999999)
        self.assertEqual(self.lb.remove_domain_servers(self.domain.id, [first]), 1)
        self.assertIsNone(self.lb.get_domain(self.domain.id).preferred_server_id)

    def test_membership_rows_cascade_when_domain_or_asset_is_deleted(self):
        server_id = self._add_assets(1)[0]
        self.lb.add_domain_servers(self.domain.id, [server_id])
        self.probe.delete_server(server_id)
        self.assertEqual(self.lb.domain_server_count(self.domain.id), 0)

        another = self._add_assets(1)[0]
        self.lb.add_domain_servers(self.domain.id, [another])
        self.lb.delete_domain(self.domain.id)
        connection = database.connect_database(self.path)
        try:
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM lb_domain_servers WHERE server_id=?", (another,)
            ).fetchone()[0], 0)
        finally:
            connection.close()

    def test_membership_page_and_write_limits_are_bounded(self):
        ids = self._add_assets(5_001)
        with self.assertRaises(ValueError):
            self.lb.add_domain_servers(self.domain.id, ids)
        self.lb.add_domain_servers(self.domain.id, ids[:5_000])
        self.assertEqual(len(self.lb.domain_server_ids(self.domain.id, limit=50_000)), 5_000)
        with self.assertRaises(ValueError):
            self.lb.domain_server_ids(self.domain.id, limit=0)


if __name__ == "__main__":
    unittest.main()
