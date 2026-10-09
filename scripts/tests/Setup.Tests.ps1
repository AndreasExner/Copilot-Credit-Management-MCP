#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "ccm-setup-test-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path "$testRoot\scripts", "$testRoot\.azure" | Out-Null
$sources = Split-Path $PSScriptRoot -Parent
foreach ($name in @('Azure-Helpers.ps1', 'Initialize-Entra.ps1', 'Initialize-OboCertificate.ps1', 'Initialize-Federation.ps1', 'New-GraphConsentUrl.ps1')) {
    Copy-Item -LiteralPath (Join-Path $sources $name) -Destination "$testRoot\scripts\$name"
}
$script:tenant = [guid]::NewGuid()
$script:subscription = [guid]::NewGuid()
$script:operator = [guid]::NewGuid()
$script:applications = @{}
$script:counts = @{ apps = 0; principals = 0; assignments = 0; grants = 0; certificates = 0; patches = 0; federation = 0 }
$script:certificate = $null
$script:rsa = [Security.Cryptography.RSA]::Create(2048)
$request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=offline-setup-test', $script:rsa, [Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$script:publicCertificate = $request.CreateSelfSigned([datetimeoffset]::UtcNow.AddDays(-1), [datetimeoffset]::UtcNow.AddMonths(6))
$global:CcmOfflineTestState = @{
    tenant = $script:tenant
    subscription = $script:subscription
    operator = $script:operator
    applications = $script:applications
    counts = $script:counts
    certificate = $null
    publicCertificate = $script:publicCertificate
    federatedCredentials = @()
    identity = @{
        id = "/subscriptions/$($script:subscription)/resourceGroups/offline/providers/Microsoft.ManagedIdentity/userAssignedIdentities/offline-mcp"
        tenantId = $script:tenant.ToString()
        clientId = [guid]::NewGuid().ToString()
        principalId = [guid]::NewGuid().ToString()
    }
}

function Assert-Test {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Offline setup assertion failed: $Message" }
}

# Every CLI invocation is intercepted; unknown commands fail instead of reaching Azure.
function global:az {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
    $global:LASTEXITCODE = 0
    $value = $null
    if (($Arguments[0..1] -join ' ') -eq 'account show') {
        $value = @{ tenantId = $global:CcmOfflineTestState.tenant.ToString(); id = $global:CcmOfflineTestState.subscription.ToString() }
    } elseif ($Arguments[0] -eq 'rest') {
        $method = $Arguments[[array]::IndexOf($Arguments, '--method') + 1]
        $url = $Arguments[[array]::IndexOf($Arguments, '--url') + 1]
        $bodyIndex = [array]::IndexOf($Arguments, '--body')
        $body = if ($bodyIndex -ge 0) {
            Get-Content -LiteralPath $Arguments[$bodyIndex + 1].Substring(1) -Raw | ConvertFrom-Json -AsHashtable
        } else { @{} }
        switch -Regex ($url) {
            '^https://graph.microsoft.com/v1.0/applications/([^/]+)/federatedIdentityCredentials$' {
                Assert-Test ($global:CcmOfflineTestState.applications.ContainsKey($Matches[1])) 'federation accesses only newly created app'
                if ($method -eq 'GET') {
                    $value = @{ value = $global:CcmOfflineTestState.federatedCredentials }
                } elseif ($method -eq 'POST') {
                    Assert-Test ($body.subject -eq $global:CcmOfflineTestState.identity.principalId) 'trust subject is identity principal ID, not client ID'
                    Assert-Test ($body.issuer -ceq "https://login.microsoftonline.com/$($global:CcmOfflineTestState.tenant)/v2.0") 'exact tenant issuer'
                    Assert-Test ($body.audiences.Count -eq 1 -and $body.audiences[0] -ceq 'api://AzureADTokenExchange') 'exact exchange audience'
                    $value = $body.Clone()
                    $value.id = [guid]::NewGuid().ToString()
                    $global:CcmOfflineTestState.federatedCredentials += $value
                    $global:CcmOfflineTestState.counts.federation++
                } else { throw 'Unexpected federation method.' }
                break
            }
            '^https://graph.microsoft.com/v1.0/applications$' {
                Assert-Test ($method -eq 'POST') 'application method'
                Assert-Test ($body.signInAudience -eq 'AzureADMyOrg') 'single-tenant registration'
                $id = [guid]::NewGuid().ToString()
                $value = @{ id = $id; appId = [guid]::NewGuid().ToString(); keyCredentials = @() }
                $global:CcmOfflineTestState.applications[$id] = $value.Clone()
                $global:CcmOfflineTestState.counts.apps++
                break
            }
            '^https://graph.microsoft.com/v1.0/applications/([^?]+)(?:\?.*)?$' {
                $id = $Matches[1]
                Assert-Test ($global:CcmOfflineTestState.applications.ContainsKey($id)) 'only newly created apps may be accessed'
                if ($method -eq 'GET') {
                    $value = $global:CcmOfflineTestState.applications[$id]
                } elseif ($method -eq 'PATCH') {
                    $global:CcmOfflineTestState.counts.patches++
                    if ($body.ContainsKey('keyCredentials')) {
                        $global:CcmOfflineTestState.applications[$id].keyCredentials = $body.keyCredentials
                    }
                } else { throw 'Unexpected application method.' }
                break
            }
            '^https://graph.microsoft.com/v1.0/servicePrincipals$' {
                Assert-Test ($method -eq 'POST') 'principal method'
                $value = @{ id = [guid]::NewGuid().ToString() }
                $global:CcmOfflineTestState.counts.principals++
                break
            }
            '^https://graph.microsoft.com/v1.0/servicePrincipals/[^/]+/appRoleAssignedTo$' {
                Assert-Test ($body.principalId -eq $global:CcmOfflineTestState.operator.ToString()) 'assignment uses setup operator only'
                $value = @{ id = [guid]::NewGuid().ToString() }
                $global:CcmOfflineTestState.counts.assignments++
                break
            }
            '^https://graph.microsoft.com/v1.0/oauth2PermissionGrants$' {
                Assert-Test ($body.consentType -eq 'Principal' -and $body.scope -eq 'Mcp.Read') 'no organization-wide Graph grant'
                $value = @{ id = [guid]::NewGuid().ToString() }
                $global:CcmOfflineTestState.counts.grants++
                break
            }
            default { throw "Unmocked Graph URL: $url" }
        }
    } elseif (($Arguments[0..1] -join ' ') -eq 'identity show') {
        Assert-Test ($Arguments[[array]::IndexOf($Arguments, '--ids') + 1] -eq $global:CcmOfflineTestState.identity.id) 'selected identity resource'
        $value = $global:CcmOfflineTestState.identity
    } elseif (($Arguments[0..2] -join ' ') -eq 'keyvault certificate list') {
        $value = if ($global:CcmOfflineTestState.certificate) { @(@{ id = 'https://offline.vault.azure.net/certificates/mcp-obo' }) } else { @() }
    } elseif (($Arguments[0..2] -join ' ') -eq 'keyvault certificate create') {
        $policyFile = $Arguments[[array]::IndexOf($Arguments, '--policy') + 1].Substring(1)
        $policy = Get-Content -LiteralPath $policyFile -Raw | ConvertFrom-Json -AsHashtable
        Assert-Test ($policy.keyProperties.exportable -eq $false) 'private key must be non-exportable'
        $global:CcmOfflineTestState.certificate = @{
            cer = [Convert]::ToBase64String($global:CcmOfflineTestState.publicCertificate.Export(
                [Security.Cryptography.X509Certificates.X509ContentType]::Cert
            ))
            kid = 'https://offline.vault.azure.net/keys/mcp-obo/mockversion'
        }
        $value = $global:CcmOfflineTestState.certificate
        $global:CcmOfflineTestState.counts.certificates++
    } elseif (($Arguments[0..2] -join ' ') -eq 'keyvault certificate show') {
        $value = $global:CcmOfflineTestState.certificate
    } else { throw "Unmocked Azure CLI command: $($Arguments -join ' ')" }
    if ($null -ne $value) { ConvertTo-Json -InputObject $value -Depth 30 -Compress }
}

try {
    $parameters = @{
        TenantId = $script:tenant
        SubscriptionId = $script:subscription
        OperatorObjectId = $script:operator
        EnvironmentName = 'offline-eval'
        McpPublicUrl = 'https://mcp.offline.test/mcp'
    }
    & "$testRoot\scripts\Initialize-Entra.ps1" @parameters | Out-Null
    & "$testRoot\scripts\Initialize-Entra.ps1" @parameters | Out-Null
    Assert-Test ($script:counts.apps -eq 2 -and $script:counts.principals -eq 2) 'registration rerun must not create duplicates'
    Assert-Test ($script:counts.assignments -eq 1 -and $script:counts.grants -eq 1) 'assignment/consent rerun must not create duplicates'
    $beforeFederation = $script:counts.Clone()
    $federationParameters = @{
        TenantId = $script:tenant
        SubscriptionId = $script:subscription
        ManagedIdentityResourceId = $global:CcmOfflineTestState.identity.id
    }
    & "$testRoot\scripts\Initialize-Federation.ps1" @federationParameters | Out-Null
    & "$testRoot\scripts\Initialize-Federation.ps1" @federationParameters | Out-Null
    Assert-Test ($script:counts.federation -eq 1) 'federation rerun must not duplicate trust'
    Assert-Test ($script:counts.certificates -eq $beforeFederation.certificates -and $script:counts.patches -eq $beforeFederation.patches) 'federation must not touch certificates or existing credentials'
    $federationState = Get-Content -LiteralPath "$testRoot\.azure\identity.json" -Raw | ConvertFrom-Json -AsHashtable
    Assert-Test ($federationState.managedIdentityPrincipalId -eq $global:CcmOfflineTestState.identity.principalId) 'principal ID persisted'
    $global:CcmOfflineTestState.federatedCredentials[0].subject = [guid]::NewGuid().ToString()
    $failed = $false
    try { & "$testRoot\scripts\Initialize-Federation.ps1" @federationParameters | Out-Null } catch { $failed = $true }
    Assert-Test $failed 'conflicting trust must fail without replacing credentials'
    Assert-Test ($script:counts.federation -eq 1) 'conflicting trust must not add credentials'
    $global:CcmOfflineTestState.federatedCredentials[0].subject = $global:CcmOfflineTestState.identity.principalId
    $invalidFederation = $federationParameters.Clone()
    $invalidFederation.SubscriptionId = [guid]::NewGuid()
    $failed = $false
    try { & "$testRoot\scripts\Initialize-Federation.ps1" @invalidFederation | Out-Null } catch { $failed = $true }
    Assert-Test $failed 'wrong context must reject federation'
    Assert-Test ($script:counts.federation -eq 1) 'wrong context must not add credentials'
    $certificateParameters = @{ TenantId = $script:tenant; SubscriptionId = $script:subscription; VaultName = 'offline-vault' }
    & "$testRoot\scripts\Initialize-OboCertificate.ps1" @certificateParameters | Out-Null
    & "$testRoot\scripts\Initialize-OboCertificate.ps1" @certificateParameters | Out-Null
    Assert-Test ($script:counts.certificates -eq 1) 'certificate rerun must reuse existing version'
    $state = Get-Content -LiteralPath "$testRoot\.azure\identity.json" -Raw | ConvertFrom-Json -AsHashtable
    Assert-Test ($state.certificateThumbprint -eq $script:publicCertificate.Thumbprint) 'registered public certificate and runtime thumbprint must match'
    Assert-Test ($script:applications[$state.api.objectId].keyCredentials.Count -eq 1) 'certificate registration rerun must not duplicate keys'
    $before = $script:counts.Clone()
    $output = & "$testRoot\scripts\New-GraphConsentUrl.ps1" -McpPublicUrl $parameters.McpPublicUrl
    Assert-Test ($output[0] -like 'https://login.microsoftonline.com/*/v2.0/adminconsent?*') 'hidden scope consent URL'
    Assert-Test ($output[0] -like '*CopilotCostManagement-Policy.Read.All*') 'policy scope must be requested'
    Assert-Test ($output[0] -notlike '*UserData.Read.All*') 'default consent must remain limited to the two existing reads'
    $originalConsent = Get-Content -LiteralPath "$testRoot\.azure\consent-state.json" -Raw
    $extendedConsent = & "$testRoot\scripts\New-GraphConsentUrl.ps1" -McpPublicUrl $parameters.McpPublicUrl -IncludeUserServiceBalances
    Assert-Test ($extendedConsent[0] -like '*CopilotCostManagement-UserData.Read.All*') 'user balances require the evidenced UserData read scope'
    Assert-Test ($extendedConsent[0] -notmatch 'ReadWrite|GroupMember|Assignment') 'user balances must not request write, group or assignment scopes'
    Assert-Test ((Get-Content -LiteralPath "$testRoot\.azure\consent-state.json" -Raw) -eq $originalConsent) 'new consent request must preserve original consent proof'
    $pendingConsent = Get-Content -LiteralPath "$testRoot\.azure\consent-userdata-state.json" -Raw | ConvertFrom-Json
    Assert-Test ($pendingConsent.requestedScopes.Count -eq 3) 'pending user-data consent must request exactly three delegated reads'
    $originalUserData = Get-Content -LiteralPath "$testRoot\.azure\consent-userdata-state.json" -Raw
    $rosterConsent = & "$testRoot\scripts\New-GraphConsentUrl.ps1" -McpPublicUrl $parameters.McpPublicUrl -IncludePolicyRoster
    Assert-Test ($rosterConsent[0] -like '*CopilotCostManagement-Assignment.Read.All*') 'policy assignments require the evidenced Assignment read scope'
    Assert-Test ($rosterConsent[0] -like '*GroupMember.ReadBasic.All*') 'membership must use the documented least-privilege read scope'
    Assert-Test ($rosterConsent[0] -like '*CopilotCostManagement-UserData.Read.All*') 'roster includes per-user service balances'
    Assert-Test ($rosterConsent[0] -notmatch 'ReadWrite|Directory.Read|User.Read|Member.Read.Hidden|GroupMember.Read.All') 'roster must not broaden directory or write access'
    Assert-Test ((Get-Content -LiteralPath "$testRoot\.azure\consent-state.json" -Raw) -eq $originalConsent) 'roster must preserve original consent proof'
    Assert-Test ((Get-Content -LiteralPath "$testRoot\.azure\consent-userdata-state.json" -Raw) -eq $originalUserData) 'roster must preserve earlier UserData request state'
    $pendingRoster = Get-Content -LiteralPath "$testRoot\.azure\consent-roster-state.json" -Raw | ConvertFrom-Json
    Assert-Test ($pendingRoster.requestedScopes.Count -eq 5) 'roster must request exactly five delegated reads'
    Assert-Test ($script:counts.grants -eq $before.grants) 'printing consent URL must not grant consent'
    $failed = $false
    $invalid = $parameters.Clone()
    $invalid.SubscriptionId = [guid]::NewGuid()
    try {
        & "$testRoot\scripts\Initialize-Entra.ps1" @invalid | Out-Null
    } catch { $failed = $true }
    Assert-Test $failed 'wrong subscription must fail'
    Assert-Test ($script:counts.apps -eq $before.apps) 'wrong context must not create applications'
    Write-Output 'Offline setup tests passed: dedicated apps, idempotent federation, conflicting trust/context rejection, no federation certificate/fallback/Graph grant, operator-only MCP grant, explicit non-exportable certificate mode, consent URL without grant.'
} finally {
    Remove-Item Function:\az
    Remove-Variable -Name CcmOfflineTestState -Scope Global
    $script:publicCertificate.Dispose()
    $script:rsa.Dispose()
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
