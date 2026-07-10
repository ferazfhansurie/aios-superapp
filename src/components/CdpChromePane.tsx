/** CDP Chrome pane (spike) — a REAL supervised Chrome tab mirrored into the
 *  cockpit: screencast jpeg frames painted onto a <canvas>, pointer/wheel/key
 *  events mapped back over the DevTools Protocol (src/lib/cdp.ts → cdp.rs).
 *
 *  Unlike BrowserPane/AppCastPane there is NO native overlay view to bounds-
 *  sync — frames are ordinary DOM pixels — so the AppCastPane slot pattern
 *  reduces here to: a slot div + ResizeObserver, debounced into
 *  cdp_set_viewport so the page layout viewport tracks the pane rect (the
 *  rAF/300ms reposition loop is unnecessary; deliberate deviation).
 *
 *  DEBUG OVERLAY (spike gate instrumentation): rolling fps + input→frame
 *  latency — latency = pointerdown/keydown wall time → first frame whose CDP
 *  metadata.timestamp (epoch seconds) postdates the input.
 *
 *  TDZ NOTE (same as AppCastPane): every ref/state is declared at the top,
 *  BEFORE any hook that reads it. */
import { useCallback, useEffect, useRef, useState } from "react";

import { ArrowLeft, ArrowRight, Globe, Loader2, RotateCw, X } from "lucide-react";

import {
  cdpBack,
  cdpClosePane,
  cdpDetectChrome,
  cdpForward,
  cdpInsertText,
  cdpKey,
  cdpMouse,
  cdpNavigate,
  cdpOpen,
  cdpReload,
  cdpScroll,
  cdpSetViewport,
  cdpModifiers,
  keyEventsFor,
  wheelDeltas,
  type CdpEvent,
  type CdpMouseButton,
  type ChromeInfo,
  type FrameMeta,
} from "../lib/cdp";
import { reportDiag } from "../lib/diag";

type Status = "detecting" | "nochrome" | "opening" | "live" | "closed" | "error";

/** DOM MouseEvent.button → CDP button name. */
function buttonName(b: number): CdpMouseButton {
  return b === 1 ? "middle" : b === 2 ? "right" : "left";
}

export function CdpChromePane({ onClose }: { onClose?: () => void }) {
  // ── refs + state (declare BEFORE any hook that consumes them — TDZ guard) ──
  const slotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  /** Latest frame metadata — the coordinate map for input forwarding. */
  const metaRef = useRef<FrameMeta | null>(null);
  /** Frame ordering guard: only paint a decode that is still the newest. */
  const frameSeqRef = useRef({ received: 0, painted: 0 });
  /** Debug stats: rolling frame arrival times + latency probe. */
  const statsRef = useRef({
    arrivals: [] as number[],
    fps: 0,
    latencyMs: null as number | null,
    /** armed on pointerdown/keydown: { epochSec, startedMs } */
    probe: null as { epochSec: number; startedMs: number } | null,
  });
  /** rAF throttle for mousemove forwarding. */
  const moveRef = useRef<{ raf: number; pending: (() => void) | null }>({ raf: 0, pending: null });
  const liveRef = useRef(false);

  const [chrome, setChrome] = useState<ChromeInfo | null>(null);
  const [status, setStatus] = useState<Status>("detecting");
  const [error, setError] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState("");
  const [urlText, setUrlText] = useState("");
  const [urlFocused, setUrlFocused] = useState(false);
  const [hud, setHud] = useState({ fps: 0, latencyMs: null as number | null, w: 0, h: 0 });

  // ── frame sink ─────────────────────────────────────────────────────────────
  const onCdpEvent = useCallback((ev: CdpEvent) => {
    if (ev.type === "url") {
      setCurrentUrl(ev.url);
      return;
    }
    if (ev.type === "closed" || ev.type === "detached") {
      liveRef.current = false;
      setStatus("closed");
      return;
    }
    // frame
    const meta = ev.metadata;
    metaRef.current = meta;
    const s = statsRef.current;
    const now = performance.now();
    s.arrivals.push(now);
    while (s.arrivals.length && s.arrivals[0] < now - 2000) s.arrivals.shift();
    s.fps = s.arrivals.length / 2;
    if (s.probe && meta?.timestamp && meta.timestamp >= s.probe.epochSec) {
      s.latencyMs = Math.round(Date.now() - s.probe.startedMs);
      s.probe = null;
    }
    const seq = ++frameSeqRef.current.received;
    const bin = atob(ev.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    createImageBitmap(new Blob([bytes], { type: "image/jpeg" }))
      .then((bmp) => {
        // decodes can land out of order — never paint an older frame over a newer one
        if (seq <= frameSeqRef.current.painted) {
          bmp.close();
          return;
        }
        frameSeqRef.current.painted = seq;
        const canvas = canvasRef.current;
        if (!canvas) {
          bmp.close();
          return;
        }
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        canvas.getContext("2d")?.drawImage(bmp, 0, 0);
        bmp.close();
      })
      .catch(() => {});
  }, []);

  // HUD repaint at 4 Hz off the refs (no per-frame React state churn).
  useEffect(() => {
    const t = setInterval(() => {
      const s = statsRef.current;
      const m = metaRef.current;
      setHud({ fps: s.fps, latencyMs: s.latencyMs, w: m?.deviceWidth ?? 0, h: m?.deviceHeight ?? 0 });
    }, 250);
    return () => clearInterval(t);
  }, []);

  // ── open on mount, close on unmount ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const info = await cdpDetectChrome().catch(() => null);
      if (cancelled) return;
      setChrome(info);
      if (!info) {
        setStatus("nochrome");
        return;
      }
      setStatus("opening");
      const r = slotRef.current?.getBoundingClientRect();
      const url = await cdpOpen(onCdpEvent, {
        width: Math.max(320, Math.floor(r?.width ?? 1024)),
        height: Math.max(240, Math.floor(r?.height ?? 768)),
      });
      if (cancelled) return;
      liveRef.current = true;
      setCurrentUrl(url);
      setStatus("live");
    })().catch((e) => {
      if (cancelled) return;
      setError(typeof e === "string" ? e : String(e));
      setStatus("error");
      reportDiag("cdp.open", e, { action: "open" });
    });
    return () => {
      cancelled = true;
      liveRef.current = false;
      cdpClosePane().catch(() => {});
    };
  }, [onCdpEvent]);

  // address bar follows navigation unless the user is editing it.
  useEffect(() => {
    if (!urlFocused) setUrlText(currentUrl);
  }, [currentUrl, urlFocused]);

  // ── viewport tracking (the slot/bounds pattern, canvas edition) ────────────
  // ResizeObserver on the slot → debounce 180ms → cdp_set_viewport. No bounds
  // repositioning needed (canvas is in-DOM), so no rAF/poll loop.
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (!liveRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        cdpSetViewport(r.width, r.height).catch((e) =>
          reportDiag("cdp.viewport", e, { action: "setViewport" }),
        );
      }, 180);
    });
    ro.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  // ── input mapping ──────────────────────────────────────────────────────────
  /** Canvas CSS px → page viewport coordinates via the latest frame metadata. */
  const toPage = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    const m = metaRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const w = m?.deviceWidth ?? r.width;
    const h = m?.deviceHeight ?? r.height;
    return {
      x: ((clientX - r.left) / r.width) * w,
      y: ((clientY - r.top) / r.height) * h,
    };
  }, []);

  /** Arm the input→frame latency probe (pointerdown / keydown). */
  const armProbe = useCallback(() => {
    statsRef.current.probe = { epochSec: Date.now() / 1000, startedMs: Date.now() };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      canvasRef.current?.focus();
      const p = toPage(e.clientX, e.clientY);
      if (!p) return;
      armProbe();
      cdpMouse("mousePressed", p.x, p.y, {
        button: buttonName(e.button),
        clickCount: e.detail || 1,
        modifiers: cdpModifiers(e),
      }).catch(() => {});
    },
    [toPage, armProbe],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const p = toPage(e.clientX, e.clientY);
      if (!p) return;
      cdpMouse("mouseReleased", p.x, p.y, {
        button: buttonName(e.button),
        clickCount: e.detail || 1,
        modifiers: cdpModifiers(e),
      }).catch(() => {});
    },
    [toPage],
  );

  // mousemove is rAF-coalesced — only the latest position per frame ships.
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const p = toPage(e.clientX, e.clientY);
      if (!p) return;
      const mods = cdpModifiers(e);
      const buttons = e.buttons;
      const mv = moveRef.current;
      mv.pending = () => {
        cdpMouse("mouseMoved", p.x, p.y, {
          button: buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none",
          modifiers: mods,
        }).catch(() => {});
      };
      if (!mv.raf) {
        mv.raf = requestAnimationFrame(() => {
          mv.raf = 0;
          mv.pending?.();
          mv.pending = null;
        });
      }
    },
    [toPage],
  );

  useEffect(() => {
    const mv = moveRef.current;
    return () => {
      if (mv.raf) cancelAnimationFrame(mv.raf);
    };
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      const p = toPage(e.clientX, e.clientY);
      if (!p) return;
      armProbe();
      const d = wheelDeltas(e);
      cdpScroll(p.x, p.y, d.deltaX, d.deltaY, cdpModifiers(e)).catch(() => {});
    },
    [toPage, armProbe],
  );

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>, dir: "down" | "up") => {
      // let cockpit-level ⌘ shortcuts (⌘K/⌘W/…) pass through untouched
      if (e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (dir === "down") armProbe();
      for (const ev of keyEventsFor(e, dir)) {
        cdpKey(ev).catch(() => {});
      }
    },
    [armProbe],
  );

  const onPaste = useCallback((e: React.ClipboardEvent<HTMLCanvasElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    cdpInsertText(text).catch(() => {});
  }, []);

  // ── nav chrome ─────────────────────────────────────────────────────────────
  const navigate = useCallback(() => {
    const target = urlText.trim();
    if (!target) return;
    cdpNavigate(target).catch((e) => reportDiag("cdp.navigate", e, { action: "navigate" }));
    canvasRef.current?.focus();
  }, [urlText]);

  const retry = useCallback(() => {
    // simplest reliable retry: remount the whole flow by closing + letting the
    // parent reopen — for the spike just reload state in place via close/open.
    setError(null);
    setStatus("detecting");
    cdpClosePane()
      .catch(() => {})
      .finally(() => {
        // re-run the mount effect's work
        window.setTimeout(() => {
          cdpDetectChrome()
            .then(async (info) => {
              setChrome(info);
              if (!info) {
                setStatus("nochrome");
                return;
              }
              setStatus("opening");
              const r = slotRef.current?.getBoundingClientRect();
              const url = await cdpOpen(onCdpEvent, {
                width: Math.max(320, Math.floor(r?.width ?? 1024)),
                height: Math.max(240, Math.floor(r?.height ?? 768)),
              });
              liveRef.current = true;
              setCurrentUrl(url);
              setStatus("live");
            })
            .catch((e) => {
              setError(typeof e === "string" ? e : String(e));
              setStatus("error");
            });
        }, 50);
      });
  }, [onCdpEvent]);

  const live = status === "live";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      {/* toolbar — minimal address bar (BrowserPane-shaped row) */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-2">
        <Globe size={14} className="shrink-0 text-[var(--color-muted)]" />
        <button
          type="button"
          title="Back"
          disabled={!live}
          onClick={() => cdpBack().catch(() => {})}
          className="shrink-0 rounded p-1 text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-40"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          title="Forward"
          disabled={!live}
          onClick={() => cdpForward().catch(() => {})}
          className="shrink-0 rounded p-1 text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-40"
        >
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          title="Reload"
          disabled={!live}
          onClick={() => cdpReload().catch(() => {})}
          className="shrink-0 rounded p-1 text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-40"
        >
          <RotateCw size={13} />
        </button>
        <input
          ref={urlInputRef}
          type="text"
          value={urlText}
          disabled={!live}
          onChange={(e) => setUrlText(e.target.value)}
          onFocus={(e) => {
            setUrlFocused(true);
            e.currentTarget.select();
          }}
          onBlur={() => setUrlFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              navigate();
              urlInputRef.current?.blur();
            } else if (e.key === "Escape") {
              setUrlText(currentUrl);
              urlInputRef.current?.blur();
            }
          }}
          placeholder={live ? "enter a url…" : "real chrome (cdp spike)"}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 font-mono text-[11px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60 disabled:opacity-50"
        />
        {status === "opening" && (
          <Loader2 size={13} className="shrink-0 animate-spin text-[var(--color-accent)]" />
        )}
        {onClose && (
          <button
            type="button"
            title="Close"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* slot — the canvas paints here (no native overlay, plain DOM pixels) */}
      <div ref={slotRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerMove={onPointerMove}
          onWheel={onWheel}
          onKeyDown={(e) => onKey(e, "down")}
          onKeyUp={(e) => onKey(e, "up")}
          onPaste={onPaste}
          onContextMenu={(e) => e.preventDefault()}
          className="h-full w-full cursor-default outline-none"
          style={{ display: live || status === "closed" ? "block" : "none" }}
        />

        {/* empty / error states */}
        {status === "detecting" && (
          <div className="absolute inset-0 grid place-items-center text-[11px] text-[var(--color-faint)]">
            detecting chrome…
          </div>
        )}
        {status === "nochrome" && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <div className="max-w-sm">
              <div className="text-[13px] font-medium text-[var(--color-text)]">
                no chromium-family browser found
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-faint)]">
                install Google Chrome (or Chromium / Edge / Brave) in /Applications, then retry.
              </p>
              <button
                type="button"
                onClick={retry}
                className="mt-3 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-accent-fg)]"
              >
                retry
              </button>
            </div>
          </div>
        )}
        {status === "opening" && (
          <div className="absolute inset-0 grid place-items-center text-[11px] text-[var(--color-faint)]">
            launching {chrome?.name ?? "chrome"} + attaching tab…
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <div className="max-w-sm">
              <div className="text-[13px] font-medium text-[var(--color-text)]">couldn't drive chrome</div>
              <div className="mt-1 break-words font-mono text-[11px] text-[var(--color-muted)]">{error}</div>
              <button
                type="button"
                onClick={retry}
                className="mt-3 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-accent-fg)]"
              >
                retry
              </button>
            </div>
          </div>
        )}
        {status === "closed" && (
          <div className="absolute inset-x-0 bottom-0 z-50 flex items-center justify-center gap-2 bg-[var(--color-panel-2)]/90 px-3 py-1.5 text-[11px] text-[var(--color-muted)]">
            chrome detached
            <button type="button" onClick={retry} className="text-[var(--color-accent)] hover:underline">
              reattach
            </button>
          </div>
        )}

        {/* DEBUG OVERLAY — fps + input→frame latency (the spike gate numbers) */}
        {live && (
          <div className="pointer-events-none absolute right-2 top-2 z-50 rounded-md border border-[var(--color-border)] bg-black/70 px-2.5 py-1 font-mono text-[10px] text-emerald-300 shadow-lg">
            {hud.fps.toFixed(1)} fps · {hud.latencyMs != null ? `${hud.latencyMs}ms in→frame` : "in→frame —"} ·{" "}
            {hud.w}×{hud.h}
          </div>
        )}
      </div>
    </div>
  );
}
