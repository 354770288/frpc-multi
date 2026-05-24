import json
import tempfile
import unittest
from pathlib import Path

from app.compose_generator import generate_compose
from app.config_validator import validate_config_text
from app.instance_store import InstanceStore, validate_instance_name


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


if __name__ == "__main__":
    unittest.main()

