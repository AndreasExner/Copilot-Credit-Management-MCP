"""Validate the actual import archive against Microsoft's schema and project invariants."""

from __future__ import annotations

import argparse
import base64
import json
import re
import struct
import sys
import zipfile
from pathlib import Path, PurePosixPath
from collections.abc import Iterator
from urllib.parse import urlparse

from jsonschema import FormatChecker, ValidationError
from jsonschema.validators import extend, validator_for
import regex


def unicode_pattern(_validator: object, pattern: str, instance: object, _schema: object) -> Iterator[ValidationError]:
    if isinstance(instance, str) and regex.search(pattern, instance) is None:
        yield ValidationError("String does not match the schema pattern.")


def unicode_regex_format(instance: object) -> bool:
    if isinstance(instance, str):
        regex.compile(instance)
    return True


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate(package: Path, schema_path: Path, tenant: str, mcp_url: str, reference_id: str) -> dict[str, object]:
    expected_files = {
        "manifest.json",
        "color.png",
        "outline.png",
        "skills/copilot-credit-management/SKILL.md",
        "skills/copilot-credit-management/references/read-workflows.md",
    }
    with zipfile.ZipFile(package) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        require(len(names) == len(set(names)), "Duplicate archive entries are not allowed.")
        require(set(names) == expected_files, "Archive must contain exactly the allowlisted plugin files at the root.")
        require(sum(entry.file_size for entry in entries) <= 1024 * 1024, "Plugin exceeds the 1 MiB project package limit.")
        for name in names:
            path = PurePosixPath(name)
            require(not path.is_absolute() and ".." not in path.parts and "\\" not in name, "Unsafe archive path.")
        payloads = {name: archive.read(name) for name in names}

    for name, content in payloads.items():
        if name.endswith((".json", ".md")):
            require(not content.startswith(b"\xef\xbb\xbf"), "Text files must be UTF-8 without a BOM.")
            text = content.decode("utf-8")
            require(not re.search(r"(?i)(?:client[_ -]?secret|password)\s*['\"]?\s*[:=]\s*['\"]?\S+|bearer\s+[A-Za-z0-9._~-]{16,}", text),
                    "Credential-like content is not allowed in the archive.")
            require(not re.search(r"[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text),
                    "A fixed user account must not appear in the archive.")
            require(not re.search(r"\$\{|\bYOUR[-_ ]|<OAuth", text), "Unresolved placeholder in archive.")

    manifest = json.loads(payloads["manifest.json"])
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    checker = FormatChecker()
    checker.checks("regex", raises=regex.error)(unicode_regex_format)
    validator_class = extend(validator_for(schema), {"pattern": unicode_pattern})
    validator_class.check_schema(schema, format_checker=checker)
    validator_class(schema, format_checker=checker).validate(manifest)
    require(manifest["manifestVersion"] == "1.29", "Use manifest version 1.29.")
    require(manifest["$schema"] == "https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json",
            "Unexpected manifest schema URL.")
    require(re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"]) is not None, "Invalid package version.")
    require(manifest["agentSkills"] == [{"folder": "./skills/copilot-credit-management"}],
            "Skill registration does not match the packaged folder.")
    require(len(manifest["agentConnectors"]) == 1, "Exactly one MCP connector is required.")
    remote = manifest["agentConnectors"][0]["toolSource"]["remoteMcpServer"]
    require(remote["mcpServerUrl"] == mcp_url, "The connector must target the approved MCP URL.")
    require(remote["authorization"] == {"type": "OAuthPluginVault", "referenceId": reference_id},
            "The connector must reference the supplied OAuth configuration, never anonymous auth.")
    decoded = base64.b64decode(reference_id, validate=True).decode("utf-8")
    require(re.fullmatch(re.escape(tenant) + r"##[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", decoded) is not None,
            "OAuth reference belongs to an unexpected tenant or is malformed.")
    origin = urlparse(mcp_url)
    base = f"{origin.scheme}://{origin.netloc}"
    for field, route in (("websiteUrl", "about"), ("privacyUrl", "privacy"), ("termsOfUseUrl", "terms")):
        require(manifest["developer"][field] == f"{base}/{route}", "Publisher notice URL does not match this project.")

    skill = payloads["skills/copilot-credit-management/SKILL.md"].decode("utf-8")
    frontmatter = re.match(r"\A---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n", skill)
    require(frontmatter is not None, "Skill requires simple valid name/description frontmatter.")
    if frontmatter is None:
        raise ValueError("Skill frontmatter missing.")
    require(frontmatter[1] == "copilot-credit-management", "Skill name must match its folder exactly.")
    require(1 <= len(frontmatter[1]) <= 64 and 1 <= len(frontmatter[2]) <= 1024, "Skill frontmatter exceeds platform limits.")
    require(len(payloads["skills/copilot-credit-management/SKILL.md"]) <= 32768, "Skill exceeds the project 32 KiB limit.")
    require("references/read-workflows.md" in skill, "The skill must reference its packaged companion file.")
    tools = ["get_tenant_credit_balance", "list_spending_policies"]
    if manifest["version"] != "0.1.0":
        tools.append("list_user_service_balances")
    if tuple(map(int, manifest["version"].split("."))) >= (0, 3, 0):
        tools.extend(["list_policy_assigned_groups", "list_group_users"])
    for tool in tools:
        require(tool in skill, "The skill must describe every read tool in this release.")

    for name, size in (("color.png", 192), ("outline.png", 32)):
        png = payloads[name]
        require(len(png) >= 33 and png[:8] == b"\x89PNG\r\n\x1a\n" and png[12:16] == b"IHDR", "Invalid PNG icon.")
        require(struct.unpack(">II", png[16:24]) == (size, size), "Incorrect icon dimensions.")
        if name == "outline.png":
            require(png[25] == 6, "Outline icon must be RGBA with transparency.")

    return {
        "schema": manifest["manifestVersion"],
        "appId": manifest["id"],
        "version": manifest["version"],
        "files": sorted(names),
        "oauthTenantVerified": True,
        "skillName": frontmatter[1],
        "runtimeCoworkVerified": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--schema", required=True, type=Path)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--mcp-url", required=True)
    parser.add_argument("--oauth-reference", required=True)
    args = parser.parse_args()
    try:
        report = validate(args.package, args.schema, args.tenant, args.mcp_url, args.oauth_reference)
    except ValidationError as error:
        print(f"Plugin schema validation failed at {'/'.join(map(str, error.absolute_path))}: {error.validator}", file=sys.stderr)
        return 1
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        print(f"Plugin validation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
