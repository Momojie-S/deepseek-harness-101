# Manual DSH version check (run by hand when a new version shows up; the old
# daily scheduled task \dsh-version-check was retired on 2026-10-30).
#
# Flow:
#   1. Compare installed @deepseek-ai/dsh version vs npm dist-tags.latest
#      (override both via -CurrentVersion / -TargetVersion, e.g. to backfill a
#      report for a version the machine already installed:
#      -CurrentVersion 0.2.1-rc.5 -TargetVersion 0.2.2-rc.1)
#   2. No new version  -> log one line, exit 0 (no model calls, no cost)
#   3. New version     -> skip if docs/version/<ver>.md already exists;
#      otherwise render scripts/dsh-version-prompt.md into
#      .dsh/version-check/task-<ver>.md,
#      and run one headless investigation agent (dsh --profile headless) that
#      writes docs/version/<ver>.md.
#      NOTE: headless credential resolution has been broken since 2026-10
#      (MISSING_CREDENTIAL for zai-coding-cn etc.; web keeps working — see
#      ops dsh.md 2026-10-30 entry). If the headless agent exits without
#      writing the report, run the investigation manually following
#      scripts/dsh-version-prompt.md.

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

$stateDir = Join-Path $workspace ".dsh\version-check"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$log = Join-Path $stateDir "check.log"
function Log([string] $m) {
  ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) | Add-Content -Path $log
  Write-Host $m
}

# A manual run inside an interactive DSH session leaks session vars into the
# headless child; strip any stale session vars and pin the canonical home
# (credentials live in ~/.dsh/.credentials.yaml, shared by every launch context).
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
# No local source clone on this machine: the investigation agent reads GitHub
# online and runs its own tarball diffs (see scripts/dsh-version-prompt.md).

$templatePath = Join-Path $workspace "scripts\dsh-version-prompt.md"
$template = Get-Content $templatePath -Raw -Encoding UTF8
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
