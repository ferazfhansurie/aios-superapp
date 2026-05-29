/**
 * A single terminal pane: xterm.js (WebGL) bound to a backend PTY over a
 * per-session Channel. Mounts once, spawns its session, and cleans up (kills
 * the session) on unmount.
 */
import { useEffect, useRef } from "react";

import { Channel } from "@tauri-apps/api/core";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";

import { ptyKill, ptyResize, ptyWrite, spawnOracle, spawnShell } from "../lib/pty";

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

export type PaneKind = { type: "shell" } | { type: "oracle"; identity: string };

export function TerminalPane({ kind }: { kind: PaneKind }) {
  const hostRef = useRef<HTMLDivElement>(null);

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
      if (!disposed) term.write(chunk);
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
            : await spawnShell(onData, null, cols, rows);
      } catch (e) {
        term.write(`\r\n\x1b[31m[aios] spawn failed: ${e}\x1b[0m\r\n`);
        return;
      }

      if (disposed) {
        if (sessionId != null) ptyKill(sessionId).catch(() => {});
        return;
      }

      inputDisposer = term.onData((d) => {
        if (sessionId != null) ptyWrite(sessionId, d).catch(() => {});
      });
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
      ro.disconnect();
      inputDisposer?.dispose();
      if (sessionId != null) ptyKill(sessionId).catch(() => {});
      term.dispose();
    };
    // Mount once: each pane has a stable React key and fixed kind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="h-full min-h-0 w-full" />;
}
