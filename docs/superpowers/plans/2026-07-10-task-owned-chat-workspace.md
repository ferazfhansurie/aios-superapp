# Task-Owned Chat Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every ChatPane a durable task id and a compact control rail that owns its linked files, terminal, browser, artifacts, agents, and run timeline.

**Architecture:** A task is a stable UI identity, separate from an engine session id. `PaneContent.taskId` propagates only from a task-owning chat to panes explicitly opened from its rail/transcript; independent panes stay independent. A small external task-workspace store owns durable task snapshots and a live subscription API, while `App` remains the only authority that creates, focuses, hides, closes, and links panes.

**Tech Stack:** React 18, TypeScript, Tauri 2, existing `paneBus`, `runEvents`, `subagentFleet`, localStorage, node:test.

---

## Current boundaries to preserve

- `src/App.tsx` owns pane lifecycle, stable pane keys, layout persistence, focus/hide/close, and all `(kind, ctx) -> PaneContent` spawning. Do not let `TaskRail` mutate pane state directly.
- `src/lib/paneBus.ts` is the established child-to-App request channel. Extend its context; do not add window globals or new custom events for normal linking.
- `src/components/ChatPane.tsx` already owns the normalized run-event reducer, artifact derivation, fleet reducer, and session lifecycle. Publish a compact task snapshot from there; never parse tool output in the rail.
- `src/lib/runEvents.ts` already bounds event history to 1000 in memory and 500 persisted. The task store must keep a smaller tail and debounce storage writes so streaming does not regress.
- `src/lib/subagentFleet.ts` is the canonical agent/workflow parser. The task store receives its snapshot and must not re-interpret raw model events.
- `PaneCard` is memoized and is intentionally protected from per-token re-renders. Only `TaskRail` may subscribe to task updates.

## Data model

Create `src/lib/taskWorkspace.ts` with pure types/reducer/storage plus a tiny external store.

```ts
export type TaskId = `task:${string}`;

export interface TaskPaneLink {
  paneKey: string;
  type: "chat" | "shell" | "files" | "browser" | "file" | "editor";
  label: string;
  detail?: string;
  open: boolean;
  linkedAt: number;
}

export interface TaskWorkspace {
  id: TaskId;
  title: string;
  cwd?: string;
  ownerPaneKey: string;
  sessionId?: string;
  updatedAt: number;
  phase: RunPhase;
  paneLinks: TaskPaneLink[];
  artifacts: Artifact[];
  agents: FleetAgent[];
  workflows: FleetWorkflow[];
  events: RunEvent[];
}
```

- root chat task id: `task:${paneKey}`. Mint it in `App.spawn` after the pane key is known and persist it inside `kind`, so it survives layout restore and does not change when the engine emits a new/restarted session id.
- resumed/history chat gets a *new* task unless the persisted `kind.taskId` was present. This avoids silently merging unrelated work just because two panes resume the same old thread; explicit model handoffs pass the existing task id.
- child links are present only while their pane is open. Artifacts, agents, workflows, run events, session binding, title, and cwd survive reopen.
- retain at most 60 tasks, 100 task events each, 40 artifacts, and 40 pane links per task; newest wins. Debounce `localStorage` serialization at 500ms and safely ignore quota/malformed data.

### Task 1: Add task identity and propagation without rendering a rail

**Files:**
- Modify: `src/lib/apps.ts`
- Modify: `src/lib/paneBus.ts`
- Modify: `src/App.tsx`
- Modify: `src/lib/paneLayout.test.ts`
- Create: `src/lib/taskWorkspace.test.ts`

- [ ] **Step 1: Write failing pure tests for task identity and pane-link reduction.**

Test that `task:${paneKey}` is stable, a `taskId` survives a `migrateLayoutPanes` round trip, link insertion de-dupes a pane key, unlink marks/removes only that pane, and a pane without a task id creates no task record.

- [ ] **Step 2: Run the focused test and confirm it fails.**

Run: `node --experimental-strip-types --test src/lib/taskWorkspace.test.ts src/lib/paneLayout.test.ts`

Expected: FAIL because task workspace helpers and `PaneContent.taskId` do not exist.

- [ ] **Step 3: Make every pane content optionally task-bound.**

Wrap the existing `PaneContent` union in an intersection with `{ taskId?: TaskId }` in `src/lib/apps.ts`; this keeps all existing discriminated narrowing intact and makes task binding opt-in rather than adding a new pane type.

- [ ] **Step 4: Thread `taskId` through the existing request path.**

Add `taskId?: TaskId` to `SpawnCtx` in `src/lib/paneBus.ts`. In `App.spawnPaneFromCtx`, pass it to terminal/files/browser/chat kinds. In `App.spawn`, normalize a new chat to `{ ...kind, taskId: kind.taskId ?? (`task:${key}` as TaskId) }` after the stable pane key is selected. Do not synthesize ids for non-chat independent panes.

- [ ] **Step 5: Preserve task id through App mutations.**

Audit `onUpdatePaneKind`, duplicate, history reopen, Discord bridge updates, and control-command re-fire. Preserve the existing task id when an update payload does not explicitly replace it. Extend control-command parsing and the `chat-agent-spawned` detail with optional `taskId` so background workers can be attributed.

- [ ] **Step 6: Run focused tests.**

Run: `node --experimental-strip-types --test src/lib/taskWorkspace.test.ts src/lib/paneLayout.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/apps.ts src/lib/paneBus.ts src/App.tsx src/lib/paneLayout.test.ts src/lib/taskWorkspace.test.ts
git commit -m "feat: propagate stable chat task ids across panes"
```

### Task 2: Build the durable task-workspace store

**Files:**
- Create: `src/lib/taskWorkspace.ts`
- Create: `src/lib/taskWorkspace.test.ts`
- Modify: `src/lib/runEvents.test.ts`
- Modify: `src/lib/subagentFleet.test.ts`

- [ ] **Step 1: Write failing reducer/storage tests.**

Cover these actions exactly: `ensureTask`, `bindSession`, `linkPane`, `unlinkPane`, `publishSnapshot`, `removeTask`; artifact de-dupe by absolute path; agent/workflow replacement by id; latest phase/event tail; bounded serialization; malformed storage recovery; and subscriber notification only when that task actually changes.

- [ ] **Step 2: Add a pure reducer before any React code.**

```ts
type TaskWorkspaceAction =
  | { type: "ensure"; task: Pick<TaskWorkspace, "id" | "title" | "cwd" | "ownerPaneKey"> }
  | { type: "bind-session"; taskId: TaskId; sessionId: string }
  | { type: "link-pane"; taskId: TaskId; link: TaskPaneLink }
  | { type: "unlink-pane"; taskId: TaskId; paneKey: string }
  | { type: "snapshot"; taskId: TaskId; snapshot: TaskSnapshot }
  | { type: "remove"; taskId: TaskId };
```

`TaskSnapshot` receives already-normalized `RunEvent[]`, `Artifact[]`, `FleetState`, phase, title, cwd, and optional session id. It must never receive raw `ChatEvent`.

- [ ] **Step 3: Add the external store API.**

Expose `ensureTaskWorkspace`, `publishTaskSnapshot`, `linkTaskPane`, `unlinkTaskPane`, `getTaskWorkspace`, and `subscribeTaskWorkspace`. Use `useSyncExternalStore` only from UI consumers. Keep localStorage loading/persisting in this module, not `App` or `ChatPane`.

- [ ] **Step 4: Add compatibility bootstrap.**

When a task first binds a known chat session, import the current `aios.chat.run-events:<sessionId>` tail only if the task has no events. This makes already-open and resumed chats useful immediately without migrating/deleting the existing per-session replay store.

- [ ] **Step 5: Run pure tests.**

Run: `node --experimental-strip-types --test src/lib/taskWorkspace.test.ts src/lib/runEvents.test.ts src/lib/subagentFleet.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/taskWorkspace.ts src/lib/taskWorkspace.test.ts src/lib/runEvents.test.ts src/lib/subagentFleet.test.ts
git commit -m "feat: add durable task workspace snapshots"
```

### Task 3: Link App-managed panes to their owning task

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/lib/paneBus.ts`
- Modify: `src/lib/taskWorkspace.ts`
- Modify: `src/lib/taskWorkspace.test.ts`

- [ ] **Step 1: Write failing tests for App-facing link metadata helpers.**

Extract a pure `taskPaneLinkFor(pane)` helper into `taskWorkspace.ts` and test chat/shell/files/browser/file/editor labels and details. It must use `paneContextDetail`-equivalent data, never inspect DOM refs.

- [ ] **Step 2: Link on creation and restore.**

After `spawn` normalizes a task-bound pane, call `linkTaskPane`. Add one reconciliation effect keyed by `panes` that ensures every restored task-bound pane is linked. It must not create links for unbound panes.

- [ ] **Step 3: Unlink on close, retain activity history.**

Call `unlinkTaskPane` in the single App close path. Closing a child must not remove the task, owner chat, artifacts, or run history. Closing the owner chat keeps the task for history/reopen and marks its owner link closed.

- [ ] **Step 4: Register task context in PaneCard.**

Extend `PaneContext` with optional `taskId`, and have the existing `registerPane` call report static cwd/url/file/task id. This gives future cross-pane commands a canonical lookup without touching DOM or special-casing native browser webviews.

- [ ] **Step 5: Run focused tests and typecheck.**

Run: `node --experimental-strip-types --test src/lib/taskWorkspace.test.ts src/lib/paneLayout.test.ts src/lib/paneOpenActions.test.ts`

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/App.tsx src/lib/paneBus.ts src/lib/taskWorkspace.ts src/lib/taskWorkspace.test.ts
git commit -m "feat: link app panes into task workspaces"
```

### Task 4: Publish ChatPane artifacts, agents, and run state to the task

**Files:**
- Modify: `src/components/ChatPane.tsx`
- Modify: `src/components/chat/chatContext.ts`
- Modify: `src/components/chat/ChatMarkdown.tsx`
- Modify: `src/components/chat/toolPresentation.tsx`
- Modify: `src/lib/paneBus.ts`
- Modify: `src/lib/taskWorkspace.test.ts`
- Modify: `src/lib/bundleBoundaries.test.ts`

- [ ] **Step 1: Add failing snapshot tests.**

Use the pure task store to prove that an Edit/Write artifact becomes one task artifact, duplicate file writes stay deduped, a Task agent's final status replaces its running status, and completed/failed/interrupted phase is preserved after remount.

- [ ] **Step 2: Pass task identity into ChatPane and its markdown context.**

Add required `taskId` to `ChatPane` props from `PaneCard`. Add `ChatTaskContext` alongside the existing cwd/file opener contexts so code-fence terminal opens, markdown browser links, and artifact card actions can include the task id in `SpawnCtx` / file opener calls.

- [ ] **Step 3: Publish a debounced snapshot, not raw per-token DOM state.**

After `runEventState`, `fleetState`, derived artifact list, title/cwd, and engine session id change, call `publishTaskSnapshot(taskId, ...)`. Keep the store persistence debounce at 500ms. Do not lift token state into `App`, and do not alter existing transcript or `runEvents` persistence behavior.

- [ ] **Step 4: Make artifact actions task-linked.**

Extend `openFileInPane`, `openEditorFileInPane`, `openViewerFileInPane`, and `revealFileInPane` with an optional task id/context parameter. `FileCard` passes the current task id so open editor/viewer/files becomes part of the same task. Existing callers remain behaviorally unchanged when omitted.

- [ ] **Step 5: Make worker attribution explicit.**

When App emits `chat-agent-spawned`, carry `taskId`; ChatPane only accepts it when both parent backend session and task id match. The fleet snapshot then supplies focusable `paneKey`s to the rail.

- [ ] **Step 6: Run focused tests and bundle boundary guards.**

Run: `node --experimental-strip-types --test src/lib/taskWorkspace.test.ts src/lib/runEvents.test.ts src/lib/subagentFleet.test.ts src/lib/bundleBoundaries.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/components/ChatPane.tsx src/components/chat/chatContext.ts src/components/chat/ChatMarkdown.tsx src/components/chat/toolPresentation.tsx src/lib/paneBus.ts src/lib/taskWorkspace.test.ts src/lib/bundleBoundaries.test.ts
git commit -m "feat: publish chat runs into task workspaces"
```

### Task 5: Add the responsive task control rail

**Files:**
- Create: `src/components/chat/TaskRail.tsx`
- Modify: `src/components/ChatPane.tsx`
- Modify: `src/App.tsx`
- Modify: `src/lib/taskWorkspace.ts`
- Modify: `src/lib/bundleBoundaries.test.ts`

- [ ] **Step 1: Write presentation-level tests for empty and populated rail projections.**

Keep rendering logic pure in exported helpers: `taskRailSections(workspace)` returns only non-empty sections in this order: run, workspace, artifacts, agents, activity. Test a task with no links shows a single unobtrusive “linked workspace” action, and a full task returns deterministic rows and count badges.

- [ ] **Step 2: Implement a narrow, independently-subscribed rail.**

`TaskRail` calls `useSyncExternalStore(subscribeTaskWorkspace, ...)` for one task. Place it beside the transcript only at sufficient pane width; collapse it behind a header button on narrow panes. It renders:

1. **run** — phase, latest status/time, stop and detach. Stop/detach invoke the existing `chatHandles` contracts; no second run-control implementation.
2. **workspace** — linked terminal, files, browser, editor/viewer, owner chat. Click asks App to focus/reveal by pane key.
3. **artifacts** — deduped files with editor/viewer/files actions, reusing the existing artifact action behavior.
4. **agents** — fleet/workflow status plus focus action for `paneKey` when present.
5. **activity** — compact 100-event tail with expandable details, sourced from normalized run events.

- [ ] **Step 3: Register an App-only task controller.**

Follow the existing `paneBus` registration pattern: App registers focus/reveal/spawn linked terminal/files/browser/editor/viewer actions once, and `TaskRail` requests them. For a new linked pane, App calls normal `spawnPaneFromCtx` with `{ taskId, cwd/path/url }`; never mutate the layout store from the rail.

- [ ] **Step 4: Preserve performance safeguards.**

Memoize row components, virtualize the activity list only when it exceeds 40 rows, and keep the rail closed by default for an empty fresh chat. Confirm the composer remains its own memoized child and transcript rendering is untouched in this increment.

- [ ] **Step 5: Add source-boundary assertions.**

Update `bundleBoundaries.test.ts` to assert ChatPane imports `TaskRail` lazily/locally and still does not import App/session-list/sidebar code. Assert App remains the only `registerTaskWorkspaceController` owner.

- [ ] **Step 6: Run verification.**

Run: `npm run test:chatpane`

Run: `npx tsc --noEmit`

Run: `npm run build`

Expected: all pass.

- [ ] **Step 7: Manual desktop verification.**

1. Open a chat in a repo; verify it owns `task:<pane-key>`.
2. Open terminal/files/browser from rail; verify each appears under workspace and focuses when clicked.
3. Have the agent edit one file and spawn an agent; verify artifacts and agent status live-update without transcript scrolling or composer lag.
4. Stop, detach, hide, reopen, and restart AIOS; verify the task retains artifacts/event tail, while only currently-open linked panes appear as open.
5. Open an unrelated terminal/browser; verify it never appears in the task rail.

- [ ] **Step 8: Commit.**

```bash
git add src/components/chat/TaskRail.tsx src/components/ChatPane.tsx src/App.tsx src/lib/taskWorkspace.ts src/lib/bundleBoundaries.test.ts
git commit -m "feat: add task-owned chat control rail"
```

### Task 6: Ship safely and measure the result

**Files:**
- Modify: `src/lib/taskWorkspace.ts` only if measurement finds a bounded-state bug
- Modify: `docs/superpowers/specs/...` only if product behavior materially changes

- [ ] **Step 1: Run full checks from a clean build output.**

Run: `npm run test:chatpane && npx tsc --noEmit && npm run build`

Expected: zero failures.

- [ ] **Step 2: Verify no layout migration loss.**

Save/restore a mix of legacy panes, a task chat with children, and unbound panes. Confirm `migrateLayoutPanes` preserves unknown task fields for all core kinds.

- [ ] **Step 3: Verify storage bounds.**

Generate 61 task records and 101 events. Confirm the oldest drops and normal boot survives malformed/quota-limited localStorage.

- [ ] **Step 4: Check streaming responsiveness.**

With two active chat panes plus terminal/browser, verify rail updates no more often than the normal state stream, storage is debounced, and there is no `App`-wide per-token rerender. Use React profiler if subjective lag returns.

- [ ] **Step 5: Commit any measured correction separately.**

```bash
git add -p
git commit -m "fix: bound task workspace persistence"
```

## Explicit non-goals for this increment

- no Codex private UI/pet/overlay integration.
- no attempt to infer artifacts from arbitrary shell commands.
- no hidden background agent spawning policy change.
- no new persistent backend/Rust database; local task metadata stays client-local and existing Rust chat sessions remain authoritative for live process control.
- no transcript virtualization in this patch. It should be the next independent track once the rail ships, because the rail deliberately avoids touching transcript rendering.
