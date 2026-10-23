import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("PROJECT_DIR", tempfile.mkdtemp(prefix="probe-context-facets-"))

from app.control.database import connect_database
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
        self.add("203.0.113.11", "east", ["one"])
        global_facets = self.store.server_facets()
        self.assertEqual(global_facets["groups"], [{"group": "east", "count": 1}])
        self.assertEqual(global_facets["labels"], [{"label": "one", "count": 1}])
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
                tagMode="all", conn="pass",
            )
        # Group counts omit groupIds but keep query, all-tag, and conn filters.
        self.assertEqual(facets["groups"], [{"group": "east", "count": 1}, {"group": "west", "count": 1}])
        self.assertEqual({row["name"]: row["count"] for row in facets["tagItems"]},
                         {"red": 1, "blue": 1})

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
        self.assertIn("probe_current_results", aggregate_sql[0])
        self.assertNotIn("probe_results", aggregate_sql[0])
        explain_connection = connect_database(self.path)
        try:
            explain_connection.create_function("probe_endpoint_host", 1, lambda value: value)
            explain_connection.create_function("probe_endpoint_port", 1, lambda value: 7000)
            plan = explain_connection.execute("EXPLAIN QUERY PLAN " + aggregate_sql[0]).fetchall()
            plan_text = " ".join(str(row["detail"]) for row in plan)
        finally:
            explain_connection.close()
        self.assertIn("probe_current_results", plan_text)
        self.assertRegex(plan_text, r"SEARCH c USING (?:COVERING )?INDEX [^ ]*probe_current_results")
        self.assertNotIn("probe_results", plan_text)

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
