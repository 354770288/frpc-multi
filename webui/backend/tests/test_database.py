import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from app.control import database


class DatabaseLifecycleTests(unittest.TestCase):
    @staticmethod
    def _create_legacy_discovery(path: Path, addresses: list[str]) -> None:
        connection = sqlite3.connect(path)
        try:
            connection.executescript(
                """
                CREATE TABLE probe_discover_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ip TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    latency_ms REAL NOT NULL DEFAULT 0,
                    server_group TEXT NOT NULL DEFAULT '',
                    label TEXT NOT NULL DEFAULT '',
                    discovered_at TEXT NOT NULL,
                    UNIQUE (ip, port)
                );
                """
            )
            connection.executemany(
                "INSERT INTO probe_discover_results "
                "(ip, port, latency_ms, discovered_at) VALUES (?, ?, 1, ?)",
                [(ip, 7000, "2026-01-01T00:00:00") for ip in addresses],
            )
            connection.commit()
        finally:
            connection.close()

    @staticmethod
    def _open_legacy(path: Path) -> sqlite3.Connection:
        connection = sqlite3.connect(path)
        connection.row_factory = sqlite3.Row
        return connection

    def test_initialization_is_cached_per_resolved_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "console.db"
            with mock.patch.object(
                database, "_migrate_nodes", wraps=database._migrate_nodes
            ) as migrate_nodes:
                database.initialize_database(path)
                database.initialize_database(path.parent / "." / path.name)
                connection = database.connect_database(path)
                connection.close()

            self.assertEqual(migrate_nodes.call_count, 1)
            self.assertTrue(path.exists())

    def test_wal_is_enabled_and_retained(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "console.db"
            database.initialize_database(path)

            connection = sqlite3.connect(path)
            try:
                mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
            finally:
                connection.close()

            self.assertEqual(mode.lower(), "wal")

    def test_wal_allows_writer_commit_while_reader_keeps_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "console.db"
            reader = database.connect_database(path)
            writer = database.connect_database(path)
            try:
                writer.execute("CREATE TABLE wal_behavior (value TEXT NOT NULL)")
                writer.execute("INSERT INTO wal_behavior (value) VALUES ('first')")
                writer.commit()

                reader.execute("BEGIN")
                self.assertEqual(
                    reader.execute("SELECT COUNT(*) FROM wal_behavior").fetchone()[0],
                    1,
                )

                writer.execute("INSERT INTO wal_behavior (value) VALUES ('second')")
                writer.commit()

                self.assertEqual(
                    reader.execute("SELECT COUNT(*) FROM wal_behavior").fetchone()[0],
                    1,
                )
                reader.commit()
                self.assertEqual(
                    reader.execute("SELECT COUNT(*) FROM wal_behavior").fetchone()[0],
                    2,
                )
            finally:
                reader.close()
                writer.close()

    def test_discovery_migration_backfills_ipv4_and_preserves_invalid_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.db"
            connection = sqlite3.connect(path)
            try:
                connection.executescript(
                    """
                    CREATE TABLE probe_discover_results (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        ip TEXT NOT NULL,
                        port INTEGER NOT NULL,
                        latency_ms REAL NOT NULL DEFAULT 0,
                        server_group TEXT NOT NULL DEFAULT '',
                        label TEXT NOT NULL DEFAULT '',
                        discovered_at TEXT NOT NULL,
                        UNIQUE (ip, port)
                    );
                    CREATE INDEX idx_probe_discover_group
                        ON probe_discover_results (server_group);
                    CREATE INDEX idx_probe_discover_label
                        ON probe_discover_results (label);
                    INSERT INTO probe_discover_results
                        (ip, port, latency_ms, discovered_at)
                    VALUES ('10.0.0.2', 7000, 1, '2026-01-01T00:00:00'),
                           ('legacy.invalid', 7000, 2, '2026-01-01T00:00:00'),
                           ('2001:db8::1', 7000, 3, '2026-01-01T00:00:00');
                    """
                )
                connection.commit()
            finally:
                connection.close()

            database.initialize_database(path)
            connection = database.connect_database(path)
            try:
                values = {
                    row["ip"]: row["ip_sort"]
                    for row in connection.execute(
                        "SELECT ip, ip_sort FROM probe_discover_results"
                    ).fetchall()
                }
                indexes = {
                    row["name"]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master "
                        "WHERE type = 'index' AND tbl_name = 'probe_discover_results'"
                    ).fetchall()
                }
                ip_order_plans = {}
                for order, index_name in (
                    ("ASC", "idx_probe_discover_ip"),
                    ("DESC", "idx_probe_discover_ip_desc"),
                ):
                    ip_order_plans[index_name] = [
                        row["detail"]
                        for row in connection.execute(
                            "EXPLAIN QUERY PLAN "
                            "SELECT id, ip_sort FROM probe_discover_results "
                            f"ORDER BY (ip_sort IS NULL) ASC, ip_sort {order}, id {order}"
                        ).fetchall()
                    ]
                filter_order_plans = {}
                filters = (
                    ("group", "server_group = ?", ("",), "idx_probe_discover_group_time"),
                    ("label", "label = ?", ("",), "idx_probe_discover_label_time"),
                    (
                        "combined",
                        "server_group = ? AND label = ?",
                        ("", ""),
                        "idx_probe_discover_label_time",
                    ),
                )
                for filter_name, predicate, params, index_name in filters:
                    for order in ("ASC", "DESC"):
                        filter_order_plans[(filter_name, order)] = (
                            index_name,
                            [
                                row["detail"]
                                for row in connection.execute(
                                    "EXPLAIN QUERY PLAN "
                                    "SELECT id, ip, port, latency_ms, server_group, label, "
                                    "discovered_at FROM probe_discover_results "
                                    f"WHERE {predicate} ORDER BY discovered_at {order}, id {order} "
                                    "LIMIT ? OFFSET ?",
                                    (*params, 50, 0),
                                ).fetchall()
                            ],
                        )
            finally:
                connection.close()

            self.assertEqual(values["10.0.0.2"], 167772162)
            self.assertIsNone(values["legacy.invalid"])
            self.assertIsNone(values["2001:db8::1"])
            self.assertTrue({
                "idx_probe_discover_time",
                "idx_probe_discover_ip",
                "idx_probe_discover_ip_desc",
                "idx_probe_discover_group_time",
                "idx_probe_discover_label_time",
            }.issubset(indexes))
            self.assertNotIn("idx_probe_discover_group", indexes)
            self.assertNotIn("idx_probe_discover_label", indexes)
            for index_name, details in ip_order_plans.items():
                plan = " ".join(details)
                self.assertIn(f"USING COVERING INDEX {index_name}", plan)
                self.assertNotIn("USE TEMP B-TREE", plan)
            for index_name, details in filter_order_plans.values():
                plan = " ".join(details)
                self.assertIn(f"USING INDEX {index_name}", plan)
                self.assertNotIn("USE TEMP B-TREE", plan)

    def test_discovery_migration_rolls_back_column_and_retries_after_backfill_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.db"
            self._create_legacy_discovery(path, ["10.0.0.1"])
            connection = self._open_legacy(path)
            try:
                connection.execute(
                    "CREATE TRIGGER fail_discovery_backfill "
                    "BEFORE UPDATE ON probe_discover_results "
                    "BEGIN SELECT RAISE(ABORT, 'backfill failed'); END"
                )
                connection.commit()

                with self.assertRaisesRegex(sqlite3.IntegrityError, "backfill failed"):
                    database._migrate_probe_discover_results(connection)
                self.assertNotIn(
                    "ip_sort", database._column_names(connection, "probe_discover_results")
                )
                self.assertFalse(connection.in_transaction)

                connection.execute("DROP TRIGGER fail_discovery_backfill")
                connection.commit()
                database._migrate_probe_discover_results(connection)
                self.assertEqual(
                    connection.execute(
                        "SELECT ip_sort FROM probe_discover_results"
                    ).fetchone()[0],
                    167772161,
                )
            finally:
                connection.close()

    def test_discovery_migration_rolls_back_backfill_and_indexes_then_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.db"
            self._create_legacy_discovery(path, ["10.0.0.2"])
            connection = self._open_legacy(path)
            try:
                connection.execute("CREATE TABLE idx_probe_discover_group_time (value INTEGER)")
                connection.commit()

                with self.assertRaisesRegex(sqlite3.OperationalError, "already a table"):
                    database._migrate_probe_discover_results(connection)
                self.assertNotIn(
                    "ip_sort", database._column_names(connection, "probe_discover_results")
                )
                created_indexes = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'index' "
                        "AND name LIKE 'idx_probe_discover_%'"
                    )
                }
                self.assertEqual(created_indexes, set())
                self.assertFalse(connection.in_transaction)

                connection.execute("DROP TABLE idx_probe_discover_group_time")
                connection.commit()
                database._migrate_probe_discover_results(connection)
                self.assertEqual(
                    connection.execute(
                        "SELECT ip_sort FROM probe_discover_results"
                    ).fetchone()[0],
                    167772162,
                )
                self.assertIn(
                    "idx_probe_discover_group_time",
                    {
                        row[0]
                        for row in connection.execute(
                            "SELECT name FROM sqlite_master WHERE type = 'index'"
                        )
                    },
                )
            finally:
                connection.close()

    def test_discovery_migration_backfills_multiple_bounded_batches(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.db"
            addresses = [
                "10.0.0.1",
                "legacy.invalid",
                "10.0.0.2",
                "2001:db8::1",
                "10.0.0.3",
            ]
            self._create_legacy_discovery(path, addresses)
            connection = self._open_legacy(path)
            try:
                with mock.patch.object(database, "DISCOVER_MIGRATION_BATCH_SIZE", 2):
                    database._migrate_probe_discover_results(connection)
                values = {
                    row["ip"]: row["ip_sort"]
                    for row in connection.execute(
                        "SELECT ip, ip_sort FROM probe_discover_results"
                    )
                }
            finally:
                connection.close()

            self.assertEqual(values["10.0.0.1"], 167772161)
            self.assertEqual(values["10.0.0.2"], 167772162)
            self.assertEqual(values["10.0.0.3"], 167772163)
            self.assertIsNone(values["legacy.invalid"])
            self.assertIsNone(values["2001:db8::1"])

    def test_each_connection_has_required_pragmas(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "console.db"
            connection = database.connect_database(path)
            try:
                self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
                self.assertEqual(
                    connection.execute("PRAGMA busy_timeout").fetchone()[0],
                    database.BUSY_TIMEOUT_MS,
                )
                self.assertEqual(connection.execute("PRAGMA synchronous").fetchone()[0], 1)
                self.assertIs(connection.row_factory, sqlite3.Row)
            finally:
                connection.close()

    def test_connections_are_fresh_and_keep_default_thread_ownership(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "console.db"
            first = database.connect_database(path)
            second = database.connect_database(path)
            self.assertIsNot(first, second)

            errors = []

            def use_from_other_thread():
                try:
                    first.execute("SELECT 1").fetchone()
                except Exception as exc:  # capture the SQLite ownership error
                    errors.append(exc)

            thread = threading.Thread(target=use_from_other_thread)
            thread.start()
            thread.join()
            first.close()
            second.close()

            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], sqlite3.ProgrammingError)

    def test_configuration_failure_closes_connection_and_allows_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "console.db"
            resolved_path = path.resolve()
            real_connect = sqlite3.connect
            raw_connection = mock.Mock()
            raw_connection.execute.side_effect = sqlite3.OperationalError("pragma failed")

            with mock.patch.object(
                database.sqlite3,
                "connect",
                side_effect=[raw_connection, real_connect(path)],
            ):
                with self.assertRaisesRegex(sqlite3.OperationalError, "pragma failed"):
                    database.initialize_database(path)
                raw_connection.close.assert_called_once_with()
                self.assertNotIn(resolved_path, database._initialized_paths)
                database.initialize_database(path)

            self.assertIn(resolved_path, database._initialized_paths)

    def test_wal_failure_is_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "console.db"
            memory_connection = sqlite3.connect(":memory:")
            with mock.patch.object(database, "_open_database", return_value=memory_connection):
                with self.assertRaisesRegex(RuntimeError, "failed to enable SQLite WAL mode"):
                    database.initialize_database(path)

    def test_failed_initialization_is_not_cached_and_can_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "console.db"
            original = database._migrate_nodes
            attempts = 0

            def fail_once(connection):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise RuntimeError("migration failed")
                original(connection)

            with mock.patch.object(database, "_migrate_nodes", side_effect=fail_once):
                with self.assertRaisesRegex(RuntimeError, "migration failed"):
                    database.initialize_database(path)
                database.initialize_database(path)

            self.assertEqual(attempts, 2)
            connection = database.connect_database(path)
            try:
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    ).fetchall()
                }
            finally:
                connection.close()
            self.assertIn("nodes", tables)


if __name__ == "__main__":
    unittest.main()
