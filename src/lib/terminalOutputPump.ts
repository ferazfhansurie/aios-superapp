export interface TerminalOutputPumpOptions {
  write: (text: string, done: () => void) => void;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
  visibleDelayMs?: number;
  hiddenDelayMs?: number;
  immediateBytes?: number;
}

export interface TerminalOutputPump {
  push(chunk: string): void;
  setHidden(hidden: boolean): void;
  flush(): void;
  dispose(): void;
}

/** Serializes xterm parsing to one write at a time. Multiple busy panes can no
 * longer queue overlapping parser/layout work on the WebView main thread. */
export function createTerminalOutputPump({
  write,
  schedule,
  cancel,
  visibleDelayMs = 24,
  hiddenDelayMs = 240,
  immediateBytes = 64_000,
}: TerminalOutputPumpOptions): TerminalOutputPump {
  let pending: string[] = [];
  let pendingBytes = 0;
  let scheduled: unknown;
  let inFlight = false;
  let hidden = false;
  let disposed = false;

  const clearScheduled = () => {
    if (scheduled === undefined) return;
    cancel(scheduled);
    scheduled = undefined;
  };

  const scheduleFlush = () => {
    if (disposed || inFlight || scheduled !== undefined || pending.length === 0) return;
    scheduled = schedule(() => {
      scheduled = undefined;
      flush();
    }, hidden ? hiddenDelayMs : visibleDelayMs);
  };

  const flush = () => {
    clearScheduled();
    if (disposed || inFlight || pending.length === 0) return;
    const text = pending.join("");
    pending = [];
    pendingBytes = 0;
    inFlight = true;
    write(text, () => {
      if (disposed) return;
      inFlight = false;
      scheduleFlush();
    });
  };

  return {
    push(chunk) {
      if (disposed || !chunk) return;
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (!inFlight && pendingBytes >= immediateBytes) flush();
      else scheduleFlush();
    },
    setHidden(nextHidden) {
      if (hidden === nextHidden) return;
      hidden = nextHidden;
      if (scheduled !== undefined) {
        clearScheduled();
        scheduleFlush();
      }
    },
    flush,
    dispose() {
      disposed = true;
      clearScheduled();
      pending = [];
      pendingBytes = 0;
    },
  };
}
