<#
.SYNOPSIS
  The "AIOS" desktop app launcher: pull firaz's latest, then open the app.

.DESCRIPTION
  This is what the Desktop "AIOS" icon runs. Every time you open the app it:
    1. fetches origin and, if firaz pushed, auto-merges his commits into your branch
       (auto-resolving the known pnpm-lock conflict; backing out of real conflicts)
    2. installs deps only when package.json changed
    3. launches the app (Tauri dev — hot, always-latest source)
  So "reopen app" == "open the newest version". Up-to-date launches are instant;
  a launch right after firaz changed Rust recompiles once (then cached).

  Safe: the sync is read+merge only (never pushes); if you have uncommitted work
  or there's a real conflict, it SKIPS the merge and launches what you have, so
  the app always opens.
#>
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Say($m) { Write-Host "▸ $m" -ForegroundColor Cyan }

# ── 1. sync latest from firaz (best-effort; never blocks the launch) ───────────
try {
  Say "checking for updates from firaz..."
  git fetch origin --quiet 2>$null
  $incoming = (git rev-list --count "HEAD..origin/master" 2>$null).Trim()
  if ($incoming -and $incoming -ne "0") {
    if (git status --porcelain) {
      Say "$incoming update(s) available but you have uncommitted changes — launching your version. (run scripts\aios-sync.ps1 to merge.)"
    } else {
      Say "pulling $incoming new commit(s)..."
      git merge --no-edit origin/master 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        $conflicts = git diff --name-only --diff-filter=U 2>$null
        $real = $conflicts | Where-Object { $_ -and $_ -ne "pnpm-lock.yaml" }
        if ($real) {
          Say "a real conflict needs you ($($real -join ', ')) — launching your current version."
          git merge --abort 2>$null
        } elseif ($conflicts -contains "pnpm-lock.yaml") {
          git rm -f pnpm-lock.yaml 2>$null | Out-Null
          git commit --no-edit 2>$null | Out-Null
          Say "merged + auto-resolved lockfile."
        }
      } else {
        Say "updated to latest."
      }
    }
  } else {
    Say "already on the latest."
  }
} catch {
  Say "update check skipped ($_) — launching anyway."
}

# ── 2. install deps only when package.json is newer than node_modules ──────────
$needInstall = $true
if (Test-Path "node_modules") {
  if ((Get-Item "node_modules").LastWriteTime -ge (Get-Item "package.json").LastWriteTime) {
    $needInstall = $false
  }
}
if ($needInstall) { Say "installing deps..."; npm install --no-audit --no-fund }

# ── 3. launch the app ─────────────────────────────────────────────────────────
Say "launching AIOS... (first build after an update takes a moment, then cached)"
npx tauri dev
