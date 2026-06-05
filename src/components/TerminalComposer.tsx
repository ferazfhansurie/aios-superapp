/**
 * Compose box docked at the bottom of a terminal pane.
 *
 * Built to look + behave like the AIOS **chat pane composer** (ChatPane) — the
 * same `/` slash menu, the same `@` file-mention picker, the same bottom pill
 * row, the same tokens/spacing — so driving a CLI AI (claude code, codex) in a
 * real PTY isn't a poorer experience than the headless chat surface.
 *
 * CRITICAL difference from ChatPane: this composer drives a RAW PTY (claude
 * code's TUI), NOT the chat's headless `claude -p`. So we MATCH the chat
 * composer's look exactly, but every control routes to claude code's PTY
 * equivalent — slash commands are TYPED INTO claude code's own TUI, pills send
 * the keystrokes claude code understands. Each control's real effect is spelled
 * out honestly in the code below; chat-only concepts with no TUI equivalent
 * (effort / persistent goal) are OMITTED rather than faked.
 *
 * What's matched from ChatPane's composer:
 *   - `/` slash menu (OverlayPanel/OverlayRow style): /clear /plan /resume
 *     /model /help — type `/` at the start, arrow/enter to pick, filters as you
 *     type. Each ROUTES to claude code's PTY (see SLASH mapping below).
 *   - `@` file-mention picker sourced from the pane's cwd (readDir), inserts the
 *     quoted path into the box — mirrors ChatPane's @ picker.
 *   - bottom pill row: `+` add files, a "full access" permission pill, a "plan"
 *     pill, a model pill ("opus 4.8" ▾). permission + plan + model all send the
 *     keystrokes claude code uses; effort + persistent-goal pills are omitted
 *     (no TUI equivalent — see note on the pill row).
 *
 * QoL kept / added:
 *   - ↑ history recall: arrow-up through previously SENT prompts, edit + resend.
 *   - the capture-phase focus guard (printable keys re-target the composer after
 *     a terminal scroll moves keyboard focus to xterm).
 *   - image thumbnail chips + saveImageTemp (paste / drag-drop / picker).
 *   - voice: in-composer mic (click-to-record → inline waveform + timer →
 *     transcript lands in the box) AND the global ⌘J bridge via `register`.
 *   - `+` attach menu, auto-grow, Enter=send, Shift+Enter=newline, Esc→onEscape.
 *
 * claude code PTY mapping (raw bytes via `onRaw`, which writes straight to the
 * PTY with NO auto-CR):
 *   /clear  → ^U (\x15, clear claude's input line) then "/clear\r"
 *   /model  → "/model\r"  (opens claude code's own model picker in the TUI)
 *   /resume → "/resume\r"
 *   /help   → "/help\r"
 *   /plan   → \x1b[Z (Shift+Tab — claude code cycles its mode, incl. plan mode).
 *             claude code has no literal "/plan" command; Shift+Tab is the real
 *             plan-mode toggle, so that's what the menu item + pill send.
 *   model pill       → "/model\r"
 *   permission pill  → \x1b[Z (Shift+Tab — claude code cycles permission/mode).
 *                      claude code's permission state is driven by Shift+Tab, not
 *                      a stable command, so the pill cycles it; the label is
 *                      generic ("permissions") since we can't read claude's
 *                      current mode back from the raw PTY.
 *   plan pill        → \x1b[Z (same Shift+Tab cycle as the /plan item).
 *
 * Pure presentation + local state: all PTY effects flow through the
 * `onSend` / `onRaw` / `onInterrupt` / `onEscape` callbacks the pane passes down
 * (which wrap ptyWrite).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ArrowUp,
  ChevronDown,
  CornerDownLeft,
  FileText,
  Folder,
  HelpCircle,
  History,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Mic,
  PackageOpen,
  Plus,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";

import { gitStatus, readDir, saveImageTemp, type DirEntry } from "../lib/fs";
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

/** basename of a path, for the context chip + @-mention labels. */
function baseName(p: string): string {
  const cleaned = p.replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

let _imgSeq = 0;

/** A pasted/dropped/picked image, shown as a thumbnail chip until send. */
interface ImageChip {
  id: string;
  /** object-URL for the live thumbnail preview. */
  url: string;
  /** saved temp-file path (shell-quoted on send); null while still saving. */
  path: string | null;
}

// ── slash menu (matches ChatPane's `/` overlay) ──────────────────────────────
// Each command ROUTES to claude code's own TUI via raw PTY bytes — these are not
// AIOS-side actions like in ChatPane, they're the keystrokes you'd type in
// claude code. The `effect` strings below are the literal byte sequences.
interface SlashCommand {
  id: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
}

export function TerminalComposer({
  onSend,
  onRaw,
  onInterrupt,
  onEscape,
  onClose,
  register,
  cwd,
  liveMode,
  liveModel,
  liveCtxPct,
}: {
  /** Write the composed text to the PTY (the pane appends the CR). */
  onSend: (text: string) => void;
  /**
   * Write RAW bytes straight to the PTY — NO auto-CR, NO quoting. Drives claude
   * code's own TUI controls (slash commands, ^U line-clear, Shift+Tab cycle).
   * Optional so the composer degrades gracefully if a pane doesn't wire it.
   */
  onRaw?: (bytes: string) => void;
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
  /** Working directory for this pane — drives the context bar + @-mention picker. */
  cwd?: string;
  /** claude-code's live mode, parsed from its TUI by TerminalPane (e.g. "full
   *  access" / "plan" / "accept edits"). Reflects the pill instead of a generic
   *  label; undefined until first parsed. */
  liveMode?: string;
  /** claude-code's live model, parsed from its TUI (e.g. "Opus 4.8"). */
  liveModel?: string;
  /** claude-code's "% context left", parsed from its TUI (0–100). */
  liveCtxPct?: number;
}) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<ImageChip[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  // armed after /handoff fires — shows the one-tap "clear + start fresh" banner.
  const [handoffArmed, setHandoffArmed] = useState(false);

  // Tap-2 of the handoff flow: clear claude's context, then seed it to read the
  // freshly-written handoff doc and continue — a clean fresh session in-place.
  const finishHandoff = useCallback(() => {
    const raw = onRaw;
    raw?.("\x15");
    raw?.("/clear\r");
    // R6: drop the resume prompt as a BRACKETED paste with a real Enter OUTSIDE
    // the paste brackets, all in one write. The `\x1b[201~` terminator closes
    // the paste so the trailing \r is a genuine submit — no longer relying on
    // 600ms/150ms setTimeouts to win the dual-enter race (which broke on a loaded
    // machine: the \r could land inside the paste → newline, prompt sits unsent).
    // A small delay still lets the prior /clear settle before the paste arrives.
    const PROMPT =
      "read HANDOFF-SESSION.md (this repo, else ~/.aios/state/handoffs/ newest) and continue exactly where the last session left off";
    setTimeout(() => {
      raw?.(`\x1b[200~${PROMPT}\x1b[201~\r`);
    }, 250);
    setHandoffArmed(false);
  }, [onRaw]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const plusWrapRef = useRef<HTMLDivElement>(null);

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

  // ── slash + @ overlay state (mirrors ChatPane) ─────────────────────────────
  const [overlay, setOverlay] = useState<null | "slash" | "mention">(null);
  const [overlayIdx, setOverlayIdx] = useState(0);
  const [mentionItems, setMentionItems] = useState<DirEntry[]>([]);
  const [mentionQuery, setMentionQuery] = useState("");

  // ── sent-prompt history (↑ recall) ─────────────────────────────────────────
  // Every SENT prompt is pushed here (newest last). ArrowUp on an empty/at-start
  // caret walks back through them so you can edit + resend; ArrowDown walks
  // forward, and past the newest restores the draft you were typing.
  const [history, setHistory] = useState<string[]>([]);
  // -1 = not browsing history (live draft). 0..n-1 indexes from newest.
  const histIdxRef = useRef(-1);
  // the in-progress draft stashed when you first arrow up into history.
  const histDraftRef = useRef("");

  const resetHistoryNav = useCallback(() => {
    histIdxRef.current = -1;
    histDraftRef.current = "";
  }, []);

  // ── type-to-focus guard (P0) ───────────────────────────────────────────────
  // Scrolling the xterm (or entering tmux copy-mode) moves keyboard focus to the
  // terminal, so keys go to the PTY instead of this box — the user can't type
  // until they click back in. Fix: while the composer is mounted, watch
  // window keydown (capture, so we see it before xterm's handler). If a BARE
  // printable key is pressed while focus isn't already on a text field / modal,
  // we steal it: focus the textarea and route that first character in (so it's
  // not dropped). Only single-character keys with no ctrl/meta/alt are
  // redirected — Enter/Esc/Tab/arrows/function keys and every control combo pass
  // straight through to the terminal, so deliberate terminal interaction (incl.
  // ⌘-hotkeys, ^C, scrolling) is never hijacked.
  useEffect(() => {
    const onKeyCapture = (e: KeyboardEvent) => {
      // only bare printable characters (length-1 keys: letters/digits/punct/space)
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return;

      const ta = taRef.current;
      if (!ta) return;
      const active = document.activeElement as HTMLElement | null;

      // already typing into our box → let the textarea handle it natively.
      if (active === ta) return;
      // another genuine text-entry surface or a modal owns focus → don't steal.
      if (active) {
        const tag = active.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          active.isContentEditable ||
          active.closest('[role="dialog"], [role="menu"], [aria-modal="true"]')
        ) {
          return;
        }
      }

      // focus drifted to the terminal (or nothing) → reclaim it and don't drop
      // this character. Insert at the caret so it lands seamlessly.
      e.preventDefault();
      e.stopPropagation();
      const ch = e.key;
      ta.focus();
      setValue((v) => {
        const start = ta.selectionStart ?? v.length;
        const end = ta.selectionEnd ?? v.length;
        const next = v.slice(0, start) + ch + v.slice(end);
        // restore the caret after React applies the new value
        requestAnimationFrame(() => {
          const pos = start + ch.length;
          try {
            ta.setSelectionRange(pos, pos);
          } catch {
            /* element may have remounted */
          }
        });
        return next;
      });
    };
    // capture phase: beat xterm's own key handling to the keystroke.
    window.addEventListener("keydown", onKeyCapture, true);
    return () => window.removeEventListener("keydown", onKeyCapture, true);
  }, []);

  // ── bottom context bar (cwd / repo) ────────────────────────────────────────
  // Resolve a friendly label for this pane: prefer the git repo's basename,
  // else the cwd basename. Branch is intentionally skipped — the existing
  // backend exposes the repo root but not the branch, and the design says show
  // the basename rather than block on a branch lookup.
  const [repoLabel, setRepoLabel] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!cwd) {
      setRepoLabel(null);
      return;
    }
    // optimistic: cwd basename now, upgrade to the repo root basename if we're
    // inside a git repo.
    setRepoLabel(baseName(cwd));
    gitStatus(cwd)
      .then((st) => {
        if (alive && st.root) setRepoLabel(baseName(st.root));
      })
      .catch(() => {
        /* not a repo / no git → keep the cwd basename */
      });
    return () => {
      alive = false;
    };
  }, [cwd]);

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

  // ── "+" menu: add photos & files ───────────────────────────────────────────
  // No Tauri dialog plugin here, so we drive a hidden <input type=file>. Images
  // become thumbnail chips (vision-ready temp paths on send); other files have
  // their path quoted + appended to the prompt text. In the Tauri webview a
  // picked File carries an absolute `.path` (non-standard but present); we fall
  // back to the name if it's ever missing.
  const onPickFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      for (const f of files) {
        if (f.type.startsWith("image/")) {
          void addImage(f, f.type);
        } else {
          const p = (f as File & { path?: string }).path ?? f.name;
          append(quotePath(p));
        }
      }
    },
    [addImage, append],
  );

  // close the "+" menu on any outside click.
  useEffect(() => {
    if (!plusOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!plusWrapRef.current?.contains(e.target as Node)) setPlusOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [plusOpen]);

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
    // remember this prompt for ↑ recall (skip empty / exact-dup of the last one)
    if (text) {
      setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
    }
    resetHistoryNav();
    setValue("");
    setOverlay(null);
    for (const im of images) URL.revokeObjectURL(im.url);
    setImages([]);
  }, [value, images, onSend, resetHistoryNav]);

  // ── in-composer voice (click-to-record). NO global hotkey here — that's
  //    App's single VoiceButton (⌘J), which routes into this box via `register`.
  //    This mic is just a visible, focus-preserving way to dictate from the box.
  //    While recording, the input row swaps to an inline waveform + timer. ──
  type Phase = "idle" | "recording" | "transcribing";
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  // hands-free: when a dictation finishes we set this, then an effect on `value`
  // fires submit() once the appended transcript has actually landed in state
  // (can't submit in micStop's tick — `value` is still stale there).
  const autoSendRef = useRef(false);

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
      if (text) {
        append(text);
        // hands-free: send as soon as the transcript lands (see autoSendRef).
        autoSendRef.current = true;
      }
    } catch {
      /* swallow — best-effort dictation */
    } finally {
      setPhase("idle");
      taRef.current?.focus();
    }
  }, [append]);

  // auto-send the dictated transcript once `value` reflects the append. Guarded
  // by autoSendRef so ordinary typing never triggers it; cleared before submit
  // so it fires exactly once per dictation.
  useEffect(() => {
    if (!autoSendRef.current) return;
    if (!value.trim()) return;
    autoSendRef.current = false;
    submit();
  }, [value, submit]);

  const micCancel = useCallback(async () => {
    if (phaseRef.current !== "recording") return;
    setPhase("idle");
    try {
      await dictateCancel();
    } catch {
      /* best-effort */
    }
  }, []);

  // ── slash commands + @ mentions ────────────────────────────────────────────

  const slashCommands = useMemo<SlashCommand[]>(
    () => [
      {
        id: "clear",
        label: "/clear",
        desc: "clear claude's context (sends /clear)",
        icon: <RefreshCw size={14} />,
      },
      {
        id: "plan",
        label: "/plan",
        desc: "toggle plan mode (Shift+Tab)",
        icon: <ListChecks size={14} />,
      },
      {
        id: "resume",
        label: "/resume",
        desc: "reopen a past conversation (sends /resume)",
        icon: <History size={14} />,
      },
      {
        id: "model",
        label: "/model",
        desc: "switch the model (opens claude's picker)",
        icon: <Sparkles size={14} />,
      },
      {
        id: "handoff",
        label: "/handoff",
        desc: "package session → then one tap to clear + start fresh",
        icon: <PackageOpen size={14} />,
      },
      {
        id: "help",
        label: "/help",
        desc: "claude code help (sends /help)",
        icon: <HelpCircle size={14} />,
      },
    ],
    [],
  );

  // Route a slash command to claude code's PTY. These are TYPED INTO claude
  // code's own TUI — not AIOS-side actions. ^U (\x15) first clears whatever
  // claude has on its input line so the command lands clean.
  const runSlash = useCallback(
    (id: string) => {
      const raw = onRaw;
      switch (id) {
        case "clear":
          // clear claude's input line, then send /clear, then clear OUR box too
          raw?.("\x15");
          raw?.("/clear\r");
          break;
        case "model":
          raw?.("\x15");
          raw?.("/model\r");
          break;
        case "resume":
          raw?.("\x15");
          raw?.("/resume\r");
          break;
        case "help":
          raw?.("\x15");
          raw?.("/help\r");
          break;
        case "plan":
          // claude code has no literal "/plan" command — Shift+Tab cycles its
          // mode (incl. plan mode). Send that escape sequence.
          raw?.("\x1b[Z");
          break;
        case "handoff":
          // fire the AIOS /handoff skill in claude code's TUI to package the
          // session, then ARM the two-tap "clear + start fresh" affordance (we
          // can't detect when handoff finishes, so the user taps once it's done).
          raw?.("\x15");
          raw?.("/handoff\r");
          setHandoffArmed(true);
          break;
      }
      setValue("");
      setOverlay(null);
      taRef.current?.focus();
    },
    [onRaw],
  );

  // load dir entries for the @-mention picker (lazy, on first open). Mirrors
  // ChatPane: dirs first, capped, filtered by the typed token.
  const loadMentions = useCallback(async () => {
    const root = cwd;
    if (!root) {
      setMentionItems([]);
      return;
    }
    try {
      const entries = await readDir(root);
      entries.sort((a, b) =>
        a.is_dir === b.is_dir
          ? a.name.localeCompare(b.name)
          : a.is_dir
            ? -1
            : 1,
      );
      setMentionItems(entries.slice(0, 200));
    } catch {
      setMentionItems([]);
    }
  }, [cwd]);

  // detect `/word` at the very start, or an `@token` under the caret → overlay.
  const syncOverlay = useCallback(
    (next: string) => {
      if (/^\/[a-z]*$/i.test(next)) {
        setOverlay("slash");
        setOverlayIdx(0);
        return;
      }
      const m = next.match(/(?:^|\s)@([^\s]*)$/);
      if (m) {
        setMentionQuery(m[1] ?? "");
        if (overlay !== "mention") {
          setOverlay("mention");
          setOverlayIdx(0);
          void loadMentions();
        }
        return;
      }
      if (overlay) setOverlay(null);
    },
    [overlay, loadMentions],
  );

  const onChangeValue = (next: string) => {
    setValue(next);
    // any manual edit drops you out of history navigation
    if (histIdxRef.current !== -1) resetHistoryNav();
    syncOverlay(next);
  };

  const slashFiltered = useMemo(() => {
    const q = value.replace(/^\//, "").toLowerCase();
    return slashCommands.filter((c) => c.id.startsWith(q) || q === "");
  }, [value, slashCommands]);

  const mentionFiltered = useMemo(() => {
    const q = mentionQuery.toLowerCase();
    if (!q) return mentionItems;
    return mentionItems.filter((e) => e.name.toLowerCase().includes(q));
  }, [mentionItems, mentionQuery]);

  const pickMention = useCallback((entry: DirEntry) => {
    // insert the QUOTED absolute path (claude code reads it as a real file ref),
    // replacing the @token the user was typing.
    const quoted = quotePath(entry.path) + (entry.is_dir ? "/" : "") + " ";
    setValue((v) => v.replace(/(^|\s)@([^\s]*)$/, `$1${quoted}`));
    setOverlay(null);
    taRef.current?.focus();
  }, []);

  // ── keyboard ───────────────────────────────────────────────────────────────

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ── TUI driver (P0) ────────────────────────────────────────────────────
    // When the box is EMPTY and no overlay is open, route navigation keys
    // straight to the PTY so you can drive a TUI (claude code's model picker, a
    // menu, vim, less, fzf …) from the composer instead of having to click into
    // the terminal. Arrows → CSI sequences, Enter → CR, Tab → HT, Esc handled
    // below. The moment there's text in the box, this yields to normal editing +
    // history recall, so composing a message is never hijacked.
    if (!overlay && value.length === 0 && onRaw) {
      const seq: Record<string, string> = {
        ArrowUp: "\x1b[A",
        ArrowDown: "\x1b[B",
        ArrowRight: "\x1b[C",
        ArrowLeft: "\x1b[D",
        Tab: "\t",
        Enter: "\r",
      };
      const bytes = seq[e.key];
      // don't steal modified combos (⌘/⌥/^) or Shift+Enter (newline in box).
      if (bytes && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        onRaw(bytes);
        return;
      }
    }

    // overlay navigation takes priority (slash + @ menus).
    if (overlay) {
      const list = overlay === "slash" ? slashFiltered : mentionFiltered;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOverlayIdx((i) => (list.length ? (i + 1) % list.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setOverlayIdx((i) =>
          list.length ? (i - 1 + list.length) % list.length : 0,
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOverlay(null);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && list.length) {
        e.preventDefault();
        if (overlay === "slash") runSlash(slashFiltered[overlayIdx].id);
        else pickMention(mentionFiltered[overlayIdx]);
        return;
      }
    }

    // ↑ history recall: only when no overlay is open and the caret is at the
    // very start of the box (so ↑ still moves the caret within multi-line text).
    if (e.key === "ArrowUp" && !e.shiftKey && history.length > 0) {
      const ta = taRef.current;
      const atStart = ta != null && ta.selectionStart === 0 && ta.selectionEnd === 0;
      if (atStart) {
        e.preventDefault();
        if (histIdxRef.current === -1) histDraftRef.current = value;
        const ni = Math.min(histIdxRef.current + 1, history.length - 1);
        histIdxRef.current = ni;
        setValue(history[history.length - 1 - ni]);
        setOverlay(null);
        return;
      }
    }
    if (e.key === "ArrowDown" && !e.shiftKey && histIdxRef.current !== -1) {
      const ta = taRef.current;
      const atEnd = ta != null && ta.selectionStart === value.length;
      if (atEnd) {
        e.preventDefault();
        const ni = histIdxRef.current - 1;
        if (ni < 0) {
          histIdxRef.current = -1;
          setValue(histDraftRef.current);
        } else {
          histIdxRef.current = ni;
          setValue(history[history.length - 1 - ni]);
        }
        return;
      }
    }

    // Enter → send. Shift+Enter → newline. ⌘/Ctrl+Enter also sends.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    // Escape → if dictating, cancel; else forward ESC to the PTY (claude code:
    // stop generating; twice = edit the previous message).
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
  const recording = phase === "recording";

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
      {/* keyframe for the inline recording waveform — kept local so the composer
          stays self-contained (no global stylesheet edit). */}
      <style>{WAVE_KEYFRAMES}</style>

      {/* handoff two-tap banner: appears after /handoff fires; one tap clears +
          starts the fresh session in-place (reads the new handoff doc). */}
      {handoffArmed && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-3 py-2">
          <PackageOpen size={15} className="shrink-0 text-[var(--color-accent)]" />
          <span className="min-w-0 flex-1 text-[12px] text-[var(--color-text-2)]">
            handoff packaged? clear context + start the fresh session
          </span>
          <button
            type="button"
            onClick={finishHandoff}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-bg)] transition-all hover:brightness-110 active:scale-95"
          >
            <Rocket size={13} />
            clear + start fresh
          </button>
          <button
            type="button"
            onClick={() => setHandoffArmed(false)}
            title="dismiss"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* slash / @-mention overlay — sits just above the box, ChatPane styling */}
      {overlay === "slash" && slashFiltered.length > 0 && (
        <OverlayPanel>
          {slashFiltered.map((c, i) => (
            <OverlayRow
              key={c.id}
              active={i === overlayIdx}
              onMouseEnter={() => setOverlayIdx(i)}
              onClick={() => runSlash(c.id)}
              icon={c.icon}
              label={c.label}
              desc={c.desc}
            />
          ))}
        </OverlayPanel>
      )}
      {overlay === "mention" && (
        <OverlayPanel>
          {!cwd ? (
            <div className="px-3 py-2 font-mono text-[11.5px] text-[var(--color-faint)]">
              no working directory for this pane
            </div>
          ) : mentionFiltered.length === 0 ? (
            <div className="px-3 py-2 font-mono text-[11.5px] text-[var(--color-faint)]">
              no matches in {baseName(cwd)}
            </div>
          ) : (
            mentionFiltered.slice(0, 50).map((e, i) => (
              <OverlayRow
                key={e.path}
                active={i === overlayIdx}
                onMouseEnter={() => setOverlayIdx(i)}
                onClick={() => pickMention(e)}
                icon={
                  e.is_dir ? (
                    <Folder size={14} className="text-[var(--color-accent)]" />
                  ) : (
                    <FileText size={14} className="text-[var(--color-muted)]" />
                  )
                }
                label={e.name}
                desc={e.is_dir ? "dir" : ""}
                mono
              />
            ))
          )}
        </OverlayPanel>
      )}

      <div className="flash-composer group/composer relative overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-gradient-to-b from-[var(--color-panel-2)]/80 to-[var(--color-panel-2)]/55 shadow-2xl shadow-black/40 backdrop-blur transition-all duration-300 focus-within:border-[var(--color-accent)]/60 focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_50%,transparent),0_18px_50px_-12px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]">
        {/* accent sheen sweeping the top edge when focused */}
        <span className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-gradient-to-r from-transparent via-[var(--color-accent)] to-transparent opacity-0 transition-opacity duration-500 group-focus-within/composer:opacity-80" />
        {/* hidden file input driving the "+" → Add photos & files */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            onPickFiles(e.target.files);
            e.target.value = "";
          }}
        />

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

        {/* input row — textarea, OR the inline recording waveform while dictating */}
        {recording ? (
          <div className="flex items-center gap-3 px-4 pt-4 pb-2">
            {/* animated equalizer-style waveform spanning the width (time-keyed,
                no audio analysis). */}
            <div className="flex h-7 flex-1 items-center gap-[3px] overflow-hidden">
              {WAVEFORM_BARS.map((b, i) => (
                <span
                  key={i}
                  className="w-[3px] shrink-0 origin-center rounded-full bg-[var(--color-accent)]"
                  style={{
                    height: `${b.h}%`,
                    animation: "aios-wave 0.9s ease-in-out infinite",
                    animationDelay: `${b.delay}ms`,
                  }}
                />
              ))}
            </div>
            <span className="font-mono text-[12px] tabular-nums text-[var(--color-text)]">
              {fmtElapsed(elapsed)}
            </span>
            <button
              type="button"
              onClick={() => void micStop()}
              title="stop dictation (esc to cancel)"
              className="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-accent)] text-[var(--color-bg)] transition-colors hover:bg-[var(--color-accent-hover)]"
            >
              <Square size={14} className="fill-current" />
            </button>
          </div>
        ) : (
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => onChangeValue(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            spellCheck={false}
            placeholder="Do anything"
            className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 font-sans text-[15px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:outline-none"
          />
        )}

        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pt-1">
          {/* "+" → add photos & files */}
          <div ref={plusWrapRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setPlusOpen((o) => !o)}
              title="add photos & files"
              className={`grid h-8 w-8 place-items-center rounded-full border transition-colors ${
                plusOpen
                  ? "border-[var(--color-accent)]/50 bg-[var(--color-accent-soft)] text-[var(--color-text)]"
                  : "border-[var(--color-border)] bg-[var(--color-panel)]/50 text-[var(--color-text-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
              }`}
            >
              <Plus size={16} />
            </button>
            {plusOpen && (
              <div className="absolute bottom-full left-0 z-20 mb-2 min-w-[180px] overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] shadow-2xl shadow-black/50 backdrop-blur">
                <button
                  type="button"
                  onClick={() => {
                    setPlusOpen(false);
                    fileInputRef.current?.click();
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left font-sans text-[13px] text-[var(--color-text)] transition-colors hover:bg-[var(--color-panel)]"
                >
                  <ImageIcon size={15} className="text-[var(--color-muted)]" />
                  <span>Add photos &amp; files</span>
                </button>
              </div>
            )}
          </div>

          {/* permission pill — claude code's permission/mode state is driven by
              Shift+Tab (no stable command to read it back from a raw PTY), so
              this CYCLES it. Label is generic since we can't reflect the live
              mode. */}
          <button
            type="button"
            onClick={() => onRaw?.("\x1b[Z")}
            title="cycle claude permission mode (Shift+Tab)"
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-sans text-[11.5px] transition-colors ${
              liveMode && liveMode !== "ask each time"
                ? "border-[var(--color-accent)]/50 bg-[var(--color-accent-soft)] text-[var(--color-text)]"
                : "border-[var(--color-border)] bg-[var(--color-panel)]/50 text-[var(--color-text-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
            }`}
          >
            <ShieldCheck
              size={13}
              className={
                liveMode && liveMode !== "ask each time"
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-muted)]"
              }
            />
            <span>{liveMode ?? "permissions"}</span>
            <ChevronDown size={12} className="text-[var(--color-faint)]" />
          </button>

          {/* plan pill — same Shift+Tab cycle (claude code's plan mode lives on
              that cycle; there's no literal /plan command). */}
          <button
            type="button"
            onClick={() => onRaw?.("\x1b[Z")}
            title="toggle plan mode (Shift+Tab)"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]/50 px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
          >
            <ListChecks size={13} />
            <span>plan</span>
          </button>

          {/* model pill — opens claude code's own model picker (/model). We can't
              read claude's current model back from the raw PTY, so the label is
              generic rather than a faked "opus 4.8". */}
          <button
            type="button"
            onClick={() => {
              onRaw?.("\x15");
              onRaw?.("/model\r");
            }}
            title="switch model (opens claude's picker)"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]/50 px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
          >
            <Sparkles size={13} className="text-[var(--color-muted)]" />
            <span>{liveModel ?? "model"}</span>
            <ChevronDown size={12} className="text-[var(--color-faint)]" />
          </button>

          {/* live context-left meter, parsed from claude code's TUI */}
          {liveCtxPct != null && (
            <span
              title="context remaining (from claude code)"
              className={`hidden shrink-0 items-center gap-1 font-mono text-[10.5px] tabular-nums sm:flex ${
                liveCtxPct <= 15
                  ? "text-[var(--color-danger)]"
                  : "text-[var(--color-faint)]"
              }`}
            >
              {liveCtxPct}% ctx
            </span>
          )}

          {/* interrupt the running CLI (^C) */}
          <button
            type="button"
            onClick={onInterrupt}
            title="interrupt (send Ctrl-C)"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]/50 px-2.5 py-1 font-sans text-[11.5px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-danger)]/50 hover:text-[var(--color-danger)]"
          >
            <Square size={11} />
            <span>stop</span>
          </button>

          {savingImg && (
            <span className="flex items-center gap-1 font-sans text-[11px] text-[var(--color-faint)]">
              <ImageIcon size={12} /> saving…
            </span>
          )}

          {/* action cluster — pinned right (ml-auto) and kept together so the
              send button is ALWAYS visible no matter how narrow the pane: the
              left pills wrap to a new line instead of shoving these off-screen. */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* dismiss the composer */}
          <button
            type="button"
            onClick={onClose}
            title="hide composer"
            className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
          >
            <X size={15} />
          </button>

          {/* voice dictation — while recording the inline waveform above owns the
              state (with its own stop button); here we only show idle/transcribing.
              No global hotkey; ⌘J is App's single VoiceButton, routed into this box. */}
          {phase === "transcribing" ? (
            <div className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-accent)]">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : !recording ? (
            <button
              type="button"
              onClick={() => void micStart()}
              title="dictate (⌘J)"
              className="grid h-8 w-8 place-items-center rounded-full text-[var(--color-muted)] transition-all duration-200 hover:scale-110 hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] hover:shadow-[0_0_14px_-3px_var(--color-accent)]"
            >
              <Mic size={16} />
            </button>
          ) : null}

          {/* send → PTY + CR. accent when there's text/an image, dim when empty.
              hidden while recording (the waveform's square stop owns that row). */}
          {!recording && (
            <button
              type="button"
              onClick={submit}
              disabled={!hasContent}
              title="send to terminal (↵)"
              className="group/send grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-[var(--color-accent)] to-[color-mix(in_srgb,var(--color-accent)_62%,#000)] text-[var(--color-bg)] shadow-[0_2px_12px_-2px_color-mix(in_srgb,var(--color-accent)_70%,transparent)] transition-all duration-200 enabled:hover:scale-110 enabled:hover:shadow-[0_4px_22px_-2px_var(--color-accent)] enabled:active:scale-90 disabled:cursor-not-allowed disabled:bg-none disabled:bg-[var(--color-panel)] disabled:text-[var(--color-faint)] disabled:shadow-none"
            >
              <ArrowUp size={16} className="transition-transform duration-200 group-hover/send:-translate-y-0.5" />
            </button>
          )}
          </div>
        </div>

        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-[var(--color-accent)]/70 bg-[var(--color-accent)]/10">
            <span className="rounded-md bg-[var(--color-panel)]/90 px-3 py-1.5 font-sans text-[12px] text-[var(--color-text)]">
              drop image to attach
            </span>
          </div>
        )}
      </div>

      {/* bottom context bar: subtle read-only cwd / repo chip. Branch is skipped
          — backend exposes the repo root, not the branch. */}
      {repoLabel && (
        <div className="mt-1.5 flex items-center gap-2 px-2">
          <span className="inline-flex max-w-[60%] items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-faint)]">
            <FileText size={11} className="shrink-0 opacity-70" />
            <span className="truncate">{repoLabel}</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ── slash / @ overlay primitives (mirror ChatPane's OverlayPanel/OverlayRow) ──

/** The floating panel that sits just above the composer for `/` and `@`. */
function OverlayPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute bottom-full left-3 right-3 z-40 mb-2 max-h-64 overflow-y-auto rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] py-1 shadow-2xl shadow-black/50">
      {children}
    </div>
  );
}

function OverlayRow({
  active,
  onClick,
  onMouseEnter,
  icon,
  label,
  desc,
  mono,
}: {
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  icon: React.ReactNode;
  label: string;
  desc?: string;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
        active ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel)]"
      }`}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center">{icon}</span>
      <span
        className={`shrink-0 text-[12.5px] text-[var(--color-text)] ${
          mono ? "font-mono" : "font-sans"
        }`}
      >
        {label}
      </span>
      {desc && (
        <span className="truncate font-sans text-[11px] text-[var(--color-faint)]">
          {desc}
        </span>
      )}
      {active && (
        <>
          <span className="flex-1" />
          <CornerDownLeft size={12} className="shrink-0 text-[var(--color-faint)]" />
        </>
      )}
    </button>
  );
}

// Precomputed waveform bar heights + stagger delays for the inline recording
// visualization. Each bar runs the shared `aios-wave` keyframe (defined below)
// on a staggered delay so the row reads as a living equalizer — purely
// time-keyed, no audio analysis.
const WAVEFORM_BARS: { h: number; delay: number }[] = Array.from(
  { length: 40 },
  (_, i) => ({
    h: 28 + ((i * 37) % 60),
    delay: (i * 70) % 900,
  }),
);

// scaleY equalizer keyframe for the bars above — local to the composer so we
// don't touch the global stylesheet (scope is the two composer files only).
const WAVE_KEYFRAMES = `@keyframes aios-wave {
  0%, 100% { transform: scaleY(0.32); opacity: 0.55; }
  50% { transform: scaleY(1); opacity: 1; }
}`;
