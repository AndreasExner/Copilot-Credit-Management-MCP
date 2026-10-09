#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][string]$ManagedIdentityResourceId
)
. "$PSScriptRoot\Azure-Helpers.ps1"
Assert-AzureContext -TenantId $TenantId -SubscriptionId $SubscriptionId
$path = Join-Path (Split-Path $PSScriptRoot -Parent) '.azure\identity.json'
$state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
if ($state.tenantId -ne $TenantId.ToString() -or $state.subscriptionId -ne $SubscriptionId.ToString()) {
    throw 'The saved identity state belongs to another environment.'
}
if ($ManagedIdentityResourceId -notmatch "^/subscriptions/$SubscriptionId/resourceGroups/[^/]+/providers/Microsoft.ManagedIdentity/userAssignedIdentities/[^/]+$") {
    throw 'A user-assigned managed identity in the approved subscription is required.'
}
$identity = Invoke-AzureJson -Arguments @('identity', 'show', '--ids', $ManagedIdentityResourceId)
if ($identity.tenantId -ne $TenantId.ToString() -or $identity.id -ne $ManagedIdentityResourceId) {
    throw 'The selected managed identity does not match the requested tenant and resource.'
}
$application = Invoke-AzureJson -Arguments @(
    'rest', '--method', 'GET', '--url',
    "https://graph.microsoft.com/v1.0/applications/$($state.api.objectId)"
)
if ($application.appId -ne $state.api.clientId) {
    throw 'The saved MCP application identity does not match the registered application.'
}
$issuer = "https://login.microsoftonline.com/$TenantId/v2.0"
$audience = 'api://AzureADTokenExchange'
$name = 'mcp-managed-identity'
$credentials = Invoke-AzureJson -Arguments @(
    'rest', '--method', 'GET', '--url',
    "https://graph.microsoft.com/v1.0/applications/$($state.api.objectId)/federatedIdentityCredentials"
)
$existing = @($credentials.value | Where-Object { $_.name -eq $name })
if ($existing.Count -gt 1) { throw 'Duplicate managed-identity trust credentials require administrative review.' }
if ($existing.Count -eq 1) {
    $credential = $existing[0]
    if ($credential.issuer -cne $issuer -or $credential.subject -cne $identity.principalId -or
        @($credential.audiences).Count -ne 1 -or $credential.audiences[0] -cne $audience) {
        throw 'The existing federation trust differs. No credentials were replaced; administrative review is required.'
    }
} else {
    $credential = Invoke-GraphWrite -Method POST `
        -Path "applications/$($state.api.objectId)/federatedIdentityCredentials" -Body @{
            name = $name
            issuer = $issuer
            subject = $identity.principalId
            audiences = @($audience)
            description = 'Certificate-free MCP backend authentication; downstream Graph remains delegated OBO.'
        }
}
$state.oboAuthMode = 'managed-identity'
$state.managedIdentityResourceId = $identity.id
$state.managedIdentityClientId = $identity.clientId
$state.managedIdentityPrincipalId = $identity.principalId
$state.federatedCredentialId = $credential.id
$state.federationIssuer = $issuer
$state.federationAudience = $audience
Save-ProjectState -Path $path -State $state
Write-Output "Managed-identity trust configured for MCP application $($state.api.clientId). No secret, certificate or Graph consent was created."
