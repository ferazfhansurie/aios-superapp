# Codex-Calibrated Shell Visual Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AIOS read as one Codex-calibrated desktop workspace while retaining AIOS's own multi-pane behavior and user-selectable personal accent.

**Architecture:** Add a semantic CSS bridge in `App.css` with immutable focus/permission/diff/status roles beside the runtime-mutable personal-accent family. Retune shared shell and chat components to consume those roles; do not add theme React state or copy Codex private UI internals. Use source-contract tests for values and role separation, then visual checks at normal and narrow pane widths.

**Tech Stack:** React 19, TypeScript, Tailwind v4 utilities, CSS custom properties, node:test, Tauri 2.

---

### Task 1: Install the semantic token bridge

**Files:**
- Modify: `src/App.css`
- Modify: `src/lib/theme.ts`
- Create: `src/lib/codexThemeTokens.test.ts`
- Create: `src/lib/theme.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing dark/light token-contract tests.**

Test source values and invariants: dark ground/surface/card are `#000/#181818/#212121`; focus is immutable blue; warning/full-access is immutable orange with black foreground; diff/success/danger roles exist; light equivalents exist; `applyAccent` does not write any immutable role.

```ts
assert.match(css, /--color-warning-accent:\s*#fb6a22/);
assert.match(css, /--color-warning-fg:\s*#000/);
assert.match(css, /--color-focus:\s*#339cffb3/);
assert.doesNotMatch(themeApplyBody, /color-warning-accent|color-focus|color-diff-add/);
```

- [ ] **Step 2: Run the focused test and confirm it fails.**

Run: `node --experimental-strip-types --test src/lib/codexThemeTokens.test.ts`

Expected: FAIL because immutable token roles are absent.

- [ ] **Step 3: Add dark and light semantic roles.**

In `App.css`, map the current compatibility tokens to the verified Codex dark layers, introduce `--color-border-light`, `--color-focus`, `--color-warning-accent`, `--color-warning-fg`, `--color-warning-soft`, `--color-success-accent`, `--color-danger-accent`, `--color-diff-add`, and `--color-diff-delete`. Define their explicit light values inside `html[data-theme="light"]`. Preserve `--color-accent*` as the only runtime-mutable family.

- [ ] **Step 4: Calibrate the default personal orange safely.**

Set the default/preset orange to `#fb6a22`. Update `deriveAccentVars` so an orange fill receives a contrast-safe black foreground. Keep custom accent foreground derivation and add a regression assertion for the default orange.

- [ ] **Step 5: Run focused tests.**

Run: `node --experimental-strip-types --test src/lib/codexThemeTokens.test.ts src/lib/theme.test.ts`

Expected: PASS.

### Task 2: Retune shared shell geometry and focus behavior

**Files:**
- Modify: `src/App.css`
- Modify: `src/lib/bundleBoundaries.test.ts`
- Create: `src/lib/codexShellGeometry.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing geometry/source-contract tests.**

Assert the global token layer exposes 4px spacing, 10px row, 15px card, 20px bubble, and 30px composer radii; assert shared focused controls use `--color-focus` instead of personal accent.

- [ ] **Step 2: Run the focused test and confirm it fails.**

Run: `node --experimental-strip-types --test src/lib/codexShellGeometry.test.ts`

Expected: FAIL because current AIOS radius aliases are smaller and focus is accent-derived.

- [ ] **Step 3: Add compatibility geometry aliases and shared CSS primitives.**

Keep Tailwind's existing utility scale stable. Add `--aios-radius-row/card/bubble/composer`, `--aios-space-*`, elevated/hover/active surfaces, and a shared focus style in `App.css`. Do not globally redefine Tailwind `rounded-*` tokens.

- [ ] **Step 4: Migrate only shared CSS selectors.**

Retune pane headers, app menus, standard popovers, fields, and common buttons that are implemented in `App.css`. Leave xterm, Monaco, syntax highlighting, media/canvas, and native webviews as documented exceptions.

- [ ] **Step 5: Put both new token suites in the standard frontend test command.**

Add `codexThemeTokens.test.ts`, `theme.test.ts`, and `codexShellGeometry.test.ts` to the explicit `test:chatpane` list in `package.json` so token regressions cannot bypass normal verification.

- [ ] **Step 6: Run focused tests.**

Run: `node --experimental-strip-types --test src/lib/codexShellGeometry.test.ts src/lib/bundleBoundaries.test.ts`

Expected: PASS.

### Task 3: Retune ChatPane transcript and task cockpit

**Files:**
- Modify: `src/components/ChatPane.tsx`
- Modify: `src/components/chat/TaskSummary.tsx`
- Modify: `src/components/chat/ConversationRail.tsx`
- Modify: `src/components/chat/ApprovalCards.tsx`
- Modify: `src/lib/bundleBoundaries.test.ts`

- [ ] **Step 1: Write failing chat visual source-contract tests.**

Assert assistant prose stays unbubbled; user messages use the 20px bubble token and elevated surface; task summary uses card radius/surface tokens, not raw `white/*` color literals; conversation rail tooltip uses elevated surface/border roles; permission strip uses immutable warning tokens.

- [ ] **Step 2: Run the focused test and confirm it fails.**

Run: `node --experimental-strip-types --test src/lib/bundleBoundaries.test.ts`

Expected: FAIL on old hard-coded overlay/color/radius classes.

- [ ] **Step 3: Make the minimal ChatPane migration.**

Replace local literal white opacity and arbitrary radii only in the transcript header, user bubble, warning/approval strip, jump button, task summary, conversation rail, and approval cards. `ApprovalCards` must use immutable warning/focus roles rather than personal accent. Preserve behavior, event handling, queue rendering, and stream lifecycle untouched.

- [ ] **Step 4: Verify normal and narrow layouts manually.**

Run the dev shell. Inspect empty state, long streamed reply, tool activity, queued follow-ups, approval/warning, task summary, and narrow pane. Ensure rail hides cleanly without overlap.

- [ ] **Step 5: Run the chat suite and typecheck.**

Run: `npm run test:chatpane`

Run: `npx tsc --noEmit`

Expected: PASS.

### Task 4: Retune Composer controls and permission/model surfaces

**Files:**
- Modify: `src/components/Composer.tsx`
- Modify: `src/lib/bundleBoundaries.test.ts`

- [ ] **Step 1: Write failing composer source-contract tests.**

Assert composer uses 30px radius, elevated surface, immutable focus ring, 16px input type, row-radius dropdowns, and warning tokens for full-access/permission styling rather than mutable accent.

- [ ] **Step 2: Run the focused test and confirm it fails.**

Run: `node --experimental-strip-types --test src/lib/bundleBoundaries.test.ts`

Expected: FAIL on 16px composer rounding and accent-based focus/permission styling.

- [ ] **Step 3: Migrate the composer and controls.**

Retune the main composer shell, send button, plus/voice controls, model/effort menus, queue editor, and permission chips. Keep all current interactions and keyboard behavior unchanged.

- [ ] **Step 4: Run focused and full frontend validation.**

Run: `npm run test:chatpane`

Run: `npx tsc --noEmit`

Expected: PASS.

### Task 5: Bring high-traffic panes into the shared system

**Files:**
- Modify: `src/components/BrowserPane.tsx`
- Modify: `src/components/GitPane.tsx`
- Modify: `src/components/TerminalPane.tsx`
- Modify: `src/lib/bundleBoundaries.test.ts`

- [ ] **Step 1: Write failing scope-limited source-contract tests.**

Assert BrowserPane and GitPane chrome use semantic surfaces, card/row radii, immutable focus, and diff roles. Assert terminal outer chrome follows pane tokens while xterm content remains intentionally dark.

- [ ] **Step 2: Run focused tests and confirm they fail.**

Run: `node --experimental-strip-types --test src/lib/bundleBoundaries.test.ts`

Expected: FAIL before component migration.

- [ ] **Step 3: Retune browser/git/terminal chrome.**

Do not change browser web content, Monaco, xterm palette, or git behavior. Apply only shared role usage to headers, fields, menus, cards, and diff summaries.

- [ ] **Step 4: Run application verification.**

Run: `npm run test:chatpane`

Run: `npx tsc --noEmit`

Run: `cd src-tauri && cargo test --lib`

Run: `git diff --check`

Expected: all pass; Rust warnings only if pre-existing.

### Task 6: Package and visual acceptance

**Files:**
- Modify: `docs/superpowers/specs/2026-07-10-codex-calibrated-shell-design.md` only if verification reveals a deliberate contract change.
- Create: `tests/visual/codex-shell.spec.ts`
- Create: `tests/visual/codex-shell.spec.ts-snapshots/` baseline images
- Modify: `playwright.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Build the production frontend.**

Run: `npm run build`

Expected: TypeScript and Vite build succeed.

- [ ] **Step 2: Build/install only when requested.**

Run: `npm run install:mac-local`

Expected: AIOS.app is rebuilt using the stable signing identity. Do not run this if a user is actively using the installed app without first reporting the restart impact.

- [ ] **Step 3: Add screenshot baselines before manual acceptance.**

Update `playwright.config.ts` so it discovers both the existing `e2e` directory and `tests/visual`, and add the visual project to the default `test:e2e` command in `package.json`. Configure deterministic viewport, animations disabled, and screenshots enabled. Add `tests/visual/codex-shell.spec.ts` coverage for dark/default and light/custom accent at normal and narrow widths. Capture named baselines for chat empty/composer, active stream, queued follow-ups, approval card, task summary, browser toolbar, terminal chrome, and git diff; use `tests/visual/codex-shell.spec.ts-snapshots/`.

Run: `npm run test:e2e -- --update-snapshots`

Expected: baseline images are created or deliberately updated.

- [ ] **Step 4: Run screenshot regression.**

Run: `npm run test:e2e`

Expected: PASS without snapshot changes.

- [ ] **Step 5: Accept the visual matrix manually.**

Inspect dark/default and light/custom accent at normal and narrow widths across chat, composer, browser, terminal chrome, and git diff. Confirm immutable full-access, focus, success/danger, and diff roles remain correct under custom accent.
