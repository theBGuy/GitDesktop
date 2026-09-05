<#
.SYNOPSIS
  Launch GitDesktop in cold-start test mode, a brand-new-user simulation for
  walking the onboarding flow.

.DESCRIPTION
  Boots `pnpm tauri dev` with the cold-start Vite flags set. The app then reads
  and writes only throwaway namespaces: coldstart-*.json store files, and API keys
  held in sessionStorage instead of the OS keychain. Your real settings, local PRs
  and API keys are never touched.

  Run a fresh repo (e.g. `git init` in a temp folder) inside it to see the
  unborn-repo "Make your first commit" state. Use -NoGit / -NoGh to exercise the
  GitMissingScreen and GitHub-not-connected empty states without uninstalling
  anything. Automations are off by default in cold-start mode; -Automations
  enables them.

.PARAMETER NoGit
  Force the "Git is not installed" screen.

.PARAMETER NoGh
  Force the "GitHub CLI not connected" empty states (Pull Requests / Actions).

.PARAMETER Automations
  Run automations in the cold instance. They are OFF by default in cold-start mode:
  the automation claims are shared with your real instance, so an armed cold instance
  can win a claim and suppress the real run's review. Pass this to enable them.

.PARAMETER Reset
  Delete the throwaway cold-start store files, then exit (does not launch). The
  per-instance WebView2 profiles under %TEMP%\gd-coldstart-* are left alone; delete
  those yourself if you want a sibling instance's browser state gone too.

.EXAMPLE
  ./scripts/cold-start.ps1
  ./scripts/cold-start.ps1 -NoGit
  ./scripts/cold-start.ps1 -NoGh
  ./scripts/cold-start.ps1 -Automations
  ./scripts/cold-start.ps1 -Reset
#>
[CmdletBinding()]
param(
  [switch]$NoGit,
  [switch]$NoGh,
  [switch]$Automations,
  [switch]$Reset
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

# Tauri app-data dir on Windows = %APPDATA%\<identifier>.
$dataDir = Join-Path $env:APPDATA "com.thebguy.gitdesktop"

if ($Reset) {
  $files = Get-ChildItem -Path $dataDir -Filter "coldstart-*.json" -ErrorAction SilentlyContinue
  if ($files) {
    $files | Remove-Item -Force
    Write-Host "Cleared $($files.Count) cold-start store file(s) in $dataDir" -ForegroundColor Green
  } else {
    Write-Host "No cold-start store files to clear in $dataDir" -ForegroundColor Yellow
  }
  Write-Host "Note: test API keys never reach the OS keychain; they live in sessionStorage and are gone the moment the cold-start window closes."
  return
}

$env:VITE_COLD_START = "1"
if ($NoGit) { $env:VITE_COLD_START_NO_GIT = "1" }
else { Remove-Item Env:\VITE_COLD_START_NO_GIT -ErrorAction SilentlyContinue }
if ($NoGh) { $env:VITE_COLD_START_NO_GH = "1" }
else { Remove-Item Env:\VITE_COLD_START_NO_GH -ErrorAction SilentlyContinue }
if ($Automations) { $env:VITE_COLD_START_AUTOMATIONS = "1" }
else { Remove-Item Env:\VITE_COLD_START_AUTOMATIONS -ErrorAction SilentlyContinue }
# A sibling launch may have left an id in this shell; the primary instance must not
# adopt it. WEBVIEW2_* stay untouched: operators set those to get a CDP port here.
Remove-Item Env:\GD_INSTANCE_ID -ErrorAction SilentlyContinue

Write-Host "Launching GitDesktop in COLD-START test mode" -ForegroundColor Cyan
Write-Host "  NoGit = $NoGit   NoGh = $NoGh   Automations = $Automations" -ForegroundColor Cyan
Write-Host "  Real settings / local PRs / API keys are untouched." -ForegroundColor DarkGray

# The script runs in-process, so the flags above (and a Set-Location) would outlive
# it in the calling shell, and a later bare `pnpm tauri dev` there would silently
# boot a cold instance. The finally restores the whole shell state on exit.
try {
  Push-Location $repoRoot
  pnpm tauri dev
} finally {
  Pop-Location
  Remove-Item Env:\VITE_COLD_START, Env:\VITE_COLD_START_NO_GIT, Env:\VITE_COLD_START_NO_GH, Env:\VITE_COLD_START_AUTOMATIONS -ErrorAction SilentlyContinue
}
