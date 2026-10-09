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

**The protected remote MCP server is deployed in Canada East.** The user-approved
region retry resolved the Central US capacity blocker. The original Central US
resources remain unchanged; nothing was deleted.

The approved backend authentication is now **certificate-free managed-identity
federation**. The application is running with one healthy replica, and its
actual managed identity successfully authenticates the dedicated MCP application.
All 74 backend tests and 13 plugin archive tests pass. The inherited Key Vault
policy remains unchanged. Certificate setup previously failed with
`403 ForbiddenByConnection`; the selected mode does not access that vault.

MCP endpoint:
[https://ca-ccm-eval-tnx2hg.calmhill-679a9318.canadaeast.azurecontainerapps.io/mcp](https://ca-ccm-eval-tnx2hg.calmhill-679a9318.canadaeast.azurecontainerapps.io/mcp).
This is a protected endpoint: anonymous requests correctly return 401.

Release 0.2.0 implements three real MCP tools:

- `get_tenant_credit_balance`
- `list_spending_policies`, including validated, unchanged continuation URLs
- `list_user_service_balances`, with an optional target Entra user GUID;
  omitted means the validated signed-in caller's own service balances.
  Requires delegated `CopilotCostManagement-UserData.Read.All` consent.

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
operation is now implemented and deployed; its actual tenant read still needs
consent/role/availability acceptance. It does not prove a separate total-user
balance endpoint, all other planned operations or any write contract.
Eight additional reads and 11 mutations remain deferred.
There is no write endpoint,
anonymous MCP mode or app-only Graph fallback.

The importable [Cowork plugin ZIP](cowork-plugin/build/copilot-credit-management-0.2.0.zip)
includes an integrated Skill and the real OAuth token-store reference. Its
manifest 1.29 schema, archive contents and icons were validated. See the
[plugin import and acceptance instructions](cowork-plugin/README.md).
The successful Cowork read is user-reported acceptance, not an independent
runtime certification by the assistant. Reload persistence remains unconfirmed.

Local protocol tests are not evidence of real Cowork authentication or Graph
access. The protected-resource metadata and the consent callback also do not
prove that consent has been granted.

### Persistent deployment state

#### Canada East: active foundation

| Resource | Current state |
|---|---|
| Resource group `rg-ccm-eval-tnx2hg` | Created |
| Container Apps environment `cae-ccm-eval-tnx2hg` | Succeeded |
| ACR `crccmevaltnx2hg` | Succeeded; user-service-balance image cloud-built and digest pinned |
| Key Vault `kv-mcp-tnx2hg` | Created; governance disables public access |
| Identity `id-ccm-eval-tnx2hg` | AcrPull and vault signing roles confirmed |
| Log Analytics `log-ccm-eval-tnx2hg` | Created |
| Dedicated MCP API and Cowork Entra registrations | Created; `Mcp.Read` exposed |
| Managed-identity federation | Configured; live application credential proof passed |
| Container App `ca-ccm-eval-tnx2hg` | Running; revision healthy, one replica |
| OBO certificate | Not required; none created |
| Graph admin consent | Original two scopes verified on 2026-10-08; additional UserData review pending |
| Cowork OAuth configuration | Actual token-store ID supplied; tenant verified; successful Cowork read user-reported |
| Cowork plugin 0.2.0 | Import ZIP built; schema and 13 archive tests passed; original 0.1.0 preserved |
| Publisher notices | Public project/privacy/usage pages deployed and verified |

API application ID: `9941ac93-e4db-4df3-9a82-fc903ff2fbaa`.
Connector application ID: `21796b9d-9908-4d21-ba40-6477c56db15d`.
The operator assignment and user-specific MCP consent are in place. The user
also granted Graph admin consent; the actual tenant-wide Graph grant was
verified at 2026-10-08T16:26:12Z. No application certificate was created. No
connector client secret was received or persisted by this implementation;
the connector's separate credential belongs only in Microsoft's token store.

The running image was built in Canada East (ACR run `cw3`, tag
`ccm-mcp:user-balances-v1`). Its independently verified, deployed digest is
`sha256:cff1b6bd9104b03b517c69f9ddc976c1f7432dd11c43ce4820b3bc4a3d780f6d`.
Deployment `ccm-eval-user-balances` succeeded at 2026-10-09T05:27:22Z.
The current revision is `ca-ccm-eval-tnx2hg--0000002`, Healthy with one replica.
The previous notice/federation images and original certificate-backed image remain
preserved in the registry.

Live verification: both health routes and OAuth metadata return 200. Anonymous
GET/POST/DELETE and an invalid bearer token return 401. The in-container
credential probe verified the real managed identity, federated application
authentication, and the resulting token's signature/issuer/tenant/audience;
`/mcp` rejected that app-only token with 401. This probe does not call Graph.
The dedicated MCP application's tenant-wide Graph grant verified on 2026-10-08 contained exactly
`CopilotCostManagement.Read.All` and `CopilotCostManagement-Policy.Read.All`
(delegated permissions). The actual Cowork OAuth registration ID is now included
in the plugin. The user reports a successful signed-in-user read; no independent
assistant runtime certification or verification of both read tools is claimed.
The remaining operations require the separate current API contracts above.

### Additional UserData consent and acceptance

User service balances use `CopilotCostManagement-UserData.Read.All`; the two
original scopes do not replace it. Generate the administrator-review URL:

```powershell
pwsh -NoProfile -File .\scripts\New-GraphConsentUrl.ps1 `
  -McpPublicUrl 'https://ca-ccm-eval-tnx2hg.calmhill-679a9318.canadaeast.azurecontainerapps.io/mcp' `
  -IncludeUserServiceBalances
```

This requests the existing two reads plus UserData for the dedicated MCP API,
not the Cowork client. It prints a URL/state only and preserves original grant
proof in a separate pending-request file. Do not grant consent automatically.
No write, group-membership, assignment or Graph application permission is needed
by this implementation. Existing Cowork token-store `Mcp.Read offline_access`
configuration stays unchanged.

After administrator review, update the plugin, reconnect if needed, start a new
Cowork task and request your own per-service balances or Cowork consumption.
Omit `userId` for yourself; another user requires a supplied Entra object GUID,
not an email/name lookup. User roles and tenant endpoint availability still
apply. No live UserData result is claimed before that test.

The operator's consent metadata recheck on 2026-10-09 required interactive
Graph authentication after a CAE policy change; existing ARM access was usable.
No login reset or unrelated-account fallback was attempted.

#### Central US: preserved first attempt

| Resource | Current state |
|---|---|
| Resource group `rg-ccm-eval-m354jd` | Created |
| ACR `crccmevalm354jd` | Succeeded; admin credentials disabled |
| Key Vault `kv-mcp-m354jd` | Succeeded; RBAC and purge protection enabled |
| Identity `id-ccm-eval-m354jd` | Created; vault signing role confirmed |
| Log Analytics `log-ccm-eval-m354jd` | Created |
| Container Apps environment `cae-ccm-eval-m354jd` | Failed: regional capacity |
| Container App | Not created |

The actual Azure cloud build succeeded (run `cj1`) and the image is persisted
as `crccmevalm354jd.azurecr.io/ccm-mcp:0.1.0`, with digest
`sha256:ff033a92beb590ef5611405ffe2065064ee6353257f4d60c9dd5d50554b611e7`.
No local Docker installation was used. This is a verified container image,
not a working public MCP endpoint.

Both foundations remain and may incur costs. Do not redeploy into or delete
the failed Central US environment without authorization. The new Canada East
AcrPull gate passed. Certificate-free federation removes the runtime dependency
on private Key Vault access; genuine delegated Graph/Cowork proof is still required.

The exact inherited rule is `KeyVault_PublicNetwork_Modify` in
`MCAPSGovDeployPolicies`. No private networking, policy exemption, exception
tags or forced public access are used. Both existing foundations and their
vaults are preserved.

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
The checked-in plugin manifest describes this evaluation deployment; its OAuth
reference is an identifier, not a transferable credential or permission grant.

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
installed dependencies, generated build outputs and plugin ZIPs are excluded.
Keep those exclusions intact when publishing changes; build plugin ZIPs locally
from the supplied source after configuring your own authorized OAuth registration.

[Managed-identity application federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity)
documents the exact issuer/subject/audience trust.
