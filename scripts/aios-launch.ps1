<#
.SYNOPSIS
  The "AIOS" desktop app launcher: open the app (your current code, no auto-sync).

.DESCRIPTION
  This is what the Desktop "AIOS" icon runs. It:
    1. installs deps only when package.json changed
    2. launches the app (Tauri dev - hot reload of your local source)
  It does NOT fetch or merge anything from firaz's upstream - you stay on exactly
  your own code. To pull firaz's updates deliberately, run scripts\aios-sync.ps1.

  ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII
  characters would corrupt parsing. Keep this file ASCII.
#>
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Say($m) { Write-Host ">> $m" -ForegroundColor Cyan }

# 1. install deps only when package.json is newer than node_modules
$needInstall = $true
if (Test-Path "node_modules") {
  if ((Get-Item "node_modules").LastWriteTime -ge (Get-Item "package.json").LastWriteTime) {
    $needInstall = $false
  }
}
if ($needInstall) { Say "installing deps..."; npm install --no-audit --no-fund }

# 2. launch the app (your local source only)
Say "launching AIOS..."
npx tauri dev
