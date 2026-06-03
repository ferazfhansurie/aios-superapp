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

// ── open-file-in-pane channel ────────────────────────────────────────────────
// App owns pane creation; deep children (e.g. a chat artifact card) need to open
// a file as an in-app viewer pane rather than handing it to the OS. App registers
// its opener once; callers use openFileInPane and fall back to the OS only if
// nothing is registered.
let openFileImpl: ((path: string, name: string) => void) | null = null;
let openEditorFileImpl: ((path: string, name: string) => void) | null = null;
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
  fn: (path: string, name: string) => void,
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

export function openEditorFileInPane(path: string, name: string): boolean {
  if (!openEditorFileImpl) return false;
  openEditorFileImpl(path, name);
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

// ── cross-pane drag signal ───────────────────────────────────────────────────
// When an item carrying our `application/x-aios-path` payload is dragged
// anywhere in the app, every pane's drop overlay should light up so the drop is
// captured ABOVE intercepting children (e.g. xterm's canvas). We broadcast a
// single app-wide "a path drag is in flight" boolean from window-level dnd
// events, and panes subscribe via `onAiosDrag`.

/** The dataTransfer type a draggable pane item must set to be droppable. */
export const AIOS_PATH_MIME = "application/x-aios-path";

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

// Wire the window-level listeners once. We arm the overlays whenever ANY drag
// enters the window — both in-app drags (Files pane → terminal) AND OS file
// drags (Finder → pane), since `dragDropEnabled:false` routes OS drops through
// the webview's native HTML5 layer. Gutter-resizes use mouse events (not HTML5
// dnd) so they never trip this.
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
