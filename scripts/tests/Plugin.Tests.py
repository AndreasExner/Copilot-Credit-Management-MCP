"""Offline negative checks for the actual Cowork archive validator."""

from __future__ import annotations

import importlib.util
import base64
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from jsonschema import ValidationError

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("plugin_validator", ROOT / "scripts" / "Validate-CoworkPlugin.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("The plugin validator could not be loaded.")
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)
CONFIG = {
    "tenantId": "11111111-1111-4111-8111-111111111111",
    "referenceId": base64.b64encode(b"11111111-1111-4111-8111-111111111111##33333333-3333-4333-8333-333333333333").decode(),
    "mcpPublicUrl": "https://mcp.example.test/mcp",
}
APP_ID = "22222222-2222-4222-8222-222222222222"
SCHEMA = ROOT / ".azure" / "MicrosoftTeams.v1.29.schema.json"
MANIFEST = json.loads((ROOT / "cowork-plugin" / "appPackage" / "manifest.json").read_text(encoding="utf-8"))


class PluginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not SCHEMA.is_file():
            raise RuntimeError("Cache the official schema with a template build before running offline tests.")
        cls.directory = tempfile.TemporaryDirectory(prefix="ccm-plugin-test-")
        cls.addClassCleanup(cls.directory.cleanup)
        cls.build_directory = Path(cls.directory.name)
        cls.configuration = cls.build_directory / "configuration.json"
        cls.configuration.write_text(json.dumps(CONFIG), encoding="utf-8")
        for arguments in (
            ["-TenantId", CONFIG["tenantId"], "-AppId", APP_ID, "-ConfigurationPath", str(cls.configuration)],
            ["-Template"],
        ):
            result = cls.build(arguments)
            if result.returncode != 0:
                raise RuntimeError(f"Offline fixture packaging failed:\n{result.stdout}\n{result.stderr}")
        cls.package = cls.build_directory / f"copilot-credit-management-{MANIFEST['version']}.zip"
        cls.template_package = cls.build_directory / f"copilot-credit-management-{MANIFEST['version']}-template.zip"

    @classmethod
    def build(cls, arguments: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["pwsh", "-NoProfile", "-File", str(ROOT / "scripts" / "New-CoworkPlugin.ps1"),
             "-OutputDirectory", str(cls.build_directory), *arguments],
            capture_output=True, text=True, check=False,
        )

    def validate(self, path: Path) -> dict[str, object]:
        return VALIDATOR.validate(path, SCHEMA, CONFIG["tenantId"], CONFIG["mcpPublicUrl"], CONFIG["referenceId"],
                                  app_id=APP_ID)

    def mutated(self, payloads: dict[str, bytes]) -> None:
        with tempfile.TemporaryDirectory(prefix="ccm-plugin-test-") as directory:
            path = Path(directory) / "test.zip"
            with zipfile.ZipFile(path, "w") as archive:
                for name, value in payloads.items():
                    archive.writestr(name, value)
            with self.assertRaises((ValueError, ValidationError)):
                self.validate(path)

    def files(self) -> dict[str, bytes]:
        with zipfile.ZipFile(self.package) as archive:
            return {name: archive.read(name) for name in archive.namelist()}

    def test_actual_archive_passes(self) -> None:
        report = self.validate(self.package)
        self.assertEqual(report["schema"], "1.29")
        self.assertFalse(report["runtimeCoworkVerified"])
        self.assertTrue(report["importReady"])

    def test_template_requires_configuration_before_import(self) -> None:
        report = VALIDATOR.validate(self.template_package, SCHEMA, "", "", "", template=True)
        self.assertTrue(report["template"])
        self.assertFalse(report["importReady"])
        self.assertFalse(report["oauthTenantVerified"])
        with self.assertRaises((ValueError, ValidationError)):
            self.validate(self.template_package)
        with zipfile.ZipFile(self.template_package) as archive:
            text = archive.read("manifest.json").decode()
            self.assertIn("${OAUTH_REFERENCE_ID}", text)
            self.assertNotIn(CONFIG["referenceId"], text)
            self.assertNotIn(CONFIG["tenantId"], text)
            self.assertNotIn(CONFIG["mcpPublicUrl"], text)

    def test_configured_manifest_is_not_a_template(self) -> None:
        with self.assertRaises(ValueError):
            VALIDATOR.validate(self.package, SCHEMA, "", "", "", template=True)

    def test_configured_build_keeps_source_template_unchanged(self) -> None:
        source = json.loads((ROOT / "cowork-plugin" / "appPackage" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(source, MANIFEST)
        self.assertEqual(source["id"], "${PLUGIN_APP_ID}")

    def test_downloaded_template_can_be_configured(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ccm-template-extract-") as directory:
            with zipfile.ZipFile(self.template_package) as archive:
                archive.extractall(directory)
            result = self.build(["-SourcePath", directory, "-TenantId", CONFIG["tenantId"], "-AppId", APP_ID,
                                 "-ConfigurationPath", str(self.configuration)])
            self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")
            self.assertTrue(self.validate(self.package)["importReady"])
            source = json.loads((Path(directory) / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(source["id"], "${PLUGIN_APP_ID}")

    def test_build_rejects_unapproved_or_missing_tenant(self) -> None:
        for arguments in (
            [],
            ["-AppId", APP_ID, "-ConfigurationPath", str(self.configuration)],
            ["-TenantId", "44444444-4444-4444-8444-444444444444", "-AppId", APP_ID,
             "-ConfigurationPath", str(self.configuration)],
            ["-TenantId", "00000000-0000-0000-0000-000000000000", "-AppId", APP_ID,
             "-ConfigurationPath", str(self.configuration)],
            ["-TenantId", CONFIG["tenantId"], "-AppId", "00000000-0000-0000-0000-000000000000",
             "-ConfigurationPath", str(self.configuration)],
            ["-Template", "-TenantId", CONFIG["tenantId"]],
            ["-Template", "-AppId", "00000000-0000-0000-0000-000000000000"],
        ):
            with self.subTest(arguments=arguments):
                result = self.build(arguments)
                self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_build_rejects_invalid_configuration(self) -> None:
        for overrides in (
            {"tenantId": "44444444-4444-4444-8444-444444444444"},
            {"referenceId": "not-base64"},
            {"referenceId": base64.b64encode(b"11111111-1111-4111-8111-111111111111##not-a-guid").decode()},
            {"mcpPublicUrl": "http://mcp.example.test/mcp"},
            {"mcpPublicUrl": "https://mcp.example.test/mcp?unexpected=true"},
            {"mcpPublicUrl": "https://user:pass@mcp.example.test/mcp"},
        ):
            with self.subTest(overrides=overrides):
                path = self.build_directory / "invalid.json"
                path.write_text(json.dumps(CONFIG | overrides), encoding="utf-8")
                result = self.build(["-TenantId", CONFIG["tenantId"], "-AppId", APP_ID,
                                     "-ConfigurationPath", str(path)])
                self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_other_app_id_rejected(self) -> None:
        files = self.files()
        manifest = json.loads(files["manifest.json"])
        manifest["id"] = "44444444-4444-4444-8444-444444444444"
        files["manifest.json"] = json.dumps(manifest).encode()
        self.mutated(files)

    def test_root_wrapper_rejected(self) -> None:
        self.mutated({f"wrapper/{name}": value for name, value in self.files().items()})

    def test_extra_state_or_secret_file_rejected(self) -> None:
        files = self.files()
        files[".env"] = b"unexpected"
        self.mutated(files)

    def test_lowercase_skill_filename_rejected(self) -> None:
        files = self.files()
        files["skills/copilot-credit-management/skill.md"] = files.pop("skills/copilot-credit-management/SKILL.md")
        self.mutated(files)

    def test_frontmatter_name_mismatch_rejected(self) -> None:
        files = self.files()
        name = "skills/copilot-credit-management/SKILL.md"
        files[name] = files[name].replace(b"name: copilot-credit-management", b"name: another-skill", 1)
        self.mutated(files)

    def test_anonymous_auth_rejected(self) -> None:
        files = self.files()
        manifest = json.loads(files["manifest.json"])
        manifest["agentConnectors"][0]["toolSource"]["remoteMcpServer"]["authorization"] = {"type": "None"}
        files["manifest.json"] = json.dumps(manifest).encode()
        self.mutated(files)

    def test_other_oauth_reference_rejected(self) -> None:
        files = self.files()
        manifest = json.loads(files["manifest.json"])
        manifest["agentConnectors"][0]["toolSource"]["remoteMcpServer"]["authorization"]["referenceId"] = "another-reference"
        files["manifest.json"] = json.dumps(manifest).encode()
        self.mutated(files)

    def test_other_server_rejected(self) -> None:
        files = self.files()
        manifest = json.loads(files["manifest.json"])
        manifest["agentConnectors"][0]["toolSource"]["remoteMcpServer"]["mcpServerUrl"] = "https://another.example.test/mcp"
        files["manifest.json"] = json.dumps(manifest).encode()
        self.mutated(files)

    def test_unknown_manifest_property_rejected_by_schema(self) -> None:
        files = self.files()
        manifest = json.loads(files["manifest.json"])
        manifest["packageName"] = "not-supported"
        files["manifest.json"] = json.dumps(manifest).encode()
        self.mutated(files)

    def test_fixed_account_rejected(self) -> None:
        files = self.files()
        files["skills/copilot-credit-management/SKILL.md"] += b"\nUse preset-user@example.test\n"
        self.mutated(files)

    def test_credential_assignment_rejected(self) -> None:
        files = self.files()
        files["skills/copilot-credit-management/SKILL.md"] += b"\nclient_secret: forbidden-test-value\n"
        self.mutated(files)

    def test_truncated_icon_rejected(self) -> None:
        files = self.files()
        files["outline.png"] = files["outline.png"][:16]
        self.mutated(files)

    def test_missing_user_balance_tool_rejected(self) -> None:
        files = self.files()
        name = "skills/copilot-credit-management/SKILL.md"
        files[name] = files[name].replace(b"list_user_service_balances", b"unsupported_user_tool")
        self.mutated(files)

    def test_missing_roster_tools_rejected(self) -> None:
        for tool in (b"list_policy_assigned_groups", b"list_group_users"):
            with self.subTest(tool=tool):
                files = self.files()
                name = "skills/copilot-credit-management/SKILL.md"
                files[name] = files[name].replace(tool, b"unsupported_roster_tool")
                self.mutated(files)

    def test_missing_profile_tool_rejected(self) -> None:
        files = self.files()
        name = "skills/copilot-credit-management/SKILL.md"
        files[name] = files[name].replace(b"get_user_basic_profile", b"unsupported_profile_tool")
        self.mutated(files)

    def test_packaged_profile_workflow_and_permissions(self) -> None:
        files = self.files()
        skill = files["skills/copilot-credit-management/SKILL.md"].decode()
        workflow = files["skills/copilot-credit-management/references/read-workflows.md"].decode()
        self.assertIn("User.ReadBasic.All", skill)
        self.assertIn("get_user_basic_profile", workflow)
        self.assertIn("once per distinct user", workflow)
        self.assertIn("Continue balance reads even if profile resolution fails", workflow)
        self.assertIn("nameResolutionStatus", workflow)
        manifest = json.loads(files["manifest.json"])
        self.assertEqual(manifest["version"], MANIFEST["version"])


if __name__ == "__main__":
    unittest.main()
