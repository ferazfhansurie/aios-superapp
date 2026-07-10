#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle_app="$root/src-tauri/target/release/bundle/macos/AIOS.app"
installed_app="/Applications/AIOS.app"
stable_requirement='=designated => identifier "com.adletic.aios"'

cd "$root"

npm run tauri -- build --bundles app --no-sign

if [[ ! -d "$bundle_app" ]]; then
  echo "missing bundle: $bundle_app" >&2
  exit 1
fi

codesign --force --deep --sign - --requirements "$stable_requirement" "$bundle_app"
codesign --verify --deep --strict "$bundle_app"

# -f: macOS registers GUI apps under their full executable path, so a bare
# `pkill -x aios-shell` never matches and the old instance survives the install.
pkill -f "$installed_app/Contents/MacOS/aios-shell" 2>/dev/null || true

if [[ -d "$installed_app" ]]; then
  backup="/Applications/AIOS.previous-install-$(date +%Y%m%d-%H%M%S).app"
  mv "$installed_app" "$backup"
  echo "backed up previous install: $backup"
fi

ditto "$bundle_app" "$installed_app"
codesign --verify --deep --strict "$installed_app"
codesign -d -r- "$installed_app"
open -a "$installed_app"
