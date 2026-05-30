/**
 * Compose box docked at the bottom of a terminal pane.
 *
 * Gives the terminal the affordances the GUI chat composer (ChatPane) has, so
 * driving a CLI AI (claude code, codex) in a real PTY isn't a poorer experience
 * than the chat surface. It is built to be visually + behaviourally
 * indistinguishable from ChatPane's composer:
 *   - a multi-line auto-growing textarea (Shift+Enter = newline; Enter or the
 *     send button writes the whole text to the PTY + a trailing CR)
 *   - voice dictation lands cleanly in the box — both the in-composer mic AND
 *     the global ⌘J (which App routes here via the `register` writer bridge,
 *     exactly like ChatPane). The composer owns NO global hotkey of its own, so
 *     ⌘J fires exactly once (App's single VoiceButton) — no double-fire jank.
 *   - image paste / drag-drop → shown as a removable THUMBNAIL chip; on send the
 *     shell-quoted temp path(s) are written to the PTY (so claude code can read
 *     them for vision), but the user SEES the image first.
 *   - a visible Stop button that sends Ctrl-C (^C) to interrupt the CLI
 *
 * Pure presentation + local state: all PTY effects flow through the `onSend` /
 * `onInterrupt` callbacks the pane passes down (which wrap ptyWrite).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ArrowUp,
  Image as ImageIcon,
  Loader2,
  Mic,
  Square,
  X,
} from "lucide-react";

import { saveImageTemp } from "../lib/fs";
import { dictateCancel, dictateStart, dictateStop } from "../lib/voice";

/** Shell-quote a path (single-quote wrap) when it has whitespace/quotes. */
function quotePath(path: string): string {
  return /[\s'"\\]/.test(path) ? `'${path.replace(/'/g, "'\\''")}'` : path;
}

/** Extension for a clipboard/file image mime, defaulting to png. */
function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("svg")) return "svg";
  if (m.includes("bmp")) return "bmp";
  return "png";
}

/** "0:05" from elapsed seconds. */
function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

let _imgSeq = 0;

/** A pasted/dropped image, shown as a thumbnail chip until send. */
interface ImageChip {
  id: string;
  /** object-URL for the live thumbnail preview. */
  url: string;
  /** saved temp-file path (shell-quoted on send); null while still saving. */
  path: string | null;
}

export function TerminalComposer({
  onSend,
  onInterrupt,
  onEscape,
  onClose,
  register,
}: {
  /** Write the composed text to the PTY (the pane appends the CR). */
  onSend: (text: string) => void;
  /** Send Ctrl-C (^C) to the PTY. */
  onInterrupt: () => void;
  /** Send ESC to the PTY — claude code: stop / double-Esc = edit previous. */
  onEscape: () => void;
  /** Hide the composer. */
  onClose: () => void;
  /**
   * Register an append-to-box writer with the pane (mirrors ChatPane). The pane
   * publishes this into `paneWriters` so the GLOBAL ⌘J dictation (App's single
   * VoiceButton) lands in THIS box — never in the PTY, never double-fired.
   */
  register?: (append: (text: string) => void) => void;
}) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<ImageChip[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // smooth auto-grow: 1 line → ~8 lines, then internal scroll. Reset to auto
  // first so it shrinks on delete too; cap matches ChatPane's calm feel.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  // focus on mount so the user can start typing immediately on toggle
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // revoke object-URLs on unmount so previews don't leak.
  useEffect(() => {
    return () => {
      for (const im of images) URL.revokeObjectURL(im.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // append text to the box at the caret (or end), keep focus. Shared by voice
  // (in-composer mic + global ⌘J via `register`) and path drops.
  const append = useCallback((t: string) => {
    const text = t.trim();
    if (!text) return;
    setValue((v) => (v ? v.replace(/\s*$/, "") + " " + text : text));
    taRef.current?.focus();
  }, []);

  // Publish the box-writer so App's global ⌘J dictation lands HERE (like
  // ChatPane). Without this the pane's PTY writer would catch ⌘J and the
  // transcript would bypass the box entirely.
  useEffect(() => {
    register?.(append);
  }, [register, append]);

  // save an image blob to a temp file; show it as a thumbnail chip immediately,
  // fill in its path when the save resolves.
  const addImage = useCallback(async (file: Blob, mime: string) => {
    const id = `img${++_imgSeq}`;
    const url = URL.createObjectURL(file);
    setImages((prev) => [...prev, { id, url, path: null }]);
    try {
      const buf = await file.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const b64 = btoa(bin);
      const path = await saveImageTemp(b64, extFromMime(mime));
      setImages((prev) =>
        prev.map((im) => (im.id === id ? { ...im, path } : im)),
      );
    } catch {
      // save failed → drop the chip (and its preview) rather than ship a broken ref
      setImages((prev) => {
        const gone = prev.find((im) => im.id === id);
        if (gone) URL.revokeObjectURL(gone.url);
        return prev.filter((im) => im.id !== id);
      });
    }
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const gone = prev.find((im) => im.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((im) => im.id !== id);
    });
  }, []);

  const savingImg = images.some((im) => im.path == null);

  const submit = useCallback(() => {
    const text = value.replace(/\s+$/, "");
    const paths = images
      .map((im) => im.path)
      .filter((p): p is string => !!p)
      .map(quotePath);
    if (!text && paths.length === 0) return;
    // image paths lead, then the prose — matches how you'd reference them in a
    // claude code prompt ("<path> describe this").
    const out = [...paths, text].filter(Boolean).join(" ");
    onSend(out);
    setValue("");
    for (const im of images) URL.revokeObjectURL(im.url);
    setImages([]);
  }, [value, images, onSend]);

  // ── in-composer voice (click-to-record). NO global hotkey here — that's
  //    App's single VoiceButton (⌘J), which routes into this box via `register`.
  //    This mic is just a visible, focus-preserving way to dictate from the box. ──
  type Phase = "idle" | "recording" | "transcribing";
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  useEffect(() => {
    if (phase !== "recording") return;
    setElapsed(0);
    const base = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - base) / 1000)), 250);
    return () => clearInterval(t);
  }, [phase]);

  const micStart = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    try {
      await dictateStart();
      setPhase("recording");
    } catch {
      setPhase("idle");
    }
  }, []);

  const micStop = useCallback(async () => {
    if (phaseRef.current !== "recording") return;
    setPhase("transcribing");
    try {
      const text = await dictateStop();
      if (text) append(text);
    } catch {
      /* swallow — best-effort dictation */
    } finally {
      setPhase("idle");
      taRef.current?.focus();
    }
  }, [append]);

  const micCancel = useCallback(async () => {
    if (phaseRef.current !== "recording") return;
    setPhase("idle");
    try {
      await dictateCancel();
    } catch {
      /* best-effort */
    }
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter → send (start generating now). Shift+Enter → newline for multi-line
    // prompts. ⌘/Ctrl+Enter also sends (they carry no shift).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    // Escape → if dictating, cancel that; else forward ESC to the PTY (claude
    // code: stop generating; press twice to edit the previous message).
    if (e.key === "Escape") {
      e.preventDefault();
      if (phaseRef.current === "recording") void micCancel();
      else onEscape();
    }
  };

  // paste an image off the clipboard → thumbnail chip (temp file saved in bg)
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) {
          e.preventDefault();
          void addImage(file, it.type);
          return;
        }
      }
    }
  };

  // drop onto the composer: an image file → thumbnail chip; a path dragged from
  // the Files pane → quoted + appended to the box text.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      let handled = false;
      for (const f of files) {
        if (f.type.startsWith("image/")) {
          void addImage(f, f.type);
          handled = true;
        }
      }
      if (handled) return;
    }
    const path =
      e.dataTransfer.getData("application/x-aios-path") ||
      e.dataTransfer.getData("text/plain");
    if (path) append(quotePath(path));
  };

  const hasContent = value.trim().length > 0 || images.some((im) => im.path);

  // dropEffect tweak: show "copy" while a drag is over the box.
  const dropHints = useMemo(
    () => ({
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dragOver) setDragOver(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget === e.target) setDragOver(false);
      },
      onDrop,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dragOver],
  );

  return (
    <div
      className="relative border-t border-[var(--color-border)] bg-[var(--color-bg)]/80 px-3 pb-3 pt-2.5 backdrop-blur"
      {...dropHints}
    >
      <div className="relative rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)]/70 shadow-2xl shadow-black/40 backdrop-blur transition-colors focus-within:border-[var(--color-accent)]/50">
        {/* image thumbnail chips (above the textarea) */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((im) => (
              <div
                key={im.id}
                className="group relative h-14 w-14 overflow-hidden rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel)]"
              >
                <img
                  src={im.url}
                  alt="attachment"
                  className="h-full w-full object-cover"
                />
                {im.path == null && (
                  <div className="absolute inset-0 grid place-items-center bg-[var(--color-bg)]/60">
                    <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeImage(im.id)}
                  title="remove"
                  className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-[var(--color-bg)]/80 text-[var(--color-muted)] opacity-0 transition-opacity hover:text-[var(--color-text)] group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          spellCheck={false}
          placeholder="compose a prompt — ↵ send · shift+↵ newline · paste an image"
          className="block w-full resize-none bg-transparent px-4 pt-3 pb-2 font-sans text-[14px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
        />

        <div className="flex items-center gap-1.5 px-3 pb-3 pt-1">
          {/* interrupt the running CLI (^C) without knowing the keystroke */}
          <button
            type="button"
            onClick={onInterrupt}
            title="interrupt (send Ctrl-C)"
            className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]/50 px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-danger)]/50 hover:text-[var(--color-danger)]"
          >
            <Square size={11} />
            <span>stop</span>
          </button>

          {savingImg && (
            <span className="flex items-center gap-1 font-sans text-[11px] text-[var(--color-faint)]">
              <ImageIcon size={12} /> saving…
            </span>
          )}

          <div className="flex-1" />

          {/* dismiss the composer */}
          <button
            type="button"
            onClick={onClose}
            title="hide composer"
            className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
          >
            <X size={15} />
          </button>

          {/* voice dictation — recording state shown inline (no global hotkey;
              ⌘J is App's single VoiceButton, routed into this box). */}
          {phase === "recording" ? (
            <button
              type="button"
              onClick={() => void micStop()}
              title="stop dictation (esc to cancel)"
              className="flex items-center gap-1.5 rounded-full border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2.5 py-1 font-mono text-[12px] tabular-nums text-[var(--color-text)] transition-colors hover:bg-[var(--color-danger)]/20"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-danger)] opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-danger)]" />
              </span>
              {fmtElapsed(elapsed)}
            </button>
          ) : phase === "transcribing" ? (
            <div className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-accent)]">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void micStart()}
              title="dictate (⌘J)"
              className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
            >
              <Mic size={16} />
            </button>
          )}

          {/* send → PTY + CR. accent when there's text/an image, dim when empty. */}
          <button
            type="button"
            onClick={submit}
            disabled={!hasContent}
            title="send to terminal (↵)"
            className="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-accent)] text-[var(--color-bg)] transition-all hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-panel)] disabled:text-[var(--color-faint)]"
          >
            <ArrowUp size={16} />
          </button>
        </div>

        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-[var(--color-accent)]/70 bg-[var(--color-accent)]/10">
            <span className="rounded-md bg-[var(--color-panel)]/90 px-3 py-1.5 font-sans text-[12px] text-[var(--color-text)]">
              drop image to attach
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
