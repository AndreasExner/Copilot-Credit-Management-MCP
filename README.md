# Copilot Credit Management remote MCP

> [!CAUTION]
> **EXPERIMENTAL REPOSITORY - NOT FOR PRODUCTION USE.**
> This server, plugin and Skill are proof-of-concept components for controlled
> internal evaluation, not a Microsoft-supported product or a production-ready
> service. Passing tests or successful API calls do not establish production
> readiness. Independently verify results before financial or administrative use.

> [!WARNING]
> **PREVIEW API / MICROSOFT GRAPH BETA.**
> The underlying Copilot cost management API is prerelease and uses `/beta`.
> Endpoints, permissions, schemas and availability may change or be withdrawn.
> These APIs are not supported for production applications. See
> [Microsoft Graph's beta support policy](https://learn.microsoft.com/en-us/graph/versioning-and-support).

Azure-hosted, single-tenant Streamable HTTP MCP server for the delegated
Microsoft Graph Copilot cost management API. No runtime user account is fixed
in the server or deployment package.

## Current delivery stage

This repository is a tenant-neutral source template, not a shared hosted
service. Configure your own authorized single-tenant deployment. Actual tenant,
subscription, application and resource identifiers belong only in ignored local
state; the source manifest contains explicit configuration markers.

Version 0.3.0 implements five read-only MCP tools:

- `get_tenant_credit_balance`
- `list_spending_policies`, including validated, unchanged continuation URLs
- `list_user_service_balances`, with an optional target Entra user GUID;
  omitted means the validated signed-in caller's own service balances.
  Requires delegated `CopilotCostManagement-UserData.Read.All` consent.
- `list_policy_assigned_groups`, using the returned opaque policy ID and the
  selected-groups policy route. Requires delegated
  `CopilotCostManagement-Assignment.Read.All`.
- `list_group_users`, with a returned group GUID and explicit direct/transitive
  mode (nested users included by default). Requires delegated
  `GroupMember.ReadBasic.All`; uses eventual consistency and user-only results.

### Prepared release 0.4.0: missing user names

Current source and the
[0.4.0 template ZIP](https://github.com/AndreasExner/Copilot-Credit-Management-MCP/releases/download/v0.4.0/copilot-credit-management-0.4.0-template.zip)
add a sixth read-only tool, `get_user_basic_profile`. **The profile release has
not been rolled out to the existing evaluation backend, which remains 0.3.0.**
Public ZIPs are deliberately unconfigured templates, not import-ready plugins.
Configure and validate a local ZIP before importing it, and deploy a matching
backend through a separately authorized Azure workflow.

The membership read selects names but only requests membership permission.
Graph can therefore return member GUIDs with null profile properties. The new
tool uses a required user GUID and delegated `User.ReadBasic.All` to read only
`id`, `displayName` and `userPrincipalName` from Graph v1.0. It checks the
returned ID, preserves missing/null/empty fields and reports name resolution
as complete, partial or unavailable. It does not expand the existing group
or balance scopes or resolve an email address into an object ID.

The Skill deduplicates users before resolving missing names/UPNs once per user.
It retains already returned fields and source provenance, discloses conflicting
values and continues balance reads after a profile error. GUIDs and separate
profile/balance statuses remain in the table. A UPN is not necessarily email.
Local tests cover GUID-only membership followed by a matching named profile,
caller isolation, unavailable profiles and subsequent balance reads; these
are not proof of real Cowork name resolution.

After an authorized matching-backend deployment, prepare consent review with:

```powershell
pwsh -NoProfile -File .\scripts\New-GraphConsentUrl.ps1 `
  -McpPublicUrl $mcpPublicUrl `
  -IncludePolicyRoster -IncludeUserProfiles
```

This requests the current five read scopes plus `User.ReadBasic.All` on the
MCP API, not the Cowork OAuth client, and preserves earlier request/proof files
in a separate `consent-profiles-state.json`. The default two-scope and optional
UserData/roster requests are unchanged. The delegated basic-profile permission
does not inherently require admin consent, but tenant policies may require it.
Review organizational requirements; no grant or sign-in reset is automatic.
See the official [permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference#userreadbasicall)
and [limited member information](https://learn.microsoft.com/en-us/graph/api/group-list-transitivemembers?view=graph-rest-1.0).

### Policy table behavior

The Skill combines these reads into a deduplicated policy user table with
per-user Cowork service balances. It preserves paging, unavailable values and
individual errors. A directory roster is not proof of effective policy
precedence, enforcement or policy-specific consumption. Recent directory
changes may lag. The new roster workflow requires administrator consent and
actual tenant/Cowork acceptance; a successful local test does not prove either.

The user reports a successful **Cowork -> MCP -> OBO -> Graph** read on
2026-10-08. This clears the original connectivity prerequisite; the assistant
did not independently observe the response or verify both tools.

The privately provided API guide, dated 2026-09-18 and excluded from this repository,
marks the other 20 operations as planned, not currently confirmed available.
These originally comprised nine further reads and 11 mutations. It documents permissions
and roles only for the two available reads and does not specify the planned
write payloads. Current authorized availability, permissions/roles and request
contracts are required before enabling those tools. Do not infer them from the
successful existing read or from the names of the planned routes.

The user's newer [public example](https://gist.github.com/joerodgers/3774e34e1075128a63a5a372e47e324f),
updated 2026-10-08, demonstrates the user-service-balance route with a user GUID
and the additional delegated UserData read scope. This narrowly evidenced
operation is now implemented and deployed; the user also reports the updated
plugin working on 2026-10-09. The exact Graph result and additional grant were
not independently inspected. This does not prove a separate total-user
balance endpoint, all other planned operations or any write contract.
With the separate assigned-groups read now implemented, seven additional
cost-management reads and 11 mutations remain deferred. Directory membership
is supporting Graph functionality, not another cost-management operation.
There is no write endpoint,
anonymous MCP mode or app-only Graph fallback.

The [0.3.0 template ZIP](https://github.com/AndreasExner/Copilot-Credit-Management-MCP/releases/download/v0.4.0/copilot-credit-management-0.3.0-template.zip)
includes the corresponding integrated Skill without deployment identifiers.
See the [release downloads](https://github.com/AndreasExner/Copilot-Credit-Management-MCP/releases/tag/v0.4.0)
for all four historical/current template versions and SHA-256 checksums, and
the [local configuration and import instructions](cowork-plugin/README.md).
Template checks verify the exact placeholder locations and schema after
synthetic substitution; only the separately configured local ZIP is validated
as import-ready. Neither check establishes live Cowork acceptance.
The successful Cowork read is user-reported acceptance, not an independent
runtime certification by the assistant. Reload persistence remains unconfirmed.

Local protocol tests are not evidence of real Cowork authentication or Graph
access. The protected-resource metadata and the consent callback also do not
prove that consent has been granted.

### Local deployment state

Keep deployment evidence, real resource names, immutable image digests, consent
proof and OAuth registration identifiers under ignored `.azure` state. They
are not reusable configuration for another tenant. A successful evaluation
deployment does not certify a new tenant, consent grant or plugin installation.
The repository provides no public MCP service or authentication credentials.

### Additional UserData consent and acceptance

User service balances use `CopilotCostManagement-UserData.Read.All`; the two
original scopes do not replace it. Generate the administrator-review URL:

```powershell
pwsh -NoProfile -File .\scripts\New-GraphConsentUrl.ps1 `
  -McpPublicUrl $mcpPublicUrl `
  -IncludeUserServiceBalances
```

This requests the existing two reads plus UserData for the dedicated MCP API,
not the Cowork client. It prints a URL/state only and preserves original grant
proof in a separate pending-request file. Do not grant consent automatically.
No write, group-membership, assignment or Graph application permission is needed
by the user-service-balance tool alone. Existing Cowork token-store `Mcp.Read offline_access`
configuration stays unchanged.

After administrator review, update the plugin, reconnect if needed, start a new
Cowork task and request your own per-service balances or Cowork consumption.
Omit `userId` for yourself; another user requires a supplied Entra object GUID,
not an email/name lookup. User roles and tenant endpoint availability still
apply. The user reports the updated plugin working; no independently observed
UserData payload or additional grant is claimed.

The operator's consent metadata recheck on 2026-10-09 required interactive
Graph authentication after a CAE policy change; existing ARM access was usable.
No login reset or unrelated-account fallback was attempted.

### Policy roster consent and acceptance

The complete policy -> assigned groups -> group users -> service balances
workflow adds two delegated reads to the MCP API: 
`CopilotCostManagement-Assignment.Read.All` and `GroupMember.ReadBasic.All`.
Generate a review URL for the five read scopes:

```powershell
pwsh -NoProfile -File .\scripts\New-GraphConsentUrl.ps1 `
  -McpPublicUrl $mcpPublicUrl `
  -IncludePolicyRoster
```

The script does not grant consent or modify registrations. It preserves
original and UserData state in a separate `consent-roster-state.json` request.
Review as an authorized administrator. The Cowork OAuth client, token-store
reference and `Mcp.Read offline_access` do not change. No broader directory,
hidden-membership, application or write permissions are requested.

Update/import plugin 0.3.0, start a new Cowork task and request:
`Erstelle eine Tabelle aller User in Cowork Large, inkl. aktuellem Stand`.
The Skill pages every collection, retains source groups, deduplicates user
GUIDs and reads each user's Cowork records sequentially. Returned names/UPNs
may be unavailable under least-privilege access; GUIDs remain usable.
Hidden or inaccessible groups and failed user reads must be reported explicitly.
User roles, tenant API availability and eligibility still apply.

Membership uses the official
[transitive members](https://learn.microsoft.com/en-us/graph/api/group-list-transitivemembers?view=graph-rest-1.0)
and [direct members](https://learn.microsoft.com/en-us/graph/api/group-list-members?view=graph-rest-1.0)
endpoints with user-only cast, `$count=true` and `ConsistencyLevel: eventual`.
Transitive mode includes nested users but does not prove which spending policy
effectively applies to them. State this mode and possible indexing lag.
The per-user balances are service data, not policy-specific financial totals.

Remembered Cowork UI discrepancy: 0.2.0 was observed as 2.0.0; the user also
reports 0.3.0 displayed as 3.0.0. Cause unknown; no display version for 0.4.0
has been verified. Use the actual manifest version and do not change stable
app/OAuth IDs or apply a speculative version workaround.

### Write-operation feasibility

MCP can expose write tools in principle; this server, adapter and Skill remain
read-only. Neither plugin import, administrator consent nor a user's
confirmation creates a missing write tool. Actual Cowork mutation support and
tenant governance must be checked separately from backend/API support.

The public example names two candidate delegated write scopes:
`CopilotCostManagement-Policy.ReadWrite.All` (P) and
`CopilotCostManagement-Assignment.ReadWrite.All` (A).
These names are evidence for review, not a complete operation-specific
permission/role contract or proof that writes work in this tenant.

Assessment of all eleven mutations:

| Operation | Candidate scope evidence | Contract / authorization status | Read-back capability needed |
| --- | --- | --- | --- |
| Create policy | P, public example only | Current creation schema, identifiers, role and tenant availability unverified | Created policy detail |
| Update policy | P, public example only | Writable fields, patch/concurrency semantics, role and tenant availability unverified | Policy detail and requested field changes |
| Delete policy | P, public example only | Deletion effects, preconditions, role and tenant availability unverified | Authorized policy inventory/detail absence |
| Assign group | A, public example only | Reference payload, targeting constraints, role and tenant availability unverified | Complete assigned-group list |
| Remove group | A, public example only | Relationship deletion contract, role and tenant availability unverified | Complete assigned-group list |
| Add service settings | No verified per-operation scope mapping | Body schema, service identifiers, role and tenant availability unverified | Policy service settings |
| Update service settings | No verified per-operation scope mapping | Writable fields, patch semantics, role and tenant availability unverified | Policy service settings |
| Update email thresholds | No verified per-operation scope mapping | Threshold schema, validation, role and tenant availability unverified | Policy notification settings |
| Remove email thresholds | No verified per-operation scope mapping | Removal effects, role and tenant availability unverified | Policy notification settings |
| Add notification recipient | No verified per-operation scope mapping | Reference payload, recipient constraints, role and tenant availability unverified | Complete recipient list |
| Remove notification recipient | No verified per-operation scope mapping | Relationship removal contract, role and tenant availability unverified | Complete recipient list |

**None is implementation-ready on the verified evidence currently available.**
This means prerequisites are unresolved, not that Graph necessarily rejects
all writes. The confidential historical guide is not a current write contract,
and successful reads do not demonstrate write availability. Most required
detail/settings/recipient read-back tools are also not implemented; assigned
groups are available, but that alone does not complete the write contract.
No mutation was executed as a discovery probe, and no write consent is prepared.

A later, separately approved write plan must establish exact current
methods/paths/identifier constraints, typed request/response contracts,
per-operation delegated scopes and signed-in-user roles, error/concurrency
behavior and authorized read-back. Do not substitute arbitrary JSON or a
read-only role for these prerequisites. It must also include explicit
change previews and user confirmation, actor-bound expiring single-use
proposals, replay/concurrency protection, read-back verification and explicit
unknown-outcome handling without blind mutation retries. Read-only annotations
are not an authorization boundary; writes need enforced authorization.

## Authentication

Two dedicated Entra registrations separate the Cowork OAuth client from the
MCP resource/middle tier. The API accepts only delegated v2 access tokens with
its client ID as audience, the configured tenant/issuer, an allowed connector
client, and `Mcp.Read`. Graph OBO always uses the validated caller assertion.

In `managed-identity` mode, the dedicated MCP registration trusts the existing
user-assigned identity's **principal ID**, with the exact tenant v2 issuer and
`api://AzureADTokenExchange` audience. The runtime obtains a managed-identity
token for `api://AzureADTokenExchange/.default` and supplies it as MSAL's
**client assertion**, not as the Graph token or the user's OBO assertion.
`acquireTokenOnBehalfOf` retains the validated signed-in user's token and the
requested delegated Graph scopes. There is no certificate, secret, Azure CLI
credential fallback or app-only Graph path.

A separate MSAL instance/cache is created per request. Managed-identity
assertion acquisition, OBO authentication and Graph requests share the same
deadline. Requests are serialized, queues are bounded, and subsequent calls
honor Graph `Retry-After`; no automatic Graph retry occurs.

| Backend configuration | Requirements |
|---|---|
| `OBO_AUTH_MODE=managed-identity` | `AZURE_CLIENT_ID` must identify the trusted user-assigned identity; omit both certificate settings |
| `OBO_AUTH_MODE=certificate` (legacy default) | Versioned `OBO_KEY_ID` and matching 40-hex `OBO_CERTIFICATE_THUMBPRINT`; production signing requires reachable Key Vault |

Both modes also require `ENTRA_TENANT_ID`, `MCP_API_CLIENT_ID`,
`MCP_ALLOWED_CLIENT_IDS` and the real HTTPS `/mcp` URL in `MCP_PUBLIC_URL`.
Mixed or incomplete credential configuration is rejected at startup. Local
development in federation mode still requires that exact managed identity;
an unrelated developer login cannot impersonate its trust.

The initial deployment operator is assigned to the connector enterprise app
and receives a **user-specific MCP scope grant**. This does not grant Graph
permissions organization-wide. Other authorized users can be assigned and
consented without changing the server. Directory roles and early-access
eligibility remain separate Graph prerequisites.

## Local verification

Requires Node.js 24, npm and PowerShell 7 for setup-script tests.

```powershell
npm ci --prefix .\mcp-server
npm run typecheck --prefix .\mcp-server
npm test --prefix .\mcp-server
npm run build --prefix .\mcp-server
pwsh -NoProfile -File .\scripts\tests\Setup.Tests.ps1
az bicep build --file .\infra\main.bicep --outfile .\.azure\compiled-main.json
az bicep build --file .\infra\app.bicep --outfile .\.azure\compiled-app.json
```

All tests are offline. Setup tests intercept every Azure CLI call, fail on
unknown commands and use temporary state. They never open a login or contact
Azure. Configuration errors report field names, not secret values.

## Deployment sequence

Environment-specific deployment plans and setup state are local under `.azure`
and deliberately excluded from this repository. Establish your own approved
tenant/subscription/region configuration before running any cloud operation.
The checked-in plugin manifest is unconfigured. Local packaging requires your
explicit approved tenant and plugin app ID plus an independently supplied OAuth
reference and endpoint. An OAuth reference is an identifier, not a transferable
credential or permission grant.

Deployment uses Azure CLI and Bicep with two phases. This preserves the existing,
unrelated `azd` login and avoids provisioning a publicly exposed placeholder
application. `azure.yaml` also describes an azd remote-build service, but it must
only be used after checking azd's own signed-in account and selecting the
approved subscription/tenant.

1. Check the Azure CLI identity, subscription, provider registrations, regional
   quota and subscription policies. Run infrastructure validation and what-if.
2. Provision the foundation with `backendImage` empty: dedicated resource group,
   Container Apps environment, private authenticated ACR, managed identity,
   Key Vault and Log Analytics. No MCP app is exposed at this step.
3. Use the foundation outputs to create the two dedicated Entra registrations:

   ```powershell
   .\scripts\Initialize-Entra.ps1 `
     -TenantId $tenantId -SubscriptionId $subscriptionId `
     -OperatorObjectId $operatorObjectId -EnvironmentName $environmentName `
     -McpPublicUrl $mcpPublicUrl
   ```

4. Trust the existing user-assigned identity on the dedicated MCP registration:

   ```powershell
   .\scripts\Initialize-Federation.ps1 `
     -TenantId $tenantId -SubscriptionId $subscriptionId `
     -ManagedIdentityResourceId $identityResourceId
   ```

   The script checks subscription, tenant, saved application and identity,
   reuses identical trust, and refuses conflicting trust without replacing
   credentials. It creates no secret, certificate or Graph consent.

5. Build only the server directory in the subscription's ACR:

   ```powershell
   az acr build --registry $registryName --image "ccm-mcp:$imageTag" .\mcp-server
   ```

   This needs no local Docker installation. ACR Tasks must be available in the
   subscription; a task restriction must be reported, not bypassed.

6. Validate and deploy `infra\app.bicep` at the existing resource-group scope
   using the resulting immutable image digest, real application IDs and
   `oboAuthMode=managed-identity`. This entrypoint references the existing
   environment, registry and identity without redeploying the foundation or
   vault. The shared app module also preserves the original foundation's
   explicit certificate path. The image starts as a non-root user. Ingress
   allows HTTPS only. Min/max replicas are initially 1/1.
7. Verify live health, OAuth metadata and rejection of unauthenticated MCP
   requests. Run `node dist/auth/probe.js` inside the actual container to verify
   identity federation against **this MCP API only** and rejection of the
   resulting app-only token by `/mcp`. The probe verifies the token signature,
   tenant, issuer, audience and client; it prints no tokens and requests no
   Graph token. It explicitly reports `delegatedGraphVerified: false`.
   Neither health nor this credential proof substitutes for a delegated read.
8. Print the dedicated middle-tier app's hidden-scope admin-consent URL:

   ```powershell
   .\scripts\New-GraphConsentUrl.ps1 -McpPublicUrl $mcpPublicUrl
   ```

   An authorized administrator must review the app identity and exactly the two
   read permissions before approving. Check returned errors, tenant and state
   against `.azure\consent-state.json`; do not trust `admin_consent=True` alone.
9. Configure the new Cowork OAuth client in Microsoft's OAuth token store. Create
   its expiring client secret through the approved administrative UI and enter
   it directly into the token store. Never place it in source, local state,
   scripts, logs or an app ZIP.
10. Finish the connector package with the real OAuth configuration ID, then
    verify Cowork sign-in, initialize, dynamic tool discovery and a Graph read.
    A Skills ZIP is not a substitute for a connector/plugin package.

### Cowork OAuth configuration

| Setting | Value |
|---|---|
| Authorize URL | `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize` |
| Token URL | `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` |
| Client ID | New connector application ID, not the MCP API ID |
| Scope | `api://{apiClientId}/Mcp.Read offline_access` |
| Redirect URI | `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` |
| MCP endpoint | Real HTTPS endpoint ending in `/mcp` |

The connector must use the user's own sign-in. Neither a login hint nor the
deployment operator belongs in the final plugin. Select the current Cowork
organization/app restrictions in the administrative UI; do not infer them from
an older Teams manifest or the abandoned Skills importer.

## Operations and limits

- `/health/live` and `/health/ready` are minimal public process/configuration
  probes. Readiness is not a downstream Graph or backend-credential check.
- `/.well-known/oauth-protected-resource/mcp` publishes OAuth resource metadata.
- `/setup/consent/callback` is a public, non-mutating setup landing page; it never
  accepts tokens or treats query parameters as verified approval.
- `/about`, `/privacy` and `/terms` are public factual internal-evaluation
  notices for the plugin publisher links, not organization-approved legal
  policies or Microsoft endorsement. They do not call Graph, set cookies or
  reflect query parameters; live HTML/security-header checks passed.
- Every MCP method is authenticated before request-body parsing.
- Graph JSON responses are capped at 1 MiB and errors do not expose Graph's
  customer-specific messages or bearer tokens.
- The default call budget is 18 seconds, including queueing and authentication.
- Multi-replica/multi-revision operation is not yet certified. Storage-backed
  leases and atomic write proposals are required before enabling writes or
  scaling. Storage Table and runtime Application Insights instrumentation are
  deliberately deferred until the vertical-slice gate.
- Evaluation networking: ACR is publicly reachable but authenticated and its
  admin credentials are disabled. Key Vault uses RBAC and its public network
  access is disabled by inherited governance; federation does not access it.
  Private network integration and zone redundancy are not enabled in Stage A.
- Log Analytics has 30-day retention and a 0.5 GB/day ingestion cap. This cap is
  not a total Azure cost cap; resource charges continue independently.

### Optional certificate-mode rotation

This is not required for the selected federation mode. A legacy certificate
deployment must first provide authorized private connectivity to the vault and
run `Initialize-OboCertificate.ps1` explicitly. The six-month certificate does
not auto-renew. Before expiry, create a new
non-exportable certificate version, upload its public certificate to the same
MCP registration, then update both the pinned signing key URL and matching
thumbprint together. Verify a real delegated read before removing the previous
public certificate. Do not remove the old credential before the new revision
works. The setup script refuses certificates with fewer than 30 days remaining.

Only sanitized IDs/public certificate metadata are stored under ignored
`.azure` local state. Preserve this state to make setup reruns idempotent.
The excluded pre-existing test application is never reused or queried.

## Infrastructure sources

Infrastructure uses pinned Azure Verified Modules:

- [azd Container Apps stack 0.4.0](https://github.com/Azure/bicep-registry-modules/tree/main/avm/ptn/azd/container-apps-stack)
- [Container App 0.23.0](https://github.com/Azure/bicep-registry-modules/tree/main/avm/res/app/container-app)
- [Key Vault 0.14.2](https://github.com/Azure/bicep-registry-modules/tree/main/avm/res/key-vault/vault)
- [Log Analytics 0.16.1](https://github.com/Azure/bicep-registry-modules/tree/main/avm/res/operational-insights/workspace)
- [Managed identity 0.6.0](https://github.com/Azure/bicep-registry-modules/tree/main/avm/res/managed-identity/user-assigned-identity)

[Cowork plugin development](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development),
[Microsoft 365 OAuth configuration](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth)
and [Entra OBO](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow)
provide the public integration references. The confidential API guide is not
included in container build context or any public package.

## Repository publication boundaries

Source code, tests, dependency lockfile, infrastructure, packaging scripts,
plugin source/icons and documentation are included. Confidential API
documentation, local `.azure` state and validation environments, credentials,
installed dependencies and generated build outputs are excluded from Git.
Tenant-neutral template ZIPs and SHA-256 checksums are distributed as
[GitHub Release attachments](https://github.com/AndreasExner/Copilot-Credit-Management-MCP/releases/tag/v0.4.0),
not binary commits. Configured, import-ready ZIPs remain local and must not be
uploaded as neutral templates. The public templates intentionally retain
configuration markers and cannot be imported directly.

The current source and release attachments have been neutralized; older Git
commits still contain previously published deployment identifiers. No history
rewrite or credential rotation is performed by this cleanup.

## License

This project's original code and documentation are licensed under the
[MIT License](LICENSE), copyright 2026 Andreas Exner. Third-party dependencies
retain their respective licenses. The license does not cover the excluded
confidential API guide or grant access to Microsoft services; preview/API
terms and organizational requirements still apply.

[Managed-identity application federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity)
documents the exact issuer/subject/audience trust.
