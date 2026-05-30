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
}

/** Live ChatPanes keyed by pane key — lets App intercept close on a busy chat. */
export const chatHandles = new Map<string, ChatHandle>();

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
