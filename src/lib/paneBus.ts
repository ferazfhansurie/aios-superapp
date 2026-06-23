/** Lightweight registry so cross-cutting features (voice dictation, drops) can
 *  inject text into a specific terminal pane's PTY. Each TerminalPane registers
 *  a writer keyed by its pane key; App tracks which pane is focused. */
export const paneWriters = new Map<string, (text: string) => void>();

/** Like paneWriters, but a SUBMIT: inserts the text AND fires it (terminal →
 *  paste + Enter via composerSend; chat → set input + send). Lets "send to AI"
 *  actions (notes pane) hand a whole buffer to a pane and have it actually run,
 *  not just sit in the prompt. Keyed by pane key, same lifecycle as paneWriters. */
export const paneSubmitters = new Map<string, (text: string) => void>();

/** Handle a ChatPane publishes so App can decide what to do when its pane is
 *  closed: is a task in flight, and how to detach (keep running) vs kill. */
export interface ChatHandle {
  /** A turn is currently in flight. */
  busy: () => boolean;
  /** Detach: keep the claude process running in the background, optionally
   *  arming a done-notification. Marks the pane so its unmount won't kill it. */
  detach: (notify: boolean) => void;
  /** Stop the current turn while keeping the pane alive. */
  stop?: () => void;
}

/** Live ChatPanes keyed by pane key — lets App intercept close on a busy chat. */
export const chatHandles = new Map<string, ChatHandle>();

/** Pane key → backend numeric chat-session id. A ChatPane registers itself here
 *  once its session id is known, and clears on unmount. Lets a notification click
 *  resolve "is there an OPEN pane for this backend session?" without the pane
 *  having to be the literal `reattach` kind (a fresh chat learns its id at
 *  runtime). Mirrors `chatHandles` lifecycle. */
export const chatSessions = new Map<string, number>();

/** Find the pane key currently bound to a backend chat-session id, if any. */
export function paneKeyForChatSession(sessionId: number): string | null {
  for (const [key, id] of chatSessions) {
    if (id === sessionId) return key;
  }
  return null;
}

/** Detach every chat pane that is actively generating. Returns how many were
 *  moved to the background. Used by native window-close handling so closing the
 *  cockpit hides the shell instead of killing in-flight ai work. */
export function detachBusyChats(notify: boolean): number {
  let detached = 0;
  for (const handle of chatHandles.values()) {
    if (!handle.busy()) continue;
    handle.detach(notify);
    detached += 1;
  }
  return detached;
}

/** Image-drop sink a pane registers (keyed by pane key). When an OS file drop
 *  (Finder/desktop screenshot) lands on a pane, App routes IMAGE paths here so
 *  they become proper attachments (chat → thumbnail chips; terminal → quoted
 *  path) instead of raw text. Falls back to paneWriters when a pane registers no
 *  image sink. Each path is absolute on disk; the sink reads + attaches it. */
export const paneImageDrop = new Map<string, (paths: string[]) => void>();

// ── canonical pane-rect registry (R2b) ──────────────────────────────────────
// The OS-file-drop hit-test used `document.elementFromPoint`, which FAILS over a
// native child WKWebView (the browser pane paints ABOVE the React layer and is
// not a resolvable DOM node). This registry lets App hit-test purely against the
// React wrappers' live rects (topmost-wins), so drops target the right pane even
// when a browser webview occupies the cell.

/** What kind of payload a drop carries, so a pane can opt out (canAccept). */
export type PayloadKind = "path" | "url" | "image" | "files";

/** Lightweight context a pane exposes about what it's showing — lets
 *  cross-cutting features (spawn-with-context, drops, future routing) read
 *  "where is this pane rooted" without kind-specific switches. All fields
 *  optional; a pane reports whatever applies. */
export interface PaneContext {
  cwd?: string;
  url?: string;
  file?: string;
}

export interface PaneHandle {
  key: string;
  type: string;
  /** Live on-screen rect of the pane's wrapper (App's [data-pane-key] div). */
  getRect: () => DOMRect | null;
  /** Whether this pane wants a payload of the given kind. */
  canAccept: (kind: PayloadKind) => boolean;
  /** Optional: what the pane is currently showing (cwd / url / file). */
  getContext?: () => PaneContext;
}

/** Every mounted PaneCard registers here keyed by pane key. */
export const paneRegistry = new Map<string, PaneHandle>();

export function registerPane(handle: PaneHandle): () => void {
  paneRegistry.set(handle.key, handle);
  return () => {
    if (paneRegistry.get(handle.key) === handle) paneRegistry.delete(handle.key);
  };
}

/** Resolve the pane key under a CSS-pixel point, topmost-wins. Iterates the
 *  registry's live rects rather than the DOM, so it's robust over native
 *  webviews. Iteration order = insertion; later-mounted panes win ties (matches
 *  z-order well enough for a non-overlapping grid). Returns null if no pane.
 *
 *  When `payload` is given, panes whose `canAccept(payload)` declines are
 *  skipped — ALL drop hit-testing routes through here so opting out of a
 *  payload kind is honored at the registry, not ad-hoc per call site. */
export function paneKeyAtPoint(x: number, y: number, payload?: PayloadKind): string | null {
  let hit: string | null = null;
  for (const handle of paneRegistry.values()) {
    if (payload && !handle.canAccept(payload)) continue;
    const r = handle.getRect();
    if (!r) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hit = handle.key;
  }
  return hit;
}

/** Read a pane's self-reported context ({} when the pane reports none). */
export function paneContextFor(key: string): PaneContext {
  return paneRegistry.get(key)?.getContext?.() ?? {};
}

// ── per-pane drop sinks (R2b) ────────────────────────────────────────────────
// A generic sink each pane registers: given dropped filesystem paths (and the
// raw FileList when present), do the pane-appropriate thing and return true if
// the drop was consumed. The central OS-drop handler checks this FIRST, then
// falls back to the existing image/text-insert logic.
export type PaneDropSink = (paths: string[], files?: FileList) => boolean;
export const paneDropSink = new Map<string, PaneDropSink>();

export function registerPaneDropSink(key: string, sink: PaneDropSink): () => void {
  paneDropSink.set(key, sink);
  return () => {
    if (paneDropSink.get(key) === sink) paneDropSink.delete(key);
  };
}

// ── open-file-in-pane channel ────────────────────────────────────────────────
// App owns pane creation; deep children (e.g. a chat artifact card) need to open
// a file as an in-app viewer pane rather than handing it to the OS. App registers
// its opener once; callers use openFileInPane and fall back to the OS only if
// nothing is registered.
/** Optional jump target when opening a file in the editor (1-based). Used by
 *  global search (⌘⇧F) to open a file AND scroll to the matched line. */
export interface OpenAt {
  line?: number;
  col?: number;
}

let openFileImpl: ((path: string, name: string) => void) | null = null;
let openEditorFileImpl: ((path: string, name: string, at?: OpenAt) => void) | null = null;
let openViewerFileImpl: ((path: string, name: string) => void) | null = null;
let revealFileImpl: ((path: string, name: string) => void) | null = null;

/** App registers how to open a file as an in-app pane. Returns an unregister fn. */
export function registerOpenFile(
  fn: (path: string, name: string) => void,
): () => void {
  openFileImpl = fn;
  return () => {
    if (openFileImpl === fn) openFileImpl = null;
  };
}

/** Open a file in an in-app viewer pane. Returns false if no opener is wired
 *  (caller should then fall back to the OS). */
export function openFileInPane(path: string, name: string): boolean {
  if (!openFileImpl) return false;
  openFileImpl(path, name);
  return true;
}

export function registerOpenEditorFile(
  fn: (path: string, name: string, at?: OpenAt) => void,
): () => void {
  openEditorFileImpl = fn;
  return () => {
    if (openEditorFileImpl === fn) openEditorFileImpl = null;
  };
}

export function registerOpenViewerFile(
  fn: (path: string, name: string) => void,
): () => void {
  openViewerFileImpl = fn;
  return () => {
    if (openViewerFileImpl === fn) openViewerFileImpl = null;
  };
}

export function registerRevealFile(
  fn: (path: string, name: string) => void,
): () => void {
  revealFileImpl = fn;
  return () => {
    if (revealFileImpl === fn) revealFileImpl = null;
  };
}

export function openEditorFileInPane(path: string, name: string, at?: OpenAt): boolean {
  if (!openEditorFileImpl) return false;
  openEditorFileImpl(path, name, at);
  return true;
}

export function openViewerFileInPane(path: string, name: string): boolean {
  if (!openViewerFileImpl) return false;
  openViewerFileImpl(path, name);
  return true;
}

export function revealFileInPane(path: string, name: string): boolean {
  if (!revealFileImpl) return false;
  revealFileImpl(path, name);
  return true;
}

// ── generic spawn-pane channel ───────────────────────────────────────────────
// The general "any pane can spawn any pane WITH CONTEXT" primitive. App owns pane
// creation; deep children (FilesPane, BrowserPane, TerminalPane) ask App to open
// a fresh pane of a given kind, carrying just enough context to root/seed it. App
// translates the (kind, ctx) into a real PaneContent + label and spawns it
// (reusing the existing `spawn`, so the exit-fullscreen-on-spawn behavior applies).
export type SpawnPaneKind = "terminal" | "files" | "browser" | "chat";

/** Context a spawn carries. Only the fields relevant to the target kind are read:
 *  - terminal → `cwd` (shell starts there)
 *  - files    → `path` (pane is rooted there)
 *  - browser  → `url`  (initial url; e.g. a `file://` for a selected file)
 *  - chat     → `cwd` + `seed` + `modelId` (chat working dir, opening prompt,
 *               and optional model to boot)
 */
export interface SpawnCtx {
  cwd?: string;
  path?: string;
  url?: string;
  seed?: string;
  /** chat only: model id to boot the new chat pane with. */
  modelId?: string;
  /** terminal only: a command to seed + run in the freshly-spawned shell. Maps
   *  to the shell pane's startup `cmd`, so it runs as soon as the PTY is ready
   *  (no need to look the new pane up in paneWriters/paneSubmitters after mount).
   *  Used by ChatPane's "run in terminal" affordance on bash/sh code fences. */
  cmd?: string;
  /** Optional human label override for the new pane. */
  label?: string;
}

let spawnPaneImpl: ((kind: SpawnPaneKind, ctx?: SpawnCtx) => void) | null = null;

/** App registers how to spawn a pane of a given kind with context. Returns an
 *  unregister fn. */
export function registerSpawnPane(
  fn: (kind: SpawnPaneKind, ctx?: SpawnCtx) => void,
): () => void {
  spawnPaneImpl = fn;
  return () => {
    if (spawnPaneImpl === fn) spawnPaneImpl = null;
  };
}

/** Spawn a new pane of `kind` carrying `ctx`. Returns false if no impl is wired
 *  (caller can decide on a fallback; in-app there always is one once App mounts). */
export function spawnPane(kind: SpawnPaneKind, ctx?: SpawnCtx): boolean {
  if (!spawnPaneImpl) return false;
  spawnPaneImpl(kind, ctx);
  return true;
}

/** Open a fresh chat pane for a slash-command handoff. Keeps the public contract
 *  explicit instead of making ChatPane know App's pane shape. */
export function requestChatHandoffPane(ctx: {
  cwd?: string;
  seed: string;
  modelId: string;
  label?: string;
}): boolean {
  return spawnPane("chat", ctx);
}

// ── orchestrator channel ─────────────────────────────────────────────────────
// The ONE capable AI firaz talks to. The mission board (and anywhere else) asks
// App to open/focus the orchestrator chat pane (stable key, rooted in
// ~/.aios/orchestrator so it gets the orchestrator CLAUDE.md). Optional prefill
// is dropped into the composer WITHOUT sending — firaz talks, never canned auto-
// dispatch. App registers the impl once; callers use talkToOrchestrator.
let orchestratorImpl: ((prefill?: string) => void) | null = null;

export function registerOrchestrator(fn: (prefill?: string) => void): () => void {
  orchestratorImpl = fn;
  return () => {
    if (orchestratorImpl === fn) orchestratorImpl = null;
  };
}

/** Open/focus the orchestrator chat. Optional `prefill` seeds the composer
 *  (NOT sent). Returns false if no impl wired (App not mounted). */
export function talkToOrchestrator(prefill?: string): boolean {
  if (!orchestratorImpl) return false;
  orchestratorImpl(prefill);
  return true;
}

// ── pane-nav: the global keybind contract (FROZEN for wave-2 consumers) ──────
// Cockpit-wide shortcuts fire as native menu accelerators in src-tauri/lib.rs
// (so they work even when focus sits inside a child webview) and arrive in the
// React layer as a Tauri event:
//
//   event:   "pane-nav"
//   payload: { action: PaneNavAction, index?: number }   // index: 1-based, goto only
//
// App.tsx owns the single listener and routes BY FOCUSED PANE: it first offers
// the action to the focused pane's registered handler (below); only if no
// handler consumes it does the app-level default run (⌘F → fullscreen toggle,
// ⌘W → close pane, …). Pane components subscribe with `onPaneNav(key, handler)`
// and return true to consume — e.g. a browser pane consumes "find" to open
// find-in-page, an editor consumes "save". The window-keydown fallback in
// App.tsx routes through the SAME dispatcher, so handlers work in web builds.

export type PaneNavAction =
  | "find"
  | "save"
  | "close"
  | "goto"
  | "palette"
  | "sidebar"
  | "quickopen"
  | "globalsearch"
  | "newtab";

export interface PaneNavEvent {
  action: PaneNavAction;
  /** 1-based pane ordinal — present only for `goto` (⌘1-9). */
  index?: number;
}

/** Return true to consume the action (App's default behavior is skipped). */
export type PaneNavHandler = (ev: PaneNavEvent) => boolean | void;

const paneNavHandlers = new Map<string, PaneNavHandler>();

/** Register a pane's keybind handler (keyed by pane key). Last-write-wins per
 *  key; returns an unregister fn — pair with the pane's mount lifecycle. */
export function onPaneNav(key: string, handler: PaneNavHandler): () => void {
  paneNavHandlers.set(key, handler);
  return () => {
    if (paneNavHandlers.get(key) === handler) paneNavHandlers.delete(key);
  };
}

/** Offer a pane-nav action to the pane's registered handler. Returns true when
 *  the pane consumed it (callers then skip the app-level default). */
export function dispatchPaneNav(key: string | null | undefined, ev: PaneNavEvent): boolean {
  if (!key) return false;
  const handler = paneNavHandlers.get(key);
  if (!handler) return false;
  try {
    return handler(ev) === true;
  } catch {
    return false; // a broken handler must not eat the app-level default
  }
}

// ── unified focus: the active pane, readable from anywhere ───────────────────
// App owns focus as React state; the keybind router and future panes need a
// synchronous read without prop-drilling. App registers a getter once.

let activePaneGetter: (() => string | null) | null = null;

export function registerActivePane(get: () => string | null): () => void {
  activePaneGetter = get;
  return () => {
    if (activePaneGetter === get) activePaneGetter = null;
  };
}

/** The pane key that currently holds cockpit focus (null when none/idle). */
export function getActivePaneKey(): string | null {
  return activePaneGetter?.() ?? null;
}

// ── open-url-in-pane channel ─────────────────────────────────────────────────
// Same shape as file opening: App owns pane creation, deep markdown renderers can
// ask for an in-app browser pane without knowing the layout machinery.
let openUrlImpl: ((url: string, label?: string) => void) | null = null;

export function registerOpenUrl(
  fn: (url: string, label?: string) => void,
): () => void {
  openUrlImpl = fn;
  return () => {
    if (openUrlImpl === fn) openUrlImpl = null;
  };
}

export function openUrlInPane(url: string, label?: string): boolean {
  if (!openUrlImpl) return false;
  openUrlImpl(url, label);
  return true;
}

// ── open-settings-to-section channel ─────────────────────────────────────────
// Settings owns its active section as local state; a notification click needs to
// open the overlay AND jump it to a section (e.g. "diagnostics"). App registers a
// setter; callers use openSettingsTo. Same shape as the file/url openers.
let openSettingsImpl: ((section: string) => void) | null = null;

export function registerOpenSettings(fn: (section: string) => void): () => void {
  openSettingsImpl = fn;
  return () => {
    if (openSettingsImpl === fn) openSettingsImpl = null;
  };
}

export function openSettingsTo(section: string): boolean {
  if (!openSettingsImpl) return false;
  openSettingsImpl(section);
  return true;
}

// ── cross-pane drag signal ───────────────────────────────────────────────────
// When an item carrying our `application/x-aios-path` payload is dragged
// anywhere in the app, every pane's drop overlay should light up so the drop is
// captured ABOVE intercepting children (e.g. xterm's canvas). We broadcast a
// single app-wide "a path drag is in flight" boolean from window-level dnd
// events, and panes subscribe via `onAiosDrag`.

/** The dataTransfer type a draggable pane item must set to be droppable. */
export const AIOS_PATH_MIME = "application/x-aios-path";

/** Set ALONGSIDE AIOS_PATH_MIME when the dragged item is a DIRECTORY (Files-pane
 *  folder row). Drop targets read this to do the folder-appropriate thing:
 *  terminal → `cd <dir>`, files pane → set root to it. Value = the abs dir path
 *  (same as the path MIME), presence of the type is what flags "this is a dir". */
export const AIOS_DIR_MIME = "application/x-aios-dir";

type DragListener = (active: boolean) => void;
const dragListeners = new Set<DragListener>();
let dragActive = false;

function setDragActive(active: boolean) {
  if (active === dragActive) return;
  dragActive = active;
  dragListeners.forEach((fn) => fn(active));
}

/** Subscribe to the app-wide path-drag signal. Returns an unsubscribe fn. */
export function onAiosDrag(fn: DragListener): () => void {
  dragListeners.add(fn);
  fn(dragActive); // sync current state on mount
  return () => {
    dragListeners.delete(fn);
  };
}

// ── pointer-based in-app drag ────────────────────────────────────────────────
// HTML5 dnd is unreliable inside the Tauri webview on macOS: with
// `dragDropEnabled` on (required for Finder→pane drops via onDragDropEvent),
// WKWebView's native interception can swallow in-app HTML5 `drop` events — the
// FilesPane→ChatPane drag "just doesn't work". So in-app drags use plain mouse
// events instead: `beginPathDrag` on row mousedown arms the same `onAiosDrag`
// signal (so PaneDropZone overlays light up and BrowserPane hides its native
// webview), floats a ghost label under the cursor, and drop targets read the
// payload via `getDragPayload()` on mouseup. No dataTransfer involved.

export interface AiosDragPayload {
  path: string;
  isDir: boolean;
}

let dragPayload: AiosDragPayload | null = null;
// set briefly after a real drag ends so the row's click handler can tell a
// drag-release apart from a plain click (mouseup fires both).
let dragEndedAt = 0;

/** The in-flight pointer-drag payload, readable by drop targets on mouseup. */
export function getDragPayload(): AiosDragPayload | null {
  return dragPayload;
}

/** True once shortly after a pointer-drag ended — lets the drag-source row
 *  swallow the click that the ending mouseup also produces. */
export function consumeDragClick(): boolean {
  return Date.now() - dragEndedAt < 200;
}

/** Start tracking a potential pointer-drag from a row mousedown. Becomes a real
 *  drag (arms overlays + ghost) only after the cursor moves past a threshold,
 *  so plain clicks are untouched. Esc cancels. */
export function beginPathDrag(payload: AiosDragPayload, startX: number, startY: number): void {
  const THRESHOLD = 5;
  let started = false;
  let ghost: HTMLDivElement | null = null;
  const name = payload.path.replace(/\/+$/, "").split("/").pop() || payload.path;
  const onMove = (e: MouseEvent) => {
    if (!started) {
      if (Math.abs(e.clientX - startX) < THRESHOLD && Math.abs(e.clientY - startY) < THRESHOLD) {
        return;
      }
      started = true;
      dragPayload = payload;
      setDragActive(true);
      ghost = document.createElement("div");
      ghost.textContent = `${payload.isDir ? "📁" : "📄"} ${name}`;
      ghost.style.cssText =
        "position:fixed;z-index:9999;pointer-events:none;padding:3px 10px;border-radius:8px;" +
        "background:var(--color-panel-2);border:1px solid var(--color-border-strong);" +
        "color:var(--color-text);font:12px sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.5);";
      document.body.appendChild(ghost);
    }
    if (ghost) {
      ghost.style.left = `${e.clientX + 12}px`;
      ghost.style.top = `${e.clientY + 10}px`;
    }
  };
  const cleanup = () => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    document.removeEventListener("keydown", onKey, true);
    ghost?.remove();
    ghost = null;
  };
  const onUp = () => {
    cleanup();
    if (!started) return;
    dragEndedAt = Date.now();
    // capture-phase listener: defer clearing one tick so the drop target's own
    // (target-phase) mouseup can still read the payload via getDragPayload().
    setTimeout(() => {
      dragPayload = null;
      setDragActive(false);
    }, 0);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    cleanup();
    dragPayload = null;
    if (started) setDragActive(false);
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);
  document.addEventListener("keydown", onKey, true);
}

// Wire the window-level listeners once. We arm the overlays on any in-app HTML5
// drag (Files-pane row → another pane). NOTE: `dragDropEnabled:true` means OS
// file drops (Finder → pane) bypass HTML5 entirely and are handled by the
// central Tauri `onDragDropEvent` handler in App.tsx (which hides nothing — it
// hit-tests the pane registry). These window listeners therefore arm for the
// in-app drags, which is exactly what triggers the browser webview-hide unlock.
// Gutter-resizes use mouse events (not HTML5 dnd) so they never trip this.
if (typeof window !== "undefined" && !(window as unknown as { __aiosDragWired?: boolean }).__aiosDragWired) {
  (window as unknown as { __aiosDragWired?: boolean }).__aiosDragWired = true;
  const arm = () => setDragActive(true);
  const disarm = () => setDragActive(false);
  window.addEventListener("dragenter", arm, true);
  window.addEventListener("dragover", arm, true);
  window.addEventListener("dragend", disarm, true);
  window.addEventListener("drop", disarm, true);
  // a dragleave with no relatedTarget means the pointer left the window entirely
  window.addEventListener(
    "dragleave",
    (e) => {
      if (!(e as DragEvent).relatedTarget) disarm();
    },
    true,
  );
}
