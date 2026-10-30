import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import json

os.environ.setdefault("PROJECT_DIR", tempfile.mkdtemp(prefix="probe-context-facets-"))

from app.control.database import _migrate_probe_servers, connect_database
from app.probe.store import ProbeStore, ServerPageQuery


class ContextualServerFacetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "console.db"
        self.store = ProbeStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, ip, group, labels):
        return self.store.create_server(ip=ip, server_group=group, labels=labels)

    def ids(self):
        c = connect_database(self.path)
        try:
            groups = {r["name"]: r["id"] for r in c.execute("SELECT id,name FROM probe_groups")}
            tags = {r["name"]: r["id"] for r in c.execute(
                "SELECT id,name FROM probe_tags WHERE category_id=(SELECT id FROM probe_tag_categories WHERE name='other')")}
            return groups, tags
        finally:
            c.close()

    def test_contextual_group_tag_facets_all_any_exclude_and_legacy_label(self):
        a = self.add("203.0.113.1", "east", ["red", "blue", "shared"])
        self.add("203.0.113.2", "east", ["red", "shared"])
        self.add("203.0.113.3", "west", ["red", "blue"])
        self.add("203.0.113.4", "west", ["red"])
        self.add("203.0.113.5", "east", ["shared"])
        sixth = self.add("203.0.113.6", "east", ["red"])
        groups, tags = self.ids()
        self._seed_connectivity({
            a.id: (True, True, True),
            2: (False, True, True),
            3: (True, True, True),
            4: (True, False, True),
            5: (True, True, True),
            sixth.id: (True, True, True),
        })

        # Group counts discard only group/groupIds. All other filters remain.
        all_query = ServerPageQuery(
            q="203.0.113.", group="east", group_ids=(groups["east"],),
            include_tag_ids=(tags["red"], tags["blue"]), tag_mode="all", conn="pass",
            page_size=1,
        )
        facets = self.store.server_facets(all_query)
        self.assertEqual({row["group"]: row["count"] for row in facets["groups"]},
                         {"east": 1, "west": 1})

        any_query = ServerPageQuery(
            group_ids=(groups["east"],), include_tag_ids=(tags["blue"],),
            tag_mode="any", conn="pass",
        )
        any_facets = self.store.server_facets(any_query)
        self.assertEqual({row["group"]: row["count"] for row in any_facets["groups"]},
                         {"east": 1, "west": 1})
        excluded = self.store.server_facets(ServerPageQuery(
            include_tag_ids=(tags["red"],), exclude_tag_ids=(tags["blue"],), conn="pass",
        ))
        self.assertEqual(excluded["groups"], [{"group": "east", "count": 1}])

        # Tag counts discard label and all tag-ID filters but keep group/conn.
        tag_context = self.store.server_facets(ServerPageQuery(
            group_ids=(groups["east"],), include_tag_ids=(tags["blue"],),
            exclude_tag_ids=(tags["red"],), tag_mode="all", label="shared", conn="pass",
        ))
        self.assertEqual({row["name"]: row["count"] for row in tag_context["tagItems"]},
                         {"red": 2, "blue": 1, "shared": 2})
        legacy = self.store.server_facets(ServerPageQuery(label="shared", conn="pass"))
        self.assertEqual({row["group"]: row["count"] for row in legacy["groups"]}, {"east": 2})
        self.assertEqual({row["name"]: row["count"] for row in legacy["tagItems"]},
                         {"red": 3, "blue": 2, "shared": 2})

    def test_empty_context_and_no_argument_compatibility(self):
        server = self.add("203.0.113.11", "east", ["one"])
        connection = connect_database(self.path)
        try:
            connection.execute("INSERT INTO probe_tag_categories(id,name,created_at) VALUES('unpaged-cat','unpaged','2026-10-24')")
            for index in range(55):
                tag_id = f"unpaged-{index:02d}"
                connection.execute("INSERT INTO probe_tags(id,category_id,name,created_at) VALUES(?,?,?,?)",
                                   (tag_id, "unpaged-cat", f"candidate-{index:02d}", "2026-10-24"))
                connection.execute("INSERT INTO probe_server_tags(server_id,tag_id) VALUES(?,?)",
                                   (server.id, tag_id))
            connection.commit()
        finally:
            connection.close()
        global_facets = self.store.server_facets()
        self.assertEqual(global_facets["groups"], [{"group": "east", "count": 1}])
        self.assertEqual({row["label"]: row["count"] for row in global_facets["labels"]}["one"], 1)
        self.assertEqual(len(global_facets["labels"]), 56)
        self.assertEqual(len(global_facets["tagItems"]), 56)
        self.assertEqual(set(global_facets), {"groups", "labels", "tagItems"})
        empty = self.store.server_facets(ServerPageQuery(q="no-such-asset", group_ids=("missing-group-id",)))
        self.assertEqual(empty, {"groups": [], "labels": [], "tagItems": []})

    def test_facets_api_passes_list_filter_contract(self):
        first = self.add("203.0.113.21", "east", ["red", "blue"])
        second = self.add("203.0.113.22", "west", ["red", "blue"])
        groups, tags = self.ids()
        self._seed_connectivity({first.id: (True, True, True), second.id: (True, True, True)})
        import app.probe.router as router
        with patch.object(router, "source_store", return_value=self.store):
            facets = router.server_facets(
                q="203.0.113.", groupIds=groups["east"],
                includeTagIds=tags["red"] + "," + tags["blue"],
                tagMode="all", conn="pass", tagSearch="red", tagPage=1, tagPageSize=1,
            )
        # Group counts omit groupIds but keep query, all-tag, and conn filters.
        self.assertEqual(facets["groups"], [{"group": "east", "count": 1}, {"group": "west", "count": 1}])
        self.assertEqual({row["name"]: row["count"] for row in facets["tagItems"]}, {"red": 1})
        self.assertEqual((facets["tagPage"], facets["tagPageSize"], facets["tagTotal"]), (1, 1, 1))

    def test_tag_search_escaping_case_pagination_and_empty_page_total(self):
        server = self.add("203.0.113.31", "east", [])
        category_id = "facet-search-category"
        tag_data = [
            ("facet-search-1", "Alpha%One"),
            ("facet-search-2", "Alpine"),
            ("facet-search-3", "Beta_One"),
            ("facet-search-4", "Gamma\\Slash"),
        ]
        connection = connect_database(self.path)
        try:
            connection.execute("INSERT INTO probe_tag_categories(id,name,created_at) VALUES(?,?,?)",
                               (category_id, "Carrier Group", "2026-10-24"))
            for tag_id, name in tag_data:
                connection.execute("INSERT INTO probe_tags(id,category_id,name,created_at) VALUES(?,?,?,?)",
                                   (tag_id, category_id, name, "2026-10-24"))
                connection.execute("INSERT INTO probe_server_tags(server_id,tag_id) VALUES(?,?)",
                                   (server.id, tag_id))
            connection.commit()
        finally:
            connection.close()

        first = self.store.server_facets(tag_page=1, tag_page_size=2)
        second = self.store.server_facets(tag_page=2, tag_page_size=2)
        first_ids = [row["tagId"] for row in first["tagItems"]]
        second_ids = [row["tagId"] for row in second["tagItems"]]
        self.assertEqual(first_ids, ["facet-search-1", "facet-search-2"])
        self.assertEqual(second_ids, ["facet-search-3", "facet-search-4"])
        self.assertEqual(len(set(first_ids + second_ids)), 4)
        self.assertEqual(first["tagTotal"], second["tagTotal"])

        matched_category = self.store.server_facets(tag_search="cArRiEr")
        self.assertEqual([row["name"] for row in matched_category["tagItems"]],
                         [name for _, name in tag_data])
        self.assertEqual([row["name"] for row in self.store.server_facets(tag_search="%") ["tagItems"]],
                         ["Alpha%One"])
        self.assertEqual([row["name"] for row in self.store.server_facets(tag_search="_") ["tagItems"]],
                         ["Beta_One"])
        self.assertEqual([row["name"] for row in self.store.server_facets(tag_search="\\") ["tagItems"]],
                         ["Gamma\\Slash"])
        empty = self.store.server_facets(tag_page=3, tag_page_size=2)
        self.assertEqual(empty["tagItems"], [])
        self.assertEqual(empty["tagTotal"], 4)
        with self.assertRaisesRegex(ValueError, "tag_page"):
            self.store.server_facets(tag_page=10**20, tag_page_size=100)
        import app.probe.router as router
        from fastapi import HTTPException
        with patch.object(router, "source_store", return_value=self.store):
            with self.assertRaises(HTTPException) as invalid_page:
                router.server_facets(tagPage=10**20, tagPageSize=50)
        self.assertEqual(invalid_page.exception.status_code, 400)

        searched = self.store.server_facets(tag_search="Alpha", tag_page_size=1)
        self.assertEqual(searched["tagItems"][0]["count"], 1)
        self.assertEqual(searched["labels"], first["labels"])
        self.assertEqual(searched["groups"], first["groups"])

    def test_legacy_label_facet_deduplicates_same_name_across_categories(self):
        server = self.add("203.0.113.45", "east", ["shared-name"])
        connection = connect_database(self.path)
        try:
            connection.execute("INSERT INTO probe_tag_categories(id,name,created_at) VALUES('duplicate-category','duplicate','2026-10-24')")
            connection.execute("INSERT INTO probe_tags(id,category_id,name,created_at) VALUES('duplicate-name-tag','duplicate-category','shared-name','2026-10-24')")
            connection.execute("INSERT INTO probe_server_tags(server_id,tag_id) VALUES(?,?)", (server.id, "duplicate-name-tag"))
            connection.commit()
        finally:
            connection.close()
        facets = self.store.server_facets()
        self.assertEqual({row["label"]: row["count"] for row in facets["labels"]}["shared-name"], 1)
        same_name_tags = [row for row in facets["tagItems"] if row["name"] == "shared-name"]
        self.assertEqual(len(same_name_tags), 2)
        self.assertEqual([row["count"] for row in same_name_tags], [1, 1])

        groups, _ = self.ids()
        fallback = self.store.server_facets(ServerPageQuery(group_ids=(groups["east"],)))
        self.assertEqual(facets, fallback)
        for page in (1, 2):
            specialized_page = self.store.server_facets(tag_search="shared-name", tag_page=page, tag_page_size=1)
            fallback_page = self.store.server_facets(
                ServerPageQuery(group_ids=(groups["east"],)),
                tag_search="shared-name", tag_page=page, tag_page_size=1,
            )
            self.assertEqual(specialized_page, fallback_page)

        statements = []
        class TraceStore(ProbeStore):
            def _with_connection(inner, callback, *args):
                connection = connect_database(inner.database_path)
                connection.set_trace_callback(statements.append)
                try:
                    return callback(connection, *args)
                finally:
                    connection.close()
        TraceStore(self.path).server_facets()
        aggregate_sql = next(sql for sql in statements if sql.lstrip().upper().startswith("WITH") and 'tag_total AS' in sql)
        self.assertIn("INDEXED BY IDX_PROBE_SERVER_TAGS_TAG_SERVER", aggregate_sql.upper())
        self.assertNotIn("FACET_SERVERS", aggregate_sql.upper())
        connection = connect_database(self.path)
        try:
            plan = connection.execute("EXPLAIN QUERY PLAN " + aggregate_sql).fetchall()
            plan_text = " ".join(str(row["detail"]) for row in plan)
        finally:
            connection.close()
        self.assertIn("SCAN st USING COVERING INDEX idx_probe_server_tags_tag_server", plan_text)
        self.assertNotIn("SCAN probe_servers", plan_text)

    def test_conn_score_projection_tracks_current_results_and_fixed_port_hosts(self):
        connection = connect_database(self.path)
        try:
            connection.execute(
                "INSERT INTO probe_current_results(server_ip,kind,port,source_result_id,node_id,job_id,task_id,generation,test_time,data) "
                "VALUES('192.0.2.51','connectivity',7000,1,'node','job','task',0,'now',?)",
                (json.dumps({"frps_reachable": 0, "tunnel_established": 0, "firewall_open": 0}),),
            )
            connection.commit()
        finally:
            connection.close()
        base = self.add("192.0.2.51", "east", [])
        port_alias = self.add("192.0.2.51:7000", "east", [])
        alternate_port = self.add("192.0.2.51:7001", "east", [])
        untested = self.add("192.0.2.99", "east", [])

        def score(server_id):
            connection = connect_database(self.path)
            try:
                return connection.execute("SELECT conn_score FROM probe_servers WHERE id=?", (server_id,)).fetchone()[0]
            finally:
                connection.close()

        self.assertEqual((score(base.id), score(port_alias.id), score(alternate_port.id), score(untested.id)), (1, 1, 0, 0))
        connection = connect_database(self.path)
        try:
            before = connection.total_changes
            connection.execute("UPDATE probe_current_results SET test_time='same-score-time' WHERE server_ip='192.0.2.51' AND kind='connectivity' AND port=7000")
            self.assertEqual(connection.total_changes - before, 1)
            before = connection.total_changes
            connection.execute("UPDATE probe_current_results SET data=? WHERE server_ip='192.0.2.51' AND kind='connectivity' AND port=7000",
                               (json.dumps({"frps_reachable": 0, "tunnel_established": 0, "firewall_open": 0, "detail": "updated"}),))
            self.assertEqual(connection.total_changes - before, 1)
        finally:
            connection.close()
        updates = [
            {"frps_reachable": 1, "tunnel_established": 0, "firewall_open": 0},
            {"frps_reachable": 1, "tunnel_established": 1, "firewall_open": 0},
            {"frps_reachable": 1, "tunnel_established": 1, "firewall_open": 1},
        ]
        connection = connect_database(self.path)
        try:
            for payload in updates:
                connection.execute("UPDATE probe_current_results SET data=? WHERE server_ip='192.0.2.51' AND kind='connectivity' AND port=7000",
                                   (json.dumps(payload),))
                expected = 2 if not payload["tunnel_established"] else (3 if not payload["firewall_open"] else 4)
                self.assertEqual(connection.execute("SELECT conn_score FROM probe_servers WHERE id IN (?,?) ORDER BY id",
                                                    (base.id, port_alias.id)).fetchall()[0][0], expected)
                self.assertEqual(connection.execute("SELECT conn_score FROM probe_servers WHERE id=?", (port_alias.id,)).fetchone()[0], expected)
                self.assertEqual(connection.execute("SELECT conn_score FROM probe_servers WHERE id=?", (alternate_port.id,)).fetchone()[0], 0)
            connection.commit()
            ordered = self.store.query_servers(ServerPageQuery(sort="conn", order="desc", page_size=10))
            ordered_scores = [item["conn_score"] for item in ordered["items"]]
            self.assertEqual(ordered_scores, [4, 4, 0, 0])
            connection.execute("DELETE FROM probe_current_results WHERE server_ip='192.0.2.51' AND kind='connectivity' AND port=7000")
            self.assertEqual(connection.execute("SELECT conn_score FROM probe_servers WHERE id IN (?,?) ORDER BY id",
                                                (base.id, port_alias.id)).fetchall()[0][0], 0)
            self.assertEqual(connection.execute("SELECT conn_score FROM probe_servers WHERE id=?", (port_alias.id,)).fetchone()[0], 0)
            connection.execute("UPDATE probe_servers SET ip='192.0.2.52' WHERE id=?", (base.id,))
            self.assertEqual(connection.execute("SELECT conn_score FROM probe_servers WHERE id=?", (base.id,)).fetchone()[0], 0)
            connection.execute(
                "INSERT INTO probe_current_results(server_ip,kind,port,source_result_id,node_id,job_id,task_id,generation,test_time,data) "
                "VALUES('192.0.2.52','connectivity',7000,2,'node','job','task-2',0,'now',?)",
                (json.dumps({"frps_reachable": 1, "tunnel_established": 0, "firewall_open": 0}),),
            )
            self.assertEqual(connection.execute("SELECT conn_score FROM probe_servers WHERE id=?", (base.id,)).fetchone()[0], 2)
            connection.execute("DELETE FROM probe_current_results WHERE server_ip='192.0.2.52' AND kind='connectivity' AND port=7000")
            self.assertEqual(connection.execute("SELECT conn_score FROM probe_servers WHERE id=?", (base.id,)).fetchone()[0], 0)
        finally:
            connection.close()

    def test_conn_score_migration_adds_and_backfills_legacy_column(self):
        server = self.add("192.0.2.61", "east", [])
        connection = connect_database(self.path)
        try:
            connection.execute(
                "INSERT INTO probe_current_results(server_ip,kind,port,source_result_id,node_id,job_id,task_id,generation,test_time,data) "
                "VALUES('192.0.2.61','connectivity',7000,61,'node','job','task-61',0,'now',?)",
                (json.dumps({"frps_reachable": 1, "tunnel_established": 1, "firewall_open": 1}),),
            )
            for trigger in ("probe_servers_conn_insert", "probe_servers_conn_update", "probe_servers_conn_delete",
                            "probe_servers_conn_ip_refresh", "probe_servers_conn_asset_insert"):
                connection.execute(f"DROP TRIGGER IF EXISTS {trigger}")
            connection.execute("DROP INDEX IF EXISTS idx_probe_servers_conn_score")
            connection.execute("DROP INDEX IF EXISTS idx_probe_servers_conn_score_id")
            connection.execute("DROP INDEX IF EXISTS idx_probe_servers_group_conn_score")
            connection.execute("DELETE FROM probe_settings WHERE key='probe_server_conn_score_seeded'")
            connection.execute("ALTER TABLE probe_servers DROP COLUMN conn_score")
            connection.commit()
            _migrate_probe_servers(connection)
            columns = {row[1] for row in connection.execute("PRAGMA table_info(probe_servers)")}
            self.assertIn("conn_score", columns)
            self.assertEqual(connection.execute("SELECT conn_score FROM probe_servers WHERE id=?", (server.id,)).fetchone()[0], 4)
            connection.execute("UPDATE probe_servers SET conn_score=0 WHERE id=?", (server.id,))
            connection.commit()
            _migrate_probe_servers(connection)
            self.assertEqual(connection.execute("SELECT conn_score FROM probe_servers WHERE id=?", (server.id,)).fetchone()[0], 0)
        finally:
            connection.close()

    def test_facets_are_sql_aggregates_and_use_current_projection_for_100k(self):
        c = connect_database(self.path)
        try:
            c.execute("INSERT INTO probe_groups(id,name,color,created_at) VALUES('group-east','east','', '2026-10-24')")
            c.execute("INSERT INTO probe_groups(id,name,color,created_at) VALUES('group-west','west','', '2026-10-24')")
            c.execute("INSERT INTO probe_tag_categories(id,name,created_at) VALUES('facet-category','facet-test-category','2026-10-24')")
            c.execute("INSERT INTO probe_tags(id,category_id,name,created_at) VALUES('facet-red','facet-category','red','2026-10-24')")
            c.execute("INSERT INTO probe_tags(id,category_id,name,created_at) VALUES('facet-blue','facet-category','blue','2026-10-24')")
            c.execute(
                "WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<100000) "
                "INSERT INTO probe_servers(ip,ip_sort,label,server_group,group_id,created_at) "
                "SELECT printf('198.%d.%d.%d',18+((x-1)/65536),((x-1)/256)%256,(x-1)%256),NULL,'',"
                "CASE WHEN ((x-1)/2)%2=0 THEN 'east' ELSE 'west' END,"
                "CASE WHEN ((x-1)/2)%2=0 THEN 'group-east' ELSE 'group-west' END,'2026-10-24' FROM seq"
            )
            c.execute(
                "INSERT INTO probe_server_tags(server_id,tag_id) "
                "SELECT id,'facet-red' FROM probe_servers"
            )
            c.execute(
                "INSERT INTO probe_server_tags(server_id,tag_id) "
                "SELECT id,'facet-blue' FROM probe_servers WHERE id%2=0"
            )
            c.execute(
                "INSERT INTO probe_current_results(server_ip,kind,port,source_result_id,node_id,job_id,task_id,generation,test_time,data) "
                "SELECT ip,'connectivity',7000,id,'node','job','task-'||id,0,'2026-10-24',"
                "'{\"frps_reachable\":1,\"tunnel_established\":1,\"firewall_open\":1}' "
                "FROM probe_servers WHERE id%2=0"
            )
            c.commit()
        finally:
            c.close()

        statements = []

        class TraceStore(ProbeStore):
            def _with_connection(inner, callback, *args):
                connection = connect_database(inner.database_path)
                connection.create_function("probe_endpoint_host", 1, lambda value: value)
                connection.create_function("probe_endpoint_port", 1, lambda value: 7000)
                connection.set_trace_callback(statements.append)
                try:
                    return callback(connection, *args)
                finally:
                    connection.close()

        facets = TraceStore(self.path).server_facets(ServerPageQuery(
            group_ids=("group-east",), include_tag_ids=("facet-red",), conn="pass", page_size=1,
        ))
        self.assertEqual(sum(row["count"] for row in facets["groups"]), 50_000)
        self.assertEqual({row["name"]: row["count"] for row in facets["tagItems"]},
                         {"red": 25_000, "blue": 25_000})
        aggregate_sql = [sql for sql in statements if sql.lstrip().upper().startswith("WITH FACET_SERVERS")]
        group_sql = [sql for sql in statements if sql.lstrip().upper().startswith("SELECT S.SERVER_GROUP")]
        self.assertEqual(len(aggregate_sql), 1)
        self.assertEqual(len(group_sql), 1)
        self.assertIn("s.conn_score = 4", aggregate_sql[0])
        self.assertNotIn("probe_current_results", aggregate_sql[0])
        self.assertNotIn("probe_results", aggregate_sql[0])
        explain_connection = connect_database(self.path)
        try:
            explain_connection.create_function("probe_endpoint_host", 1, lambda value: value)
            explain_connection.create_function("probe_endpoint_port", 1, lambda value: 7000)
            plan = explain_connection.execute("EXPLAIN QUERY PLAN " + aggregate_sql[0]).fetchall()
            plan_text = " ".join(str(row["detail"]) for row in plan)
        finally:
            explain_connection.close()
        self.assertRegex(plan_text, r"SEARCH s USING (?:COVERING )?INDEX idx_probe_servers_group_conn_score \(group_id=\? AND conn_score=\?\)")
        self.assertNotIn("probe_current_results", plan_text)
        self.assertNotIn("probe_results", plan_text)
        self.assertIn("MATERIALIZE facet_servers", plan_text)
        self.assertRegex(plan_text, r"SEARCH st USING COVERING INDEX sqlite_autoindex_probe_server_tags_1 \(server_id=\?\)")
        self.assertNotIn("SCAN st", plan_text)
        # Same-name tags across categories need distinct-server counting;
        # ordinary names reuse the shared SQL aggregate instead.
        statements.clear()
        paged = TraceStore(self.path).server_facets(
            ServerPageQuery(group_ids=("group-east",), include_tag_ids=("facet-red",), conn="pass"),
            tag_page=1, tag_page_size=1,
        )
        paged_sql = next(sql for sql in statements if sql.lstrip().upper().startswith("WITH FACET_SERVERS"))
        self.assertIn("LIMIT 1 OFFSET 0", paged_sql)
        explain_connection = connect_database(self.path)
        try:
            explain_connection.create_function("probe_endpoint_host", 1, lambda value: value)
            explain_connection.create_function("probe_endpoint_port", 1, lambda value: 7000)
            paged_plan = explain_connection.execute("EXPLAIN QUERY PLAN " + paged_sql).fetchall()
            paged_plan_text = " ".join(str(row["detail"]) for row in paged_plan)
        finally:
            explain_connection.close()
        self.assertRegex(paged_plan_text, r"SEARCH s USING (?:COVERING )?INDEX idx_probe_servers_group_conn_score \(group_id=\? AND conn_score=\?\)")
        self.assertIn("MATERIALIZE facet_servers", paged_plan_text)
        self.assertRegex(paged_plan_text, r"SEARCH st USING COVERING INDEX sqlite_autoindex_probe_server_tags_1 \(server_id=\?\)")
        self.assertNotIn("SCAN st", paged_plan_text)
        self.assertEqual(len(paged["tagItems"]), 1)
        self.assertEqual((paged["tagPage"], paged["tagPageSize"], paged["tagTotal"]), (1, 1, 2))

        statements.clear()
        page_query = ServerPageQuery(
            group_ids=("group-east",), include_tag_ids=("facet-red",), conn="pass", sort="group", page_size=50,
        )
        server_page = TraceStore(self.path).query_servers(page_query)
        page_sql = next(sql for sql in statements if sql.lstrip().upper().startswith("WITH PAGE AS"))
        where_sql = page_sql.upper().split(") SELECT S.*", 1)[0].split(" WHERE ", 1)[1]
        self.assertIn("S.CONN_SCORE = 4", where_sql)
        self.assertNotIn("JSON_EXTRACT", where_sql)
        explain_connection = connect_database(self.path)
        try:
            explain_connection.create_function("probe_endpoint_host", 1, lambda value: value)
            explain_connection.create_function("probe_endpoint_port", 1, lambda value: 7000)
            page_plan = explain_connection.execute("EXPLAIN QUERY PLAN " + page_sql).fetchall()
            page_plan_text = " ".join(str(row["detail"]) for row in page_plan)
        finally:
            explain_connection.close()
        self.assertRegex(page_plan_text, r"SEARCH s USING INDEX idx_probe_servers_group_conn_score \(group_id=\? AND conn_score=\?\)")
        self.assertIn('MATERIALIZE page', page_plan_text)
        self.assertFalse(any('USE TEMP B-TREE' in row['detail'] and row['parent'] != 0 for row in page_plan))
        self.assertEqual((len(server_page["items"]), server_page["total"]), (50, 25_000))

        statements.clear()
        ordered_page = TraceStore(self.path).query_servers(ServerPageQuery(sort="conn", order="desc", page_size=50))
        ordered_sql = next(sql for sql in statements if sql.lstrip().upper().startswith("WITH PAGE AS"))
        explain_connection = connect_database(self.path)
        try:
            explain_connection.create_function("probe_endpoint_host", 1, lambda value: value)
            explain_connection.create_function("probe_endpoint_port", 1, lambda value: 7000)
            ordered_plan = explain_connection.execute("EXPLAIN QUERY PLAN " + ordered_sql).fetchall()
            ordered_plan_text = " ".join(str(row["detail"]) for row in ordered_plan)
        finally:
            explain_connection.close()
        self.assertIn("idx_probe_servers_conn_score_id", ordered_plan_text)
        self.assertIn('MATERIALIZE page', ordered_plan_text)
        self.assertFalse(any('USE TEMP B-TREE' in row['detail'] and row['parent'] != 0 for row in ordered_plan))
        ordered_scores = [item["conn_score"] for item in ordered_page["items"]]
        self.assertEqual(ordered_scores, sorted(ordered_scores, reverse=True))

    def _seed_connectivity(self, values):
        connection = connect_database(self.path)
        try:
            for server_id, (reachable, tunnel, firewall) in values.items():
                row = connection.execute("SELECT ip FROM probe_servers WHERE id=?", (server_id,)).fetchone()
                if row is None:
                    continue
                connection.execute(
                    "INSERT INTO probe_current_results(server_ip,kind,port,source_result_id,node_id,job_id,task_id,generation,test_time,data) "
                    "VALUES(?,'connectivity',7000,?,'node','job',?,0,'2026-10-24',?)",
                    (row["ip"], server_id, f"task-{server_id}", json.dumps({
                        "frps_reachable": reachable, "tunnel_established": tunnel,
                        "firewall_open": firewall,
                    })),
                )
            connection.commit()
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
