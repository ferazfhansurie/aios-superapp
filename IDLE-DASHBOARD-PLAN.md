# Idle Dashboard Redesign — minimal-but-useful

**Status:** PLAN ONLY. No source touched. firaz picks an option (A or B) before any code is written.
**Repo:** `/Users/firazfhansurie/Repo/firaz/aios/shell`
**Goal:** the home screen shown when no panes are open should be MORE MINIMAL but STILL USEFUL. Lots of negative space, one clear focal point, glance + launch.

---

## 0. Audit — what renders today (the load-bearing finding first)

### CRITICAL: `IdleDashboard.tsx` is a thin wrapper — the real screen is `IdleControlCenter.tsx`

`src/components/IdleDashboard.tsx:185-209` does an **early `return <IdleControlCenter .../>`**. Everything below that return — the bento grid, the `widgets`/`customizing` state, `WidgetControls`, `renderWidget`, the omni-input header, the `Pulse` hero, `DeviceTile`, `AppDock`, `FleetBoard`, `RecentProjects`, `DevPulse`, `PinnedSpaces`, `MoneyAgentsBoard` — is **dead code that never executes**. The `widgets`/`idleDashboardLayout.ts` customize system is also dead (state is set up at `IdleDashboard.tsx:139-228` but never reaches render).

So:
- `IdleDashboard.tsx` today is effectively just a **data-loader + pass-through**. It self-loads `extras / rate / focus / device / pulse / moneyAgents` (`:150-183`) and forwards them to `IdleControlCenter`. (`device` is loaded but NOT forwarded — `:135,156` → not in the `<IdleControlCenter>` prop list `:186-208`.)
- The **actual idle UI** = `IdleControlCenter.tsx` + its five lanes under `src/components/dashboard/`.
- App wires it at `src/App.tsx:2216-2234` (`<IdleDashboard .../>`), rendered when `panes.length === 0` (`:2239`) or all panes hidden (`:2242`).

This is good news for a redesign: the dead bento code (and `idleDashboardLayout.ts` + its tests) is the heaviest thing to delete, and it costs nothing because nothing renders it.

### What `IdleControlCenter` actually shows, section by section

Source: `src/components/IdleControlCenter.tsx`.

| # | Section | file:line | What it shows | Data source |
|---|---------|-----------|---------------|-------------|
| 1 | **Header** | `IdleControlCenter.tsx:75-89` | kicker "aios control center" + tagline "jarvis routes the work. chat panes keep the audit trail." + a `command ⌘k` button | static text + `onOpenPalette` |
| 2 | **PulseIdentityBand** | `:93` → `dashboard/PulseIdentityBand.tsx` | "pulse / activity & usage" header; tiny right-aligned `5h / 7d / ctx` numbers (`PulseIdentityBand.tsx:52-56`); an **8-tile metric grid** (day streak, sessions, messages, tokens, top model, active 7d, active 30d, active since — `:33-42,58-66`); a **focus** line (`:67-71`); and a **70-day activity heatmap** on the right (`:73-76` → `ActivityHeatmap`) | `extras` (UsageExtras), `rate` (IdleRate), `focus` (MemoryFocus) |
| 3 | **JarvisBriefingLane** | `:96-101` → `dashboard/JarvisBriefingLane.tsx` | "jarvis / broker between firaz and agents" header; a big `primaryPrompt` line; "N control signals · M unread"; one "talk to jarvis" button seeded with a generated prompt | `buildJarvisBriefing({agents, notifications, focus})` |
| 4 | **NotificationCommandLane** | `:102-107` → `dashboard/NotificationCommandLane.tsx` | "notifications / N unread · M important"; a list of notification cards each with talk-to-jarvis / open-context / dismiss buttons | `notifications` (AiosNotification[]) |
| 5 | **PetDashboardCompanion** | `:108-110` (lazy) → `PetPane.tsx:543-632` | "pet system / <label>" + activity/health/stress sub; an animated pixel-pet world canvas; feed / flush memory / cool down / ask-jarvis buttons | `getPetState()` / `subscribePetState` |
| 6 | **AgentOperationsLane** | `:113-117` → `dashboard/AgentOperationsLane.tsx` | "agents / X running · Y need control · Z failed"; a 3-col grid of agent cards (urgency bar, last run, schedule, next action, inspect / run-pulse buttons) | `moneyAgents` (MoneyAgentSummary[]) |
| 7 | **ControlCenterCharts** | `:119` → `dashboard/ControlCenterCharts.tsx` | 3-col charts row: **another** 70-day heatmap (duplicate of #2), agent run timeline bars, approval-aging bars + 14-day trend bars | `extras`, `agents`, `notifications` |
| 8 | **Quick-stat button row** | `:121-154` | 4 buttons: talk-to-jarvis · "N/M agents running" · "N notifications · M pinned" · "N repos need review" | `moneyAgents`, `notifications`, `pinned`, `pulse` |
| 9 | **Pinned strip** | `:156-172` | pinned sidebar links as chips + "N/M oracle panes awake · K tools" | `sidebar.items` (group `pinned`), `oracles`, `apps` |

### Data sources in play (all already-wired — REUSE, don't rebuild)
- **`extras: UsageExtras`** — `lib/stats.ts:11-21` (`currentStreak, longestStreak, active7d, active30d, totalSessions, totalMessages, favoriteModel, tokensTotal, firstSessionDate, heatmap[]`). Loaded `IdleDashboard.tsx:153`.
- **`rate: IdleRate`** — `lib/dashboard.ts:98-134` (claude `fiveHour/sevenDay` pct + resets, `contextPct`). Loaded `IdleDashboard.tsx:154`.
- **`claudeRate()` / `codexRate()`** — `lib/dashboard.ts:218-242` / `:150-205`. These power the **sidebar usage** block (`components/SidebarUsage.tsx`) and the chat-pane meters (`ChatPane.tsx:95,1398,1628`). The idle dashboard currently only uses claude (`rate`), NOT codex. To show **claude + codex at-a-glance** the minimal redesign should pull both — exactly like `SidebarUsage` does.
- **`focus: MemoryFocus`** — `lib/dashboard.ts:77-88` (freshest memory note `tag` + `title`). Loaded `:155`.
- **`device: DeviceStats`** — loaded `:156` but never displayed (dead).
- **`pulse: RepoPulse[]`** — git state for recent projects, `lib/fs.ts gitPulse`. Loaded `:168-183`.
- **`projects: ProjectInfo[]`** — from `list_projects` via App (`run.ts`). `recent` = top 6 by mtime (`IdleDashboard.tsx:148`).
- **`oracles`, `sidebar`, `apps`, `notifications`, `moneyAgents`** — all props/loads already present.
- **pet state** — `lib/pet.ts` via `getPetState`/`subscribePetState`.

### Reusable building blocks already written (so the minimal build is mostly deletion + recompose)
- `Ring` (animated %-ring) — exported from `IdleDashboard.tsx:1281`.
- `HeroClock` (isolated 1Hz clock, CSS colon blink, comment at `:1035-1037` explains the perf isolation) — `IdleDashboard.tsx:1038-1060`. **Not exported yet** — would need export or copy.
- `Greeting` (time-of-day + date) — `IdleDashboard.tsx:565-583`.
- `ProviderBlock` / `UsageBar` (claude + codex 5h/7d bars with pace warnings) — `SidebarUsage.tsx:39-128`. **Not exported** — copy the pattern or lift to a shared file.
- `ActivityHeatmap` — exported from `dashboard/ControlCenterCharts.tsx:18`.
- `RecentProjects`, `FleetBoard`, `QuickActions`, `OmniInput`, `AppDock` — all live in `IdleDashboard.tsx` (currently dead), ready to reuse.

---

## 1. Per-element verdict (keep / cut / restyle)

The bar: **what does firaz actually glance at on an empty screen?** time/date · claude+codex usage · a fast way to start work (recent projects / new chat / new terminal / ⌘K) · pet as a small ambient touch. Everything else is noise on a *home* screen — it belongs in a pane you open on purpose (agent monitor, notifications inbox, pulse pane), not on the at-rest surface.

| Element | Verdict | Rationale |
|---------|---------|-----------|
| Header tagline "jarvis routes the work…" (`IdleControlCenter.tsx:78`) | **CUT** | marketing copy on your own daily driver; replace with greeting + clock |
| `command ⌘k` button (`:80-88`) | **KEEP, restyle** | the universal launch is the single most useful affordance; make it the focal input, not a corner button |
| PulseIdentityBand 8-metric grid (`PulseIdentityBand.tsx:58-66`) | **CUT to 1** | sessions/messages/tokens/top-model/active-since are vanity stats you never act on. Keep **day streak** only (one ambient number) |
| 5h/7d/ctx mini-numbers (`PulseIdentityBand.tsx:52-56`) | **KEEP, upgrade** | this is the at-a-glance usage firaz wants — but show **claude AND codex** (reuse `SidebarUsage`'s ProviderBlock), not just claude |
| focus line (`PulseIdentityBand.tsx:67-71`) | **KEEP, restyle-minimal** | one quiet line ("what am i on") is useful context; keep it small + single-line |
| 70-day heatmap ×2 (`PulseIdentityBand.tsx:73-76` AND `ControlCenterCharts.tsx:117-120`) | **CUT one, demote other** | rendered twice. At most one small heatmap as ambient texture — or cut entirely for ultra-minimal |
| JarvisBriefingLane (`JarvisBriefingLane.tsx`) | **CUT from home** | a generated "talk to jarvis" prompt belongs behind ⌘K / a chat pane, not occupying a third of the home screen |
| NotificationCommandLane (`NotificationCommandLane.tsx`) | **CUT to a count** | full notification cards = an inbox, not a home screen. Keep a single "N notifications" pill that opens the rail/inbox |
| PetDashboardCompanion (`PetPane.tsx:543`) | **KEEP as small corner** | firaz explicitly wants the pet as a small ambient touch — shrink to a corner companion, drop the feed/flush/cool action row from the home view (those live in the pet pane) |
| AgentOperationsLane (`AgentOperationsLane.tsx`) | **CUT to a count** | the 3-col agent grid is the agent-monitor pane's job. Keep "X agents running" as one launch pill → opens money-agents pane |
| ControlCenterCharts (`ControlCenterCharts.tsx`) | **CUT** | timeline + approval-aging + trend bars are dashboard-pane material, pure noise at rest |
| 4 quick-stat buttons (`IdleControlCenter.tsx:121-154`) | **CUT to a thin status footer** | collapse the useful counts (agents running · notifications · repos dirty) into one quiet footer line; drop talk-to-jarvis (it's ⌘K) |
| pinned strip (`:156-172`) | **KEEP optional** | small pinned chips are a fast launch; keep in option B, drop in option A |
| Recent projects | **ADD (reuse dead code)** | currently NOT shown in the live screen, but it's the #1 "jump into work" affordance and the component already exists (`IdleDashboard.tsx:794`). Add to option B |
| clock/date | **ADD (reuse dead code)** | the live `IdleControlCenter` has NO clock; the dead path's `HeroClock`/`Greeting` are exactly the centerpiece a minimal home wants |
| device tile, dev pulse, fleet board, app dock | **CUT from home** | all dead today; keep them dead. Fleet/apps/dev are launchable via ⌘K + rail |

---

## 2. Option A — ultra-minimal (clock + usage + command line)

One vertical stack, centered, max-width ~720px, enormous negative space. The clock is the focal point; the command input is the one thing you touch; usage is a quiet glance; the pet sits tiny in a corner. Nothing else.

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                                                                      │
│                                                                      │
│                          good evening, firaz                         │
│                       saturday, 6 june · 21:47                       │
│                                                                      │  ← clock = focal, clamp(48–72px)
│                                                                      │
│            ┌────────────────────────────────────────────┐           │
│            │  ⌕  launch, ask, or resume anything…    ⌘K  │           │  ← single command line, the only CTA
│            └────────────────────────────────────────────┘           │
│                                                                      │
│              claude  ▓▓▓▓▓▓░░░░  61% 5h   ▓▓▓░░░░ 28% 7d              │  ← claude + codex, quiet
│              codex   ▓▓▓▓▓▓▓▓░░  79% 5h   ▓▓▓▓░░░ 44% 7d              │
│                                                                      │
│                       🔥 7 day streak                                │  ← one ambient number (optional)
│                                                                      │
│                                                                      │
│                                                            ┌──────┐  │
│   3 agents running · 2 notifications · 1 repo dirty        │ pet  │  │  ← thin footer + tiny pet corner
└────────────────────────────────────────────────────────────────────┘
```

**Scaling:** the stack stays centered (`flex` column, `justify-center`, `max-w-[720px] mx-auto`). Clock font is `clamp()`. On a short window the streak line and footer drop first; the clock + command + usage never drop. Pet is `position: absolute` bottom-right, fixed small size, hidden under a min-height.

**KEEP:** clock/date (greeting), command line (⌘K), claude+codex usage, day streak (ambient), tiny pet, one-line status footer.
**CUT:** everything else — jarvis lane, notification cards, agent grid, charts, heatmap, metric grid, pinned, recent projects, dev pulse, fleet, app dock, tagline.

---

## 3. Option B — minimal-with-quick-launch (clock + usage + recent-projects + pet corner)

Same calm centerpiece as A, but adds the single most useful "jump into work" affordance — a small recent-projects / quick-launch column — and keeps pinned chips. Two-zone: hero band on top, one launch row below. Still very lean vs today.

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                      │
│        good evening, firaz                                  ┌──────┐ │
│        saturday, 6 june                                     │ pet  │ │  ← pet small, top-right corner
│                                                             └──────┘ │
│        ╔══════════════════╗                                          │
│        ║      21 : 47      ║   claude  ▓▓▓▓▓▓░░  61%5h  28%7d         │  ← clock focal-left, usage right
│        ║       :08         ║   codex   ▓▓▓▓▓▓▓▓  79%5h  44%7d         │
│        ╚══════════════════╝   🔥 7  ·  focus: aios shell daily driver │
│                                                                      │
│        ┌──────────────────────────────────────────────────────┐     │
│        │  ⌕  launch, ask, or resume anything…              ⌘K  │     │  ← command line, full-width
│        └──────────────────────────────────────────────────────┘     │
│                                                                      │
│   RECENT                              QUICK                          │
│   ▸ aios/shell        2m   main       + new chat                     │  ← recent projects (reuse) + actions
│   ▸ aios-firaz        1h   main       + terminal                     │
│   ▸ wrms-collector    3h   i2-dev     ⌕ palette                      │
│   ▸ claude-support    1d   main       ⬓ rail                         │
│                                                                      │
│   ◷ aios.db  ◷ neon  ◷ jira          3 agents · 2 notif · 1 dirty    │  ← pinned chips + status footer
└────────────────────────────────────────────────────────────────────┘
```

**Scaling:** top band is a `grid xl:grid-cols-[auto_1fr]` (clock left, usage right; stacks on narrow). Command line spans full width. The RECENT/QUICK row is `grid lg:grid-cols-2` → single column when narrow; recent projects cap at 4-5 rows. Pinned chips wrap. Footer is one line. On a small window the RECENT/QUICK row and pinned strip collapse, leaving the A-style core.

**KEEP:** clock/date, command line, claude+codex usage, day streak + focus (one line), small pet corner, recent projects (reuse `RecentProjects`), quick actions (reuse `QuickActions`), pinned chips, status footer.
**CUT:** jarvis lane, notification cards, agent grid, charts (timeline/approval/trend), the 8-metric grid, heatmap (or keep one tiny strip under usage — optional), dev pulse, fleet board, app dock, tagline.

---

## 4. Cost — cheap (recompose existing) vs needs-wiring

### Cheap (delete / restyle / reuse what's already written)
- **Delete the dead bento path** in `IdleDashboard.tsx` (everything after the early return `:209`) + `lib/idleDashboardLayout.ts` + `idleDashboardLayout.test.ts`. Pure deletion, nothing renders it. (Keep the exported helpers `Ring/heatColor/fmtNum/shortModel/shortDate` if PulsePane still imports them — verify `git grep` before deleting; `Ring` is shared with PulsePane per the comment at `:1279-1280`.)
- **Clock + Greeting:** reuse `HeroClock` (`:1038`) and `Greeting` (`:565`) — already perf-isolated (1Hz re-render scoped so it doesn't reconcile siblings — keep that isolation). Just export them or move to a shared `dashboard/` file.
- **Recent projects / quick actions / pinned / app dock:** the components exist in `IdleDashboard.tsx` (dead) — lift the ones you keep into the new layout. No new logic.
- **Heatmap (if kept):** `ActivityHeatmap` already exported from `ControlCenterCharts.tsx:18`.
- **Status-footer counts:** `activeAgents`, `unread`, `dirtyProjects`, `pinned` already computed in `IdleControlCenter.tsx:68-71` — reuse the exact expressions.
- **Pet corner:** `PetDashboardCompanion` already lazy-loaded; just wrap it smaller / pass a `compact` flag (or a new tiny variant) and drop the action row for the home view.

### Needs new wiring (small)
- **Codex usage on the idle screen:** today `IdleDashboard` loads only `idleRate()` (claude). Add a `codexRate()` load alongside it (`useState<CodexRate>` + add to the 30s `load()` at `IdleDashboard.tsx:152-159`) and forward to the new layout. The display component = lift `ProviderBlock`/`UsageBar` out of `SidebarUsage.tsx` into a shared `dashboard/UsageGlance.tsx` so both the sidebar and the idle screen use ONE source (don't duplicate the bar markup). ~30 lines.
- **A `compact`/home variant of the pet** (or just CSS-scale the existing canvas) — small, optional.
- **New layout component** replacing `IdleControlCenter`'s body — either a new `IdleHome.tsx` or a rewrite of `IdleControlCenter`'s return. The data-loading in `IdleDashboard.tsx:150-183` mostly stays (drop `device`, `pulse`/`moneyAgents`/`notifications` if option A; keep `projects`/`pulse` if option B wants dirty-count + recent).

### What to leave alone
- `App.tsx:2216-2234` wiring — keep the same `<IdleDashboard>` entry point and prop names so the redesign is internal; trim props only after the layout settles.
- `SidebarUsage` keeps working — just import the shared bar from the new location.
- Money-agents / notifications / jarvis features aren't deleted as features — they keep their dedicated panes (money-agents pane, rail). We only remove them from the *home* surface.

---

## 5. TDZ pitfall for the builder (read before writing the new layout)

The redesign will compute several derived values (`recent`, counts, `hasClaude`/`hasCodex`, `weeks` for any heatmap) and likely a `useMemo` or two. **Do not reference a `const` before its declaration** inside the same render/`useMemo` body — `const`/`let` are in the temporal dead zone until their line executes, and a forward reference throws `ReferenceError: Cannot access 'x' before initialization` at runtime (not a compile error in TS — it'll build clean and crash the idle screen white).

Concretely:
- Today `IdleDashboard.tsx:148` computes `recent` at the top of the component, BEFORE the `return`, and the `useEffect` at `:168-183` depends on `recent.map(...)`. Keep that ordering — declare `recent` (and any `codex`/`claude` derived flags) **above** any hook or JSX that reads them.
- If you introduce a `useMemo(() => { ... }, [deps])` that builds, e.g., the heatmap `weeks`, declare `days`/`max` inside the memo body in dependency order; don't read a `weeks` const inside the same memo that defines it.
- Watch the early-return trap that created the current dead code: if you keep an early `return` for a loading/empty state, **put it after** all hooks (React's rules-of-hooks) AND make sure no later `const` is needed by the returned JSX. The cleanest move is to delete the early `return <IdleControlCenter>` and render the new layout inline so there's no dead tail.

---

## 6. Recommendation + phased build

**Recommend Option B.** Option A is beautiful but firaz's daily driver needs the one-click "jump back into work" — recent projects + quick actions are the highest-value affordance on an empty screen, and they already exist as components (zero rebuild). B keeps A's calm centerpiece (clock + command + usage + tiny pet) and adds exactly one launch row. It's "minimal but useful" rather than "minimal but you still have to ⌘K everything." If after living with B the launch row feels heavy, it degrades cleanly to A by hiding that row.

**Phased build (after firaz picks):**
1. **P0 — shared usage glance.** Lift `ProviderBlock`/`UsageBar`/`barColor` from `SidebarUsage.tsx` into `src/components/dashboard/UsageGlance.tsx`; repoint `SidebarUsage` to import it. Verify sidebar still renders. (No visual change yet — pure refactor, safe checkpoint.)
2. **P1 — new home layout.** Build the option-B layout (clock + command + UsageGlance(claude+codex) + streak/focus line + recent projects + quick actions + pinned + status footer + tiny pet corner), reusing `HeroClock`, `Greeting`, `RecentProjects`, `QuickActions`, the count expressions from `IdleControlCenter.tsx:68-71`. Add `codexRate()` to the loader. Swap `IdleDashboard`'s early return to render the new layout.
3. **P2 — delete dead weight.** Remove the dead bento tail in `IdleDashboard.tsx`, `lib/idleDashboardLayout.ts`, `idleDashboardLayout.test.ts`, and the now-unused dashboard lanes if nothing else imports them (`JarvisBriefingLane`, `NotificationCommandLane`, `AgentOperationsLane`, `PulseIdentityBand`, `ControlCenterCharts` — `git grep` each first; ControlCenterCharts exports `ActivityHeatmap` which the home may still use). Trim unused props from the `App.tsx:2216` call.
4. **P3 — pet compact variant + polish.** Small pet corner, reduce-motion respect (the dead path had `data-reduce-motion` handling — carry it over), responsive collapse for short windows.
5. **Verify:** build, launch the GUI (`open /Applications/AIOS.app` or dev), confirm no white-screen (TDZ), confirm sidebar usage unchanged, confirm idle screen renders with no panes open.

Each phase is independently shippable; P0 and P2 are safe refactors, P1 is the visible redesign.
