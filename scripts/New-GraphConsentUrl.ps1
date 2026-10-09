#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][uri]$McpPublicUrl,
    [switch]$IncludeUserServiceBalances,
    [switch]$IncludePolicyRoster
)
. "$PSScriptRoot\Azure-Helpers.ps1"
if ($McpPublicUrl.Scheme -ne 'https' -or $McpPublicUrl.AbsolutePath -ne '/mcp' -or
    $McpPublicUrl.UserInfo -or $McpPublicUrl.Query -or $McpPublicUrl.Fragment) {
    throw 'McpPublicUrl must be the exact HTTPS /mcp endpoint.'
}
$root = Split-Path $PSScriptRoot -Parent
$identity = Get-Content -LiteralPath (Join-Path $root '.azure\identity.json') -Raw |
    ConvertFrom-Json -AsHashtable
$state = [guid]::NewGuid().ToString('N')
$scopes = @(
    'https://graph.microsoft.com/CopilotCostManagement.Read.All'
    'https://graph.microsoft.com/CopilotCostManagement-Policy.Read.All'
)
if ($IncludeUserServiceBalances -or $IncludePolicyRoster) {
    $scopes += 'https://graph.microsoft.com/CopilotCostManagement-UserData.Read.All'
}
if ($IncludePolicyRoster) {
    $scopes += @(
        'https://graph.microsoft.com/CopilotCostManagement-Assignment.Read.All'
        'https://graph.microsoft.com/GroupMember.ReadBasic.All'
    )
}
$parameters = [ordered]@{
    client_id = $identity.api.clientId
    scope = $scopes -join ' '
    redirect_uri = [uri]::new($McpPublicUrl, '/setup/consent/callback').AbsoluteUri
    state = $state
}
$query = ($parameters.GetEnumerator() | ForEach-Object {
    $_.Key + '=' + [uri]::EscapeDataString([string]$_.Value)
}) -join '&'
$stateFile = if ($IncludePolicyRoster) { 'consent-roster-state.json' }
    elseif ($IncludeUserServiceBalances) { 'consent-userdata-state.json' }
    else { 'consent-state.json' }
Save-ProjectState -Path (Join-Path $root ".azure\$stateFile") -State @{
    expectedState = $state
    tenantId = $identity.tenantId
    clientId = $identity.api.clientId
    createdAt = [datetime]::UtcNow.ToString('o')
    requestedScopes = $scopes
}
"https://login.microsoftonline.com/$($identity.tenantId)/v2.0/adminconsent?$query"
"Expected state: $state"
"This only prints a URL. An authorized administrator must review and approve the $($scopes.Count) delegated read permissions."
