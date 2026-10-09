"""Offline negative checks for the actual Cowork archive validator."""

from __future__ import annotations

import importlib.util
import json
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
CONFIG = json.loads((ROOT / ".azure" / "cowork-oauth.json").read_text(encoding="utf-8"))
SCHEMA = ROOT / ".azure" / "MicrosoftTeams.v1.29.schema.json"
MANIFEST = json.loads((ROOT / "cowork-plugin" / "appPackage" / "manifest.json").read_text(encoding="utf-8"))
PACKAGE = ROOT / "cowork-plugin" / "build" / f"copilot-credit-management-{MANIFEST['version']}.zip"


class PluginTests(unittest.TestCase):
    def validate(self, path: Path) -> dict[str, object]:
        return VALIDATOR.validate(path, SCHEMA, CONFIG["tenantId"], CONFIG["mcpPublicUrl"], CONFIG["referenceId"])

    def mutated(self, payloads: dict[str, bytes]) -> None:
        with tempfile.TemporaryDirectory(prefix="ccm-plugin-test-") as directory:
            path = Path(directory) / "test.zip"
            with zipfile.ZipFile(path, "w") as archive:
                for name, value in payloads.items():
                    archive.writestr(name, value)
            with self.assertRaises((ValueError, ValidationError)):
                self.validate(path)

    def files(self) -> dict[str, bytes]:
        with zipfile.ZipFile(PACKAGE) as archive:
            return {name: archive.read(name) for name in archive.namelist()}

    def test_actual_archive_passes(self) -> None:
        report = self.validate(PACKAGE)
        self.assertEqual(report["schema"], "1.29")
        self.assertFalse(report["runtimeCoworkVerified"])

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
