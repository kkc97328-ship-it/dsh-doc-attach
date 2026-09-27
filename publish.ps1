# Publish dsh-doc-attach to GitHub and npm.
#
# WHY THIS SCRIPT EXISTS
# It was authored on a machine where none of the publishing steps could run:
# github.com, api.github.com and registry.npmjs.org all reset the connection,
# `gh` is not installed, and neither gh nor npm is logged in. Everything that
# needs no network (the repository, the manifest, the commit, the tag, the
# tarball contents) was done there; these are the steps that need a network.
#
# Run it on a machine that can reach GitHub and npm, from inside the repository:
#
#   pwsh -File publish.ps1 -DryRun    # preflight only, changes nothing
#   pwsh -File publish.ps1            # create the repo, push, tag, publish
#
# Every step is idempotent enough to re-run after a failure.
[CmdletBinding()]
param(
    [string]$Owner = 'kkc97328-ship-it',
    [string]$Repo = 'dsh-doc-attach',
    [string]$Tag = 'v0.1.0',
    [switch]$SkipNpm,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Step($text) { Write-Host "  $text" }
function Head($text) { Write-Host ""; Write-Host "== $text" }
function Fail($text) { Write-Host "  FAILED: $text" -ForegroundColor Red; exit 1 }

# ── 0. preflight ──────────────────────────────────────────────────────────
Head '0. preflight'
if (-not (Test-Path (Join-Path $PWD 'package.json'))) { Fail "run this from the repository root (no package.json in $PWD)" }
$manifest = Get-Content package.json -Raw -Encoding utf8 | ConvertFrom-Json
Step "package : $($manifest.name)@$($manifest.version)"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is not on PATH' }
Step "git     : $((git --version))"

$hasGh = $null -ne (Get-Command gh -ErrorAction SilentlyContinue)
Step "gh      : $(if ($hasGh) { (gh --version | Select-Object -First 1) } else { 'NOT INSTALLED — install it from https://cli.github.com/ and re-run' })"

$reachable = $false
try {
    $null = Invoke-WebRequest -Uri 'https://api.github.com' -Method Head -TimeoutSec 15 -UseBasicParsing
    $reachable = $true
} catch { }
Step "network : $(if ($reachable) { 'github.com and registry reachable' } else { 'UNREACHABLE — a proxy/VPN or a different machine is required' })"

if ($DryRun) {
    Head '1-4. would run'
    Step "git push -u origin main"
    Step "gh repo create $Owner/$Repo --public --source=. --remote=origin --push"
    Step "git push origin $Tag"
    if (-not $SkipNpm) { Step "npm publish --access public" }
    Write-Host ""
    Step 'DRY RUN: nothing was changed.'
    exit 0
}

if (-not $hasGh) { Fail 'gh is required for step 2; install it and re-run' }
if (-not $reachable) { Fail 'the network is unreachable; the publish steps cannot run here' }

# ── 1. authenticate ───────────────────────────────────────────────────────
Head '1. authentication'
$status = (gh auth status 2>&1 | Out-String)
if ($status -notmatch 'Logged in') {
    Step 'not logged in to GitHub — starting the interactive login'
    Step "pick: GitHub.com -> HTTPS -> authenticate with a browser, and choose the $Owner account"
    gh auth login
} else {
    Step 'already logged in to gh'
    Step ($status.Split("`n") | Select-String -Pattern 'Logged in|account' | Select-Object -First 2 | ForEach-Object { $_.Line.Trim() })
}

# ── 2. create and push the repository ─────────────────────────────────────
Head '2. create the GitHub repository'
$existing = (gh repo view "$Owner/$Repo" --json name 2>&1 | Out-String)
if ($existing -match '"name"') {
    Step "$Owner/$Repo already exists — skipping creation"
    if (-not (git remote 2>$null | Select-String -Pattern '^origin$')) { git remote add origin "https://github.com/$Owner/$Repo.git" }
} else {
    gh repo create "$Owner/$Repo" --public --source=. --remote=origin --push
    if ($LASTEXITCODE -ne 0) { Fail 'gh repo create failed' }
    Step 'repository created and pushed'
}
# Ensure the branch and remote are in place even when the repo pre-existed.
git push -u origin main
if ($LASTEXITCODE -ne 0) { Fail 'git push failed (check credentials for the remote)' }
Step 'main pushed'

# ── 3. tag ────────────────────────────────────────────────────────────────
Head '3. tag'
if (-not (git tag -l $Tag)) { git tag -a $Tag -m "$Tag - first public release" }
git push origin $Tag
if ($LASTEXITCODE -ne 0) { Fail 'pushing the tag failed' }
Step "$Tag pushed"

# ── 4. npm ────────────────────────────────────────────────────────────────
if ($SkipNpm) {
    Head '4. npm'
    Step 'skipped (-SkipNpm)'
} else {
    Head '4. publish to npm'
    $who = (npm whoami 2>&1 | Out-String).Trim()
    if ($who -eq '') {
        Step 'not logged in to npm — starting npm login'
        npm login
        $who = (npm whoami 2>&1 | Out-String).Trim()
        if ($who -eq '') { Fail 'npm login did not complete' }
    }
    Step "npm user: $who"
    Step 'the name may already be taken; if publish fails with 403/EPUBLISHCONFLICT, rename it in package.json and re-run'
    npm publish --access public
    if ($LASTEXITCODE -ne 0) { Fail 'npm publish failed' }
    Step "published $($manifest.name)@$($manifest.version)"
}

Head 'done'
Step "GitHub : https://github.com/$Owner/$Repo"
if (-not $SkipNpm) { Step "npm    : https://www.npmjs.com/package/$($manifest.name)" }
Step "install: dsh plugin --profile web add $($manifest.name)"
Step "         dsh plugin --profile web add github:$Owner/$Repo    (github spec; the profile name is yours to choose)"
