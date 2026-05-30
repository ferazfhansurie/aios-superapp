# AIOS shell — session handoff (2026-05-30)

Transfer brief for a fresh Claude session. Read this top-to-bottom, then continue.

## What this is
**AIOS superapp** — Tauri v2 + React + TS + Tailwind v4 desktop cockpit at
`~/Repo/firaz/aios/shell`. The "no more vscode" daily driver: ONE chat that sees
any pane, acts anywhere, connects every messaging channel. Multi-pane: chat /
terminal / browser / files / customers-inbox / motionboards-studio / oracles.

- build: `pnpm tauri build` (run from `~/Repo/firaz/aios/shell`)
- bundle out: `src-tauri/target/release/bundle/macos/AIOS.app` (+ dmg)
- identifier `com.adletic.aios`, productName/title "AIOS"
- WA replies to firaz: `nohup ~/Repo/firaz/aios/bridge/scripts/push.js "<text>" >/dev/null 2>&1 & disown`
  (every reply MUST go through push.js — terminal text output is invisible to him on WA)

## 🔴 ACTIVE BUG — app dies instantly on launch (UNSOLVED, was mid-debug)
Symptom: `open /Applications/AIOS.app` → process appears then dies within ~3s.
Run foreground (`/Applications/AIOS.app/Contents/MacOS/aios-shell`) → dies with
**zero stdout/stderr and no crash report** = killed pre-`main` (signing/entitlements),
NOT a Rust panic (a panic would print).

Diagnosis so far:
1. `spctl` reported: `code has no resources but signature indicates they must be
   present` → the `cp -R` install to /Applications **broke the code-signature seal**.
2. Re-signed ad-hoc: `codesign --force --deep --sign - /Applications/AIOS.app`
   → `codesign --verify` now says **valid on disk + satisfies Designated Requirement**…
3. …**but it STILL dies on launch.** So signing was *a* problem, not the whole one.

**Leading hypothesis (untested):** `--force --deep --sign -` **stripped the
entitlements** the Tauri build embedded (webview / mic getUserMedia / asset
protocol). Ad-hoc resign without `--entitlements <plist>` drops them → hardened-
runtime/entitlement mismatch kills it pre-main.

**Next diagnostic steps (do these):**
- Get the real kill reason: `log show --last 2m --predicate 'process == "aios-shell"' --info` (or `log stream` while launching). Look for amfid / taskgated / CODESIGNING / "Library Validation" / killed.
- Check `~/Library/Logs/DiagnosticReports/` again right after a death.
- Run the **pristine build bundle** binary directly (NOT the /Applications copy):
  `src-tauri/target/release/bundle/macos/AIOS.app/Contents/MacOS/aios-shell` — if
  THAT stays alive, the install copy/resign is the culprit.
- **Likely fix:** reinstall signature-safe with `ditto` (not `cp -R`):
  `ditto <build>/AIOS.app /Applications/AIOS.app`, OR re-sign WITH entitlements:
  find the Tauri entitlements plist (`src-tauri/` or generated under `target`), then
  `codesign --force --options runtime --entitlements <plist> --deep --sign - /Applications/AIOS.app`.
- Then **verify it survives a quit→relaunch cycle** (the bug only showed on relaunch;
  first post-build launch worked — pid was alive earlier this session).

## ✅ Shipped this session (committed `82bca4e` in `~/Repo/firaz/aios/shell`)
1. **chat-only `/resume`** — `/resume` in the chat pane lists ONLY chats started in
   the chat pane (store: `~/.aios/state/chat-sessions.json`), and OPENS the actual
   conversation: `read_chat_transcript` repaints prior turns + `--resume <id>`
   continues it (NOT a generic `--continue`). Backend in `src-tauri/src/chat.rs`
   (`record_chat_session`/`list_chat_sessions`/`read_chat_transcript`), TS wrappers
   in `src/lib/chat.ts`, UI in `src/components/ChatPane.tsx` (ResumePicker +
   recordChatSession on first send via claudeSessionIdRef/recordedRef).
2. **MotionBoards key fallback** — `src-tauri/src/motion.rs` reads
   `~/.aios/state/motion.key` when env vars absent (GUI has no shell env). Key
   `mb_ebc8254c2be7f7bc6b206471c4486c56` written there (chmod 600). Verified: motion
   API returns HTTP 200 with it → studio pane pulls models + credits for real.
3. **Codex-style activity rendering** in ChatPane — collapses tool spam into
   "Worked for Xs ›" + a live "Working…" timer (fixes the "is it stuck / will it
   reply" feeling). ActivityGroup / ActivityStep / FileCard components.

State of tree: `tsc --noEmit` clean, `cargo check` clean (one harmless unused-PathBuf
warning), built + committed. The BUG is purely an install/signing issue, not a code bug.

## 🟡 OPEN TASK — rename "AIOS" → marketable product name (firaz interrupted to fix app)
"AIOS" is a generic acronym (collides with many "ai os" projects, unprotectable).
Two thorough WebSearch rounds done. **The english/global AI namespace is a graveyard** —
every strong concrete word is taken by a funded competitor:
- helm → gethelm.ai = "the agency OS, staffed by AI" (near-clone) · onyx → YC/Khosla
  OSS AI chat · otto → trademark minefield · juno → 5+ AI products · orin → nvidia
  jetson · nadi → nadiai.ai "AI agents for enterprise" · pier/foreman/kawan/cipta → crowded.

Strategy doc (`~/.aios/state/context/SOUL-strategy.md`) reframes: **wallet = SEA
business owners**, brand = "AI co-founder", build-in-public, lowercase. Ownable lane =
SEA-native name that doubles as a global brand-word (grab/gojek/shopee precedent).

**Three verified ZERO-collision survivors** (presented via AskUserQuestion — firaz
did NOT pick, he interrupted to fix the app, so naming is STILL OPEN):
- **Wira** — malay hero/champion. aspirational, cleanest, globally-pronounceable. (was my rec)
- **Teman** — malay companion/friend. most on-brand for "co-founder", warmest.
- **Sigap** — malay ready/agile/acts-fast. names the product behavior, most unique.

Next: re-offer once app is fixed; OR if firaz wants english/global, coin + verify a
fresh batch (the strong common words are burned, so coined/abstract is the english path).
Once a name is picked it threads through: productName/title (`tauri.conf.json`),
identifier, the in-app wordmark (`src/App.tsx` header "aios"/"superapp"), DESIGN.md.

## Queue (deferred, in priority order)
1. **Pane resize** — drag each pane's dimensions. Top of queue, explicitly deferred as a
   dedicated layout pass. Firaz asked twice. Start here after the app launches clean (confirm w/ him).
2. **Second Codex study round** — re-study Codex's UX after the activity-rendering changes.
3. **Windows portability** — tmux / screencapture / avfoundation / launchctl are macOS-only.

## Known gaps
- Settings only partially wired (terminalFontSize/density/reduce-motion attrs set, but
  TerminalPane still hardcodes font size 13).
- No code-signing/notarization (hence the ad-hoc install fragility above).

## Voice / working rules (CLAUDE.md)
Lowercase, no exclaim, sharp + direct, action-first. Co-founder not help-desk. Fan out
2+ independent tasks via Agent tool in ONE message (background by default). Confirm before
prod DB writes. Date: check system reminder.
