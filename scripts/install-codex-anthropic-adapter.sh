#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.aios/state/codex-anthropic-adapter"
PLIST="$HOME/Library/LaunchAgents/com.aios.codex-anthropic-adapter.plist"
NODE="$(command -v node)"
CODEX="$(command -v codex)"
mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
chmod 700 "$STATE"
if [[ ! -f "$STATE/secret" ]]; then
  openssl rand -hex 32 > "$STATE/secret"
fi
chmod 600 "$STATE/secret"

/usr/libexec/PlistBuddy -c "Clear dict" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :Label string com.aios.codex-anthropic-adapter" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string $NODE" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string $ROOT/scripts/codex-anthropic-adapter.mjs" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:AIOS_CODEX_ADAPTER_SECRET_FILE string $STATE/secret" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:AIOS_CODEX_ADAPTER_PORT string 8791" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:AIOS_CODEX_BIN string $CODEX" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PATH string $(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 5" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $STATE/adapter.log" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $STATE/adapter.error.log" "$PLIST"
chmod 644 "$PLIST"

launchctl bootout "gui/$UID/com.aios.codex-anthropic-adapter" 2>/dev/null || true
sleep 0.25
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/com.aios.codex-anthropic-adapter"

echo "installed: http://127.0.0.1:8791"
echo "launch Claude Code through: $ROOT/scripts/claude-via-codex"
