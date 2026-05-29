/** Browser pane — drives a NATIVE child webview (real WebKit, renders any site,
 *  no iframe X-Frame-Options blocking). This component is just the chrome
 *  (url bar + nav) plus a placeholder div whose on-screen rect the webview
 *  tracks. The webview floats above this region; we sync its bounds on resize
 *  and a light poll, hide it when the tab is inactive, and close it on unmount. */
import { useCallback, useEffect, useRef, useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";

import {
  browserBack,
  browserClose,
  browserForward,
  browserHide,
  browserNavigate,
  browserReload,
  browserSetBounds,
  browserShow,
  type Rect,
} from "../lib/browser";

function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+/.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

export function BrowserPane({ active }: { active: boolean }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("https://vercel.com");
  const [current, setCurrent] = useState("https://vercel.com");
  const shownRef = useRef(false);

  const rect = useCallback((): Rect | null => {
    const el = slotRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, []);

  // Show + keep the webview glued to the slot while active; hide when inactive.
  useEffect(() => {
    if (!active) {
      if (shownRef.current) browserHide().catch(() => {});
      return;
    }
    let raf = 0;
    const sync = () => {
      const r = rect();
      if (!r) return;
      if (!shownRef.current) {
        shownRef.current = true;
        browserShow(current, r).catch(() => {});
      } else {
        browserSetBounds(r).catch(() => {});
      }
    };
    raf = requestAnimationFrame(() => requestAnimationFrame(sync));
    const ro = new ResizeObserver(sync);
    if (slotRef.current) ro.observe(slotRef.current);
    window.addEventListener("resize", sync);
    // poll catches pure position moves (sidebar toggle, dock reposition).
    const poll = setInterval(sync, 300);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", sync);
      clearInterval(poll);
    };
  }, [active, current, rect]);

  // Tear down the webview entirely when the pane unmounts.
  useEffect(() => {
    return () => {
      browserClose().catch(() => {});
      shownRef.current = false;
    };
  }, []);

  const go = useCallback(() => {
    const url = normalizeUrl(input);
    if (!url) return;
    setCurrent(url);
    setInput(url);
    if (shownRef.current) browserNavigate(url).catch(() => {});
  }, [input]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      {/* chrome */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-2">
        <NavBtn title="Back" onClick={() => browserBack().catch(() => {})}>
          <ArrowLeft size={14} />
        </NavBtn>
        <NavBtn title="Forward" onClick={() => browserForward().catch(() => {})}>
          <ArrowRight size={14} />
        </NavBtn>
        <NavBtn title="Reload" onClick={() => browserReload().catch(() => {})}>
          <RotateCw size={13} />
        </NavBtn>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
          className="flex min-w-0 flex-1 items-center"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 font-mono text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/50"
            placeholder="search or enter url"
          />
        </form>
        <NavBtn title="Open in system browser" onClick={() => openUrl(current).catch(() => {})}>
          <ExternalLink size={13} />
        </NavBtn>
      </div>

      {/* webview slot — the native webview overlays this exact rect */}
      <div ref={slotRef} className="relative min-h-0 flex-1">
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] text-[var(--color-faint)]">
          loading native browser…
        </div>
      </div>
    </div>
  );
}

function NavBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded p-1.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  );
}
