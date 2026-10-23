<#
.SYNOPSIS
  Build the Slop Factory installers for Windows (NSIS setup .exe and .msi).

.EXAMPLE
  pwsh scripts/build.ps1
  pwsh scripts/build.ps1 -Version 1.2.3

.NOTES
  Needs Node 18+, Rust (MSVC toolchain) and the WebView2 runtime (see README).
  The installers land in src-tauri\target\release\bundle\.
#>
param(
    # Stamp a version first; the release workflow does this from its vX.Y.Z tag.
    [string]$Version
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

foreach ($tool in 'node', 'npm', 'cargo') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool isn't installed or isn't on PATH."
    }
}

function Invoke-Step([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
}

if ($Version) { Invoke-Step node @('scripts/set-version.mjs', $Version) }

Invoke-Step npm @('ci')
Invoke-Step npm @('--prefix', 'sidecar', 'ci')
Invoke-Step npx @('tauri', 'build', '--bundles', 'nsis,msi')

Write-Host ''
Write-Host 'Done. Installers are in src-tauri\target\release\bundle\.'
