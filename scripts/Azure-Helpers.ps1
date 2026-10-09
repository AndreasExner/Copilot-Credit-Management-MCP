Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-AzureJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $result = & az @Arguments --only-show-errors --output json
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed: $($Arguments[0..([Math]::Min(2, $Arguments.Length - 1))] -join ' ')."
    }
    if ($result) { return ($result -join "`n") | ConvertFrom-Json -AsHashtable }
}

function Invoke-GraphWrite {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$Body
    )
    $file = New-TemporaryFile
    try {
        $Body | ConvertTo-Json -Depth 30 | Set-Content $file.FullName -Encoding utf8NoBOM
        Invoke-AzureJson -Arguments @(
            'rest', '--method', $Method, '--url', "https://graph.microsoft.com/v1.0/$Path",
            '--body', "@$($file.FullName)"
        )
    } finally {
        Remove-Item -LiteralPath $file.FullName -Force
    }
}

function Assert-AzureContext {
    param([string]$TenantId, [string]$SubscriptionId)
    $context = Invoke-AzureJson -Arguments @('account', 'show')
    if ($context.tenantId -ne $TenantId -or $context.id -ne $SubscriptionId) {
        throw 'Azure CLI context does not match the requested tenant and subscription. No changes were made.'
    }
}

function Save-ProjectState {
    param([string]$Path, [hashtable]$State)
    $State | ConvertTo-Json -Depth 30 | Set-Content "$Path.tmp" -Encoding utf8NoBOM
    Move-Item -LiteralPath "$Path.tmp" -Destination $Path -Force
}
