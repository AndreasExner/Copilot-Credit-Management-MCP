#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9-]{3,24}$')][string]$VaultName
)
. "$PSScriptRoot\Azure-Helpers.ps1"
Assert-AzureContext -TenantId $TenantId -SubscriptionId $SubscriptionId
$path = Join-Path (Split-Path $PSScriptRoot -Parent) '.azure\identity.json'
$state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
if ($state.tenantId -ne $TenantId.ToString() -or $state.subscriptionId -ne $SubscriptionId.ToString()) {
    throw 'The saved identity state belongs to another environment.'
}
$certificates = Invoke-AzureJson -Arguments @('keyvault', 'certificate', 'list', '--vault-name', $VaultName)
if (-not ($certificates | Where-Object { $_.id -match '/certificates/mcp-obo$' })) {
    $policy = @{
        issuerParameters = @{ name = 'Self' }
        keyProperties = @{ exportable = $false; keySize = 3072; keyType = 'RSA'; reuseKey = $false }
        secretProperties = @{ contentType = 'application/x-pkcs12' }
        x509CertificateProperties = @{
            subject = 'CN=Copilot Credit Management MCP OBO'
            keyUsage = @('digitalSignature')
            ekus = @('1.3.6.1.5.5.7.3.2')
            validityInMonths = 6
        }
        lifetimeActions = @()
    }
    $file = New-TemporaryFile
    try {
        $policy | ConvertTo-Json -Depth 10 | Set-Content $file.FullName -Encoding utf8NoBOM
        Invoke-AzureJson -Arguments @(
            'keyvault', 'certificate', 'create', '--vault-name', $VaultName,
            '--name', 'mcp-obo', '--policy', "@$($file.FullName)"
        ) | Out-Null
    } finally {
        Remove-Item -LiteralPath $file.FullName -Force
    }
}
$certificate = Invoke-AzureJson -Arguments @(
    'keyvault', 'certificate', 'show', '--vault-name', $VaultName, '--name', 'mcp-obo'
)
$public = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    [Convert]::FromBase64String($certificate.cer)
)
if ($public.NotAfter.ToUniversalTime() -le [datetime]::UtcNow.AddDays(30)) {
    throw 'The OBO certificate is expired or nearing expiry. Renew and register a new public certificate first.'
}
$application = Invoke-AzureJson -Arguments @(
    'rest', '--method', 'GET', '--url',
    "https://graph.microsoft.com/v1.0/applications/$($state.api.objectId)?`$select=keyCredentials"
)
$keys = @($application.keyCredentials)
if (-not ($keys | Where-Object { $_.displayName -eq "mcp-obo-$($public.Thumbprint)" })) {
    $keys += @{
        keyId = [guid]::NewGuid().ToString()
        type = 'AsymmetricX509Cert'
        usage = 'Verify'
        key = $certificate.cer
        displayName = "mcp-obo-$($public.Thumbprint)"
        startDateTime = $public.NotBefore.ToUniversalTime().ToString('o')
        endDateTime = $public.NotAfter.ToUniversalTime().ToString('o')
    }
    Invoke-GraphWrite -Method PATCH -Path "applications/$($state.api.objectId)" `
        -Body @{ keyCredentials = $keys } | Out-Null
}
$state.signingKeyId = $certificate.kid
$state.certificateThumbprint = $public.Thumbprint
$state.certificateExpires = $public.NotAfter.ToUniversalTime().ToString('o')
Save-ProjectState -Path $path -State $state
[pscustomobject]@{
    KeyId = $state.signingKeyId
    CertificateThumbprint = $state.certificateThumbprint
    Expires = $state.certificateExpires
}
