import type { PaneContent } from "./apps";
import { invoke, isTauriRuntime } from "./tauri.ts";

const PANE_HISTORY_KEY = "aios.pane.history.v1";
const PANE_HISTORY_LIMIT = 200;
const PANE_HISTORY_EVENT = "aios:pane-history";
const BAD_CHAT_TITLE =
  /#?\s*agents\.md\s+instructions|<instructions>|<\/instructions>|<critical_persona>|<\/critical_persona>|you are aios/i;

export interface PaneHistoryItem {
  id: string;
  label: string;
  detail: string;
  indicator: string;
  openedAt: number;
  kind: PaneContent;
}

function basename(path?: string): string {
  const clean = (path ?? "").replace(/\/+$/, "");
  return clean.split("/").filter(Boolean).pop() || clean || "";
}

function compactText(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function shortId(id?: string): string {
  const clean = compactText(id);
  return clean ? clean.slice(0, 8) : "";
}

function cleanChatTitle(title: string | undefined, cwd?: string, fallback?: string): string {
  const raw = compactText(title);
  const alt = compactText(fallback);
  const candidate = raw && !BAD_CHAT_TITLE.test(raw) ? raw : alt && !BAD_CHAT_TITLE.test(alt) ? alt : "";
  if (candidate) return candidate.length > 72 ? `${candidate.slice(0, 69)}...` : candidate;
  const project = basename(cwd);
  return project ? `resumed chat · ${project}` : "resumed chat";
}

function hostFromUrl(url?: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return basename(decodeURIComponent(parsed.pathname)) || "file";
    return parsed.hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

function restorablePaneKind(kind: PaneContent): PaneContent {
  if (kind.type === "chat") {
    const resume = kind.resume
      ? {
          ...kind.resume,
          title: cleanChatTitle(kind.resume.title, kind.cwd, kind.agentLabel),
        }
      : undefined;
    return {
      type: "chat",
      cwd: kind.cwd,
      resume,
      modelId: kind.modelId,
      agentLabel: kind.agentLabel,
    };
  }
  if (kind.type === "browser") {
    return {
      type: "browser",
      url: kind.url,
      profile: kind.profile,
      memKey: kind.memKey,
      transient: kind.transient,
    };
  }
  return kind;
}

export function paneHistoryKindLabel(kind: PaneContent): string {
  switch (kind.type) {
    case "browser":
      return "browser";
    case "chat":
      return "chat";
    case "files":
      return "files";
    case "history":
      return "history";
    case "oracle":
    case "shell":
    case "tmux":
      return "terminal";
    default:
      return kind.type;
  }
}

export function describePaneHistoryItem(kind: PaneContent, label: string): Pick<PaneHistoryItem, "label" | "detail" | "indicator"> {
  switch (kind.type) {
    case "browser": {
      const host = hostFromUrl(kind.url);
      return {
        label: label || host || "browser",
        detail: kind.url || "new browser",
        indicator: kind.profile ? `web · ${kind.profile}` : "web",
      };
    }
    case "chat": {
      const cwd = basename(kind.cwd);
      if (kind.resume) {
        const engine = compactText(kind.resume.engine) || "chat";
        const id = shortId(kind.resume.id);
        return {
          label: cleanChatTitle(kind.resume.title, kind.cwd, label),
          detail: [engine === "chat" ? "chat session" : `${engine} session`, id, cwd]
            .filter(Boolean)
            .join(" · "),
          indicator: "resume",
        };
      }
      return {
        label: cleanChatTitle(kind.agentLabel || label || "chat", kind.cwd, "chat"),
        detail: kind.cwd || "new chat",
        indicator: cwd ? `chat · ${cwd}` : "chat",
      };
    }
    case "files":
      return {
        label: label || basename(kind.root) || "files",
        detail: kind.root || "home",
        indicator: "files",
      };
    case "history":
      return {
        label: "history",
        detail: "opened panes",
        indicator: "history",
      };
    case "shell":
      return {
        label: label || basename(kind.cwd) || "terminal",
        detail: [kind.cwd, kind.cmd].filter(Boolean).join(" · ") || "shell",
        indicator: "terminal",
      };
    case "oracle":
      return {
        label: label || `oracle · ${kind.identity}`,
        detail: kind.identity,
        indicator: "oracle",
      };
    case "tmux":
      return {
        label: label || kind.session || "tmux",
        detail: `${kind.socket}/${kind.session}`,
        indicator: "tmux",
      };
    default:
      return {
        label: label || kind.type,
        detail: kind.type,
        indicator: paneHistoryKindLabel(kind),
      };
  }
}

function paneHistoryIdentity(kind: PaneContent, label: string): string {
  switch (kind.type) {
    case "chat":
      return kind.resume?.id ? `chat:resume:${kind.resume.id}` : `chat:${kind.cwd ?? ""}:${label}`;
    case "browser":
      return `browser:${kind.profile ?? ""}:${kind.memKey ?? ""}:${kind.url ?? ""}`;
    case "files":
      return `files:${kind.root ?? ""}`;
    case "shell":
      return `shell:${kind.cwd ?? ""}:${kind.cmd ?? ""}`;
    case "oracle":
      return `oracle:${kind.identity}`;
    case "tmux":
      return `tmux:${kind.socket}:${kind.session}`;
    default:
      return `${kind.type}:${label}`;
  }
}

function chatCwdKey(kind: PaneContent): string | null {
  return kind.type === "chat" ? `chat:cwd:${kind.cwd ?? ""}` : null;
}

function isPaneHistoryItem(item: unknown): item is PaneHistoryItem {
  return Boolean(
    item &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { label?: unknown }).label === "string" &&
      typeof (item as { detail?: unknown }).detail === "string" &&
      typeof (item as { indicator?: unknown }).indicator === "string" &&
      typeof (item as { openedAt?: unknown }).openedAt === "number" &&
      (item as { kind?: unknown }).kind &&
      typeof (item as { kind?: { type?: unknown } }).kind === "object" &&
      typeof (item as { kind?: { type?: unknown } }).kind?.type === "string",
  );
}

function normalizePaneHistoryItem(item: PaneHistoryItem): PaneHistoryItem {
  const kind = restorablePaneKind(item.kind);
  const description = describePaneHistoryItem(kind, item.label);
  return { ...item, kind, ...description };
}

function normalizePaneHistoryItems(items: PaneHistoryItem[]): { items: PaneHistoryItem[]; changed: boolean } {
  const seen = new Set<string>();
  const next: PaneHistoryItem[] = [];
  let changed = false;
  const sorted = items.slice().sort((a, b) => b.openedAt - a.openedAt);
  const normalizedSorted = sorted.map((item) => ({ item, normalized: normalizePaneHistoryItem(item) }));
  const resumedChatCwds = new Set(
    normalizedSorted
      .map(({ normalized }) => (normalized.kind.type === "chat" && normalized.kind.resume ? chatCwdKey(normalized.kind) : null))
      .filter((key): key is string => Boolean(key)),
  );
  for (const { item, normalized } of normalizedSorted) {
    if (normalized.kind.type === "chat" && !normalized.kind.resume && resumedChatCwds.has(chatCwdKey(normalized.kind) ?? "")) {
      changed = true;
      continue;
    }
    const key = paneHistoryIdentity(normalized.kind, normalized.label);
    if (seen.has(key)) {
      changed = true;
      continue;
    }
    seen.add(key);
    next.push(normalized);
    if (
      normalized.label !== item.label ||
      normalized.detail !== item.detail ||
      normalized.indicator !== item.indicator ||
      JSON.stringify(normalized.kind) !== JSON.stringify(item.kind)
    ) {
      changed = true;
    }
  }
  return {
    items: next.slice(0, PANE_HISTORY_LIMIT),
    changed: changed || next.length !== items.length || sorted.some((item, index) => item !== items[index]),
  };
}

function mergePaneHistoryItems(...groups: PaneHistoryItem[][]): PaneHistoryItem[] {
  return normalizePaneHistoryItems(groups.flat()).items;
}

function coercePaneHistoryItems(value: unknown): PaneHistoryItem[] {
  if (!Array.isArray(value)) return [];
  return normalizePaneHistoryItems(value.filter(isPaneHistoryItem)).items;
}

function readPaneHistoryItems(value: unknown): { items: PaneHistoryItem[]; changed: boolean } {
  if (!Array.isArray(value)) return { items: [], changed: true };
  const valid = value.filter(isPaneHistoryItem);
  const normalized = normalizePaneHistoryItems(valid);
  return {
    items: normalized.items,
    changed: normalized.changed || valid.length !== value.length,
  };
}

function emitPaneHistoryChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PANE_HISTORY_EVENT));
}

function persistPaneHistoryCache(items: PaneHistoryItem[], notify: boolean): PaneHistoryItem[] {
  try {
    localStorage.setItem(PANE_HISTORY_KEY, JSON.stringify(items));
    if (notify) emitPaneHistoryChanged();
  } catch {
    /* quota / unavailable */
  }
  return items;
}

export function loadPaneHistory(): PaneHistoryItem[] {
  try {
    const raw = localStorage.getItem(PANE_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const normalized = readPaneHistoryItems(parsed);
    if (normalized.changed) persistPaneHistoryCache(normalized.items, false);
    schedulePaneHistoryResumeValidation();
    return normalized.items;
  } catch {
    return [];
  }
}

async function loadPaneHistoryDb(): Promise<PaneHistoryItem[] | null> {
  if (!isTauriRuntime()) return null;
  try {
    const rows = await invoke<unknown[]>("load_pane_history");
    return coercePaneHistoryItems(rows);
  } catch {
    return null;
  }
}

async function savePaneHistoryDb(items: PaneHistoryItem[]): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("save_pane_history", { items });
}

let durableQueue: Promise<void> = Promise.resolve();
let hydrationPromise: Promise<PaneHistoryItem[]> | null = null;
let resumeValidationPromise: Promise<void> | null = null;
let historyMutationVersion = 0;

async function existingTranscripts(ids: string[]): Promise<Set<string> | null> {
  try {
    const existing = await invoke<string[]>("chat_transcripts_exist", { ids });
    return new Set(existing);
  } catch {
    return null;
  }
}

function schedulePaneHistoryResumeValidation(): void {
  if (!isTauriRuntime() || resumeValidationPromise) return;
  resumeValidationPromise = Promise.resolve()
    .then(async () => {
      const items = loadPaneHistory();
      const ids = [
        ...new Set(
          items
            .map((item) => (item.kind.type === "chat" ? item.kind.resume?.id?.trim() : ""))
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      if (!ids.length) return;
      const existing = await existingTranscripts(ids);
      if (!existing) return;
      const stale = new Set(ids.filter((id) => !existing.has(id)));
      if (!stale.size) return;
      savePaneHistory(
        loadPaneHistory().filter(
          (item) => item.kind.type !== "chat" || !item.kind.resume?.id || !stale.has(item.kind.resume.id),
        ),
        "replace",
      );
    })
    .catch(() => undefined)
    .finally(() => {
      resumeValidationPromise = null;
    });
}

function queueDurablePaneHistory(
  items: PaneHistoryItem[],
  mode: "merge" | "replace",
  version: number,
): void {
  if (!isTauriRuntime()) return;
  const snapshot = normalizePaneHistoryItems(items).items;
  durableQueue = durableQueue
    .catch(() => undefined)
    .then(async () => {
      const next =
        mode === "merge"
          ? mergePaneHistoryItems(snapshot, (await loadPaneHistoryDb()) ?? [])
          : snapshot;
      await savePaneHistoryDb(next);
      const cached = loadPaneHistory();
      if (version === historyMutationVersion && JSON.stringify(cached) !== JSON.stringify(next)) {
        persistPaneHistoryCache(next, true);
      }
    })
    .catch(() => undefined);
}

export async function hydratePaneHistoryStore(): Promise<PaneHistoryItem[]> {
  if (!isTauriRuntime()) return loadPaneHistory();
  if (hydrationPromise) return hydrationPromise;
  const version = historyMutationVersion;
  hydrationPromise = durableQueue
    .catch(() => undefined)
    .then(async () => {
      const local = loadPaneHistory();
      const stored = await loadPaneHistoryDb();
      if (!stored) return local;
      const merged = mergePaneHistoryItems(local, stored);
      if (version !== historyMutationVersion) return loadPaneHistory();
      if (JSON.stringify(local) !== JSON.stringify(merged)) {
        persistPaneHistoryCache(merged, true);
      }
      await savePaneHistoryDb(merged);
      schedulePaneHistoryResumeValidation();
      return merged;
    })
    .catch(() => loadPaneHistory())
    .finally(() => {
      hydrationPromise = null;
    });
  return hydrationPromise;
}

function savePaneHistory(items: PaneHistoryItem[], mode: "merge" | "replace"): PaneHistoryItem[] {
  const next = persistPaneHistoryCache(normalizePaneHistoryItems(items).items, true);
  historyMutationVersion += 1;
  queueDurablePaneHistory(next, mode, historyMutationVersion);
  return next;
}

export function recordPaneHistory(kind: PaneContent, label: string): PaneHistoryItem | null {
  if (kind.type === "history") return null;
  const description = describePaneHistoryItem(kind, label);
  const item: PaneHistoryItem = {
    id: `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    openedAt: Date.now(),
    kind: restorablePaneKind(kind),
    ...description,
  };
  const key = paneHistoryIdentity(item.kind, item.label);
  savePaneHistory(
    [item, ...loadPaneHistory().filter((old) => paneHistoryIdentity(old.kind, old.label) !== key)],
    "merge",
  );
  return item;
}

export function removePaneHistory(id: string): PaneHistoryItem[] {
  return savePaneHistory(loadPaneHistory().filter((item) => item.id !== id), "replace");
}

export function prunePaneHistoryResume(id: string): PaneHistoryItem[] {
  const clean = compactText(id);
  if (!clean) return loadPaneHistory();
  return savePaneHistory(
    loadPaneHistory().filter((item) => item.kind.type !== "chat" || item.kind.resume?.id !== clean),
    "replace",
  );
}

export function clearPaneHistory(): PaneHistoryItem[] {
  return savePaneHistory([], "replace");
}

export function subscribePaneHistory(listener: () => void): () => void {
  window.addEventListener(PANE_HISTORY_EVENT, listener);
  return () => window.removeEventListener(PANE_HISTORY_EVENT, listener);
}
