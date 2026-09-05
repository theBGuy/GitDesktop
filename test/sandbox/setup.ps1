<#
  Runs inside Windows Sandbox at logon (invoked by onboarding.wsb).

  Installs GitDesktop into a genuinely bare Windows: no git, no gh, no keychain
  entries, no app data: the real cold start a brand-new user gets. The NSIS
  installer pulls in the WebView2 runtime if it's missing (the sandbox has
  internet by default).

  To walk *past* the "Git is not installed" screen, drop a Git-for-Windows
  installer into  test\sandbox\tools\  on the host before launching; it gets
  mapped to C:\Setup\tools and installed here too.
#>
$ErrorActionPreference = "Continue"

function Find-First($root, $pattern) {
  Get-ChildItem -Path $root -Recurse -Filter $pattern -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

Write-Host "=== GitDesktop onboarding sandbox ===" -ForegroundColor Cyan

# 1. Install GitDesktop from the host-built bundle (NSIS preferred, else MSI).
$nsis = Find-First "C:\Installer\nsis" "*-setup.exe"
if (-not $nsis) { $nsis = Find-First "C:\Installer" "*-setup.exe" }
$msi = Find-First "C:\Installer\msi" "*.msi"

if ($nsis) {
  Write-Host "Installing $($nsis.Name) (NSIS, silent)..." -ForegroundColor Green
  Start-Process -FilePath $nsis.FullName -ArgumentList "/S" -Wait
} elseif ($msi) {
  Write-Host "Installing $($msi.Name) (MSI, passive)..." -ForegroundColor Green
  Start-Process msiexec.exe -ArgumentList "/i `"$($msi.FullName)`" /qb" -Wait
} else {
  Write-Warning "No installer found under C:\Installer. Run 'pnpm tauri build' on the host first, then relaunch the sandbox."
}

# 2. Optional: install git so the walkthrough can continue past GitMissingScreen.
$git = Find-First "C:\Setup\tools" "Git-*.exe"
if ($git) {
  Write-Host "Installing $($git.Name) (silent)..." -ForegroundColor Green
  Start-Process -FilePath $git.FullName -ArgumentList "/VERYSILENT","/NORESTART" -Wait
} else {
  Write-Host "No git installer in C:\Setup\tools; you'll see the 'Git is not installed' screen (that's the first onboarding surface)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Ready. Launch GitDesktop from the Start menu / desktop shortcut." -ForegroundColor Cyan
Write-Host "Genuine first-run journey: Git missing -> (install git) -> fresh welcome -> create/open a repo -> first commit." -ForegroundColor DarkGray
