import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from app.control import database


class DatabaseLifecycleTests(unittest.TestCase):
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
