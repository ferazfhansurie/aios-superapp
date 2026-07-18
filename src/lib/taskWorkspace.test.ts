import assert from "node:assert/strict";
import test from "node:test";

import {
  bindChatTaskId,
  createTaskWorkspaceStore,
  isTaskId,
  linkTaskPane,
  taskPaneLinkFor,
  taskIdForPaneKey,
  taskRecordForPane,
  unlinkTaskPane,
  type TaskPaneLink,
} from "./taskWorkspace.ts";
import type { Artifact } from "../components/chat/toolPresentation.tsx";
import type { FleetAgent, FleetWorkflow } from "./subagentFleet.ts";
import type { RunEvent } from "./runEvents.ts";

const shellLink = (paneKey: string): TaskPaneLink => ({
  paneKey,
  type: "shell",
  label: "terminal",
  open: true,
  linkedAt: 1,
});

test("task id is stable from its owning pane key", () => {
  assert.equal(taskIdForPaneKey("k-chat-alpha"), "task:k-chat-alpha");
  assert.equal(taskIdForPaneKey("k-chat-alpha"), "task:k-chat-alpha");
  assert.notEqual(taskIdForPaneKey("k-chat-alpha"), taskIdForPaneKey("k-chat-beta"));
});

test("chat task binding repairs legacy panes but preserves a validated explicit task", () => {
  assert.deepEqual(bindChatTaskId({ type: "chat" }, "k-chat-legacy"), {
    type: "chat",
    taskId: "task:k-chat-legacy",
  });
  assert.deepEqual(
    bindChatTaskId({ type: "chat", taskId: "task:k-chat-handoff" }, "k-chat-new"),
    { type: "chat", taskId: "task:k-chat-handoff" },
  );
});

test("task ids reject untrusted external values", () => {
  for (const value of ["task:k-chat-1", "task:agent:abc_123", "task:handoff.v2"]) {
    assert.equal(isTaskId(value), true, value);
  }
  for (const value of ["task:", "task:with space", "not-a-task", "task:../../escape", 42, null]) {
    assert.equal(isTaskId(value), false, String(value));
  }
});

test("task pane links de-dupe, and unlink only closes its requested pane", () => {
  const first = linkTaskPane([], shellLink("k-shell-a"));
  assert.equal(linkTaskPane(first, { ...first[0] }), first, "identical reconciliation keeps the same stable link array");
  const replaced = linkTaskPane(first, { ...shellLink("k-shell-a"), label: "terminal · repo", linkedAt: 2 });
  const withSecond = linkTaskPane(replaced, shellLink("k-files-b"));

  assert.equal(withSecond.length, 2);
  assert.equal(withSecond[0].label, "terminal · repo");
  assert.deepEqual(unlinkTaskPane(withSecond, "k-shell-a"), [
    { ...withSecond[0], open: false },
    withSecond[1],
  ]);
});

test("an unbound pane creates no task record", () => {
  assert.equal(taskRecordForPane({ key: "k-files-a", kind: { type: "files" } }), null);
  assert.deepEqual(taskRecordForPane({
    key: "k-chat-a",
    kind: { type: "chat", taskId: taskIdForPaneKey("k-chat-a") },
  }), {
    id: "task:k-chat-a",
    ownerPaneKey: "k-chat-a",
  });
});

test("task pane link derives stable type, detail, and open state from a bound App pane", () => {
  const taskId = taskIdForPaneKey("k-chat-owner");
  assert.deepEqual(
    taskPaneLinkFor({
      key: "k-shell-child",
      label: "terminal · shell",
      kind: { type: "shell", cwd: "/repo/shell", taskId },
    }, 42),
    {
      paneKey: "k-shell-child",
      type: "shell",
      label: "terminal · shell",
      detail: "/repo/shell",
      open: true,
      linkedAt: 42,
    },
  );
  assert.deepEqual(
    taskPaneLinkFor({
      key: "k-browser-child",
      label: "docs",
      kind: { type: "browser", url: "https://example.com/docs", taskId },
    }, 42),
    {
      paneKey: "k-browser-child",
      type: "browser",
      label: "docs",
      detail: "https://example.com/docs",
      open: true,
      linkedAt: 42,
    },
  );
  assert.equal(
    taskPaneLinkFor({ key: "k-files-independent", label: "files", kind: { type: "files", root: "/repo" } }, 42),
    null,
  );
});

const event = (index: number): RunEvent => ({
  type: "reasoning",
  id: `event-${index}`,
  text: `event ${index}`,
  streaming: false,
  at: index,
});

const artifact = (index: number): Artifact => ({
  path: `/repo/file-${index}.ts`,
  name: `file-${index}.ts`,
  kind: "code",
});

const agent = (id: string, label = id): FleetAgent => ({
  id,
  label,
  status: "running",
  startedAt: 1,
});

const workflow = (id: string, label = id): FleetWorkflow => ({
  id,
  label,
  phases: [],
  status: "running",
  startedAt: 1,
});

test("task snapshots retain only the newest bounded normalized records", () => {
  let now = 0;
  const store = createTaskWorkspaceStore({ now: () => ++now });
  const id = taskIdForPaneKey("k-chat-store");
  store.ensureTaskWorkspace({ id, title: "task", cwd: "/repo", ownerPaneKey: "k-chat-store" });
  store.bindTaskSession(id, "session-1");
  store.publishTaskSnapshot(id, {
    phase: "acting",
    artifacts: [...Array.from({ length: 41 }, (_, index) => artifact(index)), artifact(40)],
    agents: [agent("a", "old"), agent("b"), agent("a", "new")],
    workflows: [workflow("w", "old"), workflow("w", "new")],
    events: Array.from({ length: 101 }, (_, index) => event(index)),
  });

  const workspace = store.getTaskWorkspace(id);
  assert.ok(workspace);
  assert.equal(workspace.sessionId, "session-1");
  assert.equal(workspace.phase, "acting");
  assert.equal(workspace.events.length, 100);
  assert.equal(workspace.events[0].id, "event-1");
  assert.equal(workspace.artifacts.length, 40);
  assert.equal(workspace.artifacts[0].path, "/repo/file-1.ts");
  assert.deepEqual(workspace.agents.map((item) => [item.id, item.label]), [["a", "new"], ["b", "b"]]);
  assert.deepEqual(workspace.workflows.map((item) => [item.id, item.label]), [["w", "new"]]);
});

test("task links are bounded and unlink preserves the task activity record", () => {
  let now = 0;
  const store = createTaskWorkspaceStore({ now: () => ++now });
  const id = taskIdForPaneKey("k-chat-links");
  store.ensureTaskWorkspace({ id, title: "task", ownerPaneKey: "k-chat-links" });
  for (let index = 0; index < 41; index++) {
    store.linkTaskWorkspacePane(id, {
      ...shellLink(`k-shell-${index}`),
      linkedAt: index,
    });
  }
  store.unlinkTaskWorkspacePane(id, "k-shell-40");

  const workspace = store.getTaskWorkspace(id);
  assert.ok(workspace);
  assert.equal(workspace.paneLinks.length, 40);
  assert.equal(workspace.paneLinks[0].paneKey, "k-shell-1");
  assert.equal(workspace.paneLinks[workspace.paneLinks.length - 1]?.open, false);
});

test("task subscribers hear only changes to their task, including bounded eviction", () => {
  let now = 0;
  const store = createTaskWorkspaceStore({ now: () => ++now });
  const first = taskIdForPaneKey("k-chat-0");
  const last = taskIdForPaneKey("k-chat-60");
  let firstNotifications = 0;
  let lastNotifications = 0;
  store.subscribeTaskWorkspace(first, () => { firstNotifications += 1; });
  store.subscribeTaskWorkspace(last, () => { lastNotifications += 1; });

  for (let index = 0; index < 61; index++) {
    const id = taskIdForPaneKey(`k-chat-${index}`);
    store.ensureTaskWorkspace({ id, title: String(index), ownerPaneKey: `k-chat-${index}` });
  }
  assert.equal(store.getTaskWorkspace(first), null);
  assert.equal(firstNotifications, 2);
  assert.equal(lastNotifications, 1);

  store.bindTaskSession(last, "session-last");
  assert.equal(firstNotifications, 2);
  assert.equal(lastNotifications, 2);
});

test("malformed persistence recovers safely and writes are debounced for 500ms", () => {
  const values = new Map<string, string>([["aios.task-workspaces.v1", "not json"]]);
  const writes: Array<[string, string]> = [];
  const scheduled: Array<() => void> = [];
  const store = createTaskWorkspaceStore({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { writes.push([key, value]); values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    },
    schedule: (callback, delay) => {
      assert.equal(delay, 500);
      scheduled.push(callback);
      return scheduled.length;
    },
    cancel: () => {},
  });
  const id = taskIdForPaneKey("k-chat-persist");
  assert.equal(store.getTaskWorkspace(id), null);
  store.ensureTaskWorkspace({ id, title: "persist", ownerPaneKey: "k-chat-persist" });
  assert.equal(writes.length, 0);
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0][1]).tasks[0].id, id);
});

test("syntactically valid but structurally bad persisted tasks are discarded", () => {
  const id = taskIdForPaneKey("k-chat-bad-cache");
  let removed = 0;
  const store = createTaskWorkspaceStore({
    storage: {
      getItem: () => JSON.stringify({
        tasks: [{
          id,
          title: "bad cache",
          ownerPaneKey: "k-chat-bad-cache",
          updatedAt: 1,
          phase: "completed",
          paneLinks: [],
          artifacts: [],
          agents: [],
          workflows: [],
          events: ["not a normalized run event"],
        }],
      }),
      setItem: () => {},
      removeItem: () => { removed += 1; },
    },
  });
  assert.equal(store.getTaskWorkspace(id), null);
  assert.equal(removed, 1);
});

test("persisted run events require their complete task-level shape", () => {
  const id = taskIdForPaneKey("k-chat-bad-event-shape");
  const store = createTaskWorkspaceStore({
    storage: {
      getItem: () => JSON.stringify({
        tasks: [{
          id,
          title: "bad event shape",
          ownerPaneKey: "k-chat-bad-event-shape",
          updatedAt: 1,
          phase: "acting",
          paneLinks: [],
          artifacts: [],
          agents: [],
          workflows: [],
          events: [{ type: "action.started", id: "event-1", at: 1 }],
        }],
      }),
      setItem: () => {},
    },
  });
  assert.equal(store.getTaskWorkspace(id), null);
});

test("hydration dedupes valid task ids by newest updated timestamp", () => {
  const id = taskIdForPaneKey("k-chat-duplicate-cache");
  const task = (title: string, updatedAt: number) => ({
    id,
    title,
    ownerPaneKey: "k-chat-duplicate-cache",
    updatedAt,
    phase: "completed",
    paneLinks: [],
    artifacts: [],
    agents: [],
    workflows: [],
    events: [],
  });
  const store = createTaskWorkspaceStore({
    storage: {
      getItem: () => JSON.stringify({ tasks: [task("older", 1), task("newer", 2)] }),
      setItem: () => {},
    },
  });
  assert.equal(store.getState().tasks.length, 1);
  assert.equal(store.getTaskWorkspace(id)?.title, "newer");
});

test("malformed public snapshots are no-ops without notifications or persistence", () => {
  const writes: string[] = [];
  const scheduled: Array<() => void> = [];
  const store = createTaskWorkspaceStore({
    storage: {
      getItem: () => null,
      setItem: (_key, value) => { writes.push(value); },
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancel: () => {},
  });
  const id = taskIdForPaneKey("k-chat-invalid-snapshot");
  store.ensureTaskWorkspace({ id, title: "safe", ownerPaneKey: "k-chat-invalid-snapshot" });
  store.flush();
  writes.length = 0;
  scheduled.length = 0;
  let notifications = 0;
  store.subscribeTaskWorkspace(id, () => { notifications += 1; });
  const invalids = [
    { phase: "not-a-phase", events: [], artifacts: [] },
    { phase: "acting", events: [], artifacts: [{ path: 42 }], agents: [] },
    { phase: "acting", events: [{ type: "run.failed", id: "x", at: Infinity }], artifacts: [] },
    { phase: "acting", events: [], artifacts: [], fleet: { agents: [{ id: "agent" }], workflows: [] } },
    { phase: "acting", events: [], artifacts: [], workflows: [{ id: "workflow" }] },
  ];
  for (const snapshot of invalids) {
    assert.doesNotThrow(() => store.publishTaskSnapshot(id, snapshot as never));
  }
  assert.equal(store.getTaskWorkspace(id)?.title, "safe");
  assert.equal(notifications, 0);
  assert.equal(scheduled.length, 0);
  assert.equal(writes.length, 0);
});

test("malformed public seeds, sessions, and links are no-ops at ingress", () => {
  const scheduled: Array<() => void> = [];
  const store = createTaskWorkspaceStore({
    storage: { getItem: () => null, setItem: () => {} },
    schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
    cancel: () => {},
  });
  const id = taskIdForPaneKey("k-chat-invalid-public-input");
  store.ensureTaskWorkspace({ id, title: "safe", ownerPaneKey: "k-chat-invalid-public-input" });
  store.flush();
  scheduled.length = 0;
  let notifications = 0;
  store.subscribeTaskWorkspace(id, () => { notifications += 1; });

  assert.doesNotThrow(() => store.ensureTaskWorkspace({ id, title: 42, ownerPaneKey: "x" } as never));
  assert.doesNotThrow(() => store.bindTaskSession(id, 42 as never));
  assert.doesNotThrow(() => store.linkTaskWorkspacePane(id, { ...shellLink("bad-link"), type: "terminal", linkedAt: Infinity } as never));
  assert.equal(store.getTaskWorkspace(id)?.title, "safe");
  assert.equal(store.getTaskWorkspace(id)?.sessionId, undefined);
  assert.equal(store.getTaskWorkspace(id)?.paneLinks.length, 0);
  assert.equal(notifications, 0);
  assert.equal(scheduled.length, 0);
});

test("mixed persisted rows retain valid tasks and discard invalid links", () => {
  const validId = taskIdForPaneKey("k-chat-valid-mixed-cache");
  const invalidId = taskIdForPaneKey("k-chat-invalid-mixed-cache");
  const valid = {
    id: validId,
    title: "valid",
    ownerPaneKey: "k-chat-valid-mixed-cache",
    updatedAt: 1,
    phase: "completed",
    paneLinks: [
      shellLink("k-shell-valid"),
      { ...shellLink("k-shell-invalid-type"), type: "terminal" },
      { ...shellLink("k-shell-invalid-time"), linkedAt: Infinity },
    ],
    artifacts: [],
    agents: [],
    workflows: [],
    events: [],
  };
  const invalid = { ...valid, id: invalidId, events: [{ type: "action.started", id: "bad", at: 1 }] };
  const store = createTaskWorkspaceStore({
    storage: {
      getItem: () => JSON.stringify({ tasks: [valid, invalid] }),
      setItem: () => {},
    },
  });
  assert.equal(store.getState().tasks.length, 1);
  assert.deepEqual(store.getTaskWorkspace(validId)?.paneLinks, [shellLink("k-shell-valid")]);
  assert.equal(store.getTaskWorkspace(invalidId), null);
});

test("hydration discards nonfinite task update timestamps before ordering", () => {
  const id = taskIdForPaneKey("k-chat-bad-updated-at");
  const store = createTaskWorkspaceStore({
    storage: {
      getItem: () => JSON.stringify({ tasks: [{
        id,
        title: "bad timestamp",
        ownerPaneKey: "k-chat-bad-updated-at",
        updatedAt: Infinity,
        phase: "completed",
        paneLinks: [], artifacts: [], agents: [], workflows: [], events: [],
      }] }),
      setItem: () => {},
    },
  });
  assert.equal(store.getTaskWorkspace(id), null);
});

test("persisted fleet records must contain their complete renderable shape", () => {
  const id = taskIdForPaneKey("k-chat-bad-fleet");
  let removed = 0;
  const store = createTaskWorkspaceStore({
    storage: {
      getItem: () => JSON.stringify({
        tasks: [{
          id,
          title: "bad fleet",
          ownerPaneKey: "k-chat-bad-fleet",
          updatedAt: 1,
          phase: "completed",
          paneLinks: [],
          artifacts: [],
          agents: [{ id: "agent-without-label" }],
          workflows: [{ id: "workflow-without-phases" }],
          events: [],
        }],
      }),
      setItem: () => {},
      removeItem: () => { removed += 1; },
    },
  });
  assert.equal(store.getTaskWorkspace(id), null);
  assert.equal(removed, 1);
});

test("persisted fleet optional fields are structurally checked too", () => {
  const id = taskIdForPaneKey("k-chat-bad-fleet-field");
  const store = createTaskWorkspaceStore({
    storage: {
      getItem: () => JSON.stringify({
        tasks: [{
          id,
          title: "bad fleet field",
          ownerPaneKey: "k-chat-bad-fleet-field",
          updatedAt: 1,
          phase: "completed",
          paneLinks: [],
          artifacts: [],
          agents: [{ ...agent("agent"), tokens: "not a number" }],
          workflows: [{ ...workflow("workflow"), phases: [{ title: "phase", detail: 42 }] }],
          events: [],
        }],
      }),
      setItem: () => {},
    },
  });
  assert.equal(store.getTaskWorkspace(id), null);
});

test("task store clones nested snapshots and returned workspaces at every boundary", () => {
  const store = createTaskWorkspaceStore();
  const id = taskIdForPaneKey("k-chat-clone");
  store.ensureTaskWorkspace({ id, title: "clone", ownerPaneKey: "k-chat-clone" });
  const input = { nested: { source: "original" } };
  const snapshot = {
    phase: "acting" as const,
    artifacts: [artifact(1)],
    agents: [agent("agent-1")],
    workflows: [{ ...workflow("workflow-1"), phases: [{ title: "phase one", detail: "original" }] }],
    events: [{ type: "action.started" as const, id: "event", name: "read", input, at: 1 }],
  };
  store.publishTaskSnapshot(id, snapshot);
  input.nested.source = "caller mutation";
  snapshot.artifacts[0].name = "caller renamed";
  snapshot.workflows[0].phases[0].detail = "caller changed";

  const first = store.getTaskWorkspace(id);
  assert.ok(first);
  const firstEvent = first.events[0];
  assert.equal(firstEvent.type, "action.started");
  if (firstEvent.type !== "action.started") throw new Error("expected action event");
  assert.equal((firstEvent.input.nested as { source: string }).source, "original");
  assert.equal(first.artifacts[0].name, "file-1.ts");
  assert.equal(first.workflows[0].phases[0].detail, "original");

  let notifications = 0;
  store.subscribeTaskWorkspace(id, () => { notifications += 1; });
  first.title = "leaked mutation";
  (firstEvent.input.nested as { source: string }).source = "leaked mutation";
  first.workflows[0].phases[0].detail = "leaked mutation";
  const second = store.getTaskWorkspace(id);
  assert.ok(second);
  assert.equal(second.title, "clone");
  const secondEvent = second.events[0];
  if (secondEvent.type !== "action.started") throw new Error("expected action event");
  assert.equal((secondEvent.input.nested as { source: string }).source, "original");
  assert.equal(second.workflows[0].phases[0].detail, "original");
  assert.equal(notifications, 0);
});

test("task store clones pane-link input when it is ingested", () => {
  const store = createTaskWorkspaceStore();
  const id = taskIdForPaneKey("k-chat-link-clone");
  store.ensureTaskWorkspace({ id, title: "link clone", ownerPaneKey: "k-chat-link-clone" });
  const link = shellLink("k-shell-link-clone");
  store.linkTaskWorkspacePane(id, link);
  link.label = "caller mutation";
  link.open = false;

  const workspace = store.getTaskWorkspace(id);
  assert.ok(workspace);
  assert.deepEqual(workspace.paneLinks, [shellLink("k-shell-link-clone")]);
});

test("task id factories and creation reject invalid ids before writing state", () => {
  assert.throws(() => taskIdForPaneKey("bad pane key"), /invalid task id/i);
  const store = createTaskWorkspaceStore();
  const invalid = "task:bad pane key" as unknown as ReturnType<typeof taskIdForPaneKey>;
  assert.throws(
    () => store.ensureTaskWorkspace({ id: invalid, title: "bad", ownerPaneKey: "bad pane key" }),
    /invalid task id/i,
  );
  assert.equal(store.getTaskWorkspace(invalid), null);
});
