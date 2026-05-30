/** Lightweight registry so cross-cutting features (voice dictation, drops) can
 *  inject text into a specific terminal pane's PTY. Each TerminalPane registers
 *  a writer keyed by its pane key; App tracks which pane is focused. */
export const paneWriters = new Map<string, (text: string) => void>();

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
