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
import httpx

from app.agent.service import LocalAgentService
from app.compose_generator import generate_compose
from app.config_validator import validate_config_text
from app.control.agent_client import (
    AgentAuthError,
    AgentClient,
    AgentConnectionError,
    AgentNotFoundError,
    AgentServerError,
    AgentTimeoutError,
)
from app.control.node_store import NodeStore
from app.instance_store import InstanceStore, validate_instance_name


def load_main_app(**env: str):
    previous = {key: os.environ.get(key) for key in env}
    os.environ.update(env)
    for module_name in [
        "app.main",
        "app.control.router",
        "app.control.agent_client",
        "app.agent.router",
        "app.agent.auth",
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


class AppRoutingAndAuthTests(unittest.TestCase):
    def test_agent_auth_requires_valid_bearer_token_when_enabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                AGENT_AUTH_ENABLED="true",
                AGENT_TOKEN="secret-token",
                FRPC_MULTI_ROLE="all",
            )
            client = TestClient(app)

            missing = client.get("/agent/health")
            wrong = client.get("/agent/health", headers={"Authorization": "Bearer wrong-token"})
            valid = client.get("/agent/health", headers={"Authorization": "Bearer secret-token"})

            self.assertEqual(missing.status_code, 401)
            self.assertEqual(wrong.status_code, 401)
            self.assertEqual(valid.status_code, 200)
            self.assertEqual(valid.json(), {"ok": True})

    def test_agent_auth_does_not_affect_console_api_login(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                WEBUI_USERNAME="admin",
                WEBUI_PASSWORD="password",
                AGENT_AUTH_ENABLED="true",
                AGENT_TOKEN="secret-token",
                FRPC_MULTI_ROLE="all",
            )
            client = TestClient(app)

            response = client.post("/api/auth/login", json={"username": "admin", "password": "password"})

            self.assertEqual(response.status_code, 200)
            self.assertIn("token", response.json())

    def test_all_role_mounts_console_api_agent_api_and_static_frontend(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(PROJECT_DIR=tmp, FRPC_MULTI_ROLE="all")
            routes = {route.path for route in app.routes}

            self.assertIn("/api/health", routes)
            self.assertIn("/agent/health", routes)
            self.assertIn("", routes)

    def test_console_role_mounts_console_api_and_static_frontend_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(PROJECT_DIR=tmp, FRPC_MULTI_ROLE="console")
            routes = {route.path for route in app.routes}

            self.assertIn("/api/health", routes)
            self.assertNotIn("/agent/health", routes)
            self.assertIn("", routes)

    def test_agent_role_mounts_agent_api_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(PROJECT_DIR=tmp, FRPC_MULTI_ROLE="agent")
            routes = {route.path for route in app.routes}

            self.assertNotIn("/api/health", routes)
            self.assertIn("/agent/health", routes)
            self.assertNotIn("", routes)


class NodeStoreTests(unittest.TestCase):
    def test_database_file_is_created_automatically(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "console.db"

            NodeStore(db_path)

            self.assertTrue(db_path.exists())

    def test_node_crud_persists_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = NodeStore(Path(tmp) / "console.db")

            created = store.create_node(
                name="local-agent",
                base_url="http://127.0.0.1:8082/",
                token="secret-token",
            )
            fetched = store.get_node(created.id)

            self.assertEqual(created.id, fetched.id)
            self.assertEqual(fetched.name, "local-agent")
            self.assertEqual(fetched.base_url, "http://127.0.0.1:8082")
            self.assertEqual(fetched.token, "secret-token")
            self.assertEqual(fetched.status, "unknown")
            self.assertEqual(len(store.list_nodes()), 1)

            updated = store.update_node(
                created.id,
                name="edge-agent",
                base_url="https://agent.example.com",
                token="new-token",
                status="online",
            )

            self.assertEqual(updated.name, "edge-agent")
            self.assertEqual(updated.base_url, "https://agent.example.com")
            self.assertEqual(updated.token, "new-token")
            self.assertEqual(updated.status, "online")

            self.assertTrue(store.delete_node(created.id))
            self.assertEqual(store.list_nodes(), [])

    def test_node_delete_succeeds_after_audit_logs_reference_node(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "console.db"
            store = NodeStore(db_path)
            created = store.create_node(
                name="local-agent",
                base_url="http://127.0.0.1:8082/",
                token="secret-token",
            )
            from app.control.audit_store import AuditStore

            AuditStore(db_path).create_log(
                username="admin",
                action="create_instance",
                node_id=created.id,
                instance_name="client-001",
            )

            self.assertTrue(store.delete_node(created.id))
            self.assertEqual(store.list_nodes(), [])

    def test_node_crud_reports_missing_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = NodeStore(Path(tmp) / "console.db")

            with self.assertRaises(KeyError):
                store.get_node(404)

            self.assertIsNone(store.update_node(404, name="missing"))
            self.assertFalse(store.delete_node(404))


class NodeApiTests(unittest.TestCase):
    def test_node_api_crud_hides_tokens(self):
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

            created = client.post(
                "/api/nodes",
                json={
                    "name": "local-agent",
                    "baseUrl": "http://127.0.0.1:8082/",
                    "token": "secret-token",
                },
                headers=headers,
            )

            self.assertEqual(created.status_code, 200)
            created_body = created.json()
            self.assertEqual(created_body["name"], "local-agent")
            self.assertEqual(created_body["baseUrl"], "http://127.0.0.1:8082")
            self.assertNotIn("token", created_body)

            listed = client.get("/api/nodes", headers=headers)
            self.assertEqual(listed.status_code, 200)
            self.assertEqual(len(listed.json()), 1)
            self.assertNotIn("token", listed.json()[0])

            detail = client.get(f"/api/nodes/{created_body['id']}", headers=headers)
            self.assertEqual(detail.status_code, 200)
            self.assertNotIn("token", detail.json())

            patched = client.patch(
                f"/api/nodes/{created_body['id']}",
                json={"name": "edge-agent", "status": "online"},
                headers=headers,
            )
            self.assertEqual(patched.status_code, 200)
            self.assertEqual(patched.json()["name"], "edge-agent")
            self.assertEqual(patched.json()["status"], "online")
            self.assertNotIn("token", patched.json())

            deleted = client.delete(f"/api/nodes/{created_body['id']}", headers=headers)
            self.assertEqual(deleted.status_code, 200)
            self.assertEqual(deleted.json(), {"deleted": True})
            self.assertEqual(client.get("/api/nodes", headers=headers).json(), [])

    def test_node_api_requires_console_auth(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                DATABASE_PATH=str(Path(tmp) / "console.db"),
                FRPC_MULTI_ROLE="console",
            )
            client = TestClient(app)

            response = client.get("/api/nodes")

            self.assertEqual(response.status_code, 401)

    def test_node_ping_uses_stored_token_and_updates_status(self):
        class FakeAgentClient:
            def __init__(self, base_url: str, token: str):
                self.base_url = base_url
                self.token = token

            def ping(self):
                return {"ok": True, "baseUrl": self.base_url, "tokenUsed": self.token}

        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                DATABASE_PATH=str(Path(tmp) / "console.db"),
                WEBUI_USERNAME="admin",
                WEBUI_PASSWORD="password",
                FRPC_MULTI_ROLE="console",
            )
            from app.control.router import create_agent_client

            app.dependency_overrides[create_agent_client] = lambda: FakeAgentClient
            client = TestClient(app)
            headers = auth_headers(client)
            created = client.post(
                "/api/nodes",
                json={
                    "name": "local-agent",
                    "baseUrl": "http://127.0.0.1:8082",
                    "token": "secret-token",
                },
                headers=headers,
            ).json()

            response = client.post(f"/api/nodes/{created['id']}/ping", headers=headers)

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["ok"], True)
            self.assertEqual(response.json()["agent"]["tokenUsed"], "secret-token")
            detail = client.get(f"/api/nodes/{created['id']}", headers=headers).json()
            self.assertEqual(detail["status"], "online")


class NodeInstanceApiTests(unittest.TestCase):
    def test_node_instance_api_forwards_to_agent_client(self):
        calls: list[tuple[str, str, str, object]] = []

        class FakeAgentClient:
            def __init__(self, base_url: str, token: str):
                self.base_url = base_url
                self.token = token

            def list_instances(self):
                calls.append(("list_instances", self.base_url, self.token, None))
                return [{"name": "client-001"}]

            def create_instance(self, payload):
                calls.append(("create_instance", self.base_url, self.token, payload))
                return {"name": payload["name"]}

            def get_instance(self, name: str):
                calls.append(("get_instance", self.base_url, self.token, name))
                return {"name": name}

            def patch_instance(self, name: str, payload):
                calls.append(("patch_instance", self.base_url, self.token, (name, payload)))
                return {"name": name, **payload}

            def delete_instance(self, name: str):
                calls.append(("delete_instance", self.base_url, self.token, name))
                return {"deleted": name}

            def get_config(self, name: str):
                calls.append(("get_config", self.base_url, self.token, name))
                return {"configText": "serverAddr = \"x\""}

            def update_config(self, name: str, payload):
                calls.append(("update_config", self.base_url, self.token, (name, payload)))
                return {"configPath": "/tmp/frpc.toml"}

            def validate_config(self, name: str, config_text: str):
                calls.append(("validate_config", self.base_url, self.token, (name, config_text)))
                return {"valid": True, "errors": [], "warnings": [], "summary": {}}

            def logs(self, name: str, tail: int = 300, keyword: str = ""):
                calls.append(("logs", self.base_url, self.token, (name, tail, keyword)))
                return {"lines": ["ok"]}

            def start(self, name: str):
                calls.append(("start", self.base_url, self.token, name))
                return {"started": name}

            def stop(self, name: str):
                calls.append(("stop", self.base_url, self.token, name))
                return {"stopped": name}

            def restart(self, name: str):
                calls.append(("restart", self.base_url, self.token, name))
                return {"restarted": name}

            def recreate(self, name: str):
                calls.append(("recreate", self.base_url, self.token, name))
                return {"recreated": name}

        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                DATABASE_PATH=str(Path(tmp) / "console.db"),
                WEBUI_USERNAME="admin",
                WEBUI_PASSWORD="password",
                FRPC_MULTI_ROLE="console",
            )
            from app.control.router import create_agent_client

            app.dependency_overrides[create_agent_client] = lambda: FakeAgentClient
            client = TestClient(app)
            headers = auth_headers(client)
            node = client.post(
                "/api/nodes",
                json={
                    "name": "remote-agent",
                    "baseUrl": "http://agent.example.com/",
                    "token": "node-token",
                },
                headers=headers,
            ).json()
            node_id = node["id"]

            self.assertEqual(client.get(f"/api/nodes/{node_id}/instances", headers=headers).json(), [{"name": "client-001"}])
            self.assertEqual(
                client.post(
                    f"/api/nodes/{node_id}/instances",
                    json={"name": "client-002", "configText": "x"},
                    headers=headers,
                ).json(),
                {"name": "client-002"},
            )
            self.assertEqual(client.get(f"/api/nodes/{node_id}/instances/client-001", headers=headers).json(), {"name": "client-001"})
            self.assertEqual(
                client.patch(
                    f"/api/nodes/{node_id}/instances/client-001",
                    json={"enabled": False},
                    headers=headers,
                ).json(),
                {"name": "client-001", "enabled": False},
            )
            self.assertEqual(client.get(f"/api/nodes/{node_id}/instances/client-001/config", headers=headers).json(), {"configText": "serverAddr = \"x\""})
            self.assertEqual(
                client.put(
                    f"/api/nodes/{node_id}/instances/client-001/config",
                    json={"configText": "x", "restartAfterSave": True},
                    headers=headers,
                ).json(),
                {"configPath": "/tmp/frpc.toml"},
            )
            self.assertEqual(
                client.post(
                    f"/api/nodes/{node_id}/instances/client-001/config/validate",
                    content="serverAddr = \"x\"",
                    headers={**headers, "Content-Type": "text/plain"},
                ).json()["valid"],
                True,
            )
            self.assertEqual(client.get(f"/api/nodes/{node_id}/instances/client-001/logs?tail=50&keyword=ok", headers=headers).json(), {"lines": ["ok"]})
            self.assertEqual(client.post(f"/api/nodes/{node_id}/instances/client-001/start", headers=headers).json(), {"started": "client-001"})
            self.assertEqual(client.post(f"/api/nodes/{node_id}/instances/client-001/stop", headers=headers).json(), {"stopped": "client-001"})
            self.assertEqual(client.post(f"/api/nodes/{node_id}/instances/client-001/restart", headers=headers).json(), {"restarted": "client-001"})
            self.assertEqual(client.post(f"/api/nodes/{node_id}/instances/client-001/recreate", headers=headers).json(), {"recreated": "client-001"})
            self.assertEqual(client.delete(f"/api/nodes/{node_id}/instances/client-001", headers=headers).json(), {"deleted": "client-001"})

        self.assertEqual(
            calls,
            [
                ("list_instances", "http://agent.example.com", "node-token", None),
                ("create_instance", "http://agent.example.com", "node-token", {"name": "client-002", "configText": "x"}),
                ("get_instance", "http://agent.example.com", "node-token", "client-001"),
                ("patch_instance", "http://agent.example.com", "node-token", ("client-001", {"enabled": False})),
                ("get_config", "http://agent.example.com", "node-token", "client-001"),
                ("update_config", "http://agent.example.com", "node-token", ("client-001", {"configText": "x", "restartAfterSave": True})),
                ("validate_config", "http://agent.example.com", "node-token", ("client-001", "serverAddr = \"x\"")),
                ("logs", "http://agent.example.com", "node-token", ("client-001", 50, "ok")),
                ("start", "http://agent.example.com", "node-token", "client-001"),
                ("stop", "http://agent.example.com", "node-token", "client-001"),
                ("restart", "http://agent.example.com", "node-token", "client-001"),
                ("recreate", "http://agent.example.com", "node-token", "client-001"),
                ("delete_instance", "http://agent.example.com", "node-token", "client-001"),
            ],
        )

    def test_node_instance_api_returns_404_for_missing_node(self):
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
    def test_mutating_local_instance_actions_create_audit_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                DATABASE_PATH=str(Path(tmp) / "console.db"),
                WEBUI_USERNAME="admin",
                WEBUI_PASSWORD="password",
                FRPC_MULTI_ROLE="all",
            )
            client = TestClient(app)
            headers = auth_headers(client)

            client.post(
                "/api/instances",
                json={
                    "name": "client-001",
                    "displayName": "Client 001",
                    "configText": 'serverAddr = "frps.example.com"\nserverPort = 7000\n',
                    "enabled": True,
                    "startAfterCreate": False,
                },
                headers=headers,
            )
            client.patch(
                "/api/instances/client-001",
                json={"displayName": "Client 001 updated"},
                headers=headers,
            )
            client.put(
                "/api/instances/client-001/config",
                json={
                    "configText": 'serverAddr = "frps.example.com"\nserverPort = 7001\n',
                    "restartAfterSave": False,
                },
                headers=headers,
            )
            client.delete("/api/instances/client-001", headers=headers)

            response = client.get("/api/audit-logs", headers=headers)

            self.assertEqual(response.status_code, 200)
            logs = response.json()
            self.assertEqual(
                [item["action"] for item in logs],
                [
                    "delete_instance",
                    "update_config",
                    "patch_instance",
                    "create_instance",
                ],
            )
            self.assertTrue(all(item["username"] == "admin" for item in logs))
            self.assertTrue(all(item["nodeId"] is None for item in logs))
            self.assertTrue(all(item["instanceName"] == "client-001" for item in logs))
            self.assertTrue(all(item["success"] is True for item in logs))

    def test_mutating_node_instance_actions_create_audit_logs(self):
        class FakeAgentClient:
            def __init__(self, base_url: str, token: str):
                pass

            def create_instance(self, payload):
                return {"name": payload["name"]}

            def update_config(self, name: str, payload):
                return {"configPath": "/tmp/frpc.toml"}

            def start(self, name: str):
                return {"started": name}

            def stop(self, name: str):
                return {"stopped": name}

            def restart(self, name: str):
                return {"restarted": name}

            def recreate(self, name: str):
                return {"recreated": name}

            def delete_instance(self, name: str):
                return {"deleted": name}

        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                DATABASE_PATH=str(Path(tmp) / "console.db"),
                WEBUI_USERNAME="admin",
                WEBUI_PASSWORD="password",
                FRPC_MULTI_ROLE="console",
            )
            from app.control.router import create_agent_client

            app.dependency_overrides[create_agent_client] = lambda: FakeAgentClient
            client = TestClient(app)
            headers = auth_headers(client)
            node = client.post(
                "/api/nodes",
                json={"name": "remote-agent", "baseUrl": "http://agent.example.com", "token": "node-token"},
                headers=headers,
            ).json()
            node_id = node["id"]

            client.post(
                f"/api/nodes/{node_id}/instances",
                json={"name": "client-001", "configText": "x"},
                headers=headers,
            )
            client.put(
                f"/api/nodes/{node_id}/instances/client-001/config",
                json={"configText": "x", "restartAfterSave": True},
                headers=headers,
            )
            client.post(f"/api/nodes/{node_id}/instances/client-001/start", headers=headers)
            client.post(f"/api/nodes/{node_id}/instances/client-001/stop", headers=headers)
            client.post(f"/api/nodes/{node_id}/instances/client-001/restart", headers=headers)
            client.post(f"/api/nodes/{node_id}/instances/client-001/recreate", headers=headers)
            client.delete(f"/api/nodes/{node_id}/instances/client-001", headers=headers)

            response = client.get("/api/audit-logs", headers=headers)

            self.assertEqual(response.status_code, 200)
            logs = response.json()
            self.assertEqual(
                [item["action"] for item in logs],
                [
                    "delete_instance",
                    "recreate_instance",
                    "restart_instance",
                    "stop_instance",
                    "start_instance",
                    "update_config",
                    "create_instance",
                ],
            )
            self.assertTrue(all(item["username"] == "admin" for item in logs))
            self.assertTrue(all(item["nodeId"] == node_id for item in logs))
            self.assertTrue(all(item["success"] is True for item in logs))
            self.assertEqual(logs[0]["instanceName"], "client-001")


class MultiNodeSummaryTests(unittest.TestCase):
    def test_summary_aggregates_nodes_and_tolerates_offline_node(self):
        class FakeAgentClient:
            def __init__(self, base_url: str, token: str):
                self.base_url = base_url

            def summary(self):
                if "offline" in self.base_url:
                    raise AgentConnectionError("offline")
                return {
                    "total": 2,
                    "running": 1,
                    "stopped": 1,
                    "error": 0,
                    "dockerAvailable": True,
                    "dockerError": "",
                    "instances": [
                        {"name": "client-001", "displayName": "A", "enabled": True, "runtime": {"state": "running"}},
                        {"name": "client-002", "displayName": "B", "enabled": True, "runtime": {}},
                    ],
                }

        with tempfile.TemporaryDirectory() as tmp:
            app = load_main_app(
                PROJECT_DIR=tmp,
                DATABASE_PATH=str(Path(tmp) / "console.db"),
                WEBUI_USERNAME="admin",
                WEBUI_PASSWORD="password",
                FRPC_MULTI_ROLE="console",
            )
            from app.control.router import create_agent_client

            app.dependency_overrides[create_agent_client] = lambda: FakeAgentClient
            client = TestClient(app)
            headers = auth_headers(client)
            client.post(
                "/api/nodes",
                json={"name": "online-node", "baseUrl": "http://online-agent", "token": "token-a"},
                headers=headers,
            )
            client.post(
                "/api/nodes",
                json={"name": "offline-node", "baseUrl": "http://offline-agent", "token": "token-b"},
                headers=headers,
            )

            response = client.get("/api/summary", headers=headers)

            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(body["total"], 2)
            self.assertEqual(body["running"], 1)
            self.assertEqual(body["stopped"], 1)
            self.assertEqual(body["error"], 0)
            self.assertFalse(body["dockerAvailable"])
            self.assertEqual(len(body["nodes"]), 2)
            self.assertEqual(body["nodes"][0]["status"], "online")
            self.assertEqual(body["nodes"][1]["status"], "offline")
            self.assertEqual(body["instances"][0]["nodeId"], body["nodes"][0]["id"])
            self.assertEqual(body["instances"][0]["nodeName"], "online-node")


class AgentClientTests(unittest.TestCase):
    def test_agent_client_sends_bearer_token_and_maps_methods(self):
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.method == "GET" and request.url.path == "/agent/instances/client-001/config":
                return httpx.Response(200, json={"configText": "serverAddr = \"x\""})
            return httpx.Response(200, json={"path": request.url.path, "method": request.method})

        transport = httpx.MockTransport(handler)
        client = AgentClient("http://agent.local/", "secret-token", transport=transport)

        self.assertEqual(client.ping()["path"], "/agent/health")
        self.assertEqual(client.get_system()["path"], "/agent/system")
        self.assertEqual(client.list_instances()["path"], "/agent/instances")
        self.assertEqual(client.create_instance({"name": "client-001"})["method"], "POST")
        self.assertEqual(client.get_instance("client-001")["path"], "/agent/instances/client-001")
        self.assertEqual(client.get_config("client-001")["configText"], 'serverAddr = "x"')
        self.assertEqual(client.update_config("client-001", {"configText": "x"})["method"], "PUT")
        self.assertEqual(client.validate_config("client-001", "serverAddr = \"x\"")["method"], "POST")
        self.assertEqual(client.patch_instance("client-001", {"enabled": False})["method"], "PATCH")
        self.assertEqual(client.delete_instance("client-001")["method"], "DELETE")
        self.assertEqual(client.start("client-001")["path"], "/agent/instances/client-001/start")
        self.assertEqual(client.stop("client-001")["path"], "/agent/instances/client-001/stop")
        self.assertEqual(client.restart("client-001")["path"], "/agent/instances/client-001/restart")
        self.assertEqual(client.recreate("client-001")["path"], "/agent/instances/client-001/recreate")
        self.assertEqual(client.logs("client-001", tail=10, keyword="err")["path"], "/agent/instances/client-001/logs")
        self.assertEqual(client.summary()["path"], "/agent/summary")
        self.assertEqual(client.stats()["path"], "/agent/stats")

        self.assertTrue(requests)
        self.assertTrue(all(request.headers.get("Authorization") == "Bearer secret-token" for request in requests))
        logs_request = next(request for request in requests if request.url.path.endswith("/logs"))
        self.assertEqual(logs_request.url.params["tail"], "10")
        self.assertEqual(logs_request.url.params["keyword"], "err")

    def test_agent_client_classifies_http_errors(self):
        cases = [
            (401, AgentAuthError),
            (404, AgentNotFoundError),
            (500, AgentServerError),
        ]

        for status_code, expected_error in cases:
            with self.subTest(status_code=status_code):
                transport = httpx.MockTransport(lambda request: httpx.Response(status_code, json={"detail": "failed"}))
                client = AgentClient("http://agent.local", "secret-token", transport=transport)

                with self.assertRaises(expected_error):
                    client.ping()

    def test_agent_client_classifies_network_errors(self):
        def timeout_handler(request: httpx.Request) -> httpx.Response:
            raise httpx.TimeoutException("timed out", request=request)

        def connection_handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connect failed", request=request)

        with self.assertRaises(AgentTimeoutError):
            AgentClient("http://agent.local", "secret-token", transport=httpx.MockTransport(timeout_handler)).ping()

        with self.assertRaises(AgentConnectionError):
            AgentClient("http://agent.local", "secret-token", transport=httpx.MockTransport(connection_handler)).ping()


if __name__ == "__main__":
    unittest.main()
