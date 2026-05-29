/**
 * A single terminal pane: xterm.js (WebGL) bound to a backend PTY over a
 * per-session Channel. Mounts once, spawns its session, and cleans up (kills
 * the session) on unmount.
 */
import { useEffect, useRef, useState } from "react";

import { X } from "lucide-react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";

import { ptyKill, ptyResize, ptyWrite, spawnOracle, spawnShell, spawnTmux } from "../lib/pty";
import { paneWriters } from "../lib/paneBus";

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

export type PaneKind =
  | { type: "shell"; cmd?: string }
  | { type: "oracle"; identity: string }
  | { type: "tmux"; socket: string; session: string };

export function TerminalPane({ kind, paneKey }: { kind: PaneKind; paneKey?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // [[btn: a | b | c]] sentinel → clickable buttons (mirrors the WhatsApp UX).
  const [buttons, setButtons] = useState<string[] | null>(null);
  const bufRef = useRef("");
  const lastBtnRef = useRef("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      allowTransparency: true,
      scrollback: 10000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    // WebGL renderer for speed; silently fall back to the default if unavailable.
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* canvas/dom fallback */
    }

    let sessionId: number | null = null;
    let disposed = false;
    let inputDisposer: { dispose: () => void } | null = null;

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

      try {
        sessionId =
          kind.type === "oracle"
            ? await spawnOracle(onData, kind.identity, cols, rows)
            : kind.type === "tmux"
              ? await spawnTmux(onData, kind.socket, kind.session, cols, rows)
              : await spawnShell(onData, null, cols, rows);
      } catch (e) {
        term.write(`\r\n\x1b[31m[aios] spawn failed: ${e}\x1b[0m\r\n`);
        return;
      }

      if (disposed) {
        if (sessionId != null) ptyKill(sessionId).catch(() => {});
        return;
      }

      sessionIdRef.current = sessionId;
      if (paneKey) paneWriters.set(paneKey, (t) => ptyWrite(sessionId!, t).catch(() => {}));
      inputDisposer = term.onData((d) => {
        if (sessionId != null) ptyWrite(sessionId, d).catch(() => {});
      });
      // auto-run an init command (e.g. `aios`) once the shell is ready
      if (kind.type === "shell" && kind.cmd) {
        const c = kind.cmd;
        const sid = sessionId;
        setTimeout(() => {
          if (!disposed && sid != null) ptyWrite(sid, `${c}\r`).catch(() => {});
        }, 300);
      }
    })();

    const onResize = () => {
      try {
        fit.fit();
        if (sessionId != null) ptyResize(sessionId, term.cols, term.rows).catch(() => {});
      } catch {
        /* ignore */
      }
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      disposed = true;
      if (paneKey) paneWriters.delete(paneKey);
      ro.disconnect();
      inputDisposer?.dispose();
      if (sessionId != null) ptyKill(sessionId).catch(() => {});
      term.dispose();
    };
    // Mount once: each pane has a stable React key and fixed kind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click a button → "type" that choice into the session (text + Enter).
  const sendChoice = (opt: string) => {
    const id = sessionIdRef.current;
    if (id != null) ptyWrite(id, `${opt}\r`).catch(() => {});
    setButtons(null);
    bufRef.current = "";
  };

  // Drop a file/folder (dragged from the Files pane) → insert its path into
  // this session's PTY, shell-quoted, with a trailing space.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const path =
      e.dataTransfer.getData("application/x-aios-path") || e.dataTransfer.getData("text/plain");
    const id = sessionIdRef.current;
    if (!path || id == null) return;
    const quoted = /[\s'"\\]/.test(path) ? `'${path.replace(/'/g, "'\\''")}' ` : `${path} `;
    ptyWrite(id, quoted).catch(() => {});
  };

  return (
    <div
      className="relative h-full min-h-0 w-full"
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
      <div ref={hostRef} className="h-full min-h-0 w-full" />
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
  );
}
