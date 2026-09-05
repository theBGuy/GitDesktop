<#
.SYNOPSIS
  Launch ONE additional cold-start instance, with its own isolated state, against
  an already-running cold-start dev server.

.DESCRIPTION
  Starts an already-built debug exe and points it at a cold-start Vite server that
  is already up. It never builds and never starts Vite: run `./scripts/cold-start.ps1`
  first, wait for the window, then run this once per extra instance you want.

  The -Id is exported as GD_INSTANCE_ID. The app reads it at boot and namespaces its
  throwaway stores `coldstart-<Id>-<name>.json`, so parallel cold instances never
  share settings, local PRs, notifications or branch rules. An instance launched
  without an id keeps the plain `coldstart-<name>.json` files.

  Each instance NEEDS its own -DataRoot. Without one, WebView2 silently attaches to
  a sibling instance's browser process and this instance's remote-debugging port
  never opens.

  -Id, -DebugPort and -DataRoot must be unique across every cold instance running on
  the MACHINE, whichever worktree built it. All builds share the app identifier, so
  they all write %APPDATA%\com.thebguy.gitdesktop — two worktrees each launching
  `-Id a` land in the same coldstart-a-*.json files and clobber each other.

  The exe must belong to a COLD-START Vite server. Cold start is a build-time Vite
  flag, so under a normal `pnpm tauri dev` the id is ignored by design and the
  instance reads your REAL data.

  Automations follow the VITE server's flags (-Automations on cold-start.ps1), not
  this script: every instance that server feeds inherits the same setting.

.PARAMETER Id
  Instance id, matching ^[A-Za-z0-9-]{1,32}$. It becomes part of the store filenames.

.PARAMETER DebugPort
  Remote-debugging (CDP) port for this instance. Must not already be listening.

.PARAMETER ExePath
  The already-built debug exe. Defaults to src-tauri\target\debug\gitdesktop.exe.

.PARAMETER DataRoot
  WebView2 user-data folder for this instance. Defaults to %TEMP%\gd-coldstart-<Id>.

.EXAMPLE
  ./scripts/cold-start-instance.ps1 -Id b -DebugPort 9223
  ./scripts/cold-start-instance.ps1 -Id c -DebugPort 9224 -DataRoot D:\temp\gd-c
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Id,
  [Parameter(Mandatory)][int]$DebugPort,
  [string]$ExePath,
  [string]$DataRoot
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $ExePath) { $ExePath = "$repoRoot\src-tauri\target\debug\gitdesktop.exe" }
if (-not $DataRoot) { $DataRoot = Join-Path $env:TEMP "gd-coldstart-$Id" }

if ($Id -notmatch '^[A-Za-z0-9-]{1,32}$') {
  throw "Invalid -Id '$Id'. It becomes part of the store filenames (coldstart-$Id-settings.json), so only letters, digits and hyphens are allowed, 1-32 characters."
}
if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "No exe at $ExePath. This script never builds — start ./scripts/cold-start.ps1 first and let it finish building."
}
if (Get-NetTCPConnection -LocalPort $DebugPort -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $DebugPort is already listening. Give each instance its own free -DebugPort."
}

$env:GD_INSTANCE_ID = $Id
$env:WEBVIEW2_USER_DATA_FOLDER = $DataRoot
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort"

# Hidden hides only the console (debug exes are console-subsystem; the GUI window
# shows itself regardless). Sibling stdout is lost — the watcher instance keeps logs.
$proc = Start-Process $ExePath -WindowStyle Hidden -PassThru

Write-Host "Launched cold-start instance '$Id'" -ForegroundColor Cyan
Write-Host "  pid        = $($proc.Id)"
Write-Host "  stores     = coldstart-$Id-*.json"
Write-Host "  debug port = $DebugPort"
Write-Host "  data root  = $DataRoot"
