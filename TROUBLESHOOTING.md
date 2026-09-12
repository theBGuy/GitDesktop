# Troubleshooting

How to collect diagnostics when GitDesktop misbehaves, so a
[bug report](https://github.com/theBGuy/GitDesktop/issues/new?template=bug_report.yml)
has something to work from. Everything here applies to a normal installed release; none
of it needs a development setup.

Redact tokens, secrets, and private repository paths before pasting anything.

## The app closes by itself

When the window disappears with no error, the operating system recorded why. That record
is usually enough to identify the fault.

### Windows

Run this in PowerShell (no admin needed):

```powershell
$ev = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'} -MaxEvents 50 -ErrorAction SilentlyContinue |
      Where-Object { $_.Message -match 'gitdesktop' }
if ($ev) {
  $ev | Select-Object -First 3 TimeCreated, @{n='Details';e={ ($_.Message -split "`r?`n" | Select-Object -First 5) -join ' ' }} | Format-List
} else {
  Write-Output "No GitDesktop crash entries found in the Application log."
}
```

It prints entries like:

```
TimeCreated : 9/10/2026 11:58:47 AM
Details     : Faulting application name: gitdesktop.exe, version: 0.12.1.0 ...
              Exception code: 0xc00000fd Fault offset: 0x00000000028e56e7
```

Paste the **exception code** and **fault offset** into the issue. Those two values often
pin the fault on their own. The same entries are visible in Event Viewer
(`eventvwr.msc`) under *Windows Logs → Application*, filtered to source
*Application Error*.

If a maintainer asks for a crash dump, Windows can write one to
`%LOCALAPPDATA%\CrashDumps`, but **only after dump collection is switched on** — the
folder is absent or empty on a default install. Microsoft documents the registry
settings under
[Collecting User-Mode Dumps](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps).

### macOS

Crash reports land in `~/Library/Logs/DiagnosticReports/` as `GitDesktop-*.ips` files,
newest last. Console.app shows the same reports under *Crash Reports*. Attach the
newest file that matches the time of the crash.

### Linux

If the distribution uses systemd:

```sh
coredumpctl list gitdesktop
coredumpctl info gitdesktop   # most recent crash, with a backtrace
```

Otherwise, launching the binary from a terminal captures anything it prints before
dying:

```sh
gitdesktop 2>&1 | tee gitdesktop.log
```

## Inspecting the interface (Windows)

Released builds ship without the built-in web inspector, so right-click → Inspect is not
available. On Windows the underlying WebView2 runtime can still expose a debugging port,
which works on the shipped binary with no special build:

```powershell
# 1. Close every GitDesktop window first (see the note below).
$exe = @(
  "$env:LOCALAPPDATA\Programs\gitdesktop\gitdesktop.exe",
  "$env:ProgramFiles\gitdesktop\gitdesktop.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
& $exe
```

Then open `http://localhost:9222` in Edge or Chrome and pick the GitDesktop page. That
gives the usual DevTools, including the Console and Network tabs. Reproduce the problem
with DevTools open and copy anything red from the Console.

> **Close every GitDesktop window before running this.** All GitDesktop instances share
> one WebView2 profile, and the debugging flag only takes effect when that runtime
> starts. Launching while another copy is already open silently gives you no port.

The environment variable lasts for that PowerShell window only, so a normal launch from
the Start menu is unaffected.

Note that a fault in the Rust half of the app will not appear in the Console at all. If
DevTools shows nothing and the app still exits, the crash log above is the useful
artifact.

## Something is missing or degraded rather than crashing

Several features shell out to external tools, and they quietly reduce functionality when
one is missing, outdated, or signed out. **Settings → About** lists every tool
GitDesktop depends on with its version, path, and sign-in state, and links to a download
for anything missing. Include that list when a GitHub, GitLab, or AI feature behaves
unexpectedly.

## Filing the report

Open a [bug report](https://github.com/theBGuy/GitDesktop/issues/new?template=bug_report.yml)
with the version from Settings → About, your operating system, the steps that trigger
it, and whichever diagnostic above applied. Security vulnerabilities go through
[SECURITY.md](SECURITY.md) instead.
