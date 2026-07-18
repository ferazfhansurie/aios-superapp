<#
.SYNOPSIS
  Launch AIOS (Cockpit) on Windows - one command.

.DESCRIPTION
  Installs frontend deps on first run (or after dependency changes), then starts
  the Tauri dev app (Vite + Rust backend, hot-reload). First Rust build takes a
  few minutes; subsequent launches are fast (cached).

  ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII
  characters would corrupt parsing. Keep this file ASCII.

.PARAMETER Build
  Produce a distributable installer (.msi/.exe) instead of running dev.
#>
param([switch]$Build)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Say($msg) { Write-Host ">> $msg" -ForegroundColor Cyan }

# Install deps if node_modules is missing or package.json is newer than it.
$needInstall = $true
if (Test-Path "node_modules") {
  $pkg = (Get-Item "package.json").LastWriteTime
  $nm = (Get-Item "node_modules").LastWriteTime
  if ($nm -ge $pkg) { $needInstall = $false }
}
if ($needInstall) {
  Say "installing frontend deps (npm)..."
  npm install --no-audit --no-fund
}

if ($Build) {
  Say "building release installer (this takes a while)..."
  npx tauri build
  Say "done - installers under src-tauri\target\release\bundle\"
} else {
  Say "starting AIOS (dev)... first Rust build is slow, then cached."
  npx tauri dev
}
