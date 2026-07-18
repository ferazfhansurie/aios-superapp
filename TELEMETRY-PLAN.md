# TELEMETRY-PLAN — self-healing telemetry + auto-fix for the AIOS shell

> Goal (firaz, 2026-06-06): automatically **find AND fix** issues — track what's
> used, what errored, what's broken — for firaz **and for anyone who forks the
> OSS**. Trust is the moat: **local-first, opt-in per-feature, nothing leaves the
> machine without explicit consent.**
>
> Status: design only. Buildable in phases, each independently shippable.
> Phase 0+1 is the MVP and *also clears the 91-site silent-failure debt*.

---

## 0. Survey — what already exists (reuse, don't reinvent)

### Naming gotcha (fix first, 2 min)
The prompt says repo is `github.com/ferazfhansurie/aios-shell`, but the actual
remote is **`github.com/ferazfhansurie/aios-superapp`** (`git remote -v`).
`package.json` name is `aios-superapp`, `Cargo.toml` is `aios-shell`, bundle
identifier `com.adletic.aios`. The Phase 3 `gh` auto-triage must target
`ferazfhansurie/aios-superapp`. Flagging so we don't file issues into a void.

### Silent-failure debt — the instrumentation surface
`grep -rn "catch(() => {})" src/` → **91 sites**, zero `catch {}`. Distribution:

| File | sites | what's being swallowed |
|---|---|---|
| `src/components/TerminalRuntime.tsx` | 22 | `ptyWrite` / `ptyResize` / `ptyKill` / clipboard |
| `src/App.tsx` | 20 | window mgmt, oracle/chat/customer loads, clipboard, monitor start/stop |
| `src/components/BrowserPane.tsx` | 19 | browser navigate/zoom/screenshot/bounds commands |
| `src/components/ChatPane.tsx` | 10 | *(owned by another agent — do not depend on line numbers)* |
| `src/components/IdleDashboard.tsx` | 6 | dashboard data loads (usage, rate, focus, device, money agents, git pulse) |
| `src/components/PulsePane.tsx` | 3 | pulse loads |
| `NotesPane / FileViewerPane / EditorPane` | 2 each | notes save, openPath, editor save |
| `SidebarUsage / Settings / OfficePreview / MotionPane / BridgesPane` | 1 each | misc loads |

These are **exactly the instrumentation points**: each `.catch(() => {})` becomes
`.catch((e) => reportError(e, ctx))`. Two birds — observability + debt cleanup.

There is **one** existing React error boundary: `PaneErrorBoundary` in
`src/components/CrmPane.tsx:65-102` (only wraps CrmPane). It logs to
`console.error` and shows inline — a perfect template for the app-wide boundary,
but currently telemetry-blind.

### Existing telemetry / logging in the shell
- **No error telemetry. No Sentry. No `tauri-plugin-log`.** Cargo.toml deps:
  serde/serde_json/walkdir/sqlx/tokio/portable-pty/sysinfo — *no logging crate,
  no `log`/`tracing`*. JS has no analytics dep.
- Rust logging is **3 stray `eprintln!`** (`browser.rs:182,186`, `chat.rs:501`).
  No `std::panic::set_hook`. Backend convention is "soft-fail, never panic"
  (`crm.rs`, `memory.rs:19`, `monitor.rs:30`, `stats.rs:15`) — failures are
  *swallowed*, which is the Rust mirror of the 91 JS catch sites.
- **`src-tauri/src/telemetry.rs` is NOT error telemetry** — it's read-only Claude
  Code JSONL *usage* aggregation (tokens/streak/heatmap) for the sidebar. Name
  collision only. Our new module must be named differently: **`diag.rs`** (so
  `telemetry.rs` keeps its meaning). The struct shapes there (Totals/Streak/etc)
  are a good serde style reference.

### Reusable error-clustering logic already in the tree
`src-tauri/src/monitor.rs` already does error detection on tmux panes:
- `ERROR_NEEDLES = ["error","panic","failed","traceback"]` (`monitor.rs:53`)
- `fresh_error_lines(prior, current)` (`monitor.rs:232`) — diffs output, extracts
  new error lines.
- `log_event(session, kind, message)` (`monitor.rs:146`) — appends events.
- `send_whatsapp(message)` (`monitor.rs:100`), `node_bin()` (`monitor.rs:117`,
  `pub(crate)` — already shared with other modules).

**Reuse:** the signature-normalization for Phase 3 clustering should lift the
needle list + line-diff idea from `monitor.rs`. The `node_bin()` resolver is the
proven way to run node CLIs from a GUI-launched Tauri app (memory:
`reference_aios_shell_gui_no_node` — GUI app has no node on PATH).

### The OSS-portability landmine (must fix for "anyone who forks")
The shell hard-codes `$HOME/.aios/...` everywhere a fork can't assume:
- `usage.rs:15` → `~/.aios/state/usage.json`
- `bridges.rs:155-177` → `.aios/state/*-log.jsonl`
- `telemetry.rs` → `~/.claude/projects`
- `~/.aios/state/aios.db` — firaz's bridge sqlite. **A fork has none of this.**

There is **zero** use of Tauri's `appDataDir` / `path_resolver` / `BaseDirectory`
anywhere (grepped: 0 hits). So the diag store **must** use the Tauri path
resolver, not `~/.aios`. This is a load-bearing design choice for Phase 1.

### Build / distribution
- Build loop (NO `cd` — triggers permission prompts; from `HANDOFF-SESSION.md:9`):
  `pnpm --dir ~/Repo/firaz/aios/shell tauri build` → `pkill -9 -f "AIOS.app/Contents/MacOS"; rm -rf /Applications/AIOS.app; cp -R <repo>/src-tauri/target/release/bundle/macos/AIOS.app /Applications/AIOS.app; open ...`
  Always `npx tsc --noEmit` == 0 first.
- CI: `.github/workflows/build.yml` builds win+mac via `tauri-action`, uploads
  installers, cuts a GitHub Release **on `v*` tags only** (drafts). This is where
  Phase 4 PRs get their CI green-gate, and where `app_version` originates.
- **app_version source:** `tauri.conf.json` `version: "0.1.0"` (and Cargo.toml
  `0.1.0`, package.json `0.1.0`). At runtime Tauri exposes it via
  `app.package_info().version` (Rust) / `getVersion()` from `@tauri-apps/api/app`
  (JS). Currently `getVersion` is **not imported** anywhere. We add it in Phase 0.
- Tests: `pnpm test:chatpane` runs node `--test` over `src/lib/*.test.ts`. The
  diag module's pure helpers (signature normalization, scrubbing) get unit tests
  here so Phase 4's `tsc + cargo + test` gate has something to assert.

### aios.db — reuse vs duplicate (decision)
`~/.aios/state/aios.db` is **firaz's bridge/engine sqlite** (sessions/weapons/
telemetry/loot). It is **not** part of the OSS shell and a fork will never have
it. Therefore:
- **DO NOT** write diag events into `aios.db`. That couples OSS to firaz's infra
  and breaks portability — the exact thing we're avoiding.
- **DO** let firaz's *aggregation* layer (Phase 2/3, server-side, his machine
  only) optionally cross-reference aios.db `sessions`/`weapons` to enrich triage
  ("this error happened during weapon X"). That's a private join on his side, not
  in the shipped binary.
- Net: the shipped shell writes JSONL to its own app-data dir. aios.db is a
  *consumer* of the aggregated stream on firaz's side, never a dependency.

---

## Phase 0 — Instrumentation (and kills the silent-failure debt)

One `report(event)` sink on each side. Both append to the Phase 1 local store.

### Event schema (the contract — TS + Rust must agree byte-for-byte)

```ts
// src/lib/diag.ts
export type DiagKind = "error" | "usage" | "perf";

export interface DiagEvent {
  ts: string;            // ISO-8601 UTC, e.g. "2026-06-06T11:32:00.123Z"
  kind: DiagKind;
  source: string;        // "pane:terminal" | "pane:browser" | "engine:claude"
                         // | "cmd:pty_write" | "cmd:browser_navigate" | "boundary"
  action?: string;       // optional verb: "ptyWrite" | "navigate" | "save"
  message: string;       // scrubbed, one line
  stack?: string;        // scrubbed stack / component stack (errors only)
  frames?: string[];     // optional pre-split top N frames (clustering input)
  duration_ms?: number;  // perf kind only
  app_version: string;   // from getVersion()
  os: string;            // "macos" | "windows" | "linux"
  anon_install_id: string; // uuid v4, see Phase 2
  schema: 1;             // bump on shape change
}
```

```rust
// src-tauri/src/diag.rs
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DiagEvent {
    pub ts: String,
    pub kind: String,            // "error" | "usage" | "perf"
    pub source: String,          // "cmd:pty_write" | "panic" | ...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub app_version: String,
    pub os: String,
    pub anon_install_id: String,
    pub schema: u8,              // = 1
}
```

### TS side — `src/lib/diag.ts` (new file)
- `reportError(err: unknown, ctx: { source: string; action?: string }): void`
  — builds a `DiagEvent` (kind:"error"), scrubs (Phase 2 scrub fn), and calls the
  Rust sink via `invoke("diag_report", { event })`. Itself wrapped in try/catch
  so the reporter can never throw (no recursive crash).
- `reportUsage(source: string, action: string)` — kind:"usage", fire-and-forget,
  feeds Phase-3 prioritization.
- `reportPerf(source, action, duration_ms)` — kind:"perf".
- Install global handlers in `src/main.tsx`:
  - `window.addEventListener("error", e => reportError(e.error, {source:"window.onerror"}))`
  - `window.addEventListener("unhandledrejection", e => reportError(e.reason, {source:"unhandledrejection"}))`
- **App-wide error boundary:** promote `PaneErrorBoundary` (`CrmPane.tsx:65`) to a
  shared `src/components/ErrorBoundary.tsx`, add `reportError(err, {source:"boundary", action:componentStack})` inside `componentDidCatch`, wrap the
  pane router in `App.tsx` (the renderer that maps pane key → component; do NOT
  rely on a specific line, find the `switch`/map on pane.type). Keep CrmPane's
  inline-retry UX.

### Replace the 91 silent catches (the debt cleanup)
Mechanical sweep, NOT one giant commit — do it per-file so review is sane:
```
.catch(() => {})  →  .catch((e) => reportError(e, { source: "<pane>", action: "<verb>" }))
```
Per-file ctx mapping:
- `TerminalRuntime.tsx` (22) → `source:"pane:terminal"`, action = the call
  (`ptyWrite`/`ptyResize`/`ptyKill`/`clipboard`). e.g. `185`, `391`, `423`, `465`.
- `BrowserPane.tsx` (19) → `source:"pane:browser"`, action = browser verb.
- `App.tsx` (20) → `source:"app"`, action = `oracleLoad`/`chatLoad`/`windowMgmt`/
  `clipboard`/`monitor`. Skip the pure cosmetic `startDragging` (295) — wrap but
  tag `kind` so it can be filtered as noise.
- `IdleDashboard.tsx` (6) / `PulsePane.tsx` (3) → `source:"pane:dashboard"`.
- `ChatPane.tsx` (10) → **leave to the other agent**; hand them the `reportError`
  signature so they wire it during their edit. Document the ctx convention here.
- Note: many catches are on `alive`-guarded polling loads (`App.tsx:709-712`,
  `IdleDashboard:152-156`) — those should report at most once per error signature
  per session (dedupe in the sink) so a backend-down state doesn't spam 1000
  identical events. Add a session-local Set of seen signatures in `diag.ts`.

### Rust side — `src-tauri/src/diag.rs` (new file)
- `#[tauri::command] pub fn diag_report(event: DiagEvent)` — validates, scrubs,
  appends to local store (Phase 1). Register in `lib.rs:58` handler list.
- `pub fn install_panic_hook(app_version: String)` — called once in `run()` in
  `lib.rs` before `.build()`:
  ```rust
  std::panic::set_hook(Box::new(move |info| {
      let ev = DiagEvent { kind:"error".into(), source:"panic".into(),
          message: scrub(&info.to_string()), ... };
      let _ = append_local(&ev);   // best-effort, must not re-panic
  }));
  ```
- `pub fn report_cmd_err(source: &str, e: &str)` — a helper the soft-fail commands
  can call instead of swallowing. Retrofit incrementally (start with the 3
  `eprintln!` sites + the monitor/bridge swallow points). Low priority vs the JS
  sweep — the JS sites are where firaz actually feels breakage.
- `os` via `std::env::consts::OS`; `app_version` passed down from `package_info()`.

### Effort: Phase 0
- diag.ts + diag.rs + schema + sink wiring + boundary promotion: **~1 day**.
- The 91-site sweep: **~0.5 day** (mostly mechanical, per-file commits).
- Panic hook + a few Rust retrofits: **~0.5 day**.
- **Total ~2 days.** Ships value immediately even with no UI (store fills up).

---

## Phase 1 — Local store + in-app diagnostics (default, zero network)

### Store location (the portability decision)
Use the **Tauri path resolver app-data dir**, NOT `~/.aios`:
- Rust: `app.path().app_data_dir()` → e.g. macOS
  `~/Library/Application Support/com.adletic.aios/`, Windows
  `%APPDATA%/com.adletic.aios/`. A fork with a different bundle id gets its own
  dir automatically — that's the point.
- File: `<app_data_dir>/diag/events.jsonl` (one JSON object per line — append-only,
  cheap, greppable, matches the existing `*-log.jsonl` convention).
- This means `diag.rs` needs the `AppHandle` to resolve the path. `diag_report`
  already has it (Tauri injects `AppHandle`); the panic hook captures a resolved
  `PathBuf` at startup (can't get AppHandle inside the hook closure cleanly, so
  resolve once and `move` it in).

### Rotation / cap (don't let it grow unbounded)
- Cap `events.jsonl` at **5 MB** (or 50k lines). On append, if over cap, rotate to
  `events.1.jsonl` and start fresh; keep only 1 rollover (so max ~10 MB on disk).
- Implement in `diag.rs::append_local` with a cheap metadata size check before
  open-append. No external crate needed.

### In-app surface — a **Settings → Diagnostics tab** (cleanest spot)
Firaz is pruning the status pane (memory: chatpane polish / sidebar default-none),
so the status pane is the wrong home. Settings is the natural place:
- Add `"diagnostics"` to the `SectionId` union (`Settings.tsx:619`) and to `NAV`
  (`Settings.tsx:632`) with a `Activity` lucide icon.
- New `src/components/DiagnosticsSection.tsx` rendered when `section==="diagnostics"`
  (`Settings.tsx:912`-style block). Shows:
  - last N events (newest first), filter by kind, copy-as-text.
  - error count by source (the local pre-cluster — group by normalized signature).
  - "open events.jsonl" button (via `opener` plugin, already a dep).
  - "clear diagnostics" button (truncate the file).
  - the **opt-in toggle** for Phase 2 (off by default, with consent copy).
- New Rust command `diag_recent(limit) -> Vec<DiagEvent>` and `diag_clear()`.

### Local-first guarantee
Phases 0+1 make **zero network calls**. Everything stays in app-data. This is the
shippable MVP and the trust foundation: a fork can use the whole diagnostics
experience with no account, no server, no consent prompt.

### Effort: Phase 1
- store + rotation + recent/clear commands: **~0.5 day**.
- Diagnostics tab UI: **~1 day**.
- **Total ~1.5 days.**

---

## Phase 2 — Opt-in remote aggregation ("anyone who forked")

### Endpoint decision: **tiny dedicated Vercel function**, not bisnesgpt
- bisnesgpt is firaz's WA/business server — coupling OSS error reports to it leaks
  his infra and is a trust smell ("why is my error data going to a sales bot?").
- A standalone **`https://aios-diag.vercel.app/api/ingest`** (or a Cloudflare
  Worker — the repo already has `wrangler.jsonc` + `workers/` + a
  `cloudflare-pages.yml` workflow, so **Worker is the lower-friction choice** and
  reuses existing infra). **Recommendation: Cloudflare Worker** — repo already
  wired for it, generous free tier, edge-cheap.
- Store: append to a D1/KV table or a Cloudflare R2 JSONL bucket keyed by
  `anon_install_id` + day. Minimal — this is a sink, the clustering is Phase 3.

### Anonymous install id
- `anon_install_id`: uuid v4 generated once, stored at
  `<app_data_dir>/diag/install_id` (plain text). Generated in Rust on first
  `diag_report`. **No machine fingerprinting, no hostname, no username** — a
  random uuid is the *entire* identity. A fork inherits this for free.

### Consent model (the make-or-break for OSS trust)
- **Off by default.** No event leaves the machine until the user flips the toggle.
- Toggle lives in the Diagnostics tab with explicit copy:
  > "Share anonymous crash + usage reports to help improve AIOS. We send error
  > messages, stack frames (file paths stripped), the feature where it happened,
  > app version and OS — tied to a random ID, never to you. Nothing else leaves
  > your machine. Off by default. [View exactly what's sent] [Open raw log]"
- "View exactly what's sent" opens a modal rendering the **scrubbed** payload of a
  real recent event, so consent is informed, not abstract.
- Persist consent in app-data (`diag/consent.json`: `{enabled:bool, ts}`); the
  Rust sink checks it before any upload. A fork's user makes their own choice.
- Forks get a documented `DIAG_ENDPOINT` build-time env so they can point at
  *their own* aggregator instead of firaz's (so a fork isn't silently shipping
  data to firaz). Default endpoint constant in code; overridable.

### What is sent vs scrubbed (be exact)
**Sent:** `kind, source, action, message (scrubbed), stack/frames (scrubbed),
duration_ms, app_version, os, anon_install_id, schema`.
**Scrubbed before send AND before local store (scrub at ingest, defense in depth):**
- Absolute paths → tokens: `/Users/<x>/...` and `/home/<x>/...` → `~/`;
  `C:\Users\<x>\...` → `%USER%\`. Regex in `src/lib/scrub.ts` + mirror in
  `diag.rs::scrub`.
- Anything after the home prefix that looks like a repo path → keep the
  *basename only* (so `error in /Users/firaz/Repo/secret-client/x.ts` →
  `error in x.ts`). Stack frames keep filename + line, drop the dir.
- Drop any token matching email / phone / obvious key shapes
  (`sk-[A-Za-z0-9]{20,}`, `xox[bp]-`, `AKIA...`, 16-digit runs).
- **Never** send file *contents*, env vars, clipboard text, terminal output
  bodies, message text from panes. Error `message` is capped at 500 chars.
- Honest limit: **PII scrubbing is heuristic, not perfect.** A custom error string
  could embed a secret we don't pattern-match. Mitigations: (a) cap message
  length, (b) the "view exactly what's sent" modal lets users see leakage, (c)
  off-by-default means only opted-in users are ever exposed, (d) keep a public
  `SCRUBBING.md` listing the rules so it's auditable. We document this as a known
  limitation rather than claiming bulletproof.

### Aggregation view for firaz
- Worker exposes `/api/clusters` (auth: a shared secret in firaz's env) returning
  events grouped by **signature** (Phase 3 normalization), with count, app
  versions affected, first/last seen.
- Render: a single-file HTML dashboard (reuse the `web-deliverable-ship` pattern)
  or just a CLI table — firaz consumes it, it doesn't ship in the app.

### Effort: Phase 2
- Worker ingest + KV/R2 store: **~1 day**.
- install_id + consent toggle + scrub (TS+Rust) + "what's sent" modal: **~1.5 days**.
- Aggregation view: **~0.5 day**.
- **Total ~3 days.** Higher risk = the scrubbing correctness; budget extra QA.

---

## Phase 3 — Auto-triage (cluster → dedupe → rank → draft GH issues)

A scheduled job, **no code changes**, triage only.

### Where it runs
- For firaz's own machine: a **launchd plist** (matches the 19 existing AIOS
  plists, memory: `reference_aios_bridge_paths`) running a node script every ~6h.
- For the aggregated OSS stream: a **Worker cron** (`wrangler.jsonc` supports
  `[triggers] crons`) hitting `/api/clusters` then `gh`.

### Clustering / signature (reuse monitor.rs ideas)
- Signature = `sha1(normalize(message) + "|" + top_frame)`.
- `normalize(message)`: lowercase, strip digits → `N`, strip hex → `H`, strip the
  already-scrubbed paths, collapse whitespace. (Same spirit as
  `monitor.rs:232 fresh_error_lines` + `ERROR_NEEDLES`.)
- `top_frame`: first frame in `frames[]` after dropping node_modules / framework
  frames — the app's own frame is the cluster key.
- Dedupe by signature; aggregate count, `app_versions: Set`, `os: Set`,
  first_seen/last_seen, `sources: Set`.

### Ranking (this is where usage analytics feeds in — see §"What I use")
`score = frequency × severity × is_on_used_feature`
- `frequency` = event count for the signature.
- `severity`: panic/boundary-crash = 3, command Err = 2, swallowed-catch = 1,
  perf-regression = 1.
- `is_on_used_feature` = usage-count of `source` from the kind:"usage" stream,
  normalized. **Fix what's actually used.** An error in a pane firaz opens 50×/day
  outranks one in a pane opened once.

### GitHub issue drafting
- For each **new** cluster above a score threshold (and not already filed), draft
  an issue via `gh issue create` against `ferazfhansurie/aios-superapp`:
  - title: `[auto-triage] <normalized message> (<source>)`
  - body: count, app_versions affected, os spread, first/last seen, top 3 raw
    (scrubbed) stack frames, repro hint (the `action` + `source`), the signature
    hash (idempotency key — search existing issues by it before filing).
  - label `auto-triage` + `needs-confidence`.
- Track filed signatures in a small state file so re-runs don't duplicate.

### Effort: Phase 3
- clustering + ranking lib (+ unit tests in `test:chatpane`): **~1 day**.
- launchd/Worker cron + `gh` drafting + idempotency: **~1 day**.
- **Total ~2 days.** Pure-function clustering is testable; the flaky part is `gh`
  auth in a launchd context (no PATH — use full `gh` path, like `node_bin()`).

---

## Phase 4 — Auto-fix loop (the ambition, heavily gated)

For **high-confidence** clusters only, spawn a fix agent (AIOS recursive-oracle
pattern) → branch → implement → verify → PR. **Human-gated initially.**

### Pipeline
1. Triage (Phase 3) marks a cluster `auto-fixable` only if it matches a
   **whitelist of low-risk signatures** (see below) AND score > threshold AND has
   a clear top frame in shell-owned code.
2. Dispatch a fix agent (Task tool, `run_in_background:true`) with: cluster
   summary, scrubbed frames, the offending file:line (from `top_frame`), repro
   hint. Instruct it to (a) reproduce/understand, (b) implement minimal fix, (c)
   add a regression test, (d) run the gate.
3. **Gate (all must pass):** `npx tsc --noEmit` == 0, `cargo check` (or
   `cargo build`) == 0, `pnpm test:chatpane` green.
4. Open a PR: branch `autofix/<signature8>`, body links the cluster + event count
   + app versions, labels `auto-fix` + `needs-review`. **Never pushes to master.**
5. CI (`build.yml`) must go green on the PR before any merge.

### Graduation to auto-merge (only later, only for a whitelist)
- Auto-merge-on-green **only** for a curated allow-list of signature *classes*
  that are mechanically safe, e.g.:
  - "unhandled rejection from a known fire-and-forget load → add reportError ctx"
  - "missing null-guard on optional pane data" (the IdleDashboard-style loads)
  - "stale pane key / Math.random regression" (see POLISH-PLAN.md:59)
- Guardrails, non-negotiable:
  - CI green required (no exceptions).
  - confidence threshold (agent self-scores; below → human review).
  - a **kill switch**: a single config flag (`diag/autofix.json: {enabled:false}`)
    + a `gh` label `autofix-pause` that halts all dispatch.
  - rate limit: max 1 auto-merge PR / day initially.
  - every auto-merge still leaves the PR + its CI run as an audit trail.

### Honest reliability limits (do not oversell)
- **This will not fix most bugs.** It reliably handles *mechanical, localized,
  test-coverable* defects — null guards, missing error handling, stale keys. It
  will **not** fix logic bugs, race conditions, design flaws, or anything needing
  product judgment. Expect a meaningful PR rate only on the whitelist; everything
  else stays human-triaged (Phase 3 issues).
- Agent-written fixes can be *plausible but wrong* — that's why the CI green +
  human gate exists before auto-merge graduation. The default is **human-gated PR,
  forever** for anything off the whitelist.
- A bad auto-fix that passes CI but regresses UX is the real risk; the whitelist +
  rate limit + kill switch are the defense, plus firaz reviews the first ~20 PRs
  manually to calibrate before enabling any auto-merge.

### Effort: Phase 4
- agent dispatch + branch/PR plumbing + gate runner: **~2 days**.
- whitelist + kill switch + confidence scoring + calibration: **~2 days** + ongoing
  tuning. **This is the experimental phase — treat estimates as soft.**

---

## "What I use" — usage analytics → auto-fix prioritization

- kind:"usage" events from `reportUsage(source, action)` at the cheap hot spots:
  pane open/focus (in `App.tsx` pane router), command palette invocations
  (`⌘K`), terminal spawn, chat send, browser navigate. Fire-and-forget, debounced.
- Aggregated locally into per-source counters (and into the opt-in stream if
  consent on). These counters are the `is_on_used_feature` multiplier in Phase 3
  ranking — so the auto-fix loop spends effort on **the panes firaz/forkers
  actually live in**, not dead corners.
- Also surfaced read-only in the Diagnostics tab ("most-used features this week")
  — a nice honest "here's what the data says you use" without any dark-pattern.
- Privacy: usage events carry only `source`/`action` enums — never argument
  values, never typed text. Same scrub + consent gate as errors.

---

## Privacy / consent model (consolidated — the OSS trust contract)

1. **Local-first.** Phases 0+1 are fully offline. The product is *complete and
   useful* with the network never touched.
2. **Opt-in, off by default.** No upload without an explicit toggle. Consent copy
   states exactly what's sent + a live "view exactly what's sent" modal.
3. **Anonymous.** Identity = a random uuid in app-data. No hostname, username,
   email, IP-derived id, or fingerprint. Forks inherit this.
4. **Scrubbed twice.** Paths/PII stripped at local-store time *and* re-checked at
   send time. Rules are public + auditable (`SCRUBBING.md`). Honest about
   heuristic limits.
5. **Fork-sovereign.** `DIAG_ENDPOINT` is overridable so a fork ships to its own
   aggregator, not firaz's. Default endpoint documented in README.
6. **No content, ever.** File contents, terminal/chat bodies, clipboard, env vars
   are never collected, even with consent on.
7. **User control.** Clear/export local log, flip consent off any time (immediate,
   no re-upload), and the autofix kill switch.

---

## Reuse vs duplicate — summary
| Existing | Reuse how | Don't |
|---|---|---|
| `telemetry.rs` (usage agg) | serde-struct style reference | name-collide — new module is `diag.rs` |
| `monitor.rs` error detection | lift `ERROR_NEEDLES` + line-diff for signatures | re-implement clustering from scratch |
| `monitor.rs::node_bin()` | run node/gh CLIs from GUI context | assume node on PATH |
| `CrmPane.tsx PaneErrorBoundary` | promote to app-wide boundary + add reporting | leave it CrmPane-only |
| `wrangler.jsonc` + `workers/` + CF pages CI | host the ingest Worker + cron here | spin up a separate Vercel project |
| `aios.db` | private join on firaz's side for triage enrichment | write diag events into it / ship dependency |
| app-data dir (currently unused) | the diag store home | reuse `~/.aios` (breaks forks) |
| `build.yml` | the CI green-gate for Phase 4 PRs | bypass CI for auto-merge |

---

## Recommended MVP + phase ordering

**Ship Phase 0 + Phase 1 first.** It is the obvious MVP because it:
- clears the 91-site silent-failure debt (real, audited tech debt),
- adds the app-wide error boundary + panic hook (no more white-screens / silent
  Rust deaths),
- gives a local Diagnostics tab — zero network, zero consent friction, works for
  every fork on day one,
- produces the event stream every later phase depends on.

Effort to MVP: **~3.5 days** (P0 ~2d + P1 ~1.5d). Highest value, lowest risk,
fully local — no trust questions to answer yet.

Then:
- **Phase 2** (~3d) once the local stream is proven — gated behind the consent
  toggle, so it's additive and reversible.
- **Phase 3** (~2d) to turn the stream into ranked GitHub issues — pure win, no
  code mutation.
- **Phase 4** (~4d+ ongoing) last and most cautiously — human-gated PRs first,
  auto-merge only after manual calibration on a tiny whitelist, with a kill switch.

Total to full system: **~12-13 engineering days**, front-loaded so the first 3.5
deliver standalone value and the silent-failure debt is gone regardless of whether
the later phases ever ship.
