/**
 * Compose box docked at the bottom of a terminal pane.
 *
 * Gives the terminal the affordances the GUI chat composer (ChatPane) has, so
 * driving a CLI AI (claude code, codex) in a real PTY isn't a poorer experience
 * than the chat surface:
 *   - a multi-line textarea so you can write long, structured prompts without
 *     fighting claude code's inline TUI (Shift+Enter = newline; ⌘/Ctrl+Enter or
 *     the Send button writes the whole text to the PTY + a trailing CR)
 *   - voice dictation (reuses VoiceButton → whisper) lands straight in the box
 *   - image paste / drag-drop → saved to a temp file, its shell-quoted path
 *     inserted into the box (so claude code can read it for vision)
 *   - a visible Stop button that sends Ctrl-C (^C) to interrupt the CLI
 *
 * Pure presentation + local state: all PTY effects flow through the `onSend` /
 * `onInterrupt` callbacks the pane passes down (which wrap ptyWrite).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { CornerDownLeft, Image as ImageIcon, Square, X } from "lucide-react";

import { saveImageTemp } from "../lib/fs";
import { VoiceButton } from "./VoiceButton";

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

export function TerminalComposer({
  onSend,
  onInterrupt,
  onClose,
}: {
  /** Write the composed text to the PTY (the pane appends the CR). */
  onSend: (text: string) => void;
  /** Send Ctrl-C (^C) to the PTY. */
  onInterrupt: () => void;
  /** Hide the composer. */
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [savingImg, setSavingImg] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // autosize the textarea (cap so it never eats the whole pane)
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

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    onSend(value.replace(/\s+$/, ""));
    setValue("");
  }, [value, onSend]);

  // append text to the box (shared by voice + image-path insertion)
  const append = useCallback((t: string) => {
    setValue((v) => (v ? v.replace(/\s*$/, "") + " " + t : t));
    taRef.current?.focus();
  }, []);

  // save an image blob to a temp file and drop its shell-quoted path in the box
  const insertImage = useCallback(
    async (file: Blob, mime: string) => {
      setSavingImg(true);
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
        append(quotePath(path));
      } catch {
        /* best-effort: a failed save just inserts nothing */
      } finally {
        setSavingImg(false);
      }
    },
    [append],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter → send (start generating now). Shift+Enter → newline for multi-line
    // prompts. ⌘/Ctrl+Enter also sends (they carry no shift).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // paste an image off the clipboard → temp file → path in the box
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) {
          e.preventDefault();
          void insertImage(file, it.type);
          return;
        }
      }
    }
  };

  // drop an image file onto the composer → temp file → path in the box
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      for (const f of files) {
        if (f.type.startsWith("image/")) {
          void insertImage(f, f.type);
          return;
        }
      }
    }
    // a non-image drop (e.g. a path dragged from the Files pane) → quote + insert
    const path =
      e.dataTransfer.getData("application/x-aios-path") ||
      e.dataTransfer.getData("text/plain");
    if (path) append(quotePath(path));
  };

  return (
    <div
      className="relative border-t border-[var(--color-border)] bg-[var(--color-panel)]/95 p-2 backdrop-blur"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)]/70 shadow-lg shadow-black/30 transition-colors focus-within:border-[var(--color-accent)]/50">
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          spellCheck={false}
          placeholder="compose a prompt — ↵ to send · shift+↵ newline · paste/drop an image"
          className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1.5 font-sans text-[13.5px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2 pt-0.5">
          {/* voice dictation → composer (same whisper path the chat uses) */}
          <VoiceButton onTranscript={(t) => append(t.trim())} />

          {/* interrupt the running CLI (^C) without knowing the keystroke */}
          <button
            type="button"
            onClick={onInterrupt}
            title="interrupt (send Ctrl-C)"
            className="flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]/50 px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-red)]/50 hover:text-[var(--color-red)]"
          >
            <Square size={12} />
            <span>stop</span>
          </button>

          {savingImg && (
            <span className="flex items-center gap-1 font-sans text-[11px] text-[var(--color-faint)]">
              <ImageIcon size={12} /> saving image…
            </span>
          )}

          <div className="flex-1" />

          {/* dismiss the composer */}
          <button
            type="button"
            onClick={onClose}
            title="hide composer"
            className="rounded p-1 text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            <X size={14} />
          </button>

          {/* send → PTY + CR */}
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            title="send to terminal (↵)"
            className="flex items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-3 py-1 font-sans text-[12px] text-[var(--color-bg)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span>send</span>
            <CornerDownLeft size={13} />
          </button>
        </div>
      </div>

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl border-2 border-dashed border-[var(--color-accent)]/70 bg-[var(--color-accent)]/10">
          <span className="rounded-md bg-[var(--color-panel)]/90 px-3 py-1.5 text-[12px] text-[var(--color-text)]">
            drop image → insert path
          </span>
        </div>
      )}
    </div>
  );
}
