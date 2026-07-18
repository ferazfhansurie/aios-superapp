# PRUNE-LIST — AIOS shell dead-weight audit

> Read-only audit, 2026-06-06. Grep-verified. **Nothing edited/deleted.**
> Scope lock (firaz): first-class panes = **chat, terminal, files, browser**;
> also keep **notes** + **codex**. Everything else is prune candidate.
>
> Caveat: `ChatPane.tsx` / `chat.rs` are being edited by another agent — line
> numbers for those two may drift; the *facts* about them below are stable.

---

## 0. Architecture recap (how a pane is wired)

Each pane kind threads through **5 places**. A clean DELETE removes all five:

1. `src/lib/apps.ts` — `PaneContent` union member **+** `SPAWN[]` catalog entry (+ `SPAWN_BY_ID` derives automatically).
2. `src/App.tsx` — `lazy(() => import(...))` declaration (≈ lines 156-189) **+** the render-switch branch (≈ lines 3304-3372).
3. `src/components/<Pane>.tsx` — the component itself.
4. `src/lib/<feature>.ts` — its data/IPC module (if not shared).
5. `src-tauri/src/<feature>.rs` — backend module + `mod` line + `generate_handler![]` entries in `lib.rs` (if not shared).

The sidebar **seeds every `SPAWN` entry by default** (`sidebar.ts seedDefault()` maps all of `SPAWN`). So **removing the `SPAWN` entry alone = HIDE** (gone from default sidebar, type/render still compile). Full DELETE = pull all 5 layers.

**Self-contained confirmed:** shell imports nothing from sibling dirs (`app/ app-web/ crm/ desktop/ flagship/ hud/`).
Grep: `rg "aios/(app|crm|desktop|hud|flagship)" src src-tauri` → 0 hits. Leave siblings as a separate firaz decision.

---

## TIER 1 — ZERO-RISK DELETES (provably unreferenced)

These have **zero inbound imports / zero invoke sites**. Safe to remove with no chain.

### 1.1 `src/lib/providers.ts` — fully orphaned module
- **Proof:** `rg "from .*providers|import\(.*providers" --glob '*.ts' --glob '*.tsx' src` → **0 hits** (the only mention is `chat.ts` being imported BY providers, reverse direction). No test file either.
- 215+ LOC of `PROVIDERS[]` data + helpers, never consumed.
- **DELETE** `src/lib/providers.ts`. No other change needed.

### 1.2 `src/lib/commands.ts` — orphaned except its own test
- **Proof:** only inbound = `src/lib/commands.test.ts`. App uses `appCommands.ts` (the real command source) + `CommandPalette.tsx`; `commands.ts` (`createCommand/runCommand/commandToPaletteCommand`) is referenced nowhere in app code.
- **DELETE** `src/lib/commands.ts` **+** `src/lib/commands.test.ts`, and remove `src/lib/commands.test.ts` from the `test:chatpane` script in `package.json`.

### 1.3 `package.json` test script references a nonexistent file
- **Proof:** `test:chatpane` lists `src/lib/aiosContext.test.ts`; `find . -name 'aiosContext*'` → **0 hits**. The script is already broken (would fail `node --test`).
- **FIX (not delete):** drop `src/lib/aiosContext.test.ts` from the `test:chatpane` script.

### 1.4 Dead JS dependencies (zero imports in `src/`)
| dep | proof | action |
|-----|-------|--------|
| `class-variance-authority` | `rg "class-variance|cva\(" src` → 0 | remove from `package.json` |
| `clsx` | `rg "\bclsx\b" src` → 0 | remove from `package.json` |
| `tailwind-merge` | `rg "tailwind-merge|twMerge" src` → 0 | remove from `package.json` |
| `react-resizable-panels` | only a CSS *comment* in `App.css:457`; `rg "react-resizable-panels|PanelGroup" src/**/*.ts*` → 0 imports. `ResizableGrid.tsx` is a custom impl. | remove from `package.json` |

### 1.5 Dead backend commands — voice.rs (whole module)
- The webview does dictation itself: `voice.ts` records via `getUserMedia`+`MediaRecorder` and POSTs to a local whisper.cpp server over `fetch` (see `voice.ts` `WHISPER_URL` / `/inference`). It **never invokes** the Rust commands.
- **Proof:** `rg "dictate_start|dictate_stop|dictate_cancel" src` → **0 hits** (frontend `dictateStart/Stop/Cancel` are JS functions in `voice.ts`, unrelated to the Rust `dictate_*`).
- **DELETE** `src-tauri/src/voice.rs` (entire file, ~3 commands + helpers) **+** `mod voice;` in `lib.rs` **+** the 3 `voice::dictate_*` lines in `generate_handler![]`.
- **Keep** `src/lib/voice.ts` and `VoiceButton.tsx` — those are the live path.

### 1.6 Dead backend commands — files.rs search pair
- **Proof:** `rg "find_files|search_in_files" src` → **0 hits**. Defined `files.rs:1034` (`find_files`) and `:1106` (`search_in_files`), registered in `lib.rs`, invoked nowhere.
- **DELETE** the two `fn find_files` / `fn search_in_files` in `files.rs` **+** their 2 lines in `generate_handler![]`. Keep the rest of `files.rs` (load-bearing for the files pane).

### 1.7 Dead backend command — read_telemetry / telemetry.rs
- **Proof:** `rg "read_telemetry|readTelemetry|Telemetry" src` → **0 hits**. `read_telemetry` is defined inline in `lib.rs` (returns `telemetry::collect()`), invoked nowhere from the frontend.
- `telemetry.rs` is referenced only by that one dead command.
- **DELETE** `src-tauri/src/telemetry.rs` **+** `mod telemetry;` **+** the inline `fn read_telemetry` in `lib.rs` **+** its `generate_handler!` line.
- **UNSURE FLAG:** confirm telemetry isn't read by an out-of-tree tool / launchd job before removing the file. Removing just the registration is the zero-risk subset.

**Tier-1 total:** ~3 lib files + 2 rs files + 4 npm deps + 5 dead backend cmds. No UI/type changes, no chain.

---

## TIER 2 — CLEAN PANE DELETES (whole chain unique to one pane)

Reachable today (in `SPAWN` + render switch) but firaz called them out as not-used.
Each owns a unique component + lib + (sometimes) rs. The only shared-code risk is `bundleBoundaries.test.ts` (asserts on these files) — update/trim it in the same pass.

Order within tier = ascending chain size.

### 2.1 `studio` pane (motion / MotionBoards)
- **Chain:** `SPAWN` id `studio` + union `motion` → `MotionPane.tsx` → `lib/motion.ts` → `src-tauri/src/motion.rs` (6 cmds: `motion_models/boards/board_save/generate/status/credits`).
- **Shared-code check:** `motion.ts`/`motion.rs` used ONLY by MotionPane. `rg "MotionPane|from .*motion\b" src` → only `App.tsx` (lazy) + `MotionPane` + test. ✅ isolated.
- **DELETE:** `MotionPane.tsx`, `lib/motion.ts`, `motion.rs`, `mod motion;`, 6 `motion::*` handler lines, `studio` SPAWN entry, `motion` union member, App.tsx lazy + render branch.
- Note: `.motion.key` is gitignored and absent locally — nothing to remove there.

### 2.2 `contacts` pane (CRM + inbox)
- **Chain:** `SPAWN` id `contacts` + union `customers` → `CrmPane.tsx` → `lib/crm.ts` (→ `crm.rs`) **and** `lib/inbox.ts` (→ `inbox.rs`).
- **COUPLING — do NOT split:** `inbox.rs` calls `crate::crm::crm_load` (`inbox.rs:355`). If you delete crm you must delete inbox too, and vice-versa. They go together.
- **Shared-code check:** `inbox.ts` inbound = `App.tsx` + `CrmPane`. `crm.ts` inbound = `CrmPane` only. App.tsx references inbox — verify those App.tsx uses are CRM-only before pulling (likely the contacts/customer notification feed).
- **DELETE:** `CrmPane.tsx`, `lib/crm.ts`, `lib/inbox.ts`, `crm.rs`, `inbox.rs`, both `mod` lines, `crm::*` (3) + `inbox::*` (3) handler lines, `contacts` SPAWN entry, `customers` union member, App.tsx lazy + render branch + the inbox import/usages.
- **UNSURE FLAG:** confirm App.tsx's `inbox` usage isn't feeding a notification count firaz wants. Quick grep before cut.

### 2.3 `pet` pane
- **Chain:** `SPAWN` id `pet` + union `pet` → `PetPane.tsx` → `lib/pet.ts` (pure frontend, **no Rust**, `rg invoke src/lib/pet.ts` → 0).
- **COUPLING — ChatPane (other agent's file):** `ChatPane.tsx` calls `onPetUserMessage/onPetResult/onPetError/onPetUsage` (lines ~1154/1168/1192/1203/1611) to drive pet mood from chat events. `IdleControlCenter.tsx` also imports `PetPane`.
- **DELETE:** `PetPane.tsx`, `lib/pet.ts`, `pet` SPAWN entry, `pet` union member, App.tsx lazy + render branch, the `PetPane` render in `IdleControlCenter.tsx`, **and** the 4 `onPet*` call-sites + import in `ChatPane.tsx`.
- **UNSURE FLAG:** ChatPane edit must be coordinated with the other agent. Pure-frontend so low risk, but it's a cross-file cut into a file you don't own.

### 2.4 `automations` pane
- **Chain:** `SPAWN` id `automations` + union `automations` → `AutomationsPane.tsx` → `lib/automations.ts` → `automations.rs` (4 cmds).
- **SHARED-CODE — do NOT remove `lib/automations.ts` blindly:** `StatusPane.tsx` ALSO imports `lib/automations.ts`. If StatusPane survives, keep `automations.ts` + `automations.rs`; only drop `AutomationsPane.tsx` + SPAWN entry + union + App branch. If StatusPane is also deleted (2.5), then `automations.ts`/`.rs` become free and can go.
- **DELETE (pane only):** `AutomationsPane.tsx`, `automations` SPAWN entry, `automations` union member, App.tsx lazy + render branch.

### 2.5 `status` pane
- **Chain:** `SPAWN` id `status` + union `status` → `StatusPane.tsx`. Imports shared libs (`chat.ts`, `fs.ts`, `automations.ts`) — **all shared, keep them.** Component is self-contained otherwise.
- **DELETE:** `StatusPane.tsx`, `status` SPAWN entry, `status` union member, App.tsx lazy + render branch. (Then re-evaluate 2.4's `automations.ts`/`.rs` freedom.)

### 2.6 `apps` + `app` panes (mac app attach)
- **Chain:** `SPAWN` id `apps` (union `apps`) → `AttachAppsPane.tsx`; union `app` → `AppAttachPane.tsx`. Both → `lib/macApps.ts` → `mac_apps.rs` (3 cmds). `AppAttachPane` also uses shared `fs.ts` (keep).
- **Shared-code check:** `macApps.ts` inbound = only those 2 panes. ✅ isolated. (`apps.ts` the catalog is unrelated — different file, do not touch.)
- **DELETE:** `AttachAppsPane.tsx`, `AppAttachPane.tsx`, `lib/macApps.ts`, `mac_apps.rs`, `mod mac_apps;`, 3 `mac_apps::*` handler lines, `apps` SPAWN entry, both `apps` + `app` union members, App.tsx 2 lazy decls + 2 render branches.

### 2.7 `database` pane (memory vault + DB browser + 3D graph)
- **Chain:** `SPAWN` id `database` + union `memory` → renders `DatabasePane.tsx` → which lazy-loads `MemoryPane.tsx` (exports `MemoryView`) → `MemoryGraph3D.tsx`. Libs: `lib/db.ts` (→ `db.rs`, 12 cmds), `lib/memory.ts` (→ `memory.rs`, 6 cmds).
- **COUPLING — ChatPane (other agent's file):** `memory.ts` is also imported by `ChatPane.tsx` (`memorySearch`), and ChatPane has a `memoryPanelOpen` UI. So **`memory.ts` + `memory.rs` are SHARED — keep them** unless ChatPane's memory panel is also being cut.
- **DELETE (safe subset):** `DatabasePane.tsx`, `MemoryPane.tsx`, `MemoryGraph3D.tsx`, `lib/db.ts`, `db.rs`, `mod db;`, 12 `db::*` handler lines, `database` SPAWN entry, `memory` union member, App.tsx lazy + render branch.
- **Frees JS deps:** `3d-force-graph`, `three`, `@types/three` (only used by `MemoryGraph3D`/`MemoryPane` — `rg "3d-force-graph|from \"three\"" src` → only those + test). Remove from `package.json` once the pane is gone.
- **KEEP:** `lib/memory.ts`, `memory.rs`, `memory::*` handlers (ChatPane memory search).
- **UNSURE FLAG:** firaz said "database" is suspect — confirm he doesn't use the DB-connection browser (Neon) before cutting `db.rs`.

---

## TIER 3 — HIGH-COUPLING / HIDE-FIRST (don't hard-delete yet)

These are wired into always-on surfaces (idle dashboard / App startup). HIDE by removing the SPAWN entry; defer the deep delete.

### 3.1 `money-agents` (a.k.a. sales/money agents)
- **Why not a clean delete:** deeply integrated. `lib/moneyAgents.ts` has **10 inbound refs** incl. `App.tsx` (auto-spawns agent chats on startup, App.tsx ~1404-1468), `IdleDashboard.tsx` (always-on home screen, `loadMoneyAgentSummaries`), `controlCenter.ts`, `ChatPane.tsx`, and 3 `dashboard/*Lane.tsx` files.
- **Components:** `MoneyAgentsPane.tsx` (the `money-agents` pane), `MoneyAgentsSection.tsx` (rendered in idle dashboard at App.tsx:1653).
- **Note:** `money-agents` is in the `PaneContent` union but is **NOT in `SPAWN`** — so it has no sidebar entry already; it's reached via `onOpenMoneyAgentChat`/dashboard, not the catalog.
- **Action:** HIDE = stop rendering `MoneyAgentsSection` in App.tsx + remove the dashboard money-agents lane. Full delete is a multi-file refactor across IdleDashboard + dashboard lanes + App startup loops + ChatPane — **flag for firaz**, don't do it blind.

### 3.2 `mirror` (MirrorViewer + mirror.ts + mirrorTransport.ts + agentActions.ts)
- `MirrorViewer.tsx` rendered in App.tsx:1674 (idle area). Chain: `mirror.ts`, `mirrorTransport.ts`, `agentActions.ts`, `agentController.ts`.
- Not a `SPAWN`/pane — it's a dashboard widget. If firaz doesn't use the mirror reflection in-app, HIDE by removing the App.tsx:1674 render + its imports, then the 4 libs become free (verify: `agentActions.ts` inbound = `mirrorTransport.ts` + `App.tsx` + `MirrorViewer.tsx`; `mirror.ts` similar).
- **Flag for firaz** — it's idle-screen UI, his call.

### 3.3 `bridges` / `plugins` panes
- `BridgesPane.tsx` + `lib/bridges.ts` (→ `bridges.rs`, 3 cmds) and `PluginsPane.tsx` + `lib/plugins.ts` (→ `plugins.rs`). Both are in `SPAWN`? — **No:** neither `bridges` nor `plugins` is in `SPAWN` (catalog has no entry), but both are in the union + render switch + are imported by `Settings.tsx`.
- They're reached via Settings, not the sidebar catalog. If firaz doesn't use WA-bridge pairing / plugins, these are TIER-2-clean candidates, but the `Settings.tsx` coupling means you must also pull their Settings tabs.
- **Flag** — likely deletable but verify Settings usage first.

### 3.4 `pulse` pane
- `PulsePane.tsx` → `lib/stats.ts` (shared), `IdleDashboard` (shared). In union + render switch, **not in `SPAWN`**. Imported by `IdleDashboard.tsx`. Low-value standalone but shares dashboard libs. HIDE-or-defer.

---

## TIER 4 — REPO CRUFT (non-code)

- **`outputs/*.dmg`** — 5 build artifacts (~57 MB total) sitting on disk. Gitignored (`*.dmg`), so not in history; just local bloat. Safe to `rm`. Keep the 2 tracked `.md` notes if wanted.
- **`dist/`** — build output, gitignored (not tracked). Safe to `rm` (regenerates on `vite build`).
- **Root PLAN/SPIKE docs** (firaz's call, not code): `PLAN-chat-engines.md`, `PLAN-chatpane-daily-driver.md`, `PLAN-chatpane-steer-usage-detach.md`, `PLAN-control-plane.md`, `PLAN-customizable-sidebar.md`, `PLAN-model-agnostic.md`, `SPIKE-screencapturekit.md`, `WINDOWS-PORT.md`. Stale planning docs — archive or delete at firaz's discretion. **Not auto-deleting.**
- **`bundleBoundaries.test.ts`** — asserts on many of the components above (DatabasePane, MemoryPane, MotionPane, PetPane, MirrorViewer, MoneyAgents*, StatusPane, AttachAppsPane, AppAttachPane). Any Tier-2/3 delete must trim the matching assertions here or the test breaks. Treat as a same-PR companion edit, not a separate item.

---

## Browser sub-features (investigated — all KEEP)

firaz is keeping+improving browser. None of these are dead:

| feature | UI wiring | verdict |
|---------|-----------|---------|
| nav (back/fwd/reload) | core | KEEP |
| zoom | `applyZoom` buttons BrowserPane:622/638 → `browserZoom` | KEEP |
| device/mobile mode | `toggleDeviceMode` button :613 → `browserDeviceMode` | KEEP |
| clear cookies | buttons :649/654 → `browserClearCookies` | KEEP |
| profiles | profile menu :516, `loadProfiles/addProfile` (`lib/profiles.ts`) | KEEP |
| annotate | `toggleAnnotate` button :501 → enter/exit/copy_selection | KEEP |
| screenshot | → `browserScreenshot` | KEEP |
| adblock | auto-installed on webview create (`browser.rs:231 install_standard_adblock`), no toggle by design | KEEP (load-bearing) |

No half-built dead browser code found.

---

## ONE-SHOT ORDERED DELETION PLAN

Do in this order (safety descending). Each step independently compiles.

1. **Tier 1 (zero chain):**
   a. `rm src/lib/providers.ts`
   b. `rm src/lib/commands.ts src/lib/commands.test.ts` → edit `package.json test:chatpane` to drop `commands.test.ts` **and** the phantom `aiosContext.test.ts`.
   c. `package.json` deps: remove `class-variance-authority`, `clsx`, `tailwind-merge`, `react-resizable-panels`. Run install.
   d. `rm src-tauri/src/voice.rs` → drop `mod voice;` + 3 `voice::dictate_*` handler lines in `lib.rs`.
   e. `files.rs`: delete `find_files` + `search_in_files` fns → drop their 2 handler lines.
   f. `lib.rs`: delete inline `read_telemetry` + handler line; `rm src-tauri/src/telemetry.rs` + `mod telemetry;` *(after confirming no external reader — Tier-1 UNSURE)*.
   g. `cargo check` + `tsc` to confirm green.

2. **Tier 2 panes** (each = component + lib + rs + apps.ts union/SPAWN + App.tsx lazy/branch + bundleBoundaries.test trim). Order: 2.1 studio → 2.6 apps → 2.2 contacts → 2.5 status → 2.4 automations(pane) → free automations.ts/.rs → 2.3 pet (coordinate ChatPane) → 2.7 database (keep memory.ts/.rs; then free `three`/`3d-force-graph`/`@types/three`).

3. **Tier 3** — HIDE only (remove SPAWN/idle-render), get firaz sign-off before deep delete: money-agents, mirror, bridges, plugins, pulse.

4. **Tier 4 cruft** — `rm outputs/*.dmg dist/`; archive stale PLAN/SPIKE md at firaz's call.

---

## ESTIMATE OF REMOVAL

| bucket | files | approx LOC | deps |
|--------|-------|-----------|------|
| Tier 1 | 4 files (providers, commands, commands.test, voice.rs) + telemetry.rs + partial files.rs/lib.rs | ~1,200 | 4 npm (+ later 3 via DB pane) |
| Tier 2 (full) | ~13 components/libs + 4 rs modules + ~25 handler lines | ~5,500 (Crm 42k-char + Database 31k + Motion 30k + Automations 22k dominate) | +3 npm (three stack) |
| Tier 3 (HIDE) | 0 deleted (render edits only) | ~0 now | 0 |
| Tier 4 | dist/ + 5 dmg + ~8 md | n/a (artifacts) | 0 |

**If Tier 1 + Tier 2 fully executed:** ~17 source files removed, ~6,700 LOC, 7 npm deps, ~30 dead Rust handlers + 5 Rust modules. Backend `generate_handler!` shrinks from 114 → ~75 commands.

---

## MUST-CONFIRM BEFORE DELETING (UNSURE)

1. **telemetry.rs / read_telemetry** — registered + collected but invoked nowhere in `src/`. Confirm no out-of-tree/launchd consumer reads it. (Removing the *registration* is safe regardless; removing the *file* needs the nod.)
2. **contacts (crm+inbox)** — App.tsx imports `inbox.ts`; confirm it's not feeding a notification badge firaz wants. inbox.rs ⇄ crm.rs are coupled — delete as a pair, never one alone.
3. **database / db.rs** — confirm firaz doesn't use the Neon DB-connection browser. `memory.ts`/`memory.rs` MUST survive (ChatPane uses memory search) — only `db.rs` and the 3D graph go.
4. **pet** — requires editing `ChatPane.tsx` (4 `onPet*` call-sites) which another agent owns. Coordinate the cut.
5. **money-agents / mirror / bridges / plugins / pulse** — wired to idle dashboard + Settings, not the SPAWN catalog. HIDE first; full delete is a refactor needing firaz's explicit yes.
6. **PLAN-*/SPIKE-*/WINDOWS-* docs** — firaz's planning history; archive vs delete is his call, not auto-pruned.

---

## KEEP (first-class + actively used — do not touch)

- Panes: `chat` (ChatPane + chat.ts/chat.rs), `terminal`/`codex`/`claude-code` (TerminalPane/Runtime/Composer + pty.ts/pty.rs), `files` (FilesPane/FileViewerPane/EditorPane + fs.ts/files.rs + monaco), `browser` (BrowserPane + browser.ts/.rs + profiles.ts/browser-mem.ts), `notes` (NotesPane + notes.ts).
- Shared libs: `tauri.ts` (23 refs), `fs.ts` (15), `paneBus.ts`, `sidebar.ts`, `settings.ts`, `theme.ts`, `dashboard.ts`, `notifications.ts`, `stats.ts`, `run.ts`, `projects.ts`, `paneLayout.ts`, `paneRouting.ts`, `usagePace.ts`, `device.ts`, `monitor.ts`, `memory.ts`, `apps.ts` (catalog), `voice.ts` (live dictation), `editorLanguage.ts`/`monaco.ts`.
- Backend: pty, oracles, files, browser, chat, memory, usage, stats, monitor, device + monitor (kept). 
- Components: CommandPalette, AccountMenu, Settings, ThemeSwitcher, VoiceButton, OracleRoster, IdleDashboard + dashboard/* lanes (if money-agents kept), ResizableGrid, PaneDropZone, SidebarUsage, TerminalComposer/Runtime/Pane.
- Deps: all `@xterm/*`, `monaco-editor`, `@tauri-apps/*`, `react`/`react-dom`, `lucide-react`, `tailwindcss`/`@tailwindcss/vite`. (`three`/`3d-force-graph` only if database pane stays.)
