# Cowork import plugin

> [!CAUTION]
> **EXPERIMENTAL REPOSITORY - NOT FOR PRODUCTION USE.**
> This repository and its MCP server, Cowork plugin and Skill are experimental
> proof-of-concept components intended only for controlled internal evaluation.
> They are not production-ready, a Microsoft-supported product or a commitment
> to stable behavior, security certification, availability or ongoing support.
> Successful tests, installation or individual API calls do **not** establish
> production readiness. Do not rely on their output as the sole basis for
> billing, financial, compliance or administrative decisions.

> [!WARNING]
> **PREVIEW API / MICROSOFT GRAPH BETA - BREAKING CHANGES MAY OCCUR.**
> This project uses the prerelease Copilot cost management API under Microsoft
> Graph `/beta`. These APIs are for evaluation, not supported for production
> applications. Endpoints, permissions, roles, response schemas and availability
> may change or be withdrawn without notice. Early-access eligibility,
> administrator consent and the signed-in user's authorization are separate
> prerequisites; importing this plugin does not enable API access.
> See [Microsoft Graph's beta support policy](https://learn.microsoft.com/en-us/graph/versioning-and-support).

**Evaluate only with authorized accounts and data in an approved test
environment. Independently verify results, completeness and current API
behavior. Review security, privacy and organizational requirements before
broader use; this repository does not provide those approvals.**

This is a Microsoft 365 Unified App Manifest 1.29 plugin, not a standalone
Skills importer archive. It contains the integrated `copilot-credit-management`
skill and one OAuth-protected remote MCP connector.

## Verified delivery state

[Prepared ZIP: copilot-credit-management-0.4.0.zip](build/copilot-credit-management-0.4.0.zip)
is built and validated against the official 1.29 JSON Schema and the exact
archive constraints. All 16 positive/negative package tests pass. This is not a
claim that Microsoft's App Validation Library or tenant publication has been
completed. The user reports a successful Cowork read on 2026-10-08; this is
user-reported acceptance, not an independently observed response.

**0.4.0 is prepared locally, not deployed.** The existing backend remains 0.3.0
with five read tools. The new profile tool requires a separately approved
backend update and delegated basic-profile consent; importing this ZIP alone
cannot make it available. Do not treat package validation as live acceptance.

The publisher's [project](https://ca-ccm-eval-tnx2hg.calmhill-679a9318.canadaeast.azurecontainerapps.io/about),
[privacy](https://ca-ccm-eval-tnx2hg.calmhill-679a9318.canadaeast.azurecontainerapps.io/privacy)
and [usage](https://ca-ccm-eval-tnx2hg.calmhill-679a9318.canadaeast.azurecontainerapps.io/terms)
notices are deployed and return HTTP 200. Health/OAuth metadata remain available,
and anonymous or invalid-token MCP requests still return 401.

The original read prerequisite is now satisfied by the user's report.
The user also reports the updated user-service plugin working on 2026-10-09;
the exact Graph response and additional grant were not independently inspected.
Persistence after reloading and the new policy roster reads remain unconfirmed.
The roster requires additional administrator review and an actual Cowork test.
The plugin never prescribes a user account.

Observed version discrepancy to revisit: Cowork displayed 2.0.0 for the prior
ZIP whose manifest declares 0.2.0. The user also reports 0.3.0 shown as 3.0.0.
The cause is unknown; no 0.4.0 display has been verified. The app ID and OAuth
registration stay unchanged; use the actual ZIP manifest version, not a guess
based on the display pattern.

## Build and validation

Requires Windows, PowerShell 7 and Python. The official schema includes Unicode
regular expressions such as `\p{L}`; validation uses `jsonschema` plus `regex`
rather than weakening or rewriting the schema. The isolated tooling environment
does not change global packages. No secret, token or runtime account is needed.

```powershell
python -m venv .\.azure\plugin-validator-env --system-site-packages
.\.azure\plugin-validator-env\Scripts\python.exe -m pip install -r .\scripts\requirements-plugin-validation.txt
pwsh -NoProfile -File .\scripts\New-CoworkPlugin.ps1
.\.azure\plugin-validator-env\Scripts\python.exe .\scripts\tests\Plugin.Tests.py
```

Run from the workspace root. The pipeline creates original project icons,
packages only the five allowlisted files, validates the actual ZIP against
Microsoft's official 1.29 schema and project constraints, and publishes
`build/copilot-credit-management-0.4.0.zip` only after successful validation.
The downloaded schema is cached outside the archive under `.azure`.

Local `.azure` state and generated ZIPs are intentionally not committed.
Before building from a fresh clone, create `.azure/cowork-oauth.json` containing
the real `referenceId` and `mcpPublicUrl` from your authorized OAuth setup;
the validator uses these independently supplied values to check the manifest.
The current build script is restricted to the evaluation tenant, and the
checked-in manifest references that deployment. Adapting it to another tenant
requires reviewing the tenant guard, manifest, endpoint and OAuth registration
together. Never add secrets or access tokens to that configuration or Git.

This is an intentionally small custom packaging pipeline, a supported path in
the official Cowork documentation. It does not require provisioning/sharing
an app before a manual import and does not overwrite global CLI installations.
No CLI provisioning or authentication is needed for this packaging pipeline.

## Import and acceptance

1. In Cowork, open **Sources & Skills > Plugins** and use its plugin upload/import
   action. Import the ZIP, not the skill folder or a Skills-only archive.
   Version 0.4.0 retains the original app ID and OAuth registration; use the
   existing plugin's update/import workflow rather than a separate skill import.
   First deploy the matching backend through the approved Azure workflow; the
   currently deployed 0.3.0 server does not expose the profile tool.
2. If uploading for tenant discovery, an administrator uses the organization's
   approved Microsoft 365 app-management upload workflow. This build does not
   automatically publish or share anything with the tenant.
3. Enable the plugin and connect **Copilot Credit Management** using your own
   authorized account. The manifest references the user-provided Enterprise
   Token Store configuration; it contains no client secret or login hint.
4. Start a new Cowork task and request:
   - `Zeige mein Copilot-Credit-Guthaben.`
   - `Liste alle Copilot-Ausgabenrichtlinien.`
   - `Zeige meine Copilot-Serviceguthaben und meinen Cowork-Verbrauch.`
   - `Erstelle eine Tabelle aller User in Cowork Large, inkl. aktuellem Stand.`
5. Verify dynamic tool discovery and an actual successful delegated Graph read.
   A successful ZIP/schema check or sign-in dialog alone is not that proof.
6. Reload Cowork and verify that the plugin, integrated skill and connector
   remain available in a new task. Do not infer persistence from OneDrive files.

This release contains `get_tenant_credit_balance`, `list_spending_policies`,
`list_user_service_balances`, `list_policy_assigned_groups`, `list_group_users`
and `get_user_basic_profile`. The profile read is part of prepared 0.4.0;
the deployed 0.3.0 server has the preceding five tools only.
The user-service operation is evidenced by the newer
[user-supplied public example](https://gist.github.com/joerodgers/3774e34e1075128a63a5a372e47e324f);
the user reports the updated plugin working. The new assigned-groups and
membership workflow still needs its own authorized read test.
The remaining seven cost-management reads and 11 mutations need current availability,
permissions/roles and request contracts. A successful read does not prove
availability of unrelated endpoints.
An error must remain an error; missing quantities and partial policy pages must
not be presented as zero or a complete inventory.

## Authentication

### Missing user names

The group query already selects names but only requests membership permission;
Graph may legitimately return GUIDs and null profile fields. The separate
`get_user_basic_profile` reads exactly id, displayName and userPrincipalName
by user GUID with delegated `User.ReadBasic.All`. The
[profile consent/release setup](../README.md#prepared-release-040-missing-user-names)
preserves all earlier scopes/proof and prepares a separate review request.
Basic delegated profile consent is governed by tenant policies; no grant,
new credential or sign-in reset is automatic.

The Skill resolves missing names only after deduplication, once per user.
It preserves existing fields/source provenance, flags conflicting values and
retains GUIDs with explicit complete/partial/unavailable profile status.
Inaccessible/deleted profiles or missing consent do not prevent separate
balance reads. A UPN is not necessarily the user's email address.
Actual name-resolution acceptance remains pending the backend rollout,
authorized consent and a real Cowork table test.

### User service balances

The additional delegated `CopilotCostManagement-UserData.Read.All` scope
requires administrator review on the existing MCP API application. Follow the
[consent setup](../README.md#additional-userdata-consent-and-acceptance).
The Cowork OAuth client/reference and its `Mcp.Read offline_access` configuration
do not change. The user-service tool alone does not enumerate groups or look
up email addresses and does not need directory/group permissions.

`list_user_service_balances` uses the caller's validated object GUID when
`userId` is omitted. A supplied target GUID changes only the read target, never
the delegated caller. Continue pages using the same user and unchanged
`nextLink`. Errors, omitted quantities and absent service records must not be
presented as zero or a successful read.

### Policy user tables

Follow the [roster consent setup](../README.md#policy-roster-consent-and-acceptance)
for delegated `CopilotCostManagement-Assignment.Read.All` and
`GroupMember.ReadBasic.All` on the MCP API, in addition to the existing three
read scopes. Consent is not automatically granted; the separate pending roster
state preserves earlier proof. No write or application permissions are needed.

The integrated Skill resolves the actual named policy, pages assigned groups,
pages each group's user-only membership, deduplicates users by GUID and then
reads every user's service balances sequentially. Names may be unavailable;
keep the returned GUIDs. Nested members are included by default; direct mode
is also available. Membership has eventual consistency and does not prove
effective policy precedence/enforcement or policy-specific consumption.
Incomplete pages, inaccessible/hidden groups and failed balances remain explicit
in the report; they are not empty/zero success results.

### Write tools

This plugin remains read-only. MCP can support write tools, but no mutation
tools or authorization/confirmation pipeline have been enabled here.
See the [eleven-operation feasibility assessment](../README.md#write-operation-feasibility):
candidate write-scope names do not establish operation schemas, roles or
tenant availability. Enabling writes requires a separate approved plan and
verified contracts, not merely a broader consent URL or prompt confirmation.

The real auth reference is stored in [the manifest](appPackage/manifest.json).
It is an identifier, not a credential. Its encoded tenant was checked against
the approved deployment tenant. The user reports a successful Cowork read;
no independent inspection of token-store settings or verification of both
read scopes is claimed.

The allowlisted build also compares the archive's connector URL/reference with
the independently saved user-provided configuration in ignored
`.azure/cowork-oauth.json`; it does not validate those fields against themselves.

The portal registration should use the existing Cowork Entra client,
`Mcp.Read offline_access`, PKCE, the real MCP base URL, the tenant-specific Entra
endpoints and **Any Teams app**. The server remains single-tenant and rejects
other OAuth clients. Backend managed-identity federation is independent from
the connector's OAuth credentials.

Publisher URLs are project-operated factual internal-evaluation notices, not
an organization's legal policy or Microsoft endorsement.

## Official references

- [Cowork plugin development](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development)
- [OAuth configuration](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth)
- [Microsoft 365 manifest 1.29 schema](https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json)

## Additional explanatory example

- [Microsoft Graph API calls to list Cost Mgmt. spending policies and user level consumption data.](https://gist.github.com/joerodgers/3774e34e1075128a63a5a372e47e324f)

This public PowerShell example illustrates spending-policy reads and per-user
service balance/consumption reads, including delegated permission setup.
It is supplementary example code, not an official API contract, a production
support statement or a guarantee that every endpoint is available in your
tenant. Its optional group enumeration and write-permission examples are not
required by this read-only plugin and must not be granted merely to follow it.
