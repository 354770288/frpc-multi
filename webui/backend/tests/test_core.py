import json
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("PROJECT_DIR", tempfile.mkdtemp(prefix="frpc-multi-tests-"))

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.agent.service import LocalAgentService
from app.compose_generator import generate_compose
from app.config_validator import validate_config_text
from app.control.node_store import NodeStore
from app.instance_store import InstanceStore, validate_instance_name


def load_main_app(**env: str):
    previous = {key: os.environ.get(key) for key in env}
    os.environ.update(env)
    for module_name in [
        "app.main",
        "app.control.router",
        "app.control.ws_router",
        "app.control.hub",
        "app.settings",
        "app.auth",
    ]:
        sys.modules.pop(module_name, None)
    try:
        return importlib.import_module("app.main").app
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def auth_headers(client: TestClient, username: str = "admin", password: str = "password") -> dict[str, str]:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    return {"Authorization": f"Bearer {response.json()['token']}"}


class FakeConnection:
    """模拟一条在线 Agent 连接，记录 call() 调用并按方法返回桩数据。"""

    def __init__(self, uuid: str = "uuid", responses: dict | None = None, raises: Exception | None = None):
        self.uuid = uuid
        self.calls: list[tuple[str, dict]] = []
        self.responses = responses or {}
        self.raises = raises

    async def call(self, method: str, params: dict | None = None, *, timeout: float = 15.0):
        self.calls.append((method, params or {}))
        if self.raises is not None:
            raise self.raises
        if method in self.responses:
            value = self.responses[method]
            return value(params or {}) if callable(value) else value
        return {"ok": True, "method": method, "params": params or {}}


def patch_hub(app, connection: FakeConnection | None, *, online: bool = True):
    """把 control.router / main 用到的 hub 替换为受控版本。"""
    from app.control import hub as hub_module

    class FakeHub:
        def is_online(self, uuid: str) -> bool:
            return online and connection is not None

        def get(self, uuid: str):
            if connection is None or not online:
                from app.control.hub import AgentOfflineError

                raise AgentOfflineError("offline")
            return connection

    fake = FakeHub()
    hub_module.hub = fake
    # router/main 在模块顶层 `from .hub import hub` 之外还用了 `from .hub import ... hub`，
    # 这些是名字绑定，需要同时改到已加载模块的引用。
    for mod_name in ["app.control.router", "app.main", "app.control.ws_router"]:
        mod = sys.modules.get(mod_name)
        if mod is not None and hasattr(mod, "hub"):
            mod.hub = fake
    return fake


class InstanceStoreTests(unittest.TestCase):
    def test_validate_instance_name_accepts_safe_names(self):
        self.assertEqual(validate_instance_name("client-001"), "client-001")
        self.assertEqual(validate_instance_name("office-frpc"), "office-frpc")

    def test_validate_instance_name_rejects_unsafe_names(self):
        for name in ["Client-01", "../x", "-bad", "bad-", "ab", "bad_name"]:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    validate_instance_name(name)

    def test_create_instance_writes_config_and_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = InstanceStore(Path(tmp))
            instance = store.create_instance(
                name="client-001",
                display_name="测试实例",
                config_text='serverAddr = "frps.example.com"\nserverPort = 7000\n',
                enabled=True,
                description="demo",
            )

            instance_dir = Path(tmp) / "instances" / "client-001"
            self.assertTrue((instance_dir / "frpc.toml").exists())
            self.assertTrue((instance_dir / "meta.json").exists())
            self.assertEqual(instance.name, "client-001")
            self.assertEqual(json.loads((instance_dir / "meta.json").read_text())["displayName"], "测试实例")

    def test_update_meta_persists_partial_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = InstanceStore(Path(tmp))
            store.create_instance(
                name="client-001",
                display_name="original",
                config_text='serverAddr = "x"\nserverPort = 7000\n',
                enabled=True,
                description="old",
            )

            updated = store.update_meta("client-001", enabled=False)
            self.assertFalse(updated.enabled)
            self.assertEqual(updated.display_name, "original")
            self.assertEqual(updated.description, "old")

            updated = store.update_meta(
                "client-001",
                display_name="new name",
                description="家里 NAS",
            )
            self.assertEqual(updated.display_name, "new name")
            self.assertEqual(updated.description, "家里 NAS")
            self.assertFalse(updated.enabled)

            updated = store.update_meta("client-001", display_name="   ")
            self.assertEqual(updated.display_name, "client-001")


class ConfigValidatorTests(unittest.TestCase):
    def test_validate_config_text_reports_missing_required_fields(self):
        result = validate_config_text("[auth]\ntoken = \"secret\"\n")
        self.assertFalse(result.valid)
        self.assertIn("serverAddr", "\n".join(result.errors))
        self.assertIn("serverPort", "\n".join(result.errors))

    def test_validate_config_text_detects_duplicate_proxy_names(self):
        text = """
serverAddr = "frps.example.com"
serverPort = 7000

[[proxies]]
name = "ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 6001

[[proxies]]
name = "ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 80
remotePort = 6002
"""
        result = validate_config_text(text)
        self.assertFalse(result.valid)
        self.assertIn("重复", "\n".join(result.errors))


class ComposeGeneratorTests(unittest.TestCase):
    def test_generate_compose_uses_dynamic_instances(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = InstanceStore(root)
            store.create_instance("client-001", "client-001", 'serverAddr = "x"\nserverPort = 7000\n')
            store.create_instance("office-frpc", "office", 'serverAddr = "x"\nserverPort = 7000\n')

            compose_text = generate_compose(root, store.list_instances())

            self.assertIn("frpc-client-001:", compose_text)
            self.assertIn("frpc-office-frpc:", compose_text)
            self.assertIn("./instances/client-001/frpc.toml:/etc/frp/frpc.toml:ro", compose_text)
            self.assertIn("ghcr.io/fatedier/frpc:v0.68.1", compose_text)
            self.assertIn("networks:", compose_text)
            self.assertIn("  frpc-outbound:", compose_text)
            self.assertIn("    driver: bridge", compose_text)


class ComposeFileTests(unittest.TestCase):
    def test_console_compose_uses_console_role_and_data_volume(self):
        root = Path(__file__).resolve().parents[3]
        console_compose = (root / "compose.console.yaml").read_text(encoding="utf-8")

        self.assertIn("FRPC_MULTI_ROLE: console", console_compose)
        self.assertIn("DATABASE_PATH: ${DATABASE_PATH:-/data/console.db}", console_compose)
        self.assertIn("- console-data:/data", console_compose)
        self.assertIn("name: ${CONSOLE_DATA_VOLUME:-frpc-multi-console_console-data}", console_compose)
        # 反转模型：Console 不挂 docker.sock。
        self.assertNotIn("/var/run/docker.sock", console_compose)

    def test_agent_compose_dials_out_without_inbound_port(self):
        root = Path(__file__).resolve().parents[3]
        agent_compose = (root / "compose.agent.yaml").read_text(encoding="utf-8")

        self.assertIn("FRPC_MULTI_ROLE: agent", agent_compose)
        self.assertIn("AGENT_SERVER", agent_compose)
        self.assertIn("AGENT_UUID", agent_compose)
        self.assertIn("AGENT_SECRET", agent_compose)
        self.assertIn("/var/run/docker.sock", agent_compose)
        # 出站模型：不应有入站管理端口映射（容器内 8081 不再对外）。
        self.assertNotIn(":8081\"", agent_compose)


class LocalAgentServiceTests(unittest.TestCase):
    def test_create_instance_writes_local_files_and_generated_compose(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = LocalAgentService(root)

            result = service.create_instance(
                name="client-001",
                display_name="Client 001",
                config_text='serverAddr = "frps.example.com"\nserverPort = 7000\n',
                enabled=True,
                description="demo",
                start_after_create=False,
            )

            self.assertEqual(result["name"], "client-001")
            self.assertTrue((root / "instances" / "client-001" / "frpc.toml").exists())
            self.assertTrue((root / "compose.generated.yaml").exists())
            self.assertIn("frpc-client-001", (root / "compose.generated.yaml").read_text(encoding="utf-8"))

    def test_create_instance_rejects_invalid_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = LocalAgentService(Path(tmp))

            with self.assertRaises(HTTPException) as ctx:
                service.create_instance(
                    name="client-001",
                    display_name="Client 001",
                    config_text='serverAddr = "frps.example.com"\n',
                    enabled=True,
                    description="demo",
                    start_after_create=False,
                )

            self.assertEqual(ctx.exception.status_code, 400)

    def test_summary_marks_instances_stopped_when_docker_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = LocalAgentService(root)
            service.create_instance(
                name="client-001",
                display_name="Client 001",
                config_text='serverAddr = "frps.example.com"\nserverPort = 7000\n',
                enabled=True,
                description="demo",
                start_after_create=False,
            )

            summary = service.get_summary()

            self.assertEqual(summary["total"], 1)
            self.assertEqual(summary["stopped"], 1)
            self.assertEqual(summary["instances"][0]["name"], "client-001")


class AppRoutingTests(unittest.TestCase):
    def test_console_role_mounts_console_api_ws_and_static_frontend(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(PROJECT_DIR=tmp, FRPC_MULTI_ROLE="console")
            routes = {getattr(route, "path", None) for route in app.routes}

            self.assertIn("/api/health", routes)
            self.assertIn("/api/nodes", routes)
            self.assertIn("/ws/agent", routes)
            self.assertIn("", routes)  # 静态前端挂载点

    def test_agent_role_mounts_no_console_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(PROJECT_DIR=tmp, FRPC_MULTI_ROLE="agent")
            routes = {getattr(route, "path", None) for route in app.routes}

            self.assertNotIn("/api/health", routes)
            self.assertNotIn("/api/nodes", routes)
            self.assertNotIn("/ws/agent", routes)

    def test_all_role_falls_back_to_console(self):
        # all 模式已废弃，应降级为 console 行为。
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(PROJECT_DIR=tmp, FRPC_MULTI_ROLE="all")
            routes = {getattr(route, "path", None) for route in app.routes}

            self.assertIn("/api/health", routes)
            self.assertIn("/ws/agent", routes)

    def test_login_succeeds_on_console(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                WEBUI_USERNAME="admin",
                WEBUI_PASSWORD="password",
                FRPC_MULTI_ROLE="console",
            )
            client = TestClient(app)
            response = client.post("/api/auth/login", json={"username": "admin", "password": "password"})
            self.assertEqual(response.status_code, 200)
            self.assertIn("token", response.json())


class NodeStoreTests(unittest.TestCase):
    def test_database_file_is_created_automatically(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "console.db"
            NodeStore(db_path)
            self.assertTrue(db_path.exists())

    def test_create_node_generates_uuid_and_secret(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = NodeStore(Path(tmp) / "console.db")
            created = store.create_node(name="local-agent")

            self.assertTrue(created.uuid)
            self.assertTrue(created.secret)
            self.assertEqual(created.status, "pending")
            fetched = store.get_node(created.id)
            self.assertEqual(fetched.uuid, created.uuid)
            self.assertEqual(fetched.secret, created.secret)
            # uuid 查询可命中
            self.assertEqual(store.get_node_by_uuid(created.uuid).id, created.id)

    def test_rotate_secret_changes_secret_keeps_uuid(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = NodeStore(Path(tmp) / "console.db")
            created = store.create_node(name="n1")
            rotated = store.rotate_secret(created.id)
            self.assertEqual(rotated.uuid, created.uuid)
            self.assertNotEqual(rotated.secret, created.secret)

    def test_mark_status_by_uuid_updates_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = NodeStore(Path(tmp) / "console.db")
            created = store.create_node(name="n1")
            updated = store.mark_status_by_uuid(created.uuid, status="online", last_seen_at="2026-05-30T00:00:00+08:00")
            self.assertEqual(updated.status, "online")
            self.assertEqual(updated.last_seen_at, "2026-05-30T00:00:00+08:00")

    def test_node_crud_reports_missing_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = NodeStore(Path(tmp) / "console.db")
            with self.assertRaises(KeyError):
                store.get_node(404)
            with self.assertRaises(KeyError):
                store.get_node_by_uuid("nope")
            self.assertIsNone(store.update_node(404, name="missing"))
            self.assertFalse(store.delete_node(404))

    def test_delete_succeeds_after_audit_logs_reference_node(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "console.db"
            store = NodeStore(db_path)
            created = store.create_node(name="local-agent")
            from app.control.audit_store import AuditStore

            AuditStore(db_path).create_log(
                username="admin",
                action="create_instance",
                node_id=created.id,
                instance_name="client-001",
            )
            self.assertTrue(store.delete_node(created.id))
            self.assertEqual(store.list_nodes(), [])


class DatabaseMigrationTests(unittest.TestCase):
    def test_legacy_nodes_table_gets_uuid_and_secret_columns(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "console.db"
            # 构造旧版表结构（base_url/token，无 uuid/secret）
            conn = sqlite3.connect(db_path)
            conn.executescript(
                """
                CREATE TABLE nodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    base_url TEXT NOT NULL,
                    token TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'unknown',
                    last_seen_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            conn.execute(
                "INSERT INTO nodes (name, base_url, token, status, created_at, updated_at) "
                "VALUES ('old', 'http://x', 'tok', 'unknown', '2026-01-01', '2026-01-01')"
            )
            conn.commit()
            conn.close()

            # 连接后应自动补列，不报错
            from app.control.database import connect_database

            conn2 = connect_database(db_path)
            cols = {row[1] for row in conn2.execute("PRAGMA table_info(nodes)").fetchall()}
            conn2.close()
            self.assertIn("uuid", cols)
            self.assertIn("secret", cols)

            # NodeStore 能读取旧行（uuid/secret 为空字符串）
            store = NodeStore(db_path)
            nodes = store.list_nodes()
            self.assertEqual(len(nodes), 1)
            self.assertEqual(nodes[0].name, "old")
            self.assertEqual(nodes[0].uuid, "")


class NodeApiTests(unittest.TestCase):
    def _app(self, tmp):
        return load_main_app(
            PROJECT_DIR=tmp,
            DATABASE_PATH=str(Path(tmp) / "console.db"),
            WEBUI_USERNAME="admin",
            WEBUI_PASSWORD="password",
            FRPC_MULTI_ROLE="console",
        )

    def test_create_node_returns_install_command_and_hides_secret_in_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = self._app(tmp)
            client = TestClient(app)
            headers = auth_headers(client)

            created = client.post("/api/nodes", json={"name": "vps-hk-01"}, headers=headers)
            self.assertEqual(created.status_code, 200)
            body = created.json()
            self.assertEqual(body["name"], "vps-hk-01")
            self.assertTrue(body["uuid"])
            self.assertIn("install", body)
            self.assertIn("installCommand", body["install"])
            # 安装命令里应带上 uuid
            self.assertIn(body["uuid"], body["install"]["installCommand"])

            # 列表与详情不回显 secret
            listed = client.get("/api/nodes", headers=headers).json()
            self.assertEqual(len(listed), 1)
            self.assertNotIn("secret", listed[0])
            detail = client.get(f"/api/nodes/{body['id']}", headers=headers).json()
            self.assertNotIn("secret", detail)

    def test_install_endpoint_returns_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = self._app(tmp)
            client = TestClient(app)
            headers = auth_headers(client)
            created = client.post("/api/nodes", json={"name": "n1"}, headers=headers).json()

            info = client.get(f"/api/nodes/{created['id']}/install", headers=headers)
            self.assertEqual(info.status_code, 200)
            self.assertIn("installCommand", info.json())
            self.assertEqual(info.json()["uuid"], created["uuid"])

    def test_rotate_secret_returns_new_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = self._app(tmp)
            client = TestClient(app)
            headers = auth_headers(client)
            created = client.post("/api/nodes", json={"name": "n1"}, headers=headers).json()

            rotated = client.post(f"/api/nodes/{created['id']}/rotate-secret", headers=headers)
            self.assertEqual(rotated.status_code, 200)
            self.assertEqual(rotated.json()["uuid"], created["uuid"])
            self.assertIn("install", rotated.json())

    def test_node_api_requires_console_auth(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = self._app(tmp)
            client = TestClient(app)
            response = client.get("/api/nodes")
            self.assertEqual(response.status_code, 401)

    def test_ping_reflects_online_state_from_hub(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = self._app(tmp)
            client = TestClient(app)
            headers = auth_headers(client)
            created = client.post("/api/nodes", json={"name": "n1"}, headers=headers).json()

            # 离线：hub 无连接
            patch_hub(app, None, online=False)
            offline = client.post(f"/api/nodes/{created['id']}/ping", headers=headers)
            self.assertEqual(offline.status_code, 200)
            self.assertFalse(offline.json()["ok"])

            # 在线：hub 有连接
            patch_hub(app, FakeConnection(uuid=created["uuid"]), online=True)
            online = client.post(f"/api/nodes/{created['id']}/ping", headers=headers)
            self.assertEqual(online.status_code, 200)
            self.assertTrue(online.json()["ok"])
            self.assertEqual(online.json()["node"]["status"], "online")

    def test_node_system_calls_agent_over_hub(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = self._app(tmp)
            client = TestClient(app)
            headers = auth_headers(client)
            created = client.post("/api/nodes", json={"name": "n1"}, headers=headers).json()

            conn = FakeConnection(
                uuid=created["uuid"],
                responses={"get_system": {"dockerVersion": "27.0", "frpImage": "img"}},
            )
            patch_hub(app, conn, online=True)
            resp = client.get(f"/api/nodes/{created['id']}/system", headers=headers)
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["dockerVersion"], "27.0")
            self.assertEqual(conn.calls[0][0], "get_system")

    def test_node_instance_offline_returns_502(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = self._app(tmp)
            client = TestClient(app)
            headers = auth_headers(client)
            created = client.post("/api/nodes", json={"name": "n1"}, headers=headers).json()

            patch_hub(app, None, online=False)
            resp = client.get(f"/api/nodes/{created['id']}/instances", headers=headers)
            self.assertEqual(resp.status_code, 502)


class NodeInstanceApiTests(unittest.TestCase):
    def _setup(self, tmp, conn: FakeConnection):
        app = load_main_app(
            PROJECT_DIR=tmp,
            DATABASE_PATH=str(Path(tmp) / "console.db"),
            WEBUI_USERNAME="admin",
            WEBUI_PASSWORD="password",
            FRPC_MULTI_ROLE="console",
        )
        client = TestClient(app)
        headers = auth_headers(client)
        created = client.post("/api/nodes", json={"name": "remote"}, headers=headers).json()
        conn.uuid = created["uuid"]
        patch_hub(app, conn, online=True)
        return client, headers, created["id"]

    def test_instance_actions_map_to_hub_methods(self):
        conn = FakeConnection(
            responses={
                "list_instances": [{"name": "client-001"}],
                "create_instance": lambda p: {"name": p["name"]},
                "get_instance": lambda p: {"name": p["name"]},
                "patch_instance": lambda p: {"name": p["name"], **p.get("patch", {})},
                "delete_instance": lambda p: {"deleted": p["name"]},
                "get_config": {"configText": "x"},
                "update_config": {"configPath": "/tmp/frpc.toml"},
                "validate_config": {"valid": True, "errors": [], "warnings": [], "summary": {}},
                "logs": {"lines": ["ok"]},
                "start": lambda p: {"started": p["name"]},
                "stop": lambda p: {"stopped": p["name"]},
                "restart": lambda p: {"restarted": p["name"]},
                "recreate": lambda p: {"recreated": p["name"]},
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            client, headers, node_id = self._setup(tmp, conn)

            self.assertEqual(
                client.get(f"/api/nodes/{node_id}/instances", headers=headers).json(),
                [{"name": "client-001"}],
            )
            self.assertEqual(
                client.post(
                    f"/api/nodes/{node_id}/instances",
                    json={"name": "client-002", "configText": "x"},
                    headers=headers,
                ).json(),
                {"name": "client-002"},
            )
            self.assertEqual(
                client.get(f"/api/nodes/{node_id}/instances/client-001", headers=headers).json(),
                {"name": "client-001"},
            )
            self.assertEqual(
                client.patch(
                    f"/api/nodes/{node_id}/instances/client-001",
                    json={"enabled": False},
                    headers=headers,
                ).json(),
                {"name": "client-001", "enabled": False},
            )
            self.assertEqual(
                client.get(f"/api/nodes/{node_id}/instances/client-001/config", headers=headers).json(),
                {"configText": "x"},
            )
            self.assertEqual(
                client.put(
                    f"/api/nodes/{node_id}/instances/client-001/config",
                    json={"configText": "x", "restartAfterSave": True},
                    headers=headers,
                ).json(),
                {"configPath": "/tmp/frpc.toml"},
            )
            self.assertTrue(
                client.post(
                    f"/api/nodes/{node_id}/instances/client-001/config/validate",
                    content='serverAddr = "x"',
                    headers={**headers, "Content-Type": "text/plain"},
                ).json()["valid"]
            )
            self.assertEqual(
                client.get(
                    f"/api/nodes/{node_id}/instances/client-001/logs?tail=50&keyword=ok",
                    headers=headers,
                ).json(),
                {"lines": ["ok"]},
            )
            self.assertEqual(
                client.post(f"/api/nodes/{node_id}/instances/client-001/start", headers=headers).json(),
                {"started": "client-001"},
            )
            self.assertEqual(
                client.post(f"/api/nodes/{node_id}/instances/client-001/stop", headers=headers).json(),
                {"stopped": "client-001"},
            )
            self.assertEqual(
                client.post(f"/api/nodes/{node_id}/instances/client-001/restart", headers=headers).json(),
                {"restarted": "client-001"},
            )
            self.assertEqual(
                client.post(f"/api/nodes/{node_id}/instances/client-001/recreate", headers=headers).json(),
                {"recreated": "client-001"},
            )
            self.assertEqual(
                client.delete(f"/api/nodes/{node_id}/instances/client-001", headers=headers).json(),
                {"deleted": "client-001"},
            )

            methods = [c[0] for c in conn.calls]
            self.assertEqual(
                methods,
                [
                    "list_instances",
                    "create_instance",
                    "get_instance",
                    "patch_instance",
                    "get_config",
                    "update_config",
                    "validate_config",
                    "logs",
                    "start",
                    "stop",
                    "restart",
                    "recreate",
                    "delete_instance",
                ],
            )
            # logs 参数透传
            logs_call = next(c for c in conn.calls if c[0] == "logs")
            self.assertEqual(logs_call[1]["tail"], 50)
            self.assertEqual(logs_call[1]["keyword"], "ok")

    def test_missing_node_returns_404(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                DATABASE_PATH=str(Path(tmp) / "console.db"),
                WEBUI_USERNAME="admin",
                WEBUI_PASSWORD="password",
                FRPC_MULTI_ROLE="console",
            )
            client = TestClient(app)
            headers = auth_headers(client)
            response = client.get("/api/nodes/404/instances", headers=headers)
            self.assertEqual(response.status_code, 404)


class AuditLogApiTests(unittest.TestCase):
    def test_node_instance_actions_create_success_audit_logs(self):
        conn = FakeConnection(
            responses={
                "create_instance": lambda p: {"name": p["name"]},
                "update_config": {"configPath": "/tmp/frpc.toml"},
                "start": lambda p: {"started": p["name"]},
                "delete_instance": lambda p: {"deleted": p["name"]},
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                DATABASE_PATH=str(Path(tmp) / "console.db"),
                WEBUI_USERNAME="admin",
                WEBUI_PASSWORD="password",
                FRPC_MULTI_ROLE="console",
            )
            client = TestClient(app)
            headers = auth_headers(client)
            node = client.post("/api/nodes", json={"name": "remote"}, headers=headers).json()
            conn.uuid = node["uuid"]
            patch_hub(app, conn, online=True)
            node_id = node["id"]

            client.post(f"/api/nodes/{node_id}/instances", json={"name": "client-001", "configText": "x"}, headers=headers)
            client.put(
                f"/api/nodes/{node_id}/instances/client-001/config",
                json={"configText": "x", "restartAfterSave": True},
                headers=headers,
            )
            client.post(f"/api/nodes/{node_id}/instances/client-001/start", headers=headers)
            client.delete(f"/api/nodes/{node_id}/instances/client-001", headers=headers)

            logs = client.get("/api/audit-logs", headers=headers).json()
            self.assertEqual(
                [item["action"] for item in logs],
                ["delete_instance", "start_instance", "update_config", "create_instance"],
            )
            self.assertTrue(all(item["nodeId"] == node_id for item in logs))
            self.assertTrue(all(item["success"] is True for item in logs))

    def test_failed_node_instance_action_is_audited_as_failure(self):
        from app.control.hub import AgentOfflineError

        conn = FakeConnection(raises=AgentOfflineError("node offline"))
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                DATABASE_PATH=str(Path(tmp) / "console.db"),
                WEBUI_USERNAME="admin",
                WEBUI_PASSWORD="password",
                FRPC_MULTI_ROLE="console",
            )
            client = TestClient(app)
            headers = auth_headers(client)
            node = client.post("/api/nodes", json={"name": "remote"}, headers=headers).json()
            conn.uuid = node["uuid"]
            patch_hub(app, conn, online=True)
            node_id = node["id"]

            response = client.post(f"/api/nodes/{node_id}/instances/client-001/start", headers=headers)
            self.assertEqual(response.status_code, 502)

            logs = client.get("/api/audit-logs", headers=headers).json()
            self.assertEqual(len(logs), 1)
            self.assertEqual(logs[0]["action"], "start_instance")
            self.assertEqual(logs[0]["instanceName"], "client-001")
            self.assertEqual(logs[0]["nodeId"], node_id)
            self.assertFalse(logs[0]["success"])
            self.assertTrue(logs[0]["message"])


class MultiNodeSummaryTests(unittest.TestCase):
    def test_summary_aggregates_online_and_tolerates_offline(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                DATABASE_PATH=str(Path(tmp) / "console.db"),
                WEBUI_USERNAME="admin",
                WEBUI_PASSWORD="password",
                FRPC_MULTI_ROLE="console",
            )
            client = TestClient(app)
            headers = auth_headers(client)
            online_node = client.post("/api/nodes", json={"name": "online-node"}, headers=headers).json()
            offline_node = client.post("/api/nodes", json={"name": "offline-node"}, headers=headers).json()

            summary_data = {
                "total": 2,
                "running": 1,
                "stopped": 1,
                "error": 0,
                "instances": [
                    {"name": "client-001", "displayName": "A", "enabled": True, "runtime": {"state": "running"}},
                    {"name": "client-002", "displayName": "B", "enabled": True, "runtime": {}},
                ],
            }

            # 自定义 hub：只有 online-node 在线
            from app.control import hub as hub_module

            class FakeHub:
                def is_online(self, uuid: str) -> bool:
                    return uuid == online_node["uuid"]

                def get(self, uuid: str):
                    return FakeConnection(uuid=uuid, responses={"summary": summary_data})

            fake = FakeHub()
            hub_module.hub = fake
            for mod_name in ["app.control.router", "app.main"]:
                mod = sys.modules.get(mod_name)
                if mod is not None and hasattr(mod, "hub"):
                    mod.hub = fake

            response = client.get("/api/summary", headers=headers)
            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(body["total"], 2)
            self.assertEqual(body["running"], 1)
            self.assertEqual(body["nodeCount"], 2)
            self.assertEqual(body["onlineCount"], 1)
            statuses = {n["name"]: n["status"] for n in body["nodes"]}
            self.assertEqual(statuses["online-node"], "online")
            self.assertEqual(statuses["offline-node"], "offline")
            self.assertEqual(body["instances"][0]["nodeName"], "online-node")
            _ = offline_node  # referenced for clarity


class SettingsTests(unittest.TestCase):
    def _snapshot(self, **env: str) -> dict:
        keys = [
            "WEBUI_CORS_ORIGINS",
            "FRPC_MULTI_ROLE",
            "PROJECT_DIR",
            "WEBUI_JWT_SECRET",
            "CONSOLE_PUBLIC_HOST",
            "CONSOLE_TLS",
            "AGENT_SERVER",
            "AGENT_UUID",
            "AGENT_SECRET",
            "AGENT_TLS",
        ]
        previous = {key: os.environ.get(key) for key in keys}
        for key in keys:
            os.environ.pop(key, None)
        os.environ["PROJECT_DIR"] = tempfile.mkdtemp(prefix="frpc-settings-")
        os.environ["WEBUI_JWT_SECRET"] = "test-secret"
        os.environ.update(env)
        sys.modules.pop("app.settings", None)
        try:
            settings = importlib.import_module("app.settings").settings
            return {
                "cors_origins": list(settings.cors_origins),
                "role": settings.frpc_multi_role,
                "is_console": settings.is_console,
                "is_agent": settings.is_agent,
                "include_console_api": settings.include_console_api,
                "serve_frontend": settings.serve_frontend,
                "agent_ws_url": settings.agent_ws_url,
            }
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            sys.modules.pop("app.settings", None)

    def test_cors_origins_default_is_localhost(self):
        snap = self._snapshot()
        self.assertEqual(snap["cors_origins"], ["http://127.0.0.1:8081", "http://localhost:8081"])

    def test_cors_origins_parsed_from_env(self):
        snap = self._snapshot(WEBUI_CORS_ORIGINS="https://a.example.com, https://b.example.com")
        self.assertEqual(snap["cors_origins"], ["https://a.example.com", "https://b.example.com"])

    def test_all_role_downgrades_to_console(self):
        snap = self._snapshot(FRPC_MULTI_ROLE="all")
        self.assertEqual(snap["role"], "console")
        self.assertTrue(snap["is_console"])

    def test_console_role_serves_frontend_and_api(self):
        snap = self._snapshot(FRPC_MULTI_ROLE="console")
        self.assertTrue(snap["include_console_api"])
        self.assertTrue(snap["serve_frontend"])
        self.assertFalse(snap["is_agent"])

    def test_agent_role_no_console_api(self):
        snap = self._snapshot(FRPC_MULTI_ROLE="agent")
        self.assertTrue(snap["is_agent"])
        self.assertFalse(snap["include_console_api"])
        self.assertFalse(snap["serve_frontend"])

    def test_agent_ws_url_builds_from_server_and_tls(self):
        plain = self._snapshot(FRPC_MULTI_ROLE="agent", AGENT_SERVER="console:8081")
        self.assertEqual(plain["agent_ws_url"], "ws://console:8081/ws/agent")
        secure = self._snapshot(FRPC_MULTI_ROLE="agent", AGENT_SERVER="frpc.example.com", AGENT_TLS="true")
        self.assertEqual(secure["agent_ws_url"], "wss://frpc.example.com/ws/agent")


class WsProtoTests(unittest.TestCase):
    def test_encode_decode_roundtrip(self):
        from app.control import wsproto

        frame = {"type": wsproto.T_REQUEST, "id": "abc", "method": "start", "params": {"name": "x"}}
        raw = wsproto.encode(frame)
        self.assertEqual(wsproto.decode(raw), frame)
        # bytes 也能解码
        self.assertEqual(wsproto.decode(raw.encode("utf-8")), frame)

    def test_decode_rejects_non_object(self):
        from app.control import wsproto

        with self.assertRaises(ValueError):
            wsproto.decode("[1,2,3]")


class HubTests(unittest.IsolatedAsyncioTestCase):
    async def test_call_resolves_on_matching_response(self):
        from app.control.hub import AgentConnection
        from app.control import wsproto

        sent = []

        async def send(text):
            sent.append(text)

        conn = AgentConnection("uuid", send)

        import asyncio

        async def respond():
            # 等待请求帧发出后，构造响应
            for _ in range(50):
                if sent:
                    break
                await asyncio.sleep(0.005)
            frame = wsproto.decode(sent[-1])
            conn.handle_response(
                {"type": wsproto.T_RESPONSE, "id": frame["id"], "ok": True, "result": {"done": True}}
            )

        task = asyncio.create_task(respond())
        result = await conn.call("start", {"name": "x"}, timeout=2.0)
        await task
        self.assertEqual(result, {"done": True})

    async def test_call_raises_on_error_response(self):
        from app.control.hub import AgentConnection, AgentRpcError
        from app.control import wsproto

        sent = []

        async def send(text):
            sent.append(text)

        conn = AgentConnection("uuid", send)

        import asyncio

        async def respond():
            for _ in range(50):
                if sent:
                    break
                await asyncio.sleep(0.005)
            frame = wsproto.decode(sent[-1])
            conn.handle_response(
                {
                    "type": wsproto.T_RESPONSE,
                    "id": frame["id"],
                    "ok": False,
                    "status": 404,
                    "error": "not found",
                }
            )

        task = asyncio.create_task(respond())
        with self.assertRaises(AgentRpcError) as ctx:
            await conn.call("get_instance", {"name": "x"}, timeout=2.0)
        await task
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_fail_all_wakes_pending_calls(self):
        from app.control.hub import AgentConnection, AgentOfflineError

        sent = []

        async def send(text):
            sent.append(text)

        conn = AgentConnection("uuid", send)

        import asyncio

        async def kill():
            for _ in range(50):
                if sent:
                    break
                await asyncio.sleep(0.005)
            conn.fail_all(AgentOfflineError("disconnected"))

        task = asyncio.create_task(kill())
        with self.assertRaises(AgentOfflineError):
            await conn.call("start", {"name": "x"}, timeout=2.0)
        await task

    async def test_stream_queue_receives_data_then_end(self):
        from app.control.hub import AgentConnection
        from app.control import wsproto

        sent = []

        async def send(text):
            sent.append(text)

        conn = AgentConnection("uuid", send)
        stream_id, queue = await conn.open_stream("logs_stream", {"name": "x"})
        conn.handle_stream({"type": wsproto.T_STREAM, "id": stream_id, "data": "line-1"})
        conn.handle_stream({"type": wsproto.T_STREAM, "id": stream_id, "end": True})

        first = await queue.get()
        second = await queue.get()
        self.assertEqual(first, "line-1")
        self.assertIsNone(second)


if __name__ == "__main__":
    unittest.main()
