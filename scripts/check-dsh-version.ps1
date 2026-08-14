# Daily DSH version check (scheduled task \dsh-version-check, 01:00 every day).
#
# Flow:
#   1. Compare installed @deepseek-ai/dsh version vs npm dist-tags.latest
#   2. No new version  -> log one line, exit 0 (no model calls, no cost)
#   3. New version     -> skip if docs/version/<ver>.md already exists;
#      otherwise fetch the official source repo, render
#      scripts/dsh-version-prompt.md into .dsh/version-check/task-<ver>.md,
#      and run one headless investigation agent (dsh --profile headless) that
#      writes docs/version/<ver>.md.
#
# Manual rehearsal (simulate a new version without waiting for a release):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-dsh-version.ps1 \
#     -CurrentVersion 0.1.0-rc.3 -TargetVersion 0.1.0-rc.6

param(
  # Override the detected running version (rehearsal only).
  [string] $CurrentVersion,
  # Override npm latest and skip the equality check (rehearsal only).
  [string] $TargetVersion
)

$ErrorActionPreference = "Continue"

$workspace   = "D:\code\workspace\deepseek-harness-101"
$installedPkg = "D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh\package.json"
$npmCmd      = "D:\code\env\node-v24.13.1-win-x64\npm.cmd"
$nodeExe     = "D:\code\env\node-v24.13.1-win-x64\node.exe"
$dshBin      = "D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh\lib\bin.js"
$srcRepo     = "D:\code\workspace\deepseek-harness"

$stateDir = Join-Path $workspace ".dsh\version-check"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$log = Join-Path $stateDir "check.log"
function Log([string] $m) {
  ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) | Add-Content -Path $log
  Write-Host $m
}

# The scheduled task inherits nothing from an interactive DSH session; strip any
# stale session vars and pin the canonical home (credentials live in
# ~/.dsh/.credentials.yaml, shared by every launch context).
Remove-Item Env:DSH_SESSION_ID, Env:DSH_SESSION_JSONL, Env:DSH_SHELL, Env:DSH_WEB_URL -ErrorAction SilentlyContinue
$env:DSH_HOME = "C:\Users\Administrator\.dsh"

# --- 1. resolve versions -----------------------------------------------------
if (-not $CurrentVersion) {
  $CurrentVersion = (Get-Content $installedPkg -Raw | ConvertFrom-Json).version
}
if (-not $TargetVersion) {
  $TargetVersion = (& $npmCmd view "@deepseek-ai/dsh" dist-tags.latest --silent) 2>$null
  if (-not $TargetVersion) { Log "npm view failed, aborting"; exit 1 }
}
Log "current=$CurrentVersion target=$TargetVersion"

if ($TargetVersion -eq $CurrentVersion) { Log "no new version, done"; exit 0 }

# --- 2. idempotency ----------------------------------------------------------
$report = Join-Path $workspace "docs\version\$TargetVersion.md"
if (Test-Path $report) { Log "report already exists: $report"; exit 0 }

# --- 3. prepare inputs for the investigation ---------------------------------
# Best-effort: the agent reads the source repo; fetch first so it sees fresh
# commits even if its own network calls fail.
git -C $srcRepo fetch origin master 2>&1 | ForEach-Object { Log "fetch: $_" }

$templatePath = Join-Path $workspace "scripts\dsh-version-prompt.md"
$template = Get-Content $templatePath -Raw
$task = $template.Replace("{{CURRENT_VERSION}}", $CurrentVersion).Replace("{{TARGET_VERSION}}", $TargetVersion)
$taskPath = Join-Path $stateDir "task-$TargetVersion.md"
Set-Content -Path $taskPath -Value $task -Encoding UTF8

# --- 4. run the headless investigation ---------------------------------------
Log "launching headless investigation for $TargetVersion (task: $taskPath)"
Set-Location $workspace
$agentLog = Join-Path $stateDir "investigate-$TargetVersion.log"
& $nodeExe $dshBin --profile headless "Read the task file at $taskPath and execute it fully. It is a self-contained investigation assignment; all inputs and required output are described there." 2>&1 |
  ForEach-Object { Add-Content -Path $agentLog -Value "$_" }
$code = $LASTEXITCODE

if (Test-Path $report) { Log "report written: $report (agent exit $code)"; exit 0 }
Log "agent exited $code but report is missing: $report (see $agentLog)"
exit 1
