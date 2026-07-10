import { parseRunEventState, type RunEvent, type RunPhase } from "./runEvents.ts";
import type { FleetAgent, FleetState, FleetWorkflow } from "./subagentFleet.ts";
import type { Artifact } from "../components/chat/toolPresentation.tsx";

/** A task is a durable UI identity, deliberately separate from a chat engine's
 * session/thread id. */
export type TaskId = `task:${string}`;

// Task ids cross the control-plane boundary, so do not treat a `task:` prefix
// alone as trustworthy. Keep the persisted/routable namespace deliberately
// boring: stable pane keys, worker ids, and handoff slugs all fit this shape.
const TASK_ID_PATTERN = /^task:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

export function isTaskId(value: unknown): value is TaskId {
  return typeof value === "string" && TASK_ID_PATTERN.test(value);
}

export interface TaskPaneLink {
  paneKey: string;
  type: "chat" | "shell" | "files" | "browser" | "file" | "editor";
  label: string;
  detail?: string;
  open: boolean;
  linkedAt: number;
}

/** The compact App-owned shape needed to derive a durable task pane link.
 * Keeping this structural avoids an App ↔ task workspace import cycle. */
export interface TaskPaneLinkInput {
  key: string;
  label: string;
  kind: {
    type: string;
    taskId?: TaskId;
    cwd?: string;
    root?: string;
    url?: string;
    path?: string;
  };
}

const TASK_PANE_LINK_TYPES = new Set<TaskPaneLink["type"]>([
  "chat", "shell", "files", "browser", "file", "editor",
]);

/** Derive the stable, display-safe link a task rail needs from an App pane.
 * Unbound panes and non-task workspace surfaces intentionally stay out. The
 * caller supplies the timestamp so this helper stays pure and testable. */
export function taskPaneLinkFor(pane: TaskPaneLinkInput, linkedAt: number): TaskPaneLink | null {
  if (!isTaskId(pane.kind.taskId) || !TASK_PANE_LINK_TYPES.has(pane.kind.type as TaskPaneLink["type"])) return null;
  const type = pane.kind.type as TaskPaneLink["type"];
  const detail = type === "shell" || type === "chat"
    ? pane.kind.cwd
    : type === "files"
      ? pane.kind.root
      : type === "browser"
        ? pane.kind.url
        : pane.kind.path;
  return {
    paneKey: pane.key,
    type,
    label: pane.label,
    ...(detail ? { detail } : {}),
    open: true,
    linkedAt,
  };
}

export function taskIdForPaneKey(paneKey: string): TaskId {
  const taskId = `task:${paneKey}`;
  if (!isTaskId(taskId)) throw new Error("invalid task id for pane key");
  return taskId;
}

/** Bind only chats to a task. A valid explicit handoff/history id wins; legacy
 * restored chats receive their stable pane-derived id on first normalization. */
export function bindChatTaskId<T extends { type: string; taskId?: TaskId }>(
  kind: T,
  paneKey: string,
): T {
  if (kind.type !== "chat") return kind;
  const taskId = isTaskId(kind.taskId) ? kind.taskId : taskIdForPaneKey(paneKey);
  return kind.taskId === taskId ? kind : { ...kind, taskId };
}

/** Replace a matching link in place so repeated App reconciliation never
 * duplicates a pane, while a newly opened pane remains newest at the end. */
export function linkTaskPane(links: TaskPaneLink[], link: TaskPaneLink): TaskPaneLink[] {
  const index = links.findIndex((current) => current.paneKey === link.paneKey);
  if (index < 0) return [...links, link];
  const current = links[index];
  if (
    current.type === link.type && current.label === link.label && current.detail === link.detail &&
    current.open === link.open && current.linkedAt === link.linkedAt
  ) return links;
  return links.map((current, currentIndex) => (currentIndex === index ? link : current));
}

/** Closing a child retains its activity record while making only that link
 * inactive; a later reopen can reactivate the same pane key. */
export function unlinkTaskPane(links: TaskPaneLink[], paneKey: string): TaskPaneLink[] {
  return links.map((link) => (link.paneKey === paneKey ? { ...link, open: false } : link));
}

export function taskRecordForPane(pane: {
  key: string;
  kind: { type: string; taskId?: TaskId };
}): { id: TaskId; ownerPaneKey: string } | null {
  return isTaskId(pane.kind.taskId) ? { id: pane.kind.taskId, ownerPaneKey: pane.key } : null;
}

// ── durable task workspace store ────────────────────────────────────────────

export const TASK_WORKSPACE_STORAGE_KEY = "aios.task-workspaces.v1";
const TASK_SESSION_EVENTS_PREFIX = "aios.chat.run-events:";
const MAX_TASKS = 60;
const MAX_TASK_EVENTS = 100;
const MAX_TASK_ARTIFACTS = 40;
const MAX_TASK_PANE_LINKS = 40;
const PERSIST_DEBOUNCE_MS = 500;

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

export interface TaskWorkspaceState {
  tasks: TaskWorkspace[];
}

export interface TaskWorkspaceSeed {
  id: TaskId;
  title: string;
  cwd?: string;
  ownerPaneKey: string;
}

/** The chat reducer owns normalization. This store accepts only its compact
 * snapshots, never raw model stream events. `agents`/`workflows` keep the
 * public API ergonomic while `fleet` accepts the canonical reducer output. */
export interface TaskSnapshot {
  phase: RunPhase;
  events: RunEvent[];
  artifacts: Artifact[];
  agents?: FleetAgent[];
  workflows?: FleetWorkflow[];
  fleet?: FleetState;
  title?: string;
  cwd?: string;
  sessionId?: string;
}

export type TaskWorkspaceAction =
  | { type: "ensure"; task: TaskWorkspaceSeed }
  | { type: "bind-session"; taskId: TaskId; sessionId: string }
  | { type: "link-pane"; taskId: TaskId; link: TaskPaneLink }
  | { type: "unlink-pane"; taskId: TaskId; paneKey: string }
  | { type: "snapshot"; taskId: TaskId; snapshot: TaskSnapshot }
  | { type: "remove"; taskId: TaskId };

export interface TaskWorkspaceReduceOptions {
  now?: number;
}

export interface TaskWorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface TaskWorkspaceStoreOptions {
  storage?: TaskWorkspaceStorage;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (handle: unknown) => void;
  persistDelayMs?: number;
}

export interface TaskWorkspaceStore {
  getState(): TaskWorkspaceState;
  getTaskWorkspace(taskId: TaskId): TaskWorkspace | null;
  subscribeTaskWorkspace(taskId: TaskId, listener: () => void): () => void;
  ensureTaskWorkspace(task: TaskWorkspaceSeed): void;
  bindTaskSession(taskId: TaskId, sessionId: string): void;
  linkTaskWorkspacePane(taskId: TaskId, link: TaskPaneLink): void;
  unlinkTaskWorkspacePane(taskId: TaskId, paneKey: string): void;
  publishTaskSnapshot(taskId: TaskId, snapshot: TaskSnapshot): void;
  removeTaskWorkspace(taskId: TaskId): void;
  flush(): void;
}

export const emptyTaskWorkspaceState = (): TaskWorkspaceState => ({ tasks: [] });

function isRunPhase(value: unknown): value is RunPhase {
  return value === "thinking" || value === "writing" || value === "acting" ||
    value === "waiting" || value === "completed" || value === "failed" || value === "interrupted";
}

function isTaskPaneLink(value: unknown): value is TaskPaneLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Partial<TaskPaneLink>;
  return typeof link.paneKey === "string" &&
    (link.type === "chat" || link.type === "shell" || link.type === "files" || link.type === "browser" || link.type === "file" || link.type === "editor") &&
    typeof link.label === "string" && typeof link.open === "boolean" &&
    typeof link.linkedAt === "number" && Number.isFinite(link.linkedAt) &&
    (link.detail == null || typeof link.detail === "string");
}

function isTaskWorkspaceSeed(value: unknown): value is TaskWorkspaceSeed {
  if (!isRecord(value)) return false;
  return isTaskId(value.id) && typeof value.title === "string" &&
    (value.cwd == null || typeof value.cwd === "string") && typeof value.ownerPaneKey === "string";
}

function isArtifact(value: unknown): value is Artifact {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<Artifact>;
  return typeof artifact.path === "string" && typeof artifact.name === "string" &&
    (artifact.kind === "img" || artifact.kind === "pdf" || artifact.kind === "doc" || artifact.kind === "code" || artifact.kind === "file");
}

function hasId(value: unknown): value is { id: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** parseRunEventState intentionally accepts a small legacy surface. Persisted
 * task data is a stronger boundary because it is rendered independently. */
function isTaskRunEvent(value: unknown): value is RunEvent {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.at !== "number" || !Number.isFinite(value.at)) {
    return false;
  }
  switch (value.type) {
    case "reasoning":
      return typeof value.text === "string" && typeof value.streaming === "boolean";
    case "message.delta":
      return typeof value.text === "string";
    case "action.started":
      return typeof value.name === "string" && isRecord(value.input);
    case "action.completed":
      return typeof value.output === "string" && (value.isError == null || typeof value.isError === "boolean");
    case "permission.requested":
      return typeof value.toolName === "string" && isRecord(value.input);
    case "run.completed":
      return [value.durationMs, value.tokens, value.cost].every((field) =>
        field == null || (typeof field === "number" && Number.isFinite(field)),
      );
    case "run.failed":
      return typeof value.message === "string";
    case "run.interrupted":
      return true;
    default:
      return false;
  }
}

function isFleetAgent(value: unknown): value is FleetAgent {
  if (!hasId(value)) return false;
  const agent = value as Partial<FleetAgent>;
  return typeof agent.label === "string" &&
    (agent.status === "running" || agent.status === "done" || agent.status === "failed") &&
    typeof agent.startedAt === "number" && Number.isFinite(agent.startedAt) &&
    (agent.subagentType == null || typeof agent.subagentType === "string") &&
    (agent.lastLine == null || typeof agent.lastLine === "string") &&
    (agent.tokens == null || (typeof agent.tokens === "number" && Number.isFinite(agent.tokens))) &&
    (agent.paneKey == null || typeof agent.paneKey === "string") &&
    (agent.endedAt == null || (typeof agent.endedAt === "number" && Number.isFinite(agent.endedAt)));
}

function isFleetWorkflow(value: unknown): value is FleetWorkflow {
  if (!hasId(value)) return false;
  const workflow = value as Partial<FleetWorkflow>;
  return typeof workflow.label === "string" && Array.isArray(workflow.phases) &&
    workflow.phases.every((phase) => phase && typeof phase.title === "string" &&
      (phase.detail == null || typeof phase.detail === "string")) &&
    (workflow.status === "running" || workflow.status === "done" || workflow.status === "failed") &&
    typeof workflow.startedAt === "number" && Number.isFinite(workflow.startedAt) &&
    (workflow.description == null || typeof workflow.description === "string") &&
    (workflow.runId == null || typeof workflow.runId === "string") &&
    (workflow.endedAt == null || (typeof workflow.endedAt === "number" && Number.isFinite(workflow.endedAt)));
}

function isTaskSnapshot(value: unknown): value is TaskSnapshot {
  if (!isRecord(value) || !isRunPhase(value.phase) || !Array.isArray(value.events) || !value.events.every(isTaskRunEvent)) {
    return false;
  }
  if (!Array.isArray(value.artifacts) || !value.artifacts.every(isArtifact)) return false;
  if (value.title != null && typeof value.title !== "string") return false;
  if (value.cwd != null && typeof value.cwd !== "string") return false;
  if (value.sessionId != null && typeof value.sessionId !== "string") return false;
  if (value.agents != null && (!Array.isArray(value.agents) || !value.agents.every(isFleetAgent))) return false;
  if (value.workflows != null && (!Array.isArray(value.workflows) || !value.workflows.every(isFleetWorkflow))) return false;
  if (value.fleet != null) {
    if (!isRecord(value.fleet) || !Array.isArray(value.fleet.agents) || !Array.isArray(value.fleet.workflows)) return false;
    if (!value.fleet.agents.every(isFleetAgent) || !value.fleet.workflows.every(isFleetWorkflow)) return false;
  }
  return true;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const result: T[] = [];
  const indexById = new Map<string, number>();
  for (const item of items) {
    if (!item.id) continue;
    const index = indexById.get(item.id);
    if (index == null) {
      indexById.set(item.id, result.length);
      result.push(item);
    } else {
      result[index] = item;
    }
  }
  return result;
}

function dedupeArtifacts(items: readonly Artifact[]): Artifact[] {
  const result: Artifact[] = [];
  const indexByPath = new Map<string, number>();
  for (const item of items) {
    if (!item.path) continue;
    const index = indexByPath.get(item.path);
    if (index == null) {
      indexByPath.set(item.path, result.length);
      result.push(item);
    } else {
      result[index] = item;
    }
  }
  return result.slice(-MAX_TASK_ARTIFACTS);
}

function boundedLinks(links: readonly TaskPaneLink[]): TaskPaneLink[] {
  return links.slice(-MAX_TASK_PANE_LINKS).map((link) => ({ ...link }));
}

function putTask(state: TaskWorkspaceState, next: TaskWorkspace): TaskWorkspaceState {
  const without = state.tasks.filter((task) => task.id !== next.id);
  return { tasks: [...without, next].slice(-MAX_TASKS) };
}

/** Persisted stores may outlive an older implementation that allowed the same
 * task id twice. Keep the newest timestamp; equal timestamps intentionally let
 * the later serialized record win, making recovery deterministic. */
function newestUniqueTasks(tasks: readonly TaskWorkspace[]): TaskWorkspace[] {
  const byId = new Map<TaskId, TaskWorkspace>();
  for (const task of tasks) {
    const current = byId.get(task.id);
    if (!current || task.updatedAt >= current.updatedAt) byId.set(task.id, task);
  }
  return [...byId.values()]
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .slice(-MAX_TASKS);
}

function updateTask(
  state: TaskWorkspaceState,
  taskId: TaskId,
  update: (task: TaskWorkspace) => TaskWorkspace | null,
): TaskWorkspaceState {
  const current = state.tasks.find((task) => task.id === taskId);
  if (!current) return state;
  const next = update(current);
  if (!next || next === current) return state;
  return putTask(state, next);
}

/** Pure task reducer: state has no IO and unchanged actions return the exact
 * same state reference, allowing scoped subscribers to skip work. */
export function reduceTaskWorkspace(
  state: TaskWorkspaceState,
  action: TaskWorkspaceAction,
  options: TaskWorkspaceReduceOptions = {},
): TaskWorkspaceState {
  const now = options.now ?? Date.now();
  if (action.type === "ensure") {
    if (!isTaskWorkspaceSeed(action.task)) return state;
    const current = state.tasks.find((task) => task.id === action.task.id);
    if (!current) {
      return putTask(state, {
        ...action.task,
        updatedAt: now,
        phase: "completed",
        paneLinks: [],
        artifacts: [],
        agents: [],
        workflows: [],
        events: [],
      });
    }
    const next = {
      ...current,
      title: action.task.title || current.title,
      cwd: action.task.cwd ?? current.cwd,
      ownerPaneKey: action.task.ownerPaneKey || current.ownerPaneKey,
    };
    if (next.title === current.title && next.cwd === current.cwd && next.ownerPaneKey === current.ownerPaneKey) {
      return state;
    }
    return putTask(state, { ...next, updatedAt: now });
  }

  if (action.type === "remove") {
    if (!state.tasks.some((task) => task.id === action.taskId)) return state;
    return { tasks: state.tasks.filter((task) => task.id !== action.taskId) };
  }

  if (action.type === "bind-session") {
    if (typeof action.sessionId !== "string" || !action.sessionId) return state;
    return updateTask(state, action.taskId, (task) =>
      task.sessionId === action.sessionId ? task : { ...task, sessionId: action.sessionId, updatedAt: now },
    );
  }

  if (action.type === "link-pane") {
    if (!isTaskPaneLink(action.link)) return state;
    return updateTask(state, action.taskId, (task) => {
      const paneLinks = boundedLinks(linkTaskPane(task.paneLinks, action.link));
      const unchanged = paneLinks.length === task.paneLinks.length && paneLinks.every((link, index) => link === task.paneLinks[index]);
      return unchanged ? task : { ...task, paneLinks, updatedAt: now };
    });
  }

  if (action.type === "unlink-pane") {
    return updateTask(state, action.taskId, (task) => {
      const paneLinks = unlinkTaskPane(task.paneLinks, action.paneKey);
      const unchanged = paneLinks.every((link, index) => link === task.paneLinks[index]);
      return unchanged ? task : { ...task, paneLinks, updatedAt: now };
    });
  }

  if (action.type === "snapshot" && !isTaskSnapshot(action.snapshot)) return state;

  return updateTask(state, action.taskId, (task) => {
    const snapshot = action.snapshot;
    const agents = dedupeById(snapshot.fleet?.agents ?? snapshot.agents ?? []).map(clone);
    const workflows = dedupeById(snapshot.fleet?.workflows ?? snapshot.workflows ?? []).map(clone);
    const next: TaskWorkspace = {
      ...task,
      title: snapshot.title ?? task.title,
      cwd: snapshot.cwd ?? task.cwd,
      sessionId: snapshot.sessionId ?? task.sessionId,
      phase: snapshot.phase,
      events: snapshot.events.slice(-MAX_TASK_EVENTS).map(clone),
      artifacts: dedupeArtifacts(snapshot.artifacts).map(clone),
      agents,
      workflows,
      updatedAt: now,
    };
    return next;
  });
}

function normalizedTask(value: unknown): TaskWorkspace | null {
  if (!value || typeof value !== "object") return null;
  const task = value as Partial<TaskWorkspace>;
  if (!isTaskId(task.id) || typeof task.title !== "string" || typeof task.ownerPaneKey !== "string" ||
    typeof task.updatedAt !== "number" || !Number.isFinite(task.updatedAt)) return null;
  if (!Array.isArray(task.events) || !task.events.every(isTaskRunEvent)) return null;
  const replay = parseRunEventState(JSON.stringify({ events: task.events, phase: task.phase }));
  if (!replay || replay.events.length !== task.events.length) return null;
  if (!Array.isArray(task.agents) || !task.agents.every(isFleetAgent)) return null;
  if (!Array.isArray(task.workflows) || !task.workflows.every(isFleetWorkflow)) return null;
  return {
    id: task.id,
    title: task.title,
    ...(typeof task.cwd === "string" ? { cwd: task.cwd } : {}),
    ownerPaneKey: task.ownerPaneKey,
    ...(typeof task.sessionId === "string" ? { sessionId: task.sessionId } : {}),
    updatedAt: task.updatedAt,
    phase: isRunPhase(task.phase) ? task.phase : "completed",
    paneLinks: Array.isArray(task.paneLinks) ? boundedLinks(task.paneLinks.filter(isTaskPaneLink)) : [],
    artifacts: Array.isArray(task.artifacts) ? dedupeArtifacts(task.artifacts.filter(isArtifact)) : [],
    agents: dedupeById(task.agents).map(clone),
    workflows: dedupeById(task.workflows).map(clone),
    events: replay.events.slice(-MAX_TASK_EVENTS).map(clone),
  };
}

export function loadTaskWorkspaceState(
  storage: Pick<TaskWorkspaceStorage, "getItem"> | undefined,
): TaskWorkspaceState {
  if (!storage) return emptyTaskWorkspaceState();
  try {
    const raw = storage.getItem(TASK_WORKSPACE_STORAGE_KEY);
    if (!raw) return emptyTaskWorkspaceState();
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    if (!Array.isArray(parsed.tasks)) throw new Error("invalid task workspace storage");
    const tasks = parsed.tasks.map(normalizedTask);
    const validTasks = tasks.filter((task): task is TaskWorkspace => task !== null);
    if (parsed.tasks.length > 0 && validTasks.length === 0) throw new Error("invalid task workspace record");
    return { tasks: newestUniqueTasks(validTasks) };
  } catch {
    try {
      (storage as TaskWorkspaceStorage).removeItem?.(TASK_WORKSPACE_STORAGE_KEY);
    } catch {
      // Recovery is best-effort; a read-only store is still safe to ignore.
    }
    return emptyTaskWorkspaceState();
  }
}

/** Canonical persistence always enforces task limits, even when called by a
 * future importer that did not use the reducer first. */
export function serializeTaskWorkspaceState(state: TaskWorkspaceState): string {
  const tasks = newestUniqueTasks(
    state.tasks.map(normalizedTask).filter((task): task is TaskWorkspace => task !== null),
  );
  return JSON.stringify({ tasks });
}

export function createTaskWorkspaceStore(options: TaskWorkspaceStoreOptions = {}): TaskWorkspaceStore {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const persistDelay = options.persistDelayMs ?? PERSIST_DEBOUNCE_MS;
  let state = loadTaskWorkspaceState(options.storage);
  let persistTimer: unknown;
  const subscribers = new Map<TaskId, Set<() => void>>();

  const persist = () => {
    persistTimer = undefined;
    if (!options.storage) return;
    try {
      options.storage.setItem(TASK_WORKSPACE_STORAGE_KEY, serializeTaskWorkspaceState(state));
    } catch {
      // quota/disabled storage must not disrupt an active chat.
    }
  };
  const schedulePersist = () => {
    if (!options.storage || persistTimer !== undefined) return;
    persistTimer = schedule(persist, persistDelay);
  };
  const commit = (next: TaskWorkspaceState) => {
    if (next === state) return;
    const previous = state;
    state = next;
    schedulePersist();
    for (const [taskId, listeners] of subscribers) {
      const before = previous.tasks.find((task) => task.id === taskId) ?? null;
      const after = next.tasks.find((task) => task.id === taskId) ?? null;
      if (before === after) continue;
      for (const listener of listeners) listener();
    }
  };
  const dispatch = (action: TaskWorkspaceAction) => commit(reduceTaskWorkspace(state, action, { now: now() }));

  return {
    getState: () => clone(state),
    getTaskWorkspace: (taskId) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      return task ? clone(task) : null;
    },
    subscribeTaskWorkspace: (taskId, listener) => {
      const listeners = subscribers.get(taskId) ?? new Set<() => void>();
      listeners.add(listener);
      subscribers.set(taskId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) subscribers.delete(taskId);
      };
    },
    ensureTaskWorkspace: (task) => {
      if (!isRecord(task)) return;
      if (!isTaskId(task.id)) throw new Error("invalid task id");
      if (!isTaskWorkspaceSeed(task)) return;
      dispatch({ type: "ensure", task });
    },
    bindTaskSession: (taskId, sessionId) => {
      if (typeof sessionId !== "string" || !sessionId) return;
      const before = state.tasks.find((task) => task.id === taskId) ?? null;
      let next = reduceTaskWorkspace(state, { type: "bind-session", taskId, sessionId }, { now: now() });
      const bound = next.tasks.find((task) => task.id === taskId) ?? null;
      if (before && bound && before.events.length === 0 && bound.events.length === 0 && options.storage) {
        try {
          const replay = parseRunEventState(options.storage.getItem(`${TASK_SESSION_EVENTS_PREFIX}${sessionId}`));
          if (replay?.events.length) {
            next = reduceTaskWorkspace(next, {
              type: "snapshot",
              taskId,
              snapshot: { phase: replay.phase, events: replay.events, artifacts: [], fleet: { agents: [], workflows: [] } },
            }, { now: now() });
          }
        } catch {
          // Existing per-session replay is opportunistic compatibility data.
        }
      }
      commit(next);
    },
    linkTaskWorkspacePane: (taskId, link) => {
      if (!isTaskPaneLink(link)) return;
      dispatch({ type: "link-pane", taskId, link });
    },
    unlinkTaskWorkspacePane: (taskId, paneKey) => dispatch({ type: "unlink-pane", taskId, paneKey }),
    publishTaskSnapshot: (taskId, snapshot) => dispatch({ type: "snapshot", taskId, snapshot }),
    removeTaskWorkspace: (taskId) => dispatch({ type: "remove", taskId }),
    flush: () => {
      if (persistTimer === undefined) return;
      cancel(persistTimer);
      persist();
    },
  };
}

let defaultTaskWorkspaceStore: TaskWorkspaceStore | null = null;

function globalTaskWorkspaceStore(): TaskWorkspaceStore {
  if (!defaultTaskWorkspaceStore) {
    const storage = typeof localStorage === "undefined" ? undefined : localStorage;
    defaultTaskWorkspaceStore = createTaskWorkspaceStore({ storage });
  }
  return defaultTaskWorkspaceStore;
}

export function ensureTaskWorkspace(task: TaskWorkspaceSeed): void {
  globalTaskWorkspaceStore().ensureTaskWorkspace(task);
}

export function bindTaskSession(taskId: TaskId, sessionId: string): void {
  globalTaskWorkspaceStore().bindTaskSession(taskId, sessionId);
}

export function publishTaskSnapshot(taskId: TaskId, snapshot: TaskSnapshot): void {
  globalTaskWorkspaceStore().publishTaskSnapshot(taskId, snapshot);
}

export function getTaskWorkspace(taskId: TaskId): TaskWorkspace | null {
  return globalTaskWorkspaceStore().getTaskWorkspace(taskId);
}

export function subscribeTaskWorkspace(taskId: TaskId, listener: () => void): () => void {
  return globalTaskWorkspaceStore().subscribeTaskWorkspace(taskId, listener);
}

/** App owns pane lifecycle; expose the existing store actions at that boundary
 * without introducing a second registry or DOM-owned task state. */
export function linkTaskWorkspacePane(taskId: TaskId, link: TaskPaneLink): void {
  globalTaskWorkspaceStore().linkTaskWorkspacePane(taskId, link);
}

export function unlinkTaskWorkspacePane(taskId: TaskId, paneKey: string): void {
  globalTaskWorkspaceStore().unlinkTaskWorkspacePane(taskId, paneKey);
}
