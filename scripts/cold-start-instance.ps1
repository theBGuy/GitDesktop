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
  they all write %APPDATA%\com.thebguy.gitdesktop: two worktrees each launching
  `-Id a` land in the same coldstart-a-*.json files and clobber each other.

  The exe must belong to a COLD-START Vite server. Cold start is a build-time Vite
  flag, so under a normal `pnpm tauri dev` the id is ignored by design and the
  instance reads your REAL data. -DevPort is checked for a listening dev server,
  which proves one EXISTS but cannot prove it is a cold-start one: the flag lives in
  the modules Vite serves and is not detectable from outside. That check is yours.

  Automations follow the VITE server's flags (-Automations on cold-start.ps1), not
  this script: every instance that server feeds inherits the same setting.

.PARAMETER Id
  Instance id, matching ^[a-z0-9-]{1,32}\z: lowercase letters, digits and hyphens.
  It becomes part of the store filenames, and those are case-insensitive on disk, so
  ids have to be unique case-insensitively.

.PARAMETER DebugPort
  Remote-debugging (CDP) port for this instance. Must not already be listening.

.PARAMETER DevPort
  Port the cold-start Vite server is already serving on. Defaults to 1420; a worktree
  build serves its own port, so pass -DevPort 1430 for one of those.

.PARAMETER ExePath
  The already-built debug exe. Defaults to src-tauri\target\debug\gitdesktop.exe.
  Debug builds only: a release exe hands the launch to the instance already running
  (the single-instance plugin) instead of opening a second window.

.PARAMETER DataRoot
  WebView2 user-data folder for this instance. Defaults to %TEMP%\gd-coldstart-<Id>.

.EXAMPLE
  ./scripts/cold-start-instance.ps1 -Id b -DebugPort 9223
  ./scripts/cold-start-instance.ps1 -Id c -DebugPort 9224 -DevPort 1430
  ./scripts/cold-start-instance.ps1 -Id d -DebugPort 9225 -DataRoot D:\temp\gd-d
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Id,
  [Parameter(Mandatory)][ValidateRange(1024, 65535)][int]$DebugPort,
  [ValidateRange(1024, 65535)][int]$DevPort = 1420,
  [string]$ExePath,
  [string]$DataRoot
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $ExePath) { $ExePath = "$repoRoot\src-tauri\target\debug\gitdesktop.exe" }
if (-not $DataRoot) { $DataRoot = Join-Path $env:TEMP "gd-coldstart-$Id" }

# -cnotmatch, not -notmatch: PowerShell's default match operators are case-INSENSITIVE,
# which would let -Id A through here and leave the Rust validator to reject it, silently
# dropping the instance back onto the shared coldstart- store files.
if ($Id -cnotmatch '^[a-z0-9-]{1,32}\z') {
  throw "Invalid -Id '$Id'. It becomes part of the store filenames (coldstart-$Id-settings.json), so only lowercase letters, digits and hyphens are allowed, 1-32 characters. Those filenames are case-insensitive on disk, so ids must be unique case-insensitively."
}
if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "No exe at $ExePath. This script never builds; start ./scripts/cold-start.ps1 first and let it finish building."
}
if (Get-NetTCPConnection -LocalPort $DebugPort -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $DebugPort is already listening. Give each instance its own free -DebugPort."
}
if (-not (Get-NetTCPConnection -LocalPort $DevPort -State Listen -ErrorAction SilentlyContinue)) {
  throw "Nothing is listening on dev port $DevPort. Start ./scripts/cold-start.ps1 first and wait for its window; a worktree build serves its own port, so pass -DevPort 1430 for one of those."
}

# WebView2 keys its browser process on the user-data folder, so a launch pointed at a
# live one silently attaches to that instance and this -DebugPort never opens. The
# compare is extracted-arg equality or separator-bounded prefix (the browser appends
# \EBWebView), never substring: gd-coldstart-b must not match inside gd-coldstart-b2.
$dataRootKey = $DataRoot.TrimEnd('\', '/').ToLowerInvariant()
$attached = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    if (-not $_.CommandLine) { return $false }
    if ($_.CommandLine -notmatch '--user-data-dir=(?:"([^"]*)"|(\S+))') { return $false }
    $val = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    $val = $val.TrimEnd('\', '/').ToLowerInvariant()
    $val -eq $dataRootKey -or $val.StartsWith("$dataRootKey\")
  })
if ($attached.Count -gt 0) {
  throw "A WebView2 process (pid $($attached[0].ProcessId)) already owns $DataRoot. Launching now would attach to that instance's browser instead of opening -DebugPort $DebugPort. Use a different -Id, or close that instance first."
}

$env:GD_INSTANCE_ID = $Id
$env:WEBVIEW2_USER_DATA_FOLDER = $DataRoot
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort"

# Hidden hides only the console (debug exes are console-subsystem; the GUI window
# shows itself regardless). Sibling stdout is lost; the watcher instance keeps logs.
$proc = Start-Process $ExePath -WindowStyle Hidden -PassThru

# Start-Process snapshots the child's env at spawn, so clearing now is safe, and it has
# to happen: a later cold-start.ps1 in this shell would inherit a sibling's identity.
Remove-Item Env:\GD_INSTANCE_ID -ErrorAction SilentlyContinue
Remove-Item Env:\WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
Remove-Item Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue

Write-Host "Launched cold-start instance '$Id'" -ForegroundColor Cyan
Write-Host "  pid        = $($proc.Id)"
Write-Host "  stores     = coldstart-$Id-*.json"
Write-Host "  debug port = $DebugPort"
Write-Host "  data root  = $DataRoot"
