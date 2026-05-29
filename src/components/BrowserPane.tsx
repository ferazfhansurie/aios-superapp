/** Browser pane — drives a NATIVE child webview (real WebKit, renders any site,
 *  no iframe blocking). Each pane owns its own webview keyed by `label`. The
 *  component is just the chrome (url bar + nav) plus a placeholder div whose
 *  on-screen rect the webview tracks. `active=false` (a modal is open, or the
 *  pane is hidden) shrinks the webview to 0 so HTML modals aren't occluded. */
import { useCallback, useEffect, useRef, useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  MoreVertical,
  RotateCw,
  Smartphone,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import {
  browserBack,
  browserClearCookies,
  browserClose,
  browserDeviceMode,
  browserForward,
  browserHide,
  browserNavigate,
  browserReload,
  browserScreenshot,
  browserSetBounds,
  browserShow,
  browserZoom,
  type Rect,
} from "../lib/browser";

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+/.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

export function BrowserPane({ label, active = true }: { label: string; active?: boolean }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("https://google.com");
  const [current, setCurrent] = useState("https://google.com");
  const [menuOpen, setMenuOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [deviceMode, setDeviceMode] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const shownRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rect = useCallback((): Rect | null => {
    const el = slotRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, []);

  useEffect(() => {
    if (!active) {
      if (shownRef.current) browserHide(label).catch(() => {});
      return;
    }
    let raf = 0;
    const sync = () => {
      const r = rect();
      if (!r) return;
      if (!shownRef.current) {
        shownRef.current = true;
        browserShow(label, current, r).catch(() => {});
      } else {
        browserSetBounds(label, r).catch(() => {});
      }
    };
    raf = requestAnimationFrame(() => requestAnimationFrame(sync));
    const ro = new ResizeObserver(sync);
    if (slotRef.current) ro.observe(slotRef.current);
    window.addEventListener("resize", sync);
    const poll = setInterval(sync, 300);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", sync);
      clearInterval(poll);
    };
  }, [active, current, label, rect]);

  useEffect(() => {
    return () => {
      browserClose(label).catch(() => {});
      shownRef.current = false;
    };
  }, [label]);

  const go = useCallback(() => {
    const url = normalizeUrl(input);
    if (!url) return;
    setCurrent(url);
    setInput(url);
    if (shownRef.current) browserNavigate(label, url).catch(() => {});
  }, [input, label]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // Close the options menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const onScreenshot = useCallback(() => {
    const r = rect();
    if (!r) return;
    browserScreenshot(label, r)
      .then((path) => {
        const file = path.split("/").pop() ?? path;
        showToast(`saved ${file}`);
      })
      .catch((e) => showToast(typeof e === "string" ? e : "screenshot failed"));
  }, [label, rect, showToast]);

  const applyZoom = useCallback(
    (pct: number) => {
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pct));
      setZoom(clamped);
      browserZoom(label, clamped / 100).catch(() => {});
    },
    [label],
  );

  const toggleDeviceMode = useCallback(() => {
    const next = !deviceMode;
    setDeviceMode(next);
    browserDeviceMode(label, next).catch(() => {});
  }, [deviceMode, label]);

  const clearCookies = useCallback(() => {
    browserClearCookies(label).catch(() => {});
    setMenuOpen(false);
    showToast("cleared cookies + storage");
  }, [label, showToast]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-2">
        <NavBtn title="Back" onClick={() => browserBack(label).catch(() => {})}>
          <ArrowLeft size={14} />
        </NavBtn>
        <NavBtn title="Forward" onClick={() => browserForward(label).catch(() => {})}>
          <ArrowRight size={14} />
        </NavBtn>
        <NavBtn title="Reload" onClick={() => browserReload(label).catch(() => {})}>
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
        <NavBtn title="Screenshot" onClick={onScreenshot}>
          <Camera size={13} />
        </NavBtn>
        <div ref={menuRef} className="relative">
          <NavBtn title="Options" onClick={() => setMenuOpen((o) => !o)}>
            <MoreVertical size={14} />
          </NavBtn>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] py-1 text-[12px] text-[var(--color-text)] shadow-lg">
              <MenuItem
                icon={<RotateCw size={13} />}
                label="Force reload"
                onClick={() => {
                  browserReload(label).catch(() => {});
                  setMenuOpen(false);
                }}
              />
              <MenuItem
                icon={<Smartphone size={13} />}
                label="Device toolbar"
                trailing={
                  <span
                    className={
                      deviceMode
                        ? "text-[10px] text-[var(--color-accent)]"
                        : "text-[10px] text-[var(--color-faint)]"
                    }
                  >
                    {deviceMode ? "on" : "off"}
                  </span>
                }
                onClick={toggleDeviceMode}
              />
              <div className="my-1 border-t border-[var(--color-border)]" />
              <div className="flex items-center justify-between px-3 py-1.5">
                <span className="text-[var(--color-muted)]">Zoom</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    title="Zoom out"
                    onClick={() => applyZoom(zoom - ZOOM_STEP)}
                    className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                  >
                    <ZoomOut size={13} />
                  </button>
                  <button
                    type="button"
                    title="Reset zoom"
                    onClick={() => applyZoom(100)}
                    className="min-w-[42px] rounded px-1 py-0.5 text-center text-[11px] tabular-nums text-[var(--color-text)] hover:bg-[var(--color-panel)]"
                  >
                    {zoom}%
                  </button>
                  <button
                    type="button"
                    title="Zoom in"
                    onClick={() => applyZoom(zoom + ZOOM_STEP)}
                    className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                  >
                    <ZoomIn size={13} />
                  </button>
                </div>
              </div>
              <div className="my-1 border-t border-[var(--color-border)]" />
              <MenuItem
                icon={<Trash2 size={13} />}
                label="Clear cookies"
                onClick={clearCookies}
              />
              <MenuItem
                icon={<Trash2 size={13} />}
                label="Clear cache"
                onClick={clearCookies}
              />
            </div>
          )}
        </div>
      </div>

      <div ref={slotRef} className="relative min-h-0 flex-1">
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] text-[var(--color-faint)]">
          loading native browser…
        </div>
        {toast && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-50 -translate-x-1/2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-[11px] text-[var(--color-text)] shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  trailing,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[var(--color-text)] transition-colors hover:bg-[var(--color-panel)]"
    >
      <span className="text-[var(--color-muted)]">{icon}</span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
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
