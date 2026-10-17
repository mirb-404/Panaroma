<#
.SYNOPSIS
  Authenticode-signs one file for `pnpm tauri build` (bundle.windows.signCommand).

.DESCRIPTION
  Tauri calls this for panorama.exe and for the MSI. The certificate comes from
  the environment, so no secret is ever committed:

    PANORAMA_SIGN_THUMBPRINT   SHA-1 thumbprint of a code-signing certificate in
                               Cert:\CurrentUser\My (or LocalMachine\My), or
    PANORAMA_SIGN_PFX          path to a .pfx file, plus
    PANORAMA_SIGN_PFX_PASSWORD its password.

    PANORAMA_SIGN_TIMESTAMP    RFC 3161 timestamp server
                               (default: http://timestamp.digicert.com).
    PANORAMA_REQUIRE_SIGNING   set to 1 (release CI) to fail instead of
                               producing an unsigned build.

  Without a certificate the build continues unsigned and says so.
#>
param([Parameter(Mandatory = $true)][string]$File)

$ErrorActionPreference = 'Stop'

$thumb = $env:PANORAMA_SIGN_THUMBPRINT
$pfx = $env:PANORAMA_SIGN_PFX
$timestamp = if ($env:PANORAMA_SIGN_TIMESTAMP) { $env:PANORAMA_SIGN_TIMESTAMP } else { 'http://timestamp.digicert.com' }

if (-not $thumb -and -not $pfx) {
    if ($env:PANORAMA_REQUIRE_SIGNING -eq '1') {
        Write-Error "Signing required but no certificate configured (set PANORAMA_SIGN_THUMBPRINT or PANORAMA_SIGN_PFX)."
        exit 1
    }
    Write-Warning "No signing certificate configured; leaving $(Split-Path $File -Leaf) unsigned."
    exit 0
}

# Newest signtool from the Windows SDK, unless it's already on PATH.
$signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signtool) {
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $signtool = Get-ChildItem $kits -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -eq 'x64' } |
        Sort-Object { [version]($_.Directory.Parent.Name -replace '[^\d.]', '0') } -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signtool) {
    Write-Error 'signtool.exe not found. Install the Windows SDK (Signing Tools for Desktop Apps).'
    exit 1
}

$signArgs = @('sign', '/fd', 'sha256', '/tr', $timestamp, '/td', 'sha256', '/d', 'Panorama', '/du', 'https://github.com/mirb-404/REA_Test')
if ($thumb) {
    $signArgs += @('/sha1', $thumb)
} else {
    $signArgs += @('/f', $pfx)
    if ($env:PANORAMA_SIGN_PFX_PASSWORD) { $signArgs += @('/p', $env:PANORAMA_SIGN_PFX_PASSWORD) }
}
$signArgs += $File

& $signtool @signArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "signtool failed ($LASTEXITCODE) for $File"
    exit $LASTEXITCODE
}
