<#
.SYNOPSIS
  Auto-watcher: poll origin for firaz's updates and pull them into this branch.

.DESCRIPTION
  Firaz pushes to origin/master constantly. This loops forever, checking every
  few minutes; when he's pushed new commits it auto-merges them into our branch,
  reinstalls deps, and rebuilds - so we always have the latest with zero manual
  steps. Leave it running in a terminal (or install it as a scheduled task with
  -Install). It is SAFE:
    - never pushes (read + merge only); you publish with aios-sync.ps1 -Push
    - auto-resolves the known pnpm-lock.yaml conflict (we use npm)
    - on a REAL conflict (firaz changed the same lines we did) it backs out and
      keeps watching - so it never leaves a half-merged tree.
    - skips the merge if you have uncommitted work (won't clobber you)

  ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII
  characters would corrupt parsing. Keep this file ASCII.

.PARAMETER IntervalSeconds
  Seconds between checks. Default 300 (5 min).

.PARAMETER Once
  Check once and exit (what the scheduled task uses).

.PARAMETER Install
  Register a Windows Scheduled Task that runs this every 15 min in the background.

.PARAMETER Uninstall
  Remove the scheduled task.

.EXAMPLE
  .\scripts\aios-watch.ps1                 # watch in this terminal (5-min loop)
  .\scripts\aios-watch.ps1 -Install        # run forever in the background
  .\scripts\aios-watch.ps1 -Once           # one check (for the scheduler)
#>
param(
  [int]$IntervalSeconds = 300,
  [switch]$Once,
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $repo "scripts\aios-watch.log"
$taskName = "AIOS-Watch-Upstream"

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
  Write-Host $line
  Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

# Install / uninstall as a Scheduled Task.
if ($Install) {
  $pwsh = (Get-Process -Id $PID).Path  # the powershell/pwsh running this
  $action = New-ScheduledTaskAction -Execute $pwsh `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Once"
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 15)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Description "Pull firaz's aios-shell updates every 15 min" -Force | Out-Null
  Log "installed scheduled task '$taskName' (every 15 min). Log: $logFile"
  Write-Host "Installed. It now syncs in the background. Remove with: .\scripts\aios-watch.ps1 -Uninstall" -ForegroundColor Green
  exit 0
}
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Log "uninstalled scheduled task '$taskName'"
  Write-Host "Removed the background watcher." -ForegroundColor Green
  exit 0
}

# One check: fetch, and if there are new commits, merge + rebuild.
function Sync-Once {
  Set-Location $repo
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()

  git fetch origin --quiet 2>$null
  $incoming = (git rev-list --count "HEAD..origin/master" 2>$null)
  if ($incoming) { $incoming = $incoming.Trim() } else { $incoming = "0" }

  if ($incoming -eq "0") {
    Log "up to date ($branch)."
    return
  }

  # Don't merge over uncommitted work - would risk clobbering you.
  if (git status --porcelain) {
    Log "firaz has $incoming new commit(s) but you have uncommitted changes - skipping. Commit/stash, then run .\scripts\aios-sync.ps1"
    return
  }

  Log "firaz pushed $incoming new commit(s) - merging into $branch..."
  git merge --no-edit origin/master 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    # Auto-resolve only the expected pnpm-lock.yaml conflict; bail on anything else.
    $conflicts = git diff --name-only --diff-filter=U 2>$null
    $real = $conflicts | Where-Object { $_ -and $_ -ne "pnpm-lock.yaml" }
    if ($real) {
      Log ("REAL conflict(s) - needs you: " + ($real -join ', ') + ". Aborting merge, will retry next cycle.")
      git merge --abort 2>$null
      return
    }
    if ($conflicts -contains "pnpm-lock.yaml") {
      git rm -f pnpm-lock.yaml 2>$null | Out-Null
      git commit --no-edit 2>$null | Out-Null
      Log "auto-resolved pnpm-lock.yaml (we use npm)."
    }
  }

  # Refresh deps + verify it still builds, so a bad pull is caught immediately.
  Log "installing deps (npm)..."
  npm install --no-audit --no-fund *> $null
  Log "type-checking..."
  npx tsc --noEmit *> $null
  $tscOk = ($LASTEXITCODE -eq 0)
  Log "compiling backend..."
  Push-Location src-tauri
  cargo build --color never *> $null
  $cargoOk = ($LASTEXITCODE -eq 0)
  Pop-Location

  if ($tscOk -and $cargoOk) {
    Log "synced + rebuilt clean. Relaunch (.\scripts\run.ps1) to use the update."
  } else {
    Log "merged firaz's $incoming commit(s) but the build needs a Windows tweak (tsc=$tscOk cargo=$cargoOk). Open the repo and fix."
  }
}

if ($Once) { Sync-Once; exit 0 }

# Foreground loop.
Log "watching origin/master every $([int]($IntervalSeconds/60)) min. Ctrl+C to stop. (Background option: -Install)"
while ($true) {
  try { Sync-Once } catch { Log "error: $_" }
  Start-Sleep -Seconds $IntervalSeconds
}
