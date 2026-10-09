#Requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$Template,
    [guid]$TenantId,
    [guid]$AppId,
    [string]$ConfigurationPath,
    [string]$SourcePath,
    [string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$python = Join-Path $root '.azure\plugin-validator-env\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = 'python' }
$source = if ($SourcePath) { (Resolve-Path -LiteralPath $SourcePath).Path } else { Join-Path $root 'cowork-plugin\appPackage' }
$manifest = Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw | ConvertFrom-Json -AsHashtable
$remote = $manifest.agentConnectors[0].toolSource.remoteMcpServer
if ($manifest.id -cne '${PLUGIN_APP_ID}' -or $remote.mcpServerUrl -cne '${MCP_PUBLIC_URL}' -or
    $remote.authorization.referenceId -cne '${OAUTH_REFERENCE_ID}' -or
    $manifest.developer.websiteUrl -cne '${MCP_ORIGIN}/about' -or
    $manifest.developer.privacyUrl -cne '${MCP_ORIGIN}/privacy' -or
    $manifest.developer.termsOfUseUrl -cne '${MCP_ORIGIN}/terms' -or
    $manifest.validDomains.Count -ne 1 -or $manifest.validDomains[0] -cne '${MCP_HOST}') {
    throw 'The source manifest must be the tenant-neutral project template.'
}
if ($Template) {
    if ($PSBoundParameters.ContainsKey('TenantId') -or $PSBoundParameters.ContainsKey('AppId') -or
        $PSBoundParameters.ContainsKey('ConfigurationPath')) {
        throw 'Template builds must not receive deployment configuration.'
    }
} else {
    if (-not $TenantId -or $TenantId -eq [guid]::Empty -or -not $AppId -or $AppId -eq [guid]::Empty) {
        throw 'Configured builds require explicit non-empty TenantId and AppId.'
    }
    $configurationFile = if ($ConfigurationPath) { $ConfigurationPath } else { Join-Path $root '.azure\cowork-oauth.json' }
    $configuration = Get-Content -LiteralPath $configurationFile -Raw | ConvertFrom-Json -AsHashtable
    $reference = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($configuration.referenceId))
    if ($reference -notmatch '^([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})##([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$' -or
        [guid]$Matches[1] -ne $TenantId -or [guid]$Matches[2] -eq [guid]::Empty -or
        [guid]$configuration.tenantId -ne $TenantId) {
        throw 'The OAuth configuration is malformed or does not belong to the explicitly approved tenant.'
    }
    $url = [uri]$configuration.mcpPublicUrl
    if (-not $url.IsAbsoluteUri -or $url.Scheme -cne 'https' -or $url.AbsolutePath -cne '/mcp' -or
        $url.UserInfo -or $url.Query -or $url.Fragment) {
        throw 'MCP URL must be an absolute HTTPS /mcp endpoint without credentials, query or fragment.'
    }
    $origin = $url.GetLeftPart([UriPartial]::Authority)
    $manifest.id = $AppId.ToString()
    $remote.mcpServerUrl = $configuration.mcpPublicUrl
    $remote.authorization.referenceId = $configuration.referenceId
    $manifest.validDomains = @($url.DnsSafeHost)
    foreach ($field in @(@{ name = 'websiteUrl'; route = 'about' }, @{ name = 'privacyUrl'; route = 'privacy' }, @{ name = 'termsOfUseUrl'; route = 'terms' })) {
        $manifest.developer[$field.name] = "$origin/$($field.route)"
    }
}
$manifestText = $manifest | ConvertTo-Json -Depth 30
$cache = Join-Path $root '.azure'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$schema = Join-Path $root '.azure\MicrosoftTeams.v1.29.schema.json'
if (-not (Test-Path -LiteralPath $schema)) {
    Invoke-WebRequest -Uri 'https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json' `
        -OutFile $schema -TimeoutSec 45
}

Add-Type -AssemblyName System.Drawing

$files = @(
    'manifest.json', 'color.png', 'outline.png',
    'skills\copilot-credit-management\SKILL.md',
    'skills\copilot-credit-management\references\read-workflows.md'
)
$build = if ($OutputDirectory) { $OutputDirectory } else { Join-Path $root 'cowork-plugin\build' }
New-Item -ItemType Directory -Path $build -Force | Out-Null
$suffix = if ($Template) { '-template' } else { '' }
$output = Join-Path $build "copilot-credit-management-$($manifest.version)$suffix.zip"
$temporary = "$output.$([guid]::NewGuid().ToString('N')).tmp"
try {
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew)
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $files) {
            $entryName = $file.Replace('\', '/')
            if ($file -eq 'manifest.json') {
                $entry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
                $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
                try { $writer.Write($manifestText) } finally { $writer.Dispose() }
            } else {
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive, (Join-Path $source $file), $entryName, [IO.Compression.CompressionLevel]::Optimal
                ) | Out-Null
            }
        }
    } finally {
        $archive.Dispose()
        $stream.Dispose()
    }
    $inspection = [IO.Compression.ZipFile]::OpenRead($temporary)
    try {
        foreach ($name in @('color.png', 'outline.png')) {
            $iconStream = $inspection.GetEntry($name).Open()
            $image = [Drawing.Bitmap]::new($iconStream)
            try {
                if ($name -eq 'outline.png') {
                    $transparent = 0
                    $visible = 0
                    for ($x = 0; $x -lt $image.Width; $x++) {
                        for ($y = 0; $y -lt $image.Height; $y++) {
                            $pixel = $image.GetPixel($x, $y)
                            if ($pixel.A -eq 0) { $transparent++; continue }
                            $visible++
                            if ($pixel.R -ne 255 -or $pixel.G -ne 255 -or $pixel.B -ne 255) {
                                throw 'Outline icon must contain only white visible pixels.'
                            }
                        }
                    }
                    if ($visible -eq 0 -or $transparent -eq 0) {
                        throw 'Outline icon must have visible white artwork and transparent background.'
                    }
                }
            } finally {
                $image.Dispose()
                $iconStream.Dispose()
            }
        }
    } finally {
        $inspection.Dispose()
    }
    $validation = @("$PSScriptRoot\Validate-CoworkPlugin.py", '--package', $temporary, '--schema', $schema)
    if ($Template) {
        $validation += '--template'
    } else {
        $validation += @('--tenant', $TenantId.ToString(), '--app-id', $AppId.ToString(),
            '--mcp-url', $configuration.mcpPublicUrl, '--oauth-reference', $configuration.referenceId)
    }
    & $python @validation
    if ($LASTEXITCODE -ne 0) { throw 'Cowork archive validation failed; no new import ZIP was published.' }
    Move-Item -LiteralPath $temporary -Destination $output -Force
    Get-FileHash -LiteralPath $output -Algorithm SHA256 | Select-Object Path,Hash
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
