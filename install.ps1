# Install dsh-doc-attach into the web profile.
#
# Why a manual copy instead of `dsh plugin --profile web add`: this machine has no reachable
# npm registry (verified: `npm view` exits 1, HTTPS to registry.npmjs.org is
# closed), so any install path that resolves dependencies over the network will
# fail or hang. Third-party bundles are resolved by NAME from the profile's
# node_modules (pnpm's hoisted layout) — the same way cleverer-dsh resolves
# `cleverer-dsh/plugins/*.mjs` — so placing the directory there and listing the
# name as a bundle is sufficient.
#
# Usage:
#   pwsh -File install.ps1 -DryRun     # report only, change nothing
#   pwsh -File install.ps1             # apply, then restart dsh web
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$ProfilePath = "$env:USERPROFILE\.dsh\profiles\web",
    [string]$SourcePath  = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { Write-Host "  $text" }
function Write-Head($text) { Write-Host ""; Write-Host "== $text" }

if (-not (Test-Path $ProfilePath)) { throw "profile not found: $ProfilePath" }
if (-not (Test-Path (Join-Path $SourcePath 'package.json'))) { throw "source package not found: $SourcePath" }

$packageFile = Join-Path $ProfilePath 'package.json'
$target      = Join-Path $ProfilePath 'node_modules\dsh-doc-attach'

Write-Head "plan"
Write-Step "source      : $SourcePath"
Write-Step "profile     : $ProfilePath"
Write-Step "target      : $target"
Write-Step "manifest    : $packageFile"
if ($DryRun) { Write-Step "mode        : DRY RUN (nothing will be written)" }

# ── 1. the package directory ──────────────────────────────────────────────
Write-Head "1. place the package"
if ($DryRun) {
    Write-Step "would remove and recreate $target"
} else {
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    # Only the runtime pieces ship; tests and probes stay in the development copy.
    foreach ($item in @('package.json', 'cordis.patch.yml', 'plugins', 'lib')) {
        Copy-Item -Recurse -Force (Join-Path $SourcePath $item) (Join-Path $target $item)
    }
    Write-Step "copied package.json, cordis.patch.yml, plugins/, lib/"
}

# ── 2. the profile manifest ───────────────────────────────────────────────
Write-Head "2. register the bundle"
$manifest = Get-Content $packageFile -Raw -Encoding utf8 | ConvertFrom-Json

$dependencyPresent = $null -ne $manifest.dependencies.'dsh-doc-attach'
$bundlePresent = $null -ne ($manifest.dsh.profile.bundles | Where-Object { $_ -eq 'dsh-doc-attach' })

Write-Step "dependency entry present : $dependencyPresent"
Write-Step "bundle entry present     : $bundlePresent"

if ($dependencyPresent -and $bundlePresent) {
    Write-Step "already registered — nothing to change"
} elseif ($DryRun) {
    Write-Step "would add dependency 'dsh-doc-attach': 'file:./node_modules/dsh-doc-attach'"
    Write-Step "would append 'dsh-doc-attach' to dsh.profile.bundles"
} else {
    # Back up before the first mutation so a bad edit is one copy away from undone.
    $backup = "$packageFile.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $packageFile $backup -Force
    Write-Step "backed up manifest to $(Split-Path $backup -Leaf)"
    $manifest.dependencies | Add-Member -NotePropertyName 'dsh-doc-attach' -NotePropertyValue 'file:./node_modules/dsh-doc-attach' -Force
    if (-not $bundlePresent) {
        $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles) + 'dsh-doc-attach'
    }
    # Written through .NET rather than Set-Content: PowerShell 5.1's `-Encoding utf8`
    # emits a BOM, and a JSON parser rejects a leading BOM outright. A BOM here
    # would break the profile manifest, not merely cosmetically alter it.
    $json = $manifest | ConvertTo-Json -Depth 12
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($packageFile, $json, $utf8NoBom)
    Write-Step "manifest updated (no BOM)"
}

# ── 3. verify ─────────────────────────────────────────────────────────────
Write-Head "3. verify"
$probe = Join-Path $target 'plugins\read-document.mjs'
if ($DryRun) {
    Write-Step "would verify $probe"
} else {
    foreach ($needed in @(
        'plugins\read-document.mjs',
        'plugins\drop-ingest.mjs',
        'lib\host.js',
        'lib\client.js',
        'lib\extract\document-python.mjs',
        'lib\extract\document_helper.py',
        'lib\extract\doc_reader.py',
        'lib\extract\ppt_reader.py',
        'cordis.patch.yml'
    )) {
        if (-not (Test-Path (Join-Path $target $needed))) { throw "missing after copy: $needed" }
    }
    # Retired modules must be GONE. A stale copy here would leave two owners of
    # the same job on disk, and the plugin would keep loading an older backend.
    foreach ($retired in @(
        'lib\extract\pdf-python.mjs',
        'lib\extract\pdf_extract_helper.py'
    )) {
        if (Test-Path (Join-Path $target $retired)) { throw "retired module still present: $retired" }
    }
    Write-Step "all runtime files present; retired modules absent"
}

Write-Head "4. next step"
Write-Step "Client package metadata is cached per name and never expires, so the"
Write-Step "browser half only appears after a RESTART of the host:"
Write-Step "  restart the process serving $env:DSH_WEB_URL"
Write-Step "Then verify:"
Write-Step "  GET  $env:DSH_WEB_URL/api/doc-attach/health   -> ok:true"
Write-Step "  the composer dock accepts a dropped PDF, and the agent gains"
Write-Step "  document_outline / document_search / document_read"
Write-Step ""
Write-Step "Rollback: restore the newest package.json.bak-* and delete $target"
