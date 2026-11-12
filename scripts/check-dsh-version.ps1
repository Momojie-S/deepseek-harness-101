# Manual DSH version probe — discovery step of the DSH upgrade SOP
# (D:\code\workspace\momojie-assistant\ops\home\dsh\dsh-upgrade-sop.md §1).
#
# Compares the installed @deepseek-ai/dsh version against npm dist-tags.latest.
# On a new version it only reports; the investigation itself follows the SOP
# (per-plugin subagent review). The old auto-investigation path (headless agent
# rendering scripts/dsh-version-prompt.md into docs/version/<ver>.md) was
# retired on 2026-11-12 together with the docs/version report system; the daily
# scheduled check was retired even earlier (2026-10-30).
#
# Usage:
#   pwsh -File scripts/check-dsh-version.ps1
#     -> compares the running install vs npm latest
#   pwsh -File scripts/check-dsh-version.ps1 -CurrentVersion <v1> -TargetVersion <v2>
#     -> compares any two explicit versions

param(
  # Override the detected running version.
  [string] $CurrentVersion,
  # Override npm latest (skip the registry query).
  [string] $TargetVersion
)

$ErrorActionPreference = "Stop"

$installedPkg = "D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh\package.json"
$npmCmd       = "D:\code\env\node-v24.13.1-win-x64\npm.cmd"

if (-not $CurrentVersion) {
  $CurrentVersion = (Get-Content $installedPkg -Raw | ConvertFrom-Json).version
}
if (-not $TargetVersion) {
  $TargetVersion = (& $npmCmd view "@deepseek-ai/dsh" dist-tags.latest --silent) 2>$null
  if (-not $TargetVersion) { Write-Host "npm view failed, aborting"; exit 1 }
}

Write-Host "current   = $CurrentVersion"
Write-Host "npm latest= $TargetVersion"

if ($TargetVersion -eq $CurrentVersion) {
  Write-Host "no new version, done"
  exit 0
}

Write-Host "new version available: $CurrentVersion -> $TargetVersion"
Write-Host "next: run the upgrade investigation per the DSH upgrade SOP (per-plugin subagent review)."
exit 0
