# CFO Finance Meter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an adjustable month-and-budget finance ledger to AIOS, show its spend meter in the sidebar and dashboard, seed July's verified baseline, and reinstall the verified macOS app.

**Architecture:** A locked Node CLI is the only writer for `~/.aios/state/finance/cfo.json`; it preserves an append-only adjustment history, explicit budgets/month rollover, and atomic cash changes. A defensive Rust command exposes a validated snapshot to a shared TypeScript finance model, while focused React components render compact and expanded views without adding UI editing.

**Tech Stack:** Node.js ESM, Tauri 2/Rust/serde, React 19/TypeScript, Node test runner, Cargo tests, Vite, macOS app installer.

---

## File map

- Create `scripts/cfo-state.mjs`: exclusive-lock, atomic finance state writer and CLI.
- Create `scripts/cfo-state.test.mjs`: writer validation, replay, concurrency, balance, budget, and rollover coverage.
- Create `src-tauri/src/finance.rs`: typed read-only snapshot boundary and Rust validation tests.
- Modify `src-tauri/src/lib.rs`: register `finance_snapshot`.
- Create `src/lib/finance.ts`: frontend types, derived values, pacing, formatting, stale/month status, polling hook.
- Create `src/lib/finance.test.ts`: deterministic finance-domain unit tests.
- Create `src/components/dashboard/financeViewModel.ts`: pure shared presentation model for both finance surfaces.
- Create `src/components/dashboard/financeViewModel.test.ts`: behavior tests for empty, stale, mismatch, and over-budget presentations.
- Create `src/components/dashboard/FinanceGlance.tsx`: compact sidebar finance meter.
- Create `src/components/dashboard/CfoFinanceCard.tsx`: expanded dashboard finance card.
- Modify `src/components/SidebarUsage.tsx`: compose provider usage and finance meter.
- Modify `src/components/IdleControlCenter.tsx`: add the CFO card near the top.
- Modify `src/lib/bundleBoundaries.test.ts`: verify finance placement and separation from provider usage.
- Modify `package.json`: include focused finance tests in the standard test command.
- Create `finances/cfo-meter-workflow.md`: durable Oracle runbook mapping conversational updates and transport IDs to writer calls.
- Create `scripts/cfo-conversation.mjs`: narrow bridge-facing adapter for supported expense, budget, and month phrases.
- Create `scripts/cfo-conversation.test.mjs`: adapter parsing, stable-ID forwarding, and safe rejection tests.
- Create `~/.aios/state/finance/cfo.json` through the writer: seed July baseline with budget and month.

### Task 1: Locked adjustable ledger writer

**Files:**
- Create: `scripts/cfo-state.mjs`
- Create: `scripts/cfo-state.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing writer tests**

Cover `init-month`, `show`, `set-budget`, `set-balance`, expense/refund/correction signs, stable event replay, cash delta replay, duplicate persisted IDs, negative-spend rejection, timestamp/month validation, lock timeout, simultaneous adjustment preservation, and rollover recovery around both renames. Cover late correction routing to `history/YYYY-MM.json`, refusal to overwrite the current month, hard conflict for a differing existing archive, and proof that neither adjustments nor opening spend carry into a new month. Assert input MYR values are rounded to two decimals on write and derived money is rounded before comparison. Inject failures before archive commit, between archive/current commits, and after current commit; retry each case and assert the canonical snapshot is never missing and the archive is identical. Tests must set `AIOS_CFO_STATE_PATH` to a temporary directory so real finance state is untouched.

- [ ] **Step 2: Run the writer test and confirm failure**

Run: `node --test scripts/cfo-state.test.mjs`

Expected: FAIL because `scripts/cfo-state.mjs` does not exist.

- [ ] **Step 3: Implement the minimal writer and CLI**

Implement these commands and required flags:

```text
init-month --month YYYY-MM --income N --opening-spent N --budget N --cash N --cash-floor N --card-debt N --next-target N
add-adjustment --month YYYY-MM --event-id ID --at ISO --kind expense|refund|correction --amount N [--category TEXT] [--note TEXT] [--source TEXT] [--cash-delta N]
set-balance --field cash|card_debt|income_received|cash_floor|next_month_cash_target --amount N
set-budget --month YYYY-MM --amount N
show
```

Use `AIOS_CFO_STATE_PATH` when set, otherwise `~/.aios/state/finance/cfo.json`. Validate finite MYR inputs, round accepted values to two decimals on write, round derived money before validation/comparison, validate schema, unique IDs, month timestamps, and derived non-negative spend. Every current, rollover, and archived-month mutation acquires the one canonical `<state>.lock` namespace with atomic `mkdir`; retry with bounded jitter for two seconds, reject stale locks, write a mode-0600 same-directory temp file, rename, read back, verify revision/event/totals, and always remove the lock. Archive rollover uses the commit order in the design spec and provides test-only `before-archive-commit`, `between-commits`, and `after-current-commit` failure points through `AIOS_CFO_FAILPOINT`. When `add-adjustment --month` targets a past month, resolve its archive while holding the canonical lock, reject a missing archive or future month, and update only that archive atomically; never mutate the current meter.

- [ ] **Step 4: Run writer tests**

Run: `node --test scripts/cfo-state.test.mjs`

Expected: all writer tests PASS.

- [ ] **Step 5: Add the currently valid writer test command and commit**

Run: `npm pkg set scripts.test:cfo='node --test scripts/cfo-state.test.mjs'`

Commit:

```bash
git add scripts/cfo-state.mjs scripts/cfo-state.test.mjs package.json
git commit -m "feat(finance): add adjustable cfo ledger writer"
```

### Task 2: Defensive Tauri finance boundary

**Files:**
- Create: `src-tauri/src/finance.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write failing Rust validation tests**

Add colocated tests for the valid July snapshot, missing file returning `None`, malformed JSON, non-finite/core-negative values, duplicate adjustment IDs, sign rules, negative derived spend, and month-mismatched adjustment timestamps.

- [ ] **Step 2: Run the focused Rust test and confirm failure**

Run: `cargo test finance --manifest-path src-tauri/Cargo.toml`

Expected: FAIL until the finance module and validator exist.

- [ ] **Step 3: Implement and register `finance_snapshot`**

Use serde structs with explicit snake_case fields, resolve `$HOME/.aios/state/finance/cfo.json`, return `Result<Option<FinanceSnapshot>, String>`, reject invalid payloads, and never accept a caller-provided path. Register `finance::finance_snapshot` in `tauri::generate_handler!`.

- [ ] **Step 4: Run the focused Rust tests**

Run: `cargo test finance --manifest-path src-tauri/Cargo.toml`

Expected: all finance Rust tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/finance.rs src-tauri/src/lib.rs
git commit -m "feat(finance): expose validated cfo snapshot"
```

### Task 3: Shared frontend finance model

**Files:**
- Create: `src/lib/finance.ts`
- Create: `src/lib/finance.test.ts`

- [ ] **Step 1: Write failing deterministic model tests**

Test RM6,300/RM6,700 = 94.03%, RM400 remaining, RM821.09 net cash, visual width capped at 100%, exact true percentage retained, adjustment/refund totals, Asia/Kuala_Lumpur month lengths and leap year, days remaining, safe/warning/danger precedence, stale at more than 36 hours, month mismatch, and invalid/zero budgets.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test src/lib/finance.test.ts`

Expected: FAIL because `src/lib/finance.ts` does not exist.

- [ ] **Step 3: Implement the shared model and hook**

Export typed `FinanceSnapshot`, `DerivedFinanceSnapshot`, `deriveFinanceSnapshot(snapshot, now)`, MYR compact/full formatters, and `useFinanceSnapshot()`. Invoke `finance_snapshot` immediately and refresh with `useSharedInterval(30_000, ...)` from `src/lib/ticker.ts`, return `null` outside Tauri or on invalid data, log one diagnostic per error signature, and preserve explicit `stale` and `monthMismatch` states. The hook must not create its own `setInterval`.

- [ ] **Step 4: Run focused frontend tests**

Run: `node --test src/lib/finance.test.ts`

Expected: all model tests PASS.

- [ ] **Step 5: Commit**

Before committing, extend the project command only with files that now exist:

Run: `npm pkg set scripts.test:cfo='node --test scripts/cfo-state.test.mjs src/lib/finance.test.ts'`

```bash
git add src/lib/finance.ts src/lib/finance.test.ts package.json
git commit -m "feat(finance): add shared finance snapshot model"
```

### Task 4: Sidebar and dashboard presentations

**Files:**
- Create: `src/components/dashboard/FinanceGlance.tsx`
- Create: `src/components/dashboard/CfoFinanceCard.tsx`
- Create: `src/components/dashboard/financeViewModel.ts`
- Create: `src/components/dashboard/financeViewModel.test.ts`
- Modify: `src/components/SidebarUsage.tsx`
- Modify: `src/components/IdleControlCenter.tsx`
- Modify: `src/lib/bundleBoundaries.test.ts`

- [ ] **Step 1: Add failing structural component tests**

Write behavioral tests against a pure `financeViewModel` consumed by both components: missing/invalid snapshots hide both, stale and month-mismatch labels are exact, over-budget shows exact overage and true percentage while width caps at 100%, compact output excludes debt, expanded output includes cash/debt/net/floor/target/update, and both presentations receive the same derived spent/budget values. Also assert structurally that `SidebarUsage` composes `UsageGlance` and `FinanceGlance`, `IdleControlCenter` renders `CfoFinanceCard` after its command line, and neither finance component imports provider reset semantics.

- [ ] **Step 2: Run boundary tests and confirm failure**

Run: `node --test src/lib/bundleBoundaries.test.ts src/components/dashboard/financeViewModel.test.ts`

Expected: FAIL for missing finance components/placement.

- [ ] **Step 3: Implement compact and expanded views**

Match `UsageGlance` typography, spacing, one-pixel rail, and 700 ms width transition. Render true percent text with a bar capped at 100%; status precedence is danger, warning, safe. Hide both surfaces for missing/invalid snapshots, show a muted stale label, and show `waiting for <month> baseline` on month mismatch. Preserve provider usage behavior.

- [ ] **Step 4: Run component and model tests**

Run: `node --test src/lib/bundleBoundaries.test.ts src/lib/finance.test.ts src/components/dashboard/financeViewModel.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

Before committing, extend the project command with only tests that exist by Task 4:

Run: `npm pkg set scripts.test:cfo='node --test scripts/cfo-state.test.mjs src/lib/finance.test.ts src/components/dashboard/financeViewModel.test.ts'`

```bash
git add src/components/dashboard/FinanceGlance.tsx src/components/dashboard/CfoFinanceCard.tsx src/components/dashboard/financeViewModel.ts src/components/dashboard/financeViewModel.test.ts src/components/SidebarUsage.tsx src/components/IdleControlCenter.tsx src/lib/bundleBoundaries.test.ts package.json
git commit -m "feat(finance): show cfo meter in sidebar and dashboard"
```

### Task 5: Wire the conversational CFO workflow

**Files:**
- Create: `scripts/cfo-conversation.mjs`
- Create: `scripts/cfo-conversation.test.mjs`
- Create: `finances/cfo-meter-workflow.md`

- [ ] **Step 1: Write failing adapter tests**

Test exact supported phrases including `spent rm20 lunch`, `rm45 petrol`, `refund rm10`, `set july budget rm6,700`, and `start august with budget rm3,700`. Assert the adapter requires `--event-id` and `--at`, forwards stable IDs to the writer, returns writer-derived totals, rejects ambiguous/multi-amount messages without writing, and refuses month initialization until every required baseline value is supplied.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test scripts/cfo-conversation.test.mjs`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the narrow conversational adapter**

Accept `--message`, `--event-id`, `--at`, and optional explicit reconciliation fields. Parse only the tested grammar, translate it into an argument array passed to the writer's exported API (never a shell string), force source `discord-cfo`, and print the normalized snapshot plus derived totals as JSON. Screenshot OCR remains an Oracle extraction step, but once amounts are confirmed it calls this same adapter with the real transport ID. Unsupported or ambiguous language fails closed with no write.

- [ ] **Step 4: Document the sole write path for future Oracle turns**

Record exact mappings for `spent RM20 lunch`, refunds, corrections, `set July budget RM6,700`, balance reconciliation, and `start August with budget RM3,700`. Require the Discord transport message ID as `--event-id`, the message timestamp as `--at`, `--source discord-cfo`, canonical read-back through `show`, and a response containing new spent/remaining totals. State that screenshots require human-confirmed amounts and cash source before applying `--cash-delta`.

- [ ] **Step 5: Exercise the implemented conversation adapter against a temporary state**

Copy the canonical fixture to a temporary `AIOS_CFO_STATE_PATH`; invoke the documented RM20 command twice with one Discord-style event ID. Expected: first call produces RM6,320/RM380 and replay remains RM6,320/RM380.

- [ ] **Step 6: Commit**

Before committing, add the newly created adapter test to the standard finance command:

Run: `npm pkg set scripts.test:cfo='node --test scripts/cfo-state.test.mjs scripts/cfo-conversation.test.mjs src/lib/finance.test.ts src/components/dashboard/financeViewModel.test.ts'`

```bash
git add scripts/cfo-conversation.mjs scripts/cfo-conversation.test.mjs finances/cfo-meter-workflow.md package.json
git commit -m "docs(finance): define conversational cfo update workflow"
```

### Task 6: Seed adjustable July baseline

**Files:**
- Create via CLI: `~/.aios/state/finance/cfo.json`

- [ ] **Step 1: Initialize July through the supported writer**

Run from the supershell repo:

```bash
node scripts/cfo-state.mjs init-month --month 2026-07 --income 11700 --opening-spent 6300 --budget 6700 --cash 5400 --cash-floor 5000 --card-debt 4578.91 --next-target 7000
```

Expected: JSON with revision 1, spent 6300, remaining_budget 400, month `2026-07`.

- [ ] **Step 2: Verify budget and month can be adjusted without rewriting spend**

Run:

```bash
node scripts/cfo-state.mjs set-budget --month 2026-07 --amount 6700
node scripts/cfo-state.mjs show
```

Expected: July remains active, budget is 6700, spent remains 6300, and state file mode is 0600.

- [ ] **Step 3: Verify a disposable RM20 update path**

Using `AIOS_CFO_STATE_PATH` pointed to a temporary copy, run an RM20 expense twice with the same event ID. Expected: first result is RM6,320 spent/RM380 remaining; replay returns the same totals without a second adjustment.

### Task 7: Full verification, visual check, and local reinstall

**Files:**
- No source changes expected.

- [ ] **Step 1: Run focused and regression tests**

Run:

```bash
npm run test:cfo
npm run test:chatpane
cargo test finance --manifest-path src-tauri/Cargo.toml
```

Expected: all commands PASS.

- [ ] **Step 2: Build production assets**

Run: `npm run build`

Expected: TypeScript and Vite production build PASS.

- [ ] **Step 3: Inspect both surfaces locally**

Run the Tauri app, confirm expanded sidebar shows July spend `RM6.3k / RM6.7k`, `94% used`, `RM400 left`, and the idle dashboard shows gross cash, debt, RM821.09 net cash, RM5k floor, RM7k target. Check normal and narrow widths. Back up the canonical snapshot, apply a uniquely identified RM0.01 correction through the writer, verify both surfaces refresh within 30 seconds, then apply a compensating -RM0.01 correction with a different event ID and verify the canonical totals return to baseline; preserve both audit entries.

- [ ] **Step 4: Reinstall the verified app**

Run: `npm run install:mac-local`

Expected: signed app copied to `/Applications/AIOS.app` and reopened by the installer.

- [ ] **Step 5: Verify installed artifact and runtime**

Run:

```bash
codesign --verify --deep --strict /Applications/AIOS.app
pgrep -fl '/Applications/AIOS.app|AIOS'
node scripts/cfo-state.mjs show
```

Expected: codesign succeeds, AIOS is running, and the canonical July snapshot returns RM6,300 spent and RM400 remaining.

- [ ] **Step 6: Commit any verification-only test adjustments**

Only if verification required source/test corrections:

```bash
git add <changed-files>
git commit -m "test(finance): finalize cfo meter verification"
```
