/** Push-to-talk dictation control for the header (Codex-style compact bar).
 *
 *  Idle  → a mic icon button. CLICK to start recording (primary interaction);
 *          press-and-hold also works — release to stop.
 *  Rec   → a pulsing red dot + a mono elapsed timer + a stop affordance. Click
 *          (or release the hold, or press Enter) to stop; Esc cancels.
 *  Busy  → a spinner while whisper transcribes.
 *  On success → onTranscript(text). On error → a small inline toast, then reset.
 *
 *  Fully self-contained: owns its own recording/transcribing/error state and
 *  talks to the Rust `voice` commands directly. No external store. */
import { useCallback, useEffect, useRef, useState } from "react";

import { Loader2, Mic, Square } from "lucide-react";

import { dictateCancel, dictateStart, dictateStop } from "../lib/voice";

type Phase = "idle" | "recording" | "transcribing";

/** "0:05" from elapsed seconds. */
function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VoiceButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Distinguishes a click-toggle from a press-and-hold: if the pointer is held
  // down long enough, releasing it stops the recording (hold-to-talk). A quick
  // click leaves recording armed (click-to-toggle).
  const heldRef = useRef(false);
  const holdTimer = useRef<number | null>(null);
  const startedAt = useRef<number | null>(null);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  // Tick the elapsed timer while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    setElapsed(0);
    const base = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - base) / 1000)), 250);
    return () => clearInterval(t);
  }, [phase]);

  // Auto-clear the error toast.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  const begin = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    setError(null);
    try {
      await dictateStart();
      setPhase("recording");
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  }, []);

  const finish = useCallback(async () => {
    if (phaseRef.current !== "recording") return;
    setPhase("transcribing");
    try {
      const text = await dictateStop();
      if (text) onTranscript(text);
      else setError("nothing transcribed");
    } catch (e) {
      setError(String(e));
    } finally {
      setPhase("idle");
    }
  }, [onTranscript]);

  const abort = useCallback(async () => {
    if (phaseRef.current !== "recording") return;
    setPhase("idle");
    try {
      await dictateCancel();
    } catch {
      /* best-effort */
    }
  }, []);

  // Esc cancels an active recording.
  useEffect(() => {
    if (phase !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, abort]);

  // Global hotkey: ⌘J (Ctrl+J on Windows/Linux) toggles voice — a real chord, so
  // it won't misfire on ⌘-Shift combos (e.g. shift-tab) like the old binding did.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j" && !e.repeat) {
        e.preventDefault();
        if (phaseRef.current === "idle") void begin();
        else if (phaseRef.current === "recording") void finish();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [begin, finish]);

  // ── pointer handling: hold-to-talk vs click-to-toggle ──────────────────────
  const onPointerDown = useCallback(() => {
    if (phaseRef.current === "transcribing") return;
    if (phaseRef.current === "recording") return; // pointerup/click handles stop
    heldRef.current = false;
    startedAt.current = Date.now();
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    // After 350ms of holding, treat this as a press-and-hold gesture.
    holdTimer.current = window.setTimeout(() => {
      heldRef.current = true;
    }, 350);
    void begin();
  }, [begin]);

  const onPointerUp = useCallback(() => {
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    const wasHold = heldRef.current && startedAt.current && Date.now() - startedAt.current >= 350;
    heldRef.current = false;
    startedAt.current = null;
    // Hold gesture → release stops. Quick click → stays recording (toggle).
    if (wasHold && phaseRef.current === "recording") void finish();
  }, [finish]);

  // A click that lands while already recording = the toggle-stop. (pointerup on
  // a quick click leaves us recording; the ensuing click stops.)
  const onClick = useCallback(() => {
    if (phaseRef.current === "recording" && !heldRef.current) void finish();
  }, [finish]);

  // ── render ─────────────────────────────────────────────────────────────────
  if (phase === "recording") {
    return (
      <div className="relative flex items-center">
        <button
          onPointerUp={onPointerUp}
          onClick={onClick}
          title="stop dictation (esc to cancel)"
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2 py-1 text-[11px] text-[var(--color-text)] transition-colors hover:bg-[var(--color-danger)]/20"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-danger)] opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-danger)]" />
          </span>
          <span className="font-mono tabular-nums text-[12px] text-[var(--color-text)]">
            {fmtElapsed(elapsed)}
          </span>
          <Square size={11} className="text-[var(--color-muted)]" fill="currentColor" />
        </button>
      </div>
    );
  }

  if (phase === "transcribing") {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1 text-[11px] text-[var(--color-muted)]">
        <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
        <span>transcribing…</span>
      </div>
    );
  }

  // idle
  return (
    <div className="relative flex items-center">
      <button
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        title="dictate (click to start, hold to talk)"
        className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 text-[var(--color-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
      >
        <Mic size={13} />
      </button>
      {error && (
        <div className="absolute right-0 top-full z-50 mt-1 max-w-[220px] whitespace-normal rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-panel)] px-2 py-1 text-[11px] text-[var(--color-danger)] shadow-lg">
          {error}
        </div>
      )}
    </div>
  );
}
