#Requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$python = Join-Path $root '.azure\plugin-validator-env\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = 'python' }
$source = Join-Path $root 'cowork-plugin\appPackage'
$manifest = Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw | ConvertFrom-Json -AsHashtable
$configuration = Get-Content -LiteralPath (Join-Path $root '.azure\cowork-oauth.json') -Raw | ConvertFrom-Json -AsHashtable
$reference = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($configuration.referenceId))
$tenant = $reference.Split('##')[0]
if ($tenant -ne '8052aab8-6989-451f-91b2-faa77f298324') {
    throw 'The OAuth configuration does not belong to the approved project tenant.'
}
$schema = Join-Path $root '.azure\MicrosoftTeams.v1.29.schema.json'
if (-not (Test-Path -LiteralPath $schema)) {
    Invoke-WebRequest -Uri 'https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json' `
        -OutFile $schema -TimeoutSec 45
}

Add-Type -AssemblyName System.Drawing
foreach ($spec in @(@{ name = 'color.png'; size = 192 }, @{ name = 'outline.png'; size = 32 })) {
    $bitmap = [Drawing.Bitmap]::new($spec.size, $spec.size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $pen = [Drawing.Pen]::new([Drawing.Color]::White, [single]($spec.size / 24))
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        if ($spec.name -eq 'color.png') {
            $graphics.Clear([Drawing.ColorTranslator]::FromHtml('#246B47'))
        } else {
            $graphics.Clear([Drawing.Color]::Transparent)
        }
        $margin = [single]($spec.size / 6)
        $diameter = [single]($spec.size - 2 * $margin)
        $graphics.DrawEllipse($pen, $margin, $margin, $diameter, $diameter)
        $offset = [single]($spec.size / 3)
        $line = [single]($spec.size / 3)
        $graphics.DrawLine($pen, $offset, [single]($spec.size * 0.4), ($offset + $line), [single]($spec.size * 0.4))
        $graphics.DrawLine($pen, $offset, [single]($spec.size * 0.6), ($offset + $line), [single]($spec.size * 0.6))
        if ($spec.name -eq 'outline.png') {
            for ($x = 0; $x -lt $bitmap.Width; $x++) {
                for ($y = 0; $y -lt $bitmap.Height; $y++) {
                    $pixel = $bitmap.GetPixel($x, $y)
                    if ($pixel.A -gt 0) {
                        $bitmap.SetPixel($x, $y, [Drawing.Color]::FromArgb($pixel.A, 255, 255, 255))
                    }
                }
            }
        }
        $bitmap.Save((Join-Path $source $spec.name), [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $pen.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$files = @(
    'manifest.json', 'color.png', 'outline.png',
    'skills\copilot-credit-management\SKILL.md',
    'skills\copilot-credit-management\references\read-workflows.md'
)
$build = Join-Path $root 'cowork-plugin\build'
New-Item -ItemType Directory -Path $build -Force | Out-Null
$output = Join-Path $build "copilot-credit-management-$($manifest.version).zip"
$temporary = "$output.$([guid]::NewGuid().ToString('N')).tmp"
try {
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew)
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $files) {
            $entryName = $file.Replace('\', '/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, (Join-Path $source $file), $entryName, [IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
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
    & $python "$PSScriptRoot\Validate-CoworkPlugin.py" --package $temporary --schema $schema `
        --tenant $tenant --mcp-url $configuration.mcpPublicUrl --oauth-reference $configuration.referenceId
    if ($LASTEXITCODE -ne 0) { throw 'Cowork archive validation failed; no new import ZIP was published.' }
    Move-Item -LiteralPath $temporary -Destination $output -Force
    Get-FileHash -LiteralPath $output -Algorithm SHA256 | Select-Object Path,Hash
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
