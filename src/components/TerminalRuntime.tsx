/**
 * A single terminal pane: xterm.js (WebGL) bound to a backend PTY over a
 * per-session Channel. Mounts once, spawns its session, and cleans up (kills
 * the session) on unmount.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { FolderOpen, MessageSquarePlus, RotateCw, X } from "lucide-react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";

import {
  ptyKill,
  ptyResize,
  ptyWrite,
  spawnOracle,
  spawnShell,
  spawnTerminal,
  spawnTmux,
} from "../lib/pty";
import { homeDir, saveImageTemp } from "../lib/fs";
import { paneWriters, paneSubmitters, openUrlInPane, spawnPane } from "../lib/paneBus";
import { isTauriRuntime } from "../lib/tauri";

/** Wrap text in bracketed-paste markers so a TUI (claude code, vim, a shell with
 *  bracketed-paste mode on) treats it as ONE atomic paste — the trailing CR
 *  inside the brackets is delivered literally instead of racing a separate
 *  setTimeout'd Enter (the old 40/150/600ms "dual-enter" hack). For a shell this
 *  also means a multi-line clipboard paste lands as one editable block instead of
 *  auto-executing each line. ESC[200~ … ESC[201~. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
function bracketed(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}`;
}
import { TerminalComposer } from "./TerminalComposer";
import { PaneDropZone } from "./PaneDropZone";
import { reportDiag } from "../lib/diag";

/** Adletic-orange dark palette (Tomorrow Night base). */
const THEME = {
  background: "#0a0a0c",
  foreground: "#c5c8c6",
  cursor: "#f97316",
  cursorAccent: "#0a0a0c",
  selectionBackground: "rgba(249, 115, 22, 0.30)",
  black: "#1d1f21",
  red: "#cc6666",
  green: "#b5bd68",
  yellow: "#f0c674",
  blue: "#81a2be",
  magenta: "#b294bb",
  cyan: "#8abeb7",
  white: "#c5c8c6",
  brightBlack: "#666666",
  brightRed: "#d54e53",
  brightGreen: "#b9ca4a",
  brightYellow: "#e7c547",
  brightBlue: "#7aa6da",
  brightMagenta: "#c397d8",
  brightCyan: "#70c0b1",
  brightWhite: "#eaeaea",
};

const FONT_FAMILY =
  '"SF Mono", "Menlo", "Monaco", "JetBrains Mono", "Consolas", ui-monospace, monospace';

/** Shell-quote a path (single-quote wrap) only when it needs it. */
function quotePath(path: string): string {
  return /[\s'"\\]/.test(path) ? `'${path.replace(/'/g, "'\\''")}'` : path;
}

/** Extension for a clipboard/file image mime, defaulting to png. */
function imageExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("svg")) return "svg";
  if (m.includes("bmp")) return "bmp";
  return "png";
}

/** Base64-encode a Blob (chunked, avoids call-stack blowups on big images). */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export type PaneKind =
  | { type: "shell"; cmd?: string; cwd?: string }
  | { type: "oracle"; identity: string }
  | { type: "tmux"; socket: string; session: string };

/**
 * Derives a stable, tmux-safe session name (`[a-z0-9_-]`) from a pane key so the
 * SAME pane reattaches to the SAME persistent `aios-term-<name>` session across
 * remounts/relaunches. Falls back to a per-mount id when no key is available
 * (that pane just won't persist across full app restarts — acceptable).
 */
let termFallbackSeq = 0;
export function termSessionName(paneKey?: string): string {
  const base = (paneKey ?? `pane-${++termFallbackSeq}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `pane-${++termFallbackSeq}`;
}

export function TerminalPane({ kind, paneKey }: { kind: PaneKind; paneKey?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Compose box (multi-line prompt affordance). Default-open for the dedicated
  // "claude code" pane so the chat-grade surface is there from the first frame.
  // Default the compose box open wherever you're talking to a CLI AI — the
  // "claude code" pane AND any agent/oracle or attached tmux session (those run
  // claude too). A plain raw "terminal" stays closed-by-default (toggle button).
  const [composerOpen, setComposerOpen] = useState(
    kind.type === "oracle" ||
      kind.type === "tmux" ||
      (kind.type === "shell" && !!kind.cmd && kind.cmd.startsWith("claude")),
  );
  const [savingImg, setSavingImg] = useState(false);
  // B3: the backend emits `pty-exit <sessionId>` when the child/reader dies.
  // When THIS pane's session exits we surface an inline "process exited" state
  // (⏎ restart / ⌘W close) instead of silently swallowing the user's keystrokes
  // into a dead PTY. `restartNonce` bumps to re-run the mount effect → respawn.
  const [exited, setExited] = useState(false);
  const [restartNonce, setRestartNonce] = useState(0);
  // Best-effort cwd for the composer's context bar: a shell pane's explicit cwd,
  // else the home dir (oracle/tmux panes don't carry one). Read-only label only.
  const [paneCwd, setPaneCwd] = useState<string | undefined>(
    kind.type === "shell" ? kind.cwd : undefined,
  );
  // [[btn: a | b | c]] sentinel → clickable buttons (mirrors the WhatsApp UX).
  const [buttons, setButtons] = useState<string[] | null>(null);
  const bufRef = useRef("");
  // claude-code's live state, parsed best-effort from its TUI output (the raw
  // PTY has no API to query it). Drives the composer's mode + model pills so they
  // reflect REALITY instead of generic labels. Kept in a ref + state so the
  // per-chunk parse only re-renders when something actually changes.
  const [claudeStatus, setClaudeStatus] = useState<{
    mode?: string;
    model?: string;
    ctxPct?: number;
  }>({});
  const claudeStatusRef = useRef<{ mode?: string; model?: string; ctxPct?: number }>(
    {},
  );
  const lastBtnRef = useRef("");
  // When the compose box is open, an "append to box" writer it registers — so
  // global ⌘J dictation (App's single VoiceButton) lands in the box, exactly
  // like ChatPane. null = no composer mounted → fall back to the PTY writer.
  const composerAppendRef = useRef<((text: string) => void) | null>(null);
  // Live xterm handle so composerSend can snap the viewport to the prompt before
  // writing — the common "wrong spot" is a scrolled-up terminal (reading backlog
  // / tmux copy-mode) that would eat the sent line.
  const termRef = useRef<Xterm | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // B3: starting (or restarting) a session → clear any prior exit state so the
    // fresh terminal renders instead of the "process exited" overlay.
    setExited(false);

    const term = new Xterm({
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      // Alacritty ships a slightly tighter leading + weight than xterm's defaults.
      lineHeight: 1.2,
      letterSpacing: 0,
      fontWeight: "400",
      fontWeightBold: "600",
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      // Alacritty copies the moment you finish a selection.
      rightClickSelectsWord: true,
      macOptionIsMeta: true,
      allowTransparency: true,
      scrollback: 10000,
      theme: THEME,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    // N5: route clicked URLs into the IN-APP browser pane (you stay in the
    // cockpit) instead of bouncing to the OS browser. openUrlInPane returns false
    // if no pane host is registered (e.g. running outside the desktop shell) —
    // fall back to the default OS open in that case.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.button !== 0) return; // left-click only, like the default
        if (!openUrlInPane(uri, "browser")) {
          try {
            window.open(uri, "_blank", "noopener,noreferrer");
          } catch {
            /* nothing more we can do */
          }
        }
      }),
    );
    term.open(host);

    // Save an image blob to a temp file and write its shell-quoted path (+space)
    // into the live PTY — so a CLI AI (claude code) can read it for vision.
    const insertImageBlob = async (blob: Blob, mime: string, sid: number | null) => {
      if (sid == null) return;
      setSavingImg(true);
      try {
        const b64 = await blobToBase64(blob);
        const path = await saveImageTemp(b64, imageExt(mime));
        ptyWrite(sid, `${quotePath(path)} `).catch((e) => reportDiag("terminal.write", e, { action: "dropPath" }));
      } catch {
        /* best-effort */
      } finally {
        setSavingImg(false);
      }
    };

    // Cmd+V paste: prefer an image on the clipboard (→ temp path), else text.
    const pasteClipboard = async (sid: number | null) => {
      // Try the async clipboard API for image data first.
      try {
        if (navigator.clipboard?.read) {
          const items = await navigator.clipboard.read();
          for (const it of items) {
            const imgType = it.types.find((t) => t.startsWith("image/"));
            if (imgType) {
              const blob = await it.getType(imgType);
              await insertImageBlob(blob, imgType, sid);
              return;
            }
          }
        }
      } catch {
        /* clipboard.read unsupported/denied → fall through to text */
      }
      try {
        const t = await navigator.clipboard.readText();
        // R6: bracketed paste so a MULTI-LINE clipboard paste into a shell lands
        // as one editable block instead of auto-executing each line (the
        // paste-injection footgun). No trailing CR — pasting never submits.
        if (t && sid != null) ptyWrite(sid, bracketed(t)).catch((e) => reportDiag("terminal.write", e, { action: "pasteBracketed" }));
      } catch {
        /* nothing pasteable */
      }
    };

    // Key interception (runs before xterm's default handling). Returning false
    // suppresses xterm's built-in behaviour for that key. We read sessionId from
    // the ref so the handler always targets the live session (mirrors onData).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const sid = sessionIdRef.current;
      // Shift+Enter → soft newline, NOT submit. Claude Code / Ink TUIs treat
      // meta+Enter (ESC then CR) as "insert newline"; plain Enter still submits.
      if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (sid != null) ptyWrite(sid, "\x1b\r").catch((e) => reportDiag("terminal.write", e, { action: "altEnter" }));
        return false;
      }
      // Cmd+V → paste from the system clipboard into the PTY (Ctrl+V stays
      // literal-quote in the shell, matching Alacritty on macOS). If the
      // clipboard holds an IMAGE (not text), save it to a temp file and insert
      // its shell-quoted path instead — so claude code can read it for vision.
      if (e.key === "v" && e.metaKey && !e.ctrlKey && !e.altKey) {
        void pasteClipboard(sid);
        return false;
      }
      // Cmd+C → copy the selection. We never intercept Ctrl+C, so it always
      // reaches the PTY as SIGINT (^C) — matching Alacritty on macOS.
      if (e.key === "c" && e.metaKey && !e.ctrlKey && term.hasSelection()) {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch((e) => reportDiag("terminal.clipboard", e, { action: "copySelection" }));
        return false;
      }
      return true;
    });

    // Copy-on-select: as soon as a selection settles, mirror it to the clipboard.
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch((e) => reportDiag("terminal.clipboard", e, { action: "copySelection" }));
    });

    // Middle-click paste (X11/Alacritty muscle memory).
    const onAuxClick = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      const sid = sessionIdRef.current;
      navigator.clipboard
        .readText()
        .then((t) => {
          // R6: bracketed paste — same multi-line-safety as Cmd+V.
          if (t && sid != null) ptyWrite(sid, bracketed(t)).catch((e) => reportDiag("terminal.write", e, { action: "pasteBracketed" }));
        })
        .catch((e) => reportDiag("terminal.clipboard", e, { action: "readText" }));
    };
    host.addEventListener("auxclick", onAuxClick);
    // WebGL renderer for speed; silently fall back to the default if unavailable.
    // R2: WebGL renderer for speed. On sleep/wake (or GPU pressure) the browser
    // can drop the WebGL context — without handling onContextLoss the addon
    // throws on the next draw and the pane goes black. Dispose the dead addon so
    // xterm transparently falls back to its DOM/canvas renderer; the pane keeps
    // painting (slower, but alive) until the next mount restores WebGL.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try {
          webgl?.dispose();
        } catch {
          /* already torn down */
        }
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      /* canvas/dom fallback */
    }

    let sessionId: number | null = null;
    let disposed = false;
    let inputDisposer: { dispose: () => void } | null = null;
    // B3: unlisten handle for this pane's `pty-exit` subscription.
    let unlistenExit: (() => void) | null = null;

    if (!isTauriRuntime()) {
      term.write("\r\n\x1b[33m[aios] terminal panes run inside the desktop shell.\x1b[0m\r\n");
      return () => {
        disposed = true;
        host.removeEventListener("auxclick", onAuxClick);
        term.dispose();
      };
    }

    const onData = new Channel<string>();
    onData.onmessage = (chunk) => {
      if (disposed) return;
      term.write(chunk);
      // scan a rolling window for the button sentinel across chunk boundaries.
      // strip ANSI/OSC escapes first — the raw PTY stream interleaves cursor
      // moves (\x1b[10G) + colors with the text, which garbles the labels.
      const raw = (bufRef.current + chunk).slice(-4000);
      bufRef.current = raw;
      // eslint-disable-next-line no-control-regex
      const clean = raw
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
      // parse claude-code's live status out of the same cleaned window:
      //   mode  — the footer hint "⏵⏵ bypass permissions on / plan mode on / …"
      //   model — "Opus 4.8" / "Sonnet 4.6" / "Haiku 4.5" wherever it's printed
      //   ctx%  — claude's "NN% context left" / "context: NN%" readout
      // Best-effort + sticky: update only on a fresh match, keep last otherwise.
      {
        const prev = claudeStatusRef.current;
        const next = { ...prev };
        const modeM = clean.match(
          /(bypass permissions|accept edits|plan mode|normal mode)\b/i,
        );
        if (modeM) {
          const m = modeM[1].toLowerCase();
          next.mode = m.startsWith("bypass")
            ? "full access"
            : m.startsWith("accept")
              ? "accept edits"
              : m.startsWith("plan")
                ? "plan"
                : "ask each time";
        }
        const modelM = clean.match(/\b(opus|sonnet|haiku)\s+(\d+(?:\.\d+)?)/i);
        if (modelM) {
          next.model = `${modelM[1][0].toUpperCase()}${modelM[1].slice(1).toLowerCase()} ${modelM[2]}`;
        }
        const ctxM = clean.match(/(\d+)%\s*context\s*(?:left|remaining)/i);
        if (ctxM) next.ctxPct = Number(ctxM[1]);
        if (
          next.mode !== prev.mode ||
          next.model !== prev.model ||
          next.ctxPct !== prev.ctxPct
        ) {
          claudeStatusRef.current = next;
          setClaudeStatus(next);
        }
      }

      const matches = [...clean.matchAll(/\[\[btn:\s*([^\]]+?)\]\]/gi)];
      const last = matches[matches.length - 1];
      if (last && last[1] !== lastBtnRef.current) {
        lastBtnRef.current = last[1];
        const opts = last[1]
          .split("|")
          // eslint-disable-next-line no-control-regex
          .map((s) => s.replace(/[\x00-\x1f]/g, "").trim())
          .filter(Boolean)
          .slice(0, 5);
        if (opts.length) setButtons(opts);
      }
    };

    (async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      try {
        fit.fit();
      } catch {
        /* host not measured yet */
      }
      const cols = Math.max(1, term.cols);
      const rows = Math.max(1, term.rows);

      // Default ("shell") panes route through a PERSISTENT tmux session
      // `aios-term-<name>` so they survive pane-close + app-quit (detach, not
      // kill). The name is derived from the stable pane key; cmd (e.g. "claude")
      // becomes the session's startup command. tmux is Unix-only, so on Windows
      // (or any box without tmux) pty_spawn_terminal is absent/fails — fall back
      // to the raw, non-persistent login shell.
      let persisted = false;
      try {
        if (kind.type === "oracle") {
          sessionId = await spawnOracle(onData, kind.identity, cols, rows);
        } else if (kind.type === "tmux") {
          sessionId = await spawnTmux(onData, kind.socket, kind.session, cols, rows);
        } else {
          const name = termSessionName(paneKey);
          const cwd = kind.type === "shell" ? kind.cwd ?? null : null;
          try {
            sessionId = await spawnTerminal(onData, name, kind.cmd ?? null, cwd, cols, rows);
            persisted = true;
          } catch {
            // no tmux (Windows / non-AIOS box) → ephemeral shell fallback.
            sessionId = await spawnShell(onData, null, cols, rows);
          }
        }
      } catch (e) {
        term.write(`\r\n\x1b[31m[aios] spawn failed: ${e}\x1b[0m\r\n`);
        return;
      }

      if (disposed) {
        if (sessionId != null) ptyKill(sessionId).catch((e) => reportDiag("terminal.kill", e, { action: "kill" }));
        return;
      }

      sessionIdRef.current = sessionId;
      // B3: listen for THIS session's exit. The backend evicts the session from
      // its registry (B4) then emits `pty-exit <id>`. When it's ours, drop the
      // session ref (so further writes no-op instead of black-holing into a dead
      // PTY) and surface the inline "process exited" state. A plain shell or
      // `claude` quitting is the common trigger.
      {
        const mySid = sessionId;
        listen<number>("pty-exit", (e) => {
          if (disposed || e.payload !== mySid) return;
          sessionIdRef.current = null;
          setExited(true);
        })
          .then((un) => {
            if (disposed) un();
            else unlistenExit = un;
          })
          .catch((e) => reportDiag("terminal.listen", e, { action: "exit" }));
      }
      // Pane writer for cross-cutting features (voice dictation, file drops).
      // Prefer the compose box when it's open (so dictation lands in the box and
      // is editable before send, like ChatPane); else write straight to the PTY.
      if (paneKey)
        paneWriters.set(paneKey, (t) => {
          const toBox = composerAppendRef.current;
          if (toBox) toBox(t);
          else ptyWrite(sessionId!, t).catch((e) => reportDiag("terminal.write", e, { action: "input" }));
        });
      inputDisposer = term.onData((d) => {
        if (sessionId != null) ptyWrite(sessionId, d).catch((e) => reportDiag("terminal.write", e, { action: "data" }));
      });
      // auto-run an init command (e.g. `aios`) once the shell is ready.
      // Skip for persistent panes — there `cmd` is the tmux session's startup
      // command, so typing it again would double-launch (and re-launch on reattach).
      if (kind.type === "shell" && kind.cmd && !persisted) {
        const c = kind.cmd;
        const sid = sessionId;
        setTimeout(() => {
          if (!disposed && sid != null) ptyWrite(sid, `${c}\r`).catch((e) => reportDiag("terminal.write", e, { action: "command" }));
        }, 300);
      }
    })();

    // R1: debounce the ResizeObserver. The raw callback fires on EVERY pixel
    // change while dragging a pane divider; running fit.fit() + ptyResize (an IPC
    // round-trip + SIGWINCH to the child) per frame floods the PTY and flickers.
    // Coalesce to a single trailing fit+resize ~60ms after motion settles.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const applyResize = () => {
      try {
        fit.fit();
        if (sessionId != null) ptyResize(sessionId, term.cols, term.rows).catch((e) => reportDiag("terminal.resize", e, { action: "resize" }));
      } catch {
        /* ignore */
      }
    };
    const onResize = () => {
      if (resizeTimer != null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyResize, 60);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      disposed = true;
      if (paneKey) paneWriters.delete(paneKey);
      host.removeEventListener("auxclick", onAuxClick);
      ro.disconnect();
      if (resizeTimer != null) clearTimeout(resizeTimer);
      unlistenExit?.();
      inputDisposer?.dispose();
      if (sessionId != null) ptyKill(sessionId).catch((e) => reportDiag("terminal.kill", e, { action: "cleanup" }));
      term.dispose();
    };
    // Re-runs on restartNonce (B3 restart): tears down the dead terminal + respawns
    // — for a tmux-backed pane this reattaches the persistent `aios-term-<name>`
    // (recreating it via `new-session -A` if the process had exited).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartNonce]);

  // B3: restart an exited session — bump the nonce so the mount effect re-runs
  // (respawn + reattach). Clear the exit flag optimistically.
  const restartSession = useCallback(() => {
    setExited(false);
    setRestartNonce((n) => n + 1);
  }, []);

  // While exited, ⏎ restarts (mirrors the overlay hint). Scoped to keydown on
  // the host so it doesn't fight global shortcuts; ⌘W (close) is App's job.
  useEffect(() => {
    if (!exited) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        restartSession();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exited, restartSession]);

  // Click a button → "type" that choice into the session (text + Enter).
  const sendChoice = (opt: string) => {
    const id = sessionIdRef.current;
    // R6: bracketed-paste the choice text + a real Enter outside the brackets
    // (same atomic submit as composerSend) so it can't race / get split.
    if (id != null) ptyWrite(id, bracketed(opt) + "\r").catch((e) => reportDiag("terminal.write", e, { action: "selectOption" }));
    setButtons(null);
    bufRef.current = "";
  };

  // Compose box → bracketed-paste the text, with a real Enter OUTSIDE the paste
  // brackets as the submit (see the body comment). One atomic write, no timer.
  const composerSend = (text: string) => {
    const id = sessionIdRef.current;
    if (id == null) return;
    // auto-correct the "wrong spot": if the terminal is scrolled up (reading
    // backlog / tmux copy-mode), the prompt isn't in view and the sent line gets
    // lost. Snap to the live bottom + refocus first, then write. No-op when
    // already at the bottom, so normal sends are unaffected.
    termRef.current?.scrollToBottom();
    termRef.current?.focus();
    // R6: bracketed-paste the TEXT (atomic — the TUI inserts it verbatim, no
    // per-line auto-exec, no garbled multibyte), then a REAL Enter OUTSIDE the
    // paste brackets as the submit key — all in ONE write, no setTimeout race.
    //
    // Why the CR is outside the brackets (the claude-submit caution): claude
    // code's TUI buffers a \r that arrives INSIDE a paste as a literal newline
    // (multiline-compose), so it would sit unsent — that's the whole reason the
    // old code split text + a delayed \r. The `\x1b[201~` terminator closes the
    // paste, so the trailing \r is then processed as a genuine Enter = submit.
    // This preserves the claude-code submit flow without any magic timer.
    ptyWrite(id, bracketed(text) + "\r").catch((e) => reportDiag("terminal.write", e, { action: "send" }));
  };

  // Expose composerSend as this pane's SUBMITTER so "send to AI" (notes pane)
  // can paste + run a whole buffer into this terminal (e.g. claude code).
  useEffect(() => {
    if (!paneKey) return;
    paneSubmitters.set(paneKey, composerSend);
    return () => {
      paneSubmitters.delete(paneKey);
    };
    // composerSend closes over stable refs; re-register only if the key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneKey]);

  // Interrupt the running CLI (^C) — visible "stop" affordance.
  const interrupt = () => {
    const id = sessionIdRef.current;
    if (id != null) ptyWrite(id, "\x03").catch((e) => reportDiag("terminal.write", e, { action: "interrupt" }));
  };

  // Write RAW bytes straight to the PTY (no auto-CR, no quoting). The compose
  // box uses this to drive claude code's own TUI controls — slash commands
  // (e.g. "/model\r"), line-clear (^U = \x15), and the Shift+Tab mode-cycle
  // (\x1b[Z) — exactly as if the user typed them in the terminal.
  const sendRaw = (bytes: string) => {
    const id = sessionIdRef.current;
    if (id != null) ptyWrite(id, bytes).catch((e) => reportDiag("terminal.write", e, { action: "bytes" }));
  };

  // Fall back to the home dir for the composer's context chip when this pane has
  // no explicit cwd (oracle / tmux / plain shell). Best-effort, label-only.
  useEffect(() => {
    if (paneCwd) return;
    let alive = true;
    homeDir()
      .then((h) => {
        if (alive) setPaneCwd(h);
      })
      .catch((e) => reportDiag("terminal.load", e, { action: "homeDir" }));
    return () => {
      alive = false;
    };
  }, [paneCwd]);

  // Stable register callback for the compose box: it hands us its append-to-box
  // writer so global ⌘J dictation routes into the box. Stable identity keeps the
  // composer's effect from re-firing every render.
  const registerComposer = useCallback((append: (text: string) => void) => {
    composerAppendRef.current = append;
  }, []);

  // ESC → PTY. Claude code: stop generating; press again to edit the previous
  // message. Lets you drive claude's Esc behaviour from the compose box.
  const sendEscape = () => {
    const id = sessionIdRef.current;
    if (id != null) ptyWrite(id, "\x1b").catch((e) => reportDiag("terminal.write", e, { action: "escape" }));
  };

  // Save a dropped image → temp file → insert its quoted path into the PTY.
  const insertImagePath = async (blob: Blob, mime: string) => {
    const id = sessionIdRef.current;
    if (id == null) return;
    setSavingImg(true);
    try {
      const b64 = await blobToBase64(blob);
      const path = await saveImageTemp(b64, imageExt(mime));
      ptyWrite(id, `${quotePath(path)} `).catch((e) => reportDiag("terminal.write", e, { action: "dropPath" }));
    } catch {
      /* best-effort */
    } finally {
      setSavingImg(false);
    }
  };

  // Drop onto the terminal body: an image file → temp path; a file/folder
  // dragged from the Files pane → its shell-quoted path, trailing space.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const id = sessionIdRef.current;
    if (id == null) return;
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      for (const f of files) {
        if (f.type.startsWith("image/")) {
          void insertImagePath(f, f.type);
          return;
        }
      }
    }
    const path =
      e.dataTransfer.getData("application/x-aios-path") || e.dataTransfer.getData("text/plain");
    if (!path) return;
    // a folder → `cd <dir>`; a file → just its quoted path.
    if (e.dataTransfer.getData("application/x-aios-dir")) {
      ptyWrite(id, `cd ${quotePath(path)} `).catch((e) => reportDiag("terminal.write", e, { action: "cdPath" }));
      return;
    }
    ptyWrite(id, `${quotePath(path)} `).catch((e) => reportDiag("terminal.write", e, { action: "insertPath" }));
  };

  // Insert a dropped path at the prompt (quoted, trailing space). Used by the
  // PaneDropZone overlay — which floats ABOVE xterm's canvas while a drag is
  // armed, so the drop actually reaches React instead of being swallowed.
  const insertDroppedPath = (raw: string) => {
    const id = sessionIdRef.current;
    const s = raw.trim();
    if (id == null || !s) return;
    ptyWrite(id, `${quotePath(s)} `).catch((e) => reportDiag("terminal.write", e, { action: "insertPath" }));
  };

  // A FOLDER dropped onto a terminal → prefill a `cd <dir>` at the prompt (no
  // auto-Enter, so the user confirms). The sensible thing for a dir vs a file.
  const insertCd = (dir: string): boolean => {
    const id = sessionIdRef.current;
    const s = dir.trim();
    if (id == null || !s) return false;
    ptyWrite(id, `cd ${quotePath(s)} `).catch((e) => reportDiag("terminal.write", e, { action: "cdPath" }));
    return true;
  };

  return (
    <PaneDropZone onPath={insertDroppedPath} onDir={insertCd} label="drop to insert path">
    <div
      className="relative flex h-full min-h-0 w-full flex-col"
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
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full min-h-0 w-full" />
        {/* B3: process-exited overlay — the shell/CLI died, so writes would
            black-hole. Tell the user + offer ⏎ restart (respawn/reattach) and
            point at ⌘W to close. Replaces the silent corpse the old code left. */}
        {exited && (
          <div className="absolute inset-0 z-30 grid place-items-center bg-[var(--color-bg)]/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-panel)]/95 px-6 py-5 text-center shadow-2xl shadow-black/50">
              <span className="text-[13px] text-[var(--color-text)]">
                process exited
              </span>
              <span className="text-[11px] text-[var(--color-faint)]">
                press ⏎ to restart · ⌘W to close
              </span>
              <button
                onClick={restartSession}
                className="flex items-center gap-1.5 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-3 py-1.5 text-[12px] text-[var(--color-text)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg)]"
              >
                <RotateCw size={13} />
                restart
              </button>
            </div>
          </div>
        )}
        {/* spawn a files pane rooted at this terminal's cwd ("open files here") */}
        <button
          onClick={() => spawnPane("files", { path: paneCwd })}
          title={`Open files here${paneCwd ? `\n${paneCwd}` : ""}`}
          className="absolute left-2 top-2 z-20 flex items-center gap-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-panel)]/90 px-2 py-1 text-[11px] text-[var(--color-text-2)] opacity-40 backdrop-blur transition-all hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)] hover:opacity-100"
        >
          <FolderOpen size={13} />
          <span>files</span>
        </button>
        {/* toggle the compose box (chat-grade prompt surface for CLI AIs) */}
        {!composerOpen && (
          <button
            onClick={() => setComposerOpen(true)}
            title="open compose box"
            className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-panel)]/90 px-2 py-1 text-[11px] text-[var(--color-text-2)] backdrop-blur transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
          >
            <MessageSquarePlus size={13} />
            <span>compose</span>
          </button>
        )}
        {savingImg && (
          <div className="absolute left-2 top-2 z-20 rounded-md bg-[var(--color-panel)]/90 px-2 py-1 text-[11px] text-[var(--color-faint)] backdrop-blur">
            saving image…
          </div>
        )}
        {buttons && (
          <div className="absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-panel)]/95 p-2 backdrop-blur">
            {buttons.map((b, i) => (
              <button
                key={i}
                onClick={() => sendChoice(b)}
                className="rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-3 py-1.5 text-[12px] text-[var(--color-text)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg)]"
              >
                {b}
              </button>
            ))}
            <button
              onClick={() => setButtons(null)}
              className="ml-auto rounded p-1 text-[var(--color-muted)] hover:text-[var(--color-text)]"
              title="dismiss"
            >
              <X size={13} />
            </button>
          </div>
        )}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center border-2 border-dashed border-[var(--color-accent)]/70 bg-[var(--color-accent)]/10">
            <span className="rounded-md bg-[var(--color-panel)]/90 px-3 py-1.5 text-[12px] text-[var(--color-text)]">
              drop to insert path
            </span>
          </div>
        )}
      </div>
      {composerOpen && (
        <TerminalComposer
          onSend={composerSend}
          onRaw={sendRaw}
          onInterrupt={interrupt}
          onEscape={sendEscape}
          onClose={() => {
            composerAppendRef.current = null;
            setComposerOpen(false);
          }}
          register={registerComposer}
          cwd={paneCwd}
          liveMode={claudeStatus.mode}
          liveModel={claudeStatus.model}
          liveCtxPct={claudeStatus.ctxPct}
        />
      )}
    </div>
    </PaneDropZone>
  );
}
