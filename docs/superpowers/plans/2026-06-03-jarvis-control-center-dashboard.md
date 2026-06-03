# jarvis control center dashboard implementation plan

> **for agentic workers:** required sub-skill: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. steps use checkbox (`- [ ]`) syntax for tracking.

**goal:** rebuild the idle dashboard into one continuous aios command center that keeps the pulse identity firaz likes, while making jarvis the broker between firaz and agents, surfacing proactive notifications, approval state, useful charts, and app-wide system indicators.

**architecture:** replace the current bento widget grid with a unified `IdleControlCenter` surface composed of focused lanes: pulse, command status, jarvis briefings, notification action queue, agent operations, approvals, pipeline, and utility rail. chat panes are audit/history surfaces only; jarvis sends hidden commands to agents and reports back through dashboard + notifications.

**tech stack:** react 19, typescript, tailwind utility classes, lucide icons, existing local data helpers in `src/lib/dashboard.ts`, `src/lib/stats.ts`, `src/lib/moneyAgents.ts`, and existing tauri app shell pane callbacks.

---

## file map

- create `src/components/IdleControlCenter.tsx`
  - new unified dashboard shell.
  - owns composition, not data fetching.
  - receives already-loaded pulse, usage, agent, project, app, and sidebar data from `IdleDashboard`.
- create `src/components/dashboard/ControlCenterCharts.tsx`
  - small svg/css chart primitives: activity heatmap, trend bars, agent timeline, approval aging.
  - no chart dependency unless the implementation proves css/svg is insufficient.
- create `src/components/dashboard/AgentOperationsLane.tsx`
  - shows agent status, next run, last run, control needed, current money move, and hidden command buttons.
- create `src/components/dashboard/PulseIdentityBand.tsx`
  - preserves the current pulse metrics and 70-day activity feel.
- create `src/components/dashboard/ApprovalLane.tsx`
  - first version can derive pending approvals from agent summaries and queue state.
  - later can read a richer approval store.
- create `src/components/dashboard/JarvisBriefingLane.tsx`
  - summarizes what jarvis thinks firaz should discuss, approve, ignore, or inspect.
  - main route is "talk to jarvis about this", not direct agent chat.
- create `src/components/dashboard/NotificationCommandLane.tsx`
  - highlights unread/proactive notifications with actions.
  - opens the relevant app/chat context when firaz chooses.
- create `src/lib/controlCenter.ts`
  - pure view-model helpers for derived dashboard state.
- create `src/lib/controlCenter.test.ts`
  - tests for derived state: fleet status, urgency, last run labels, trend bucketing.
- modify `src/components/IdleDashboard.tsx`
  - keep data fetching.
  - replace widget-grid rendering with `IdleControlCenter`.
  - keep old components available until final cleanup.
- modify `src/lib/idleDashboardLayout.ts`
  - either retire bento widget layout or keep only for a temporary compatibility fallback.
- modify `src/lib/idleDashboardLayout.test.ts`
  - update/retire tests that assume widgets are the primary structure.
- modify `src/lib/moneyAgents.ts`
  - finish summary fields: `schedule`, `lastRunAt`, `pendingApprovalCount`, `latestOutput`, `nextRunAt`, `runState`.
- modify `src/lib/notifications.ts`
  - add richer action/source metadata if needed for "talk to jarvis about this" and "inspect agent history".
- modify `src/lib/bundleBoundaries.test.ts`
  - assert dashboard exposes control-center lanes and does not regress to launcher tiles.
  - assert agent chat panes are not the primary control path.

---

## task 1: control center view model

**files:**
- create: `src/lib/controlCenter.ts`
- create: `src/lib/controlCenter.test.ts`
- modify: `src/lib/moneyAgents.ts`

- [ ] **step 1: write failing tests for agent dashboard state**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeAgentFleet, formatRelativeRunAge } from "./controlCenter.ts";

test("summarizeAgentFleet surfaces running, blocked, and approval state", () => {
  const fleet = summarizeAgentFleet([
    { id: "growth", label: "growth", health: "needs-steer", primaryMetric: "3 queued", currentJob: "image asset missing", nextAction: "approve asset fix", schedule: "daily", lastRunAt: Date.now() - 60_000 },
    { id: "outreach", label: "outreach", health: "scheduled", primaryMetric: "6 leads", currentJob: "zapeus", nextAction: "prepare evidence", schedule: "daily", lastRunAt: Date.now() - 120_000 },
  ]);
  assert.equal(fleet.total, 2);
  assert.equal(fleet.needsControl, 1);
  assert.equal(fleet.runningOrScheduled, 1);
  assert.match(fleet.headline, /control needed/);
});

test("formatRelativeRunAge produces compact dashboard labels", () => {
  assert.equal(formatRelativeRunAge(null, 1000), "never");
  assert.equal(formatRelativeRunAge(1000 - 60_000, 1000), "1m ago");
});
```

- [ ] **step 2: run test to verify it fails**

run: `node --experimental-strip-types --test src/lib/controlCenter.test.ts`

expected: fail because `src/lib/controlCenter.ts` does not exist.

- [ ] **step 3: implement pure helpers**

implement:
- `formatRelativeRunAge(lastRunAt, now = Date.now())`
- `summarizeAgentFleet(agents)`
- `agentUrgency(agent)`
- `agentRunLabel(agent)`
- `summarizeNotifications(notifications)`
- `buildJarvisBriefing({ agents, notifications, focus })`

keep helpers pure. do not read localstorage or tauri APIs in this file.

- [ ] **step 4: run focused tests**

run: `node --experimental-strip-types --test src/lib/controlCenter.test.ts src/lib/moneyAgents.test.ts`

expected: pass.

---

## task 2: pulse identity band

**files:**
- create: `src/components/dashboard/PulseIdentityBand.tsx`
- modify: `src/components/IdleDashboard.tsx`
- test: `src/lib/bundleBoundaries.test.ts`

- [ ] **step 1: add boundary test**

assert `IdleControlCenter` imports `PulseIdentityBand`, and `PulseIdentityBand` includes:
- `day streak`
- `sessions`
- `messages`
- `tokens`
- `top model`
- `active since`
- `70-day activity`
- `focus`

- [ ] **step 2: extract existing pulse rendering**

move the loved pulse presentation from `IdleDashboard.tsx` into `PulseIdentityBand`.

keep the vibe:
- compact metric typography.
- streak, sessions, messages, tokens.
- model/rate usage.
- focus block.
- activity heatmap.

do not wrap each metric in a big card. this is one band.

- [ ] **step 3: run tests**

run: `node --experimental-strip-types --test src/lib/bundleBoundaries.test.ts`

expected: pass.

---

## task 3: unified control center shell

**files:**
- create: `src/components/IdleControlCenter.tsx`
- modify: `src/components/IdleDashboard.tsx`
- modify: `src/lib/idleDashboardLayout.ts`
- modify: `src/lib/idleDashboardLayout.test.ts`

- [ ] **step 1: write boundary test**

in `src/lib/bundleBoundaries.test.ts`, assert:
- `IdleDashboard` renders `<IdleControlCenter`
- `IdleControlCenter` contains `PulseIdentityBand`
- `IdleControlCenter` contains `AgentOperationsLane`
- `IdleControlCenter` does not render `widgetSizeClasses` as the primary dashboard path.

- [ ] **step 2: create shell component**

`IdleControlCenter` props should include:
- `extras`
- `rate`
- `focus`
- `device`
- `pulse`
- `agents`
- `notifications`
- `apps`
- `projects`
- `sidebar`
- `oracles`
- callbacks currently passed to dashboard tiles.

layout:
- one full-height surface.
- top command header.
- pulse identity band.
- control/status band.
- jarvis briefing lane.
- notification command lane.
- operations lanes.
- utility strip.

- [ ] **step 3: preserve customization fallback only if needed**

if removing widget customization breaks existing UX too much, keep a small `legacy widgets` fallback behind a local flag. default must be control center.

- [ ] **step 4: run focused tests**

run: `node --experimental-strip-types --test src/lib/idleDashboardLayout.test.ts src/lib/bundleBoundaries.test.ts`

expected: pass after updating tests to the new default.

---

## task 4: agent operations lane

**files:**
- create: `src/components/dashboard/AgentOperationsLane.tsx`
- modify: `src/components/IdleControlCenter.tsx`
- modify: `src/lib/moneyAgents.ts`
- modify: `src/lib/moneyAgents.test.ts`

- [ ] **step 1: extend agent summary tests**

add expected fields:
- `schedule`
- `lastRunAt`
- `runState`
- `pendingApprovalCount`
- `latestOutput`
- `nextRunAt`

for now, derive safely from known state and localstorage:
- dry-run + blocked quality -> `needs-steer`
- scheduled cadence -> next run label
- missing data -> `unknown`, not fake precision.

- [ ] **step 2: implement summary fields**

in `moneyAgents.ts`, complete:
- `loadMoneyAgentLastScheduledRun`
- `nextRunAt` from schedule cadence.
- `pendingApprovalCount` from queue/status when available.
- `latestOutput` from status/log tail when available.
- `runState` as `running | scheduled | idle | blocked | approval`.

- [ ] **step 3: build lane ui**

each agent row should show:
- status indicator.
- current money move.
- last run.
- next run.
- pending approval count.
- `inspect` button.
- `run pulse` button.
- `pause` placeholder if pause state is not implemented yet.

important: `run pulse` must send hidden command and not focus the chatpane.
important: chat panes are for audit/history only. firaz may talk directly to an agent rarely, but the normal product path is jarvis-mediated control and reporting.

- [ ] **step 4: run tests**

run: `pnpm exec tsc --noEmit && node --experimental-strip-types --test src/lib/moneyAgents.test.ts src/lib/bundleBoundaries.test.ts`

expected: pass.

---

## task 5: notification action queue and jarvis briefings

**files:**
- create: `src/components/dashboard/NotificationCommandLane.tsx`
- create: `src/components/dashboard/JarvisBriefingLane.tsx`
- modify: `src/components/IdleControlCenter.tsx`
- modify: `src/components/IdleDashboard.tsx`
- modify: `src/App.tsx`
- modify: `src/lib/controlCenter.ts`
- modify: `src/lib/notifications.ts` only if current metadata is insufficient.

- [ ] **step 1: add tests for notification summarization**

in `src/lib/controlCenter.test.ts`, add:

```ts
test("buildJarvisBriefing converts notifications into next conversation prompts", () => {
  const briefing = buildJarvisBriefing({
    agents: [],
    notifications: [
      { id: "n1", source: "chat", title: "growth needs approval", body: "image asset missing", level: "warning", read: false, at: 100 },
    ],
    focus: { title: "aios shell", detail: "dashboard work" },
  });
  assert.match(briefing.primaryPrompt, /growth needs approval/);
  assert.equal(briefing.unreadCount, 1);
});
```

- [ ] **step 2: render notification command lane**

lane should show:
- unread count.
- proactive count.
- newest 3 important notifications.
- action buttons: `talk to jarvis`, `open context`, `dismiss`.

`talk to jarvis` should open the main chat context, not the agent pane. the prompt should include the notification title/body/source so the chat starts with the right context.

- [ ] **step 3: render jarvis briefing lane**

briefing should answer:
- what needs my attention.
- what jarvis is handling.
- what changed since last glance.
- what should become a chat with jarvis.

avoid feature advertising. this is operational, not marketing. obey proactive rules from `~/.aios/state/context/SOUL-rules.md`: no unsolicited urgency on money deadlines, no cold-outreach nudges as "do this now", no guilt loops.

- [ ] **step 4: boundary assertions**

assert:
- `NotificationCommandLane` exists.
- `JarvisBriefingLane` exists.
- `talk to jarvis` appears in dashboard code.
- `inspect` is the only normal route to an agent chatpane.

- [ ] **step 5: run tests**

run: `node --experimental-strip-types --test src/lib/controlCenter.test.ts src/lib/notifications.test.ts src/lib/bundleBoundaries.test.ts`

expected: pass.

---

## task 6: charts that matter

**files:**
- create: `src/components/dashboard/ControlCenterCharts.tsx`
- modify: `src/components/dashboard/PulseIdentityBand.tsx`
- modify: `src/components/dashboard/AgentOperationsLane.tsx`

- [ ] **step 1: add chart primitives**

create small components:
- `ActivityHeatmap`
- `TrendBars`
- `AgentRunTimeline`
- `ApprovalAgingBars`

start with svg/css. no new dependency unless implementation becomes ugly.

- [ ] **step 2: wire current data**

map existing data:
- pulse activity -> heatmap.
- usage extras -> trend bars.
- agent last/next run -> timeline.
- pending approvals -> aging bars.

- [ ] **step 3: visual constraints**

must pass:
- no nested cards.
- no decorative gradients.
- no viewport-scaled font sizes.
- text truncates or wraps cleanly.
- mobile gets stacked lanes.

- [ ] **step 4: run build**

run: `pnpm build`

expected: success. vite chunk warnings are acceptable if unchanged.

---

## task 7: approval lane and hidden control commands

**files:**
- create: `src/components/dashboard/ApprovalLane.tsx`
- modify: `src/components/IdleControlCenter.tsx`
- modify: `src/App.tsx`
- modify: `src/lib/moneyAgents.ts`

- [ ] **step 1: define approval item view model**

start with derived items from agent summaries:
- agent id.
- label.
- decision needed.
- source job.
- age.
- action labels: `approve`, `reject`, `inspect`.

- [ ] **step 2: send hidden control commands**

reuse `onOpenMoneyAgentChat(id, label, command)`:
- approve sends hidden approval command.
- reject sends hidden reject/rework command.
- inspect opens history.
- talk-to-jarvis opens a normal chatpane seeded with the relevant context.

- [ ] **step 3: assert no direct-chat regression**

add boundary assertions:
- command sends call `setHiddenKeys`.
- inspect is the only route that focuses agent chat.
- prompts mention shell control plane, not “ask firaz”.
- notification actions route through jarvis/context chat unless explicitly inspecting history.

- [ ] **step 4: run full chatpane suite**

run: `pnpm test:chatpane`

expected: 75+ tests pass.

---

## task 8: final verification and ship

**files:**
- modify only if previous tasks require.

- [ ] **step 1: run typecheck**

run: `pnpm exec tsc --noEmit`

expected: exit 0.

- [ ] **step 2: run full regression suite**

run: `pnpm test:chatpane`

expected: all tests pass.

- [ ] **step 3: run production build**

run: `pnpm build`

expected: exit 0.

- [ ] **step 4: run tauri bundle**

run: `pnpm tauri build`

expected:
- signed app at `src-tauri/target/release/bundle/macos/AIOS.app`
- dmg at `src-tauri/target/release/bundle/dmg/AIOS_0.1.0_aarch64.dmg`

- [ ] **step 5: copy artifact**

run:

```bash
cp src-tauri/target/release/bundle/dmg/AIOS_0.1.0_aarch64.dmg outputs/AIOS-0.1.0-2026-06-03-jarvis-control-center.dmg
```

- [ ] **step 6: final status**

run:

```bash
git status --short
ls -lh outputs/AIOS-0.1.0-2026-06-03-jarvis-control-center.dmg
```

expected: artifact exists and dirty tree is understood.

---

## non-goals for this pass

- no full new database schema.
- no external analytics package unless css/svg charts fail.
- no terminal/oracle agent control surface.
- no chatbot-style interaction inside agent panes as the primary control path.
- no direct-agent prompting as the default workflow.
- no marketing hero page.

## product bar

the final dashboard should feel like one awake system:
- pulse says who/what aios is.
- control lanes say what is happening.
- charts say whether momentum is improving.
- agents can be controlled without talking to them.
- jarvis brokers agent work and reports back.
- notifications are the action queue, not a passive inbox.
- inspection is available, but not required.
