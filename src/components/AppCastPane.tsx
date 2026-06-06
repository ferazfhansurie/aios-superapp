/** App-cast pane — live-mirrors ONE native macOS app window inside an AIOS pane
 *  (ScreenCaptureKit). Phase A: capture + mirror. Phase B: input forwarding —
 *  clicks/scroll/keys on the overlay are mapped to the real window + posted to
 *  the target app's pid (handled natively in the overlay's event handlers).
 *
 *  Structural clone of BrowserPane: a native child view (here a CALayer-backed
 *  NSView fed by an SCStream's IOSurface frames, not a WKWebView) is floated over
 *  a React slot div and bounds-synced via the SAME rAF + ResizeObserver + 300ms
 *  poll loop. Chrome here is a window-picker dropdown instead of a URL bar. The
 *  picker calls appcast_list_windows (which triggers the Screen Recording prompt
 *  on first use); selecting a window calls appcast_start; unmount hides+closes.
 *
 *  TDZ NOTE: every ref/state is declared at the top, BEFORE any useCallback /
 *  effect / derived value that reads it — referencing a const before its
 *  declaration line inside a synchronously-run hook or the render body throws
 *  "Cannot access X before initialization" and black-screens the app (tsc won't
 *  catch it). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2, MonitorUp, RefreshCw, Search, ShieldAlert, X } from "lucide-react";

import {
  appcastClose,
  appcastHide,
  appcastListWindows,
  appcastSetBounds,
  appcastShow,
  appcastStart,
  type WindowInfo,
} from "../lib/appcast";
import type { Rect } from "../lib/browser";
import { type NotificationLevel } from "../lib/notifications";
import { reportDiag } from "../lib/diag";

/** macOS deep-link straight to Privacy › Screen Recording. */
const SCREEN_REC_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/** Heuristic: does this error look like the Screen Recording TCC permission was
 *  declined / not yet granted? (SCK surfaces this a few different ways.) */
function isTccDeclined(msg: string | null): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("screen recording") ||
    m.includes("permission") ||
    m.includes("declined") ||
    m.includes("not authorized") ||
    m.includes("tcc") ||
    (m.includes("scstream") && m.includes("-3801")) ||
    m.includes("no capturable windows")
  );
}

/** One app's group of windows for the grouped picker. */
interface AppGroup {
  app: string;
  windows: WindowInfo[];
}

export function AppCastPane({
  label,
  active = true,
  initialWindowId,
  onWindowChange,
  onNotify,
}: {
  /** Per-pane key (the native child view is addressed by this), like BrowserPane. */
  label: string;
  /** false (a modal is open / pane hidden) → hide the native view so it stops
   *  compositing over the React layer. Mirrors BrowserPane `active`. */
  active?: boolean;
  /** Deep-link a pre-picked window id (cf. BrowserPane initialUrl). */
  initialWindowId?: number;
  /** Fired when the user picks a window, so the pane model can persist it. */
  onWindowChange?: (id: number) => void;
  /** Toast/error surface. */
  onNotify?: (msg: string, level: NotificationLevel) => void;
}) {
  // ── refs + state (declare BEFORE any hook that consumes them — TDZ guard) ──
  const slotRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Whether the native capture view has been created for this pane (gates the
  // sync loop between create-on-first-sync and reposition — mirrors BrowserPane
  // shownRef). Reset to false on close so a re-pick recreates it.
  const startedRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [picked, setPicked] = useState<number | null>(initialWindowId ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Picker search query + keyboard-nav highlight index (into the FLAT filtered list).
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  const notify = useCallback(
    (msg: string, level: NotificationLevel = "info") => {
      // Local in-pane status only (toast + parent toast surface). Do NOT fire a
      // global pane notification on cast-start: it's a foreground action the user
      // is looking right at, and it was spamming the notification center.
      setToast(msg);
      onNotify?.(msg, level);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 2500);
    },
    [label, onNotify],
  );

  // Slot rect → native bounds (same shape as BrowserPane.rect()).
  const rect = useCallback((): Rect | null => {
    const el = slotRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, []);

  // Enumerate capturable windows. First call surfaces the Screen Recording
  // prompt; a denied/failed call lands in `error`.
  const refreshWindows = useCallback(() => {
    setLoadingList(true);
    setError(null);
    appcastListWindows()
      .then((rows) => {
        setWindows(rows);
        if (rows.length === 0) {
          setError(
            "no capturable windows found — grant Screen Recording in System Settings › Privacy & Security, then retry",
          );
        }
      })
      .catch((e) => {
        const msg = typeof e === "string" ? e : String(e);
        setError(msg);
        reportDiag("appcast.list", e, { action: "listWindows" });
      })
      .finally(() => setLoadingList(false));
  }, []);

  // Pick a window: stop any current mirror, then arm the new one (the sync loop
  // below calls appcast_start on its next tick once startedRef is reset).
  const pickWindow = useCallback(
    (w: WindowInfo) => {
      setPickerOpen(false);
      setQuery("");
      if (startedRef.current) {
        appcastClose(label).catch((e) => reportDiag("appcast.close", e, { action: "switch" }));
        startedRef.current = false;
      }
      setPicked(w.window_id);
      onWindowChange?.(w.window_id);
      notify(`mirroring ${w.app_name}${w.window_title ? ` — ${w.window_title}` : ""}`, "success");
    },
    [label, notify, onWindowChange],
  );

  // ── bounds-sync loop (copied shape from BrowserPane.tsx:268-302) ──────────
  // Creates the native view on first sync (appcast_start), then repositions it
  // to the slot rect on every rAF / resize / 300ms poll. `picked == null` (no
  // window chosen yet) or `!active` → skip / hide.
  useEffect(() => {
    if (!active) {
      if (startedRef.current) appcastHide(label).catch((e) => reportDiag("appcast.hide", e, { action: "hide" }));
      return;
    }
    // Picker dropdown open → the native capture overlay paints ON TOP of the
    // React dropdown and clips it, so hide the mirror while the user is choosing
    // (mirrors the BrowserPane "hide webview when a menu/modal is open" pattern).
    // The pickerOpen effect below shows + re-syncs bounds again on close.
    if (pickerOpen) {
      if (startedRef.current) appcastHide(label).catch((e) => reportDiag("appcast.hide", e, { action: "picker" }));
      return;
    }
    if (picked == null) return;

    let raf = 0;
    const sync = () => {
      const r = rect();
      if (!r) return;
      if (!startedRef.current) {
        startedRef.current = true;
        setStarting(true);
        appcastStart(label, picked, r)
          .then(() => {
            setError(null);
            setStarting(false);
          })
          .catch((e) => {
            startedRef.current = false; // allow a retry next tick
            setStarting(false);
            setError(typeof e === "string" ? e : String(e));
          });
      } else {
        // Re-show in case it was hidden while inactive, then reposition.
        appcastShow(label).catch(() => {});
        appcastSetBounds(label, r).catch((e) => reportDiag("appcast.bounds", e, { action: "setBounds" }));
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
  }, [active, picked, label, rect, pickerOpen]);

  // Teardown on unmount: hide then close (stops capture + drops the view).
  useEffect(() => {
    return () => {
      startedRef.current = false;
      appcastHide(label).catch((e) => reportDiag("appcast.hide", e, { action: "cleanup" }));
      appcastClose(label).catch((e) => reportDiag("appcast.close", e, { action: "cleanup" }));
    };
  }, [label]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // Load the window list once on mount so the picker is populated.
  useEffect(() => {
    refreshWindows();
  }, [refreshWindows]);

  // Close the picker dropdown on outside click.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [pickerOpen]);

  // Focus the search box + reset the query/highlight whenever the picker opens.
  useEffect(() => {
    if (pickerOpen) {
      setActiveIdx(0);
      const t = setTimeout(() => searchRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [pickerOpen]);

  // ── derived (render-body computations — all hooks/state above this line) ──
  // Case-insensitive filter on app name + window title, then group by app.
  const groups: AppGroup[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? windows.filter(
          (w) =>
            w.app_name.toLowerCase().includes(q) ||
            w.window_title.toLowerCase().includes(q),
        )
      : windows;
    const byApp = new Map<string, WindowInfo[]>();
    for (const w of filtered) {
      const key = w.app_name || "(unknown)";
      const arr = byApp.get(key);
      if (arr) arr.push(w);
      else byApp.set(key, [w]);
    }
    return Array.from(byApp.entries())
      .map(([app, wins]) => ({ app, windows: wins }))
      .sort((a, b) => a.app.localeCompare(b.app));
  }, [windows, query]);

  // Flattened filtered windows in display (grouped) order — the index space the
  // arrow keys + Enter navigate over.
  const flat: WindowInfo[] = useMemo(() => groups.flatMap((g) => g.windows), [groups]);

  // Keep the highlight index in range as the filter narrows.
  useEffect(() => {
    setActiveIdx((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)));
  }, [flat.length]);

  // Arrow up/down + Enter in the search box drive selection.
  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (flat.length === 0 ? 0 : (i + 1) % flat.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const w = flat[activeIdx];
        if (w) pickWindow(w);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setPickerOpen(false);
      }
    },
    [flat, activeIdx, pickWindow],
  );

  const pickedWin = windows.find((w) => w.window_id === picked) ?? null;
  const tccDeclined = isTccDeclined(error);

  // Running flat index so each rendered row knows its nav position.
  let flatCursor = -1;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      {/* Toolbar — window picker (mirrors BrowserPane's URL-bar row). */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-2">
        <MonitorUp size={14} className="shrink-0 text-[var(--color-muted)]" />
        <div ref={pickerRef} className="relative min-w-0 flex-1">
          <button
            type="button"
            onClick={() => {
              setPickerOpen((o) => !o);
              if (!pickerOpen) refreshWindows();
            }}
            className="flex w-full min-w-0 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-left text-[12px] text-[var(--color-text)] outline-none hover:border-[var(--color-accent)]/50"
          >
            <span className="min-w-0 flex-1 truncate">
              {pickedWin
                ? `${pickedWin.app_name}${pickedWin.window_title ? ` — ${pickedWin.window_title}` : ""}`
                : "pick a window to mirror…"}
            </span>
            {starting && <Loader2 size={12} className="shrink-0 animate-spin text-[var(--color-accent)]" />}
          </button>
          {pickerOpen && (
            <div className="absolute left-0 right-0 top-full z-[70] mt-1 flex max-h-96 flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] text-[12px] shadow-2xl">
              {/* search + refresh header (sticky) */}
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2.5 py-1.5">
                <Search size={12} className="shrink-0 text-[var(--color-faint)]" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActiveIdx(0);
                  }}
                  onKeyDown={onSearchKeyDown}
                  placeholder="filter by app or window…"
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
                />
                <button
                  type="button"
                  title="Refresh list"
                  onClick={(e) => {
                    e.stopPropagation();
                    refreshWindows();
                  }}
                  className="shrink-0 rounded p-0.5 text-[var(--color-faint)] hover:text-[var(--color-text)]"
                >
                  {loadingList ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto py-1">
                {/* TCC-declined → friendly enable prompt instead of a raw error. */}
                {tccDeclined ? (
                  <div className="px-3 py-3 text-[11px]">
                    <div className="mb-1 flex items-center gap-1.5 text-[var(--color-text)]">
                      <ShieldAlert size={13} className="text-[var(--color-danger)]" />
                      <span className="font-medium">Screen Recording not enabled</span>
                    </div>
                    <p className="leading-relaxed text-[var(--color-faint)]">
                      Enable Screen Recording for AIOS in System Settings › Privacy & Security, then
                      retry.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openUrl(SCREEN_REC_SETTINGS_URL).catch((err) =>
                            reportDiag("appcast.openSettings", err, { action: "openSettings" }),
                          );
                        }}
                        className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-white"
                      >
                        open settings
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          refreshWindows();
                        }}
                        className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] text-[var(--color-text)] hover:border-[var(--color-accent)]/50"
                      >
                        retry
                      </button>
                    </div>
                  </div>
                ) : flat.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-[var(--color-faint)]">
                    {loadingList
                      ? "scanning…"
                      : query.trim()
                        ? "no windows match"
                        : "no app windows found"}
                  </div>
                ) : (
                  groups.map((g) => (
                    <div key={g.app} className="mb-0.5">
                      <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
                        {g.app}
                      </div>
                      {g.windows.map((w) => {
                        flatCursor += 1;
                        const idx = flatCursor;
                        const isActive = idx === activeIdx;
                        return (
                          <button
                            key={w.window_id}
                            type="button"
                            onMouseEnter={() => setActiveIdx(idx)}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              pickWindow(w);
                            }}
                            className={
                              "flex w-full items-center gap-2 px-3 py-1.5 pl-5 text-left " +
                              (isActive
                                ? "bg-[var(--color-accent)]/15 text-[var(--color-text)]"
                                : w.window_id === picked
                                  ? "bg-[var(--color-accent)]/10 text-[var(--color-text)]"
                                  : "text-[var(--color-text)] hover:bg-[var(--color-panel)]")
                            }
                          >
                            <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">
                              {w.window_title || <span className="text-[var(--color-faint)]">untitled window</span>}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">
                              #{w.window_id}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Slot — the native capture view is composited OVER this rect (bounds-sync). */}
      <div ref={slotRef} className="relative min-h-0 flex-1">
        {error && !pickerOpen ? (
          <div className="absolute inset-0 z-[55] grid place-items-center bg-[var(--color-pane)] px-6 text-center">
            <div className="max-w-sm">
              {tccDeclined ? (
                <>
                  <div className="flex items-center justify-center gap-1.5 text-[13px] font-medium text-[var(--color-text)]">
                    <ShieldAlert size={14} className="text-[var(--color-danger)]" />
                    Screen Recording not enabled
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-faint)]">
                    Enable Screen Recording for AIOS in System Settings › Privacy & Security, then
                    retry.
                  </p>
                  <div className="mt-3 flex justify-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        openUrl(SCREEN_REC_SETTINGS_URL).catch((err) =>
                          reportDiag("appcast.openSettings", err, { action: "openSettings" }),
                        )
                      }
                      className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white"
                    >
                      open settings
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        refreshWindows();
                      }}
                      className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text)] hover:border-[var(--color-accent)]/50"
                    >
                      retry
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[13px] font-medium text-[var(--color-text)]">couldn't mirror window</div>
                  <div className="mt-1 break-words font-mono text-[11px] text-[var(--color-muted)]">{error}</div>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      refreshWindows();
                    }}
                    className="mt-3 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white"
                  >
                    retry
                  </button>
                </>
              )}
            </div>
          </div>
        ) : picked == null ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-[11px] text-[var(--color-faint)]">
            pick a window above to mirror it live into this pane
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-[11px] text-[var(--color-faint)]">
            {starting ? "starting capture…" : "live mirror — click + type to control the app"}
          </div>
        )}
        {toast && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-50 -translate-x-1/2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-[11px] text-[var(--color-text)] shadow-lg">
            {toast}
          </div>
        )}
        {/* "recording this app" indicator (trust-is-the-moat: never silent). */}
        {picked != null && !error && (
          <div className="pointer-events-none absolute right-2 top-2 z-50 flex items-center gap-1.5 rounded-full border border-[var(--color-danger)]/40 bg-[var(--color-panel-2)] px-2.5 py-1 text-[10px] text-[var(--color-danger)] shadow-lg">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-danger)]" />
            mirroring
            <button
              type="button"
              title="Stop mirroring"
              className="pointer-events-auto ml-0.5 rounded p-0.5 hover:text-[var(--color-text)]"
              onClick={() => {
                appcastClose(label).catch((e) => reportDiag("appcast.close", e, { action: "stop" }));
                startedRef.current = false;
                setPicked(null);
              }}
            >
              <X size={11} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
