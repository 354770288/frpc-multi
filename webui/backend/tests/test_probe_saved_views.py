import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("PROJECT_DIR", tempfile.mkdtemp(prefix="probe-saved-views-"))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import create_token
from app.control import database
import app.probe.router as probe_router
from app.probe.saved_views import (
    DEFAULT_SERVER_VIEW_COLUMNS, ServerViewNameConflictError, ServerViewStore,
)


class ProbeSavedViewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "console.db"
        self.store = ServerViewStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def client(self):
        app = FastAPI()
        app.include_router(probe_router.router)
        client = TestClient(app)
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        patcher = patch.object(probe_router, "server_view_store", return_value=self.store)
        patcher.start()
        self.addCleanup(patcher.stop)
        return client, {"Authorization": "Bearer " + create_token("admin")["token"]}

    def test_shared_crud_casefold_names_and_patch_preserves_fields(self):
        client, headers = self.client()
        create = client.post("/api/probe/server-views", headers=headers, json={
            "name": "  Routing  ",
            "filters": {"q": "edge", "groupIds": ["group-stable"],
                        "includeTagIds": ["tag-stable"], "tagMode": "all", "conn": "pass"},
            "sort": "ip", "order": "desc", "visibleColumns": ["ip", "group", "tags"],
        })
        self.assertEqual(create.status_code, 200, create.text)
        view = create.json()
        self.assertEqual(view["name"], "Routing")
        self.assertEqual(view["sort"], "ip")
        self.assertEqual(view["visibleColumns"], ["ip", "group", "tags"])
        self.assertEqual(view["filters"]["groupIds"], ["group-stable"])
        self.assertTrue({"createdAt", "updatedAt"}.issubset(view))
        self.assertTrue({"id", "name", "filters", "sort", "order", "visibleColumns", "createdAt", "updatedAt"} == set(view))

        collision = client.post("/api/probe/server-views", headers=headers, json={"name": "routing"})
        self.assertEqual(collision.status_code, 409)

        # Any authenticated account sees the same Console-wide view collection.
        from app.auth import create_token
        other_headers = {"Authorization": "Bearer " + create_token("another-user")["token"]}
        shared = client.get("/api/probe/server-views", headers=other_headers)
        self.assertEqual([item["id"] for item in shared.json()["items"]], [view["id"]])

        patched = client.patch(f"/api/probe/server-views/{view['id']}", headers=headers,
                               json={"name": "  Main Route  "})
        self.assertEqual(patched.status_code, 200, patched.text)
        self.assertEqual(patched.json()["name"], "Main Route")
        self.assertEqual(patched.json()["filters"], view["filters"])
        self.assertEqual(patched.json()["sort"], "ip")
        self.assertEqual(patched.json()["visibleColumns"], ["ip", "group", "tags"])

        deleted = client.delete(f"/api/probe/server-views/{view['id']}", headers=other_headers)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(client.get("/api/probe/server-views", headers=headers).json()["items"], [])
        self.assertEqual(client.delete(f"/api/probe/server-views/{view['id']}", headers=headers).status_code, 404)
        self.assertEqual(client.patch("/api/probe/server-views/missing", headers=headers,
                                      json={"name": "Missing"}).status_code, 404)

    def test_defaults_validation_and_no_transient_state_persisted(self):
        client, headers = self.client()
        created = client.post("/api/probe/server-views", headers=headers,
                              json={"name": "Default columns"})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["visibleColumns"], DEFAULT_SERVER_VIEW_COLUMNS)
        self.assertEqual(created.json()["filters"], {
            "q": "", "group": None, "label": None, "tagId": None,
            "groupIds": [], "includeTagIds": [], "excludeTagIds": [],
            "tagMode": "any", "conn": "all",
        })
        connection = database.connect_database(self.path)
        try:
            stored = connection.execute("SELECT filters,visible_columns FROM probe_server_views").fetchone()
        finally:
            connection.close()
        self.assertEqual(set(json.loads(stored["filters"])), {
            "q", "group", "label", "tagId", "groupIds", "includeTagIds",
            "excludeTagIds", "tagMode", "conn",
        })
        self.assertEqual(json.loads(stored["visible_columns"]), DEFAULT_SERVER_VIEW_COLUMNS)

        for body in (
            {"name": "Bad name", "filters": {"page": 2}},
            {"name": "Bad cursor", "filters": {"cursor": "opaque"}},
            {"name": "Bad selection", "filters": {"selectionId": "frozen"}},
            {"name": "Bad columns", "visibleColumns": ["ip", "javascript"]},
            {"name": "Bad sort", "sort": "select *"},
            {"name": "x" * 65},
        ):
            with self.subTest(body=body):
                response = client.post("/api/probe/server-views", headers=headers, json=body)
                self.assertEqual(response.status_code, 400, response.text)
        extra = client.post("/api/probe/server-views", headers=headers,
                            json={"name": "No page", "page": 2})
        self.assertEqual(extra.status_code, 422)

        huge_filters = {"includeTagIds": ["x" * 200 + str(i) for i in range(100)]}
        oversized = client.post("/api/probe/server-views", headers=headers,
                                json={"name": "Too large", "filters": huge_filters})
        self.assertEqual(oversized.status_code, 400)

        invalid_query = client.post("/api/probe/server-views", headers=headers,
                                    json={"name": "Bad mode", "filters": {"tagMode": "sometimes"}})
        self.assertEqual(invalid_query.status_code, 400)
        for key, value in (("conn", []), ("tagMode", {})):
            with self.subTest(key=key):
                malformed_type = client.post("/api/probe/server-views", headers=headers,
                                             json={"name": "Bad " + key, "filters": {key: value}})
                self.assertEqual(malformed_type.status_code, 400, malformed_type.text)

    def test_casefold_patch_conflict_store_contract_and_migration_startup(self):
        first = self.store.create(name="Straße")
        with self.assertRaises(ServerViewNameConflictError):
            self.store.create(name=" STRASSE ")
        second = self.store.create(name="Other")
        with self.assertRaises(ServerViewNameConflictError):
            self.store.update(second["id"], {"name": "strasse"})
        self.assertEqual(self.store.update(first["id"], {"sort": "time"})["sort"], "time")
        self.assertEqual(len(self.store.list()), 2)

        # Re-running initialization is safe, and existing database data remains.
        database.initialize_database(self.path)
        self.assertEqual(len(ServerViewStore(self.path).list()), 2)

        # An older DB with application tables but no views receives the new table additively.
        legacy = Path(self.tmp.name) / "legacy.db"
        connection = sqlite3.connect(legacy)
        try:
            connection.execute(
                "CREATE TABLE probe_servers(id INTEGER PRIMARY KEY AUTOINCREMENT,ip TEXT NOT NULL UNIQUE,"
                "ip_sort INTEGER,label TEXT NOT NULL DEFAULT '',server_group TEXT NOT NULL DEFAULT '',"
                "group_id TEXT,created_at TEXT NOT NULL)"
            )
            connection.execute("INSERT INTO probe_servers(ip,created_at) VALUES('192.0.2.91','2026-10-24')")
            connection.commit()
        finally:
            connection.close()
        database.initialize_database(legacy)
        migrated = ServerViewStore(legacy)
        self.assertEqual(migrated.list(), [])
        connection = database.connect_database(legacy)
        try:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM probe_servers").fetchone()[0], 1)
            columns = {row[1] for row in connection.execute("PRAGMA table_info(probe_server_views)")}
        finally:
            connection.close()
        self.assertTrue({"id", "name", "name_key", "filters", "sort", "sort_order", "visible_columns"}.issubset(columns))


if __name__ == "__main__":
    unittest.main()
