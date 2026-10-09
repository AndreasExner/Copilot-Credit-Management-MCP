#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$OperatorObjectId,
    [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{2,19}$')][string]$EnvironmentName,
    [Parameter(Mandatory)][uri]$McpPublicUrl
)
. "$PSScriptRoot\Azure-Helpers.ps1"
Assert-AzureContext -TenantId $TenantId -SubscriptionId $SubscriptionId
if ($McpPublicUrl.Scheme -ne 'https' -or $McpPublicUrl.AbsolutePath -ne '/mcp' -or
    $McpPublicUrl.UserInfo -or $McpPublicUrl.Query -or $McpPublicUrl.Fragment) {
    throw 'McpPublicUrl must be the exact HTTPS /mcp endpoint.'
}
$root = Split-Path $PSScriptRoot -Parent
$path = Join-Path $root '.azure\identity.json'
$callback = [uri]::new($McpPublicUrl, '/setup/consent/callback').AbsoluteUri
$state = if (Test-Path -LiteralPath $path) {
    Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
} else {
    @{
        tenantId = $TenantId.ToString()
        subscriptionId = $SubscriptionId.ToString()
        environmentName = $EnvironmentName
        readScopeId = [guid]::NewGuid().ToString()
    }
}
if ($state.tenantId -ne $TenantId.ToString() -or $state.subscriptionId -ne $SubscriptionId.ToString() -or
    $state.environmentName -ne $EnvironmentName) {
    throw 'The saved identity state belongs to another environment.'
}
if (-not $state.ContainsKey('api')) {
    $created = Invoke-GraphWrite -Method POST -Path applications -Body @{
        displayName = "Copilot Credit Management MCP - $EnvironmentName"
        signInAudience = 'AzureADMyOrg'
        web = @{ redirectUris = @($callback) }
        api = @{ requestedAccessTokenVersion = 2 }
    }
    $state.api = @{ objectId = $created.id; clientId = $created.appId }
    Save-ProjectState -Path $path -State $state
}
Invoke-GraphWrite -Method PATCH -Path "applications/$($state.api.objectId)" -Body @{
    identifierUris = @("api://$($state.api.clientId)")
    web = @{ redirectUris = @($callback) }
    api = @{
        requestedAccessTokenVersion = 2
        oauth2PermissionScopes = @(@{
            id = $state.readScopeId
            value = 'Mcp.Read'
            type = 'Admin'
            isEnabled = $true
            adminConsentDisplayName = 'Read Copilot credit management through MCP'
            adminConsentDescription = 'Read balances and spending policies as the signed-in user.'
            userConsentDisplayName = 'Read Copilot credit management through MCP'
            userConsentDescription = 'Read balances and spending policies as you.'
        })
    }
} | Out-Null
if (-not $state.api.ContainsKey('servicePrincipalId')) {
    $principal = Invoke-GraphWrite -Method POST -Path servicePrincipals -Body @{ appId = $state.api.clientId }
    $state.api.servicePrincipalId = $principal.id
    Save-ProjectState -Path $path -State $state
}
if (-not $state.ContainsKey('connector')) {
    $created = Invoke-GraphWrite -Method POST -Path applications -Body @{
        displayName = "Copilot Credit Management Cowork - $EnvironmentName"
        signInAudience = 'AzureADMyOrg'
        web = @{ redirectUris = @('https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect') }
        requiredResourceAccess = @(@{
            resourceAppId = $state.api.clientId
            resourceAccess = @(@{ id = $state.readScopeId; type = 'Scope' })
        })
    }
    $state.connector = @{ objectId = $created.id; clientId = $created.appId }
    Save-ProjectState -Path $path -State $state
}
if (-not $state.connector.ContainsKey('servicePrincipalId')) {
    $principal = Invoke-GraphWrite -Method POST -Path servicePrincipals -Body @{
        appId = $state.connector.clientId
        appRoleAssignmentRequired = $true
    }
    $state.connector.servicePrincipalId = $principal.id
    Save-ProjectState -Path $path -State $state
}
if (-not $state.ContainsKey('operatorAssignmentId')) {
    $assignment = Invoke-GraphWrite -Method POST `
        -Path "servicePrincipals/$($state.connector.servicePrincipalId)/appRoleAssignedTo" -Body @{
            principalId = $OperatorObjectId.ToString()
            resourceId = $state.connector.servicePrincipalId
            appRoleId = '00000000-0000-0000-0000-000000000000'
        }
    $state.operatorAssignmentId = $assignment.id
    Save-ProjectState -Path $path -State $state
}
if (-not $state.ContainsKey('operatorMcpGrantId')) {
    $grant = Invoke-GraphWrite -Method POST -Path oauth2PermissionGrants -Body @{
        clientId = $state.connector.servicePrincipalId
        resourceId = $state.api.servicePrincipalId
        consentType = 'Principal'
        principalId = $OperatorObjectId.ToString()
        scope = 'Mcp.Read'
    }
    $state.operatorMcpGrantId = $grant.id
    Save-ProjectState -Path $path -State $state
}
[pscustomobject]@{
    ApiClientId = $state.api.clientId
    ConnectorClientId = $state.connector.clientId
    Scope = "api://$($state.api.clientId)/Mcp.Read"
    GraphConsentGranted = $false
    ConnectorSecretCreated = $false
}
