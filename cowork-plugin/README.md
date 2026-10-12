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

[Download 0.5.1 template ZIP and SHA-256 checksum](https://github.com/AndreasExner/Copilot-Credit-Management-MCP/releases/tag/v0.5.1).
Historical 0.1.0-0.4.0 templates remain in the
[previous release](https://github.com/AndreasExner/Copilot-Credit-Management-MCP/releases/tag/v0.4.0).
**These public ZIPs are tenant-neutral templates, not import-ready packages.**
Check each downloaded ZIP with `Get-FileHash -Algorithm SHA256` against the
matching filename in the release's `SHA256SUMS.txt` before extracting it.
They contain no configured tenant, app ID, OAuth reference or MCP endpoint.
The manifest retains explicit markers that must be configured locally.
Template validation checks their exact locations, the archive constraints and
the official 1.29 schema after synthetic substitution. Configured local ZIPs
are validated separately against their independently supplied configuration.
Neither check establishes tenant publication or runtime acceptance.

| Template version | Read tools | Status |
|---|---|---|
| 0.1.0 | Tenant balance and policies | Historical template |
| 0.2.0 | Adds user service balances | Historical template |
| 0.3.0 | Adds assigned groups and group users | Historical five-tool backend |
| 0.4.0 | Adds targeted basic user profiles | Local profile source; was not deployed as a separate backend |
| 0.5.0 | Adds resumable server-side policy user tables | Deployed; user reports successful testing and approval 2026-10-12 |
| 0.5.1 | Whole-credit display and bounded short-wait continuation; same seven tools | Deployed/schema-validated; 183 backend and 26 package tests pass; Cowork output acceptance pending |

The historical 0.5.0 rollout updated the evaluation backend from 0.3.0. Revision
health, unchanged resource controls and seven registered tools were verified.
In-container SDK registration verification made no Graph calls and does not
prove signed-in Cowork acceptance or successful live name resolution.
Separately, the user reported successful testing of 0.5.0 and explicitly
approved the release on 2026-10-12. This user-reported acceptance does not
independently verify individual Graph grants or remove the experimental and
Preview API warnings.
The profile tool and aggregate tool must be discovered from the server, not
inferred from the installed plugin's version. Consent remains a separate manual
review. Do not treat package validation as live name-resolution acceptance.

Backend 0.5.1 is now deployed with unchanged resource controls. Live health,
notice version, OAuth metadata, 401 rejection and all seven SDK registrations
were verified; the aggregate description explicitly advertises bounded
server-side continuation backoff. Synthetic registration made no Graph calls.
Both local packages pass schema/archive validation. All 183 backend tests,
26 package tests, typecheck/build and offline setup tests pass. Timeout/429/503
after user 35 recover all 53 distinct users in offline profile/balance cases.
Actual 0.5.1 Cowork whole-credit rendering and primary-table acceptance remains
pending; package/instruction checks cannot prove those UI results.

Local packaging derives the publisher's `/about`, `/privacy` and `/terms`
notice URLs and allowed domain from your approved MCP origin. Verify those
pages, health, OAuth metadata and rejection of anonymous/invalid-token MCP
requests on your own deployment. No evaluation endpoint is published here.

The original read prerequisite is now satisfied by the user's report.
The user also reports the updated user-service plugin working on 2026-10-09;
the exact Graph response and additional grant were not independently inspected.
Persistence after reloading and the new policy roster reads remain unconfirmed.
The roster requires additional administrator review and an actual Cowork test.
The plugin never prescribes a user account.

Observed version discrepancy to revisit: Cowork displayed 2.0.0 for the prior
ZIP whose manifest declares 0.2.0. The user also reports 0.3.0 shown as 3.0.0
and 0.4.0 shown as 4.0.0 (2026-10-12). The cause is unknown; no 0.5.0 display
has been verified. The app ID and OAuth
registration stay unchanged; use the actual ZIP manifest version, not a guess
based on the display pattern.

## Build and validation

Requires Windows, PowerShell 7 and Python. The official schema includes Unicode
regular expressions such as `\p{L}`; validation uses `jsonschema` plus `regex`
rather than weakening or rewriting the schema. The isolated tooling environment
does not change global packages. No secret, token or runtime account is needed for packaging.

```powershell
python -m venv .\.azure\plugin-validator-env --system-site-packages
.\.azure\plugin-validator-env\Scripts\python.exe -m pip install -r .\scripts\requirements-plugin-validation.txt
pwsh -NoProfile -File .\scripts\New-CoworkPlugin.ps1 -Template
.\.azure\plugin-validator-env\Scripts\python.exe .\scripts\tests\Plugin.Tests.py
```

Run from the workspace root. The pipeline reuses the checked-in project icons,
packages only the five allowlisted files and publishes
`build/copilot-credit-management-0.5.1-template.zip` after template validation.
The downloaded official schema is cached outside the archive under `.azure`.
The tests use synthetic configuration in temporary directories, never real
tenant state or cloud calls, and do not overwrite your configured ZIPs.

### Configure an import-ready ZIP locally

Clone the matching source repository for the packaging scripts. For an older
template, extract its ZIP to a separate directory and pass that directory with
`-SourcePath`; this retains that template's version and Skill rather than
silently upgrading to the current source.

Create ignored `.azure/cowork-oauth.json` using your approved real setup values:

```powershell
New-Item -ItemType Directory -Path .\.azure -Force | Out-Null
@{
  tenantId = $tenantId
  referenceId = $referenceId
  mcpPublicUrl = $mcpPublicUrl
} | ConvertTo-Json | Set-Content -LiteralPath .\.azure\cowork-oauth.json -Encoding utf8

pwsh -NoProfile -File .\scripts\New-CoworkPlugin.ps1 `
  -TenantId $tenantId -AppId $pluginAppId
```

The variables must contain your actual approved tenant, OAuth token-store
reference, HTTPS `/mcp` endpoint and stable plugin app GUID. For updates, retain
the existing plugin app ID; use a new, locally retained app ID only for a new
installation. Do not use the MCP API or OAuth client ID as the plugin app ID.
You can select another ignored config file with `-ConfigurationPath`.

The explicit tenant must match both the saved tenant and the tenant encoded
in the OAuth reference. Malformed references, missing approval values,
credential-bearing URLs and non-HTTPS/non-`/mcp` endpoints are rejected.
The build renders the manifest only inside the output archive; it never writes
deployment identifiers into the tracked source template. The configured ZIP is
`build/copilot-credit-management-0.5.1.zip` (or the selected source version).
Only that validated configured ZIP is suitable for import.

For example, after extracting the 0.5.1 template into a local directory:

```powershell
pwsh -NoProfile -File .\scripts\New-CoworkPlugin.ps1 `
  -SourcePath $extractedTemplateDirectory -TenantId $tenantId -AppId $pluginAppId
```

`.azure` state and generated ZIPs stay out of Git. Publish only the unconfigured
`-template.zip` files as release attachments, never configured ZIPs, secrets or
tokens. Base64 OAuth references are identifiers, not encrypted secrets; they
still disclose the configured tenant and therefore remain local.

This is an intentionally small custom packaging pipeline, a supported path in
the official Cowork documentation. It does not require provisioning/sharing
an app before a manual import and does not overwrite global CLI installations.
No CLI provisioning or authentication is needed for this packaging pipeline.

## Import and acceptance

1. In Cowork, open **Sources & Skills > Plugins** and use its plugin upload/import
   action. Import the locally configured ZIP, **not the public template ZIP**,
   the skill folder or a Skills-only archive.
   Preserve your original app ID and OAuth registration when updating; use the
   existing plugin's update/import workflow rather than a separate skill import.
   First deploy the matching backend through the approved Azure workflow; the
   a five-tool 0.3.0 server does not expose the profile or aggregate tools,
   regardless of whether Cowork displays the plugin as 4.0.0.
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
`get_user_basic_profile` and `list_policy_user_balances`. Discover seven tools
after the matching backend rollout (current 0.5.1); stale five-tool discovery indicates
an older backend or cached connection, not proof of missing Graph consent.
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
[profile consent/release setup](../README.md#basic-profiles-missing-user-names)
preserves all earlier scopes/proof and prepares a separate review request.
Basic delegated profile consent is governed by tenant policies; no grant,
new credential or sign-in reset is automatic.

The Skill resolves missing names only after deduplication, once per user.
It preserves existing fields/source provenance, flags conflicting values and
retains GUIDs with explicit complete/partial/unavailable profile status.
Inaccessible/deleted profiles or missing consent do not prevent separate
balance reads. A UPN is not necessarily the user's email address.
Actual name-resolution acceptance requires the matching backend, authorized
consent and a real Cowork table test.

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

The integrated Skill resolves the actual named policy and prefers the bounded
`list_policy_user_balances` workflow. The server pages assignments/members,
deduplicates GUIDs, resolves missing names and reads service balances. Follow
all opaque continuationToken values sequentially, including empty discovery
pages. Report paused/partial progress and per-row errors; do not start parallel
per-user calls or bypass the connector from scripts. Names may be unavailable;
keep the returned GUIDs. Nested members are included by default; direct mode
is also available. Membership has eventual consistency and does not prove
effective policy precedence/enforcement or policy-specific consumption.
Incomplete pages, inaccessible/hidden groups and failed balances remain explicit
in the report; they are not empty/zero success results.

In 0.5.1, displayed credit balances, consumption and limits use commercial
rounding to whole credits (halves away from zero), without modifying raw API
precision. Missing/null/error values remain unavailable, not zero.
The primary table has exactly one row per distinct user GUID; additional
records, periods and units are explained separately. Compare collected users
with the final discovered/processed counts before claiming completeness.

Automatic paused continuation requires the discovered tool description to
advertise server-side continuation backoff. The backend honors waits up to
ten seconds within its 15-second budget, without internal Graph retries.
The Skill stops after three consecutive pauses without observable progress
or reports a longer wait without shortening it. Normal continuation uses the
newest token; a lost reply is recovered with the exact previously sent token.
The one-second base pacing remains unchanged. Older/unknown backends and
individual-tool fallback still require deliberate continuation after waiting.

Acceptance prompt: "Erstelle eine Tabelle mit den aktuellen Copilot Credits
der Policy Small". For the reported roster, verify 53 distinct primary rows
and only whole-credit cells, including the first 35 after a pause. This is
an actual Cowork check, not established by package or offline backend tests.

### Write tools

This plugin remains read-only. MCP can support write tools, but no mutation
tools or authorization/confirmation pipeline have been enabled here.
See the [eleven-operation feasibility assessment](../README.md#write-operation-feasibility):
candidate write-scope names do not establish operation schemas, roles or
tenant availability. Enabling writes requires a separate approved plan and
verified contracts, not merely a broader consent URL or prompt confirmation.

The source [manifest](appPackage/manifest.json) stores only configuration
markers. The real auth reference is rendered into the local configured ZIP;
its encoded tenant is checked against the explicitly approved tenant.
The user reports a successful Cowork read;
no independent inspection of token-store settings or verification of both
read scopes is claimed.

The allowlisted build also compares the archive's connector URL/reference with
the independently saved user-provided configuration in ignored
`.azure/cowork-oauth.json`; it does not validate those fields against themselves.
It also checks the archive app ID against the explicitly supplied stable ID.
These checks establish local configuration consistency, not a live token-store
grant or endpoint ownership.

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
