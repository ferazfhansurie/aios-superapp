/** Browser pane — drives a NATIVE child webview (real WebKit, renders any site,
 *  no iframe blocking). Each pane owns its own webview keyed by `label`. The
 *  component is just the chrome (url bar + nav) plus a placeholder div whose
 *  on-screen rect the webview tracks. `active=false` (a modal is open, or the
 *  pane is hidden) shrinks the webview to 0 so HTML modals aren't occluded. */
import { useCallback, useEffect, useRef, useState } from "react";

import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronUp,
  Crosshair,
  ExternalLink,
  Loader2,
  MessageSquarePlus,
  MoreVertical,
  Pin,
  Check,
  Plus,
  RotateCw,
  Search,
  Smartphone,
  SquareDashedMousePointer,
  Terminal,
  Trash2,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import {
  browserBack,
  browserClearCache,
  browserClearCookies,
  browserClose,
  browserCopySelection,
  browserCurrentUrl,
  browserFind,
  browserForceReload,
  browserFullscreenState,
  browserDeviceMode,
  browserEnterAnnotate,
  browserExitAnnotate,
  browserForward,
  browserHide,
  browserNavigate,
  browserNavState,
  browserOpenDevtools,
  browserReload,
  browserScreenshot,
  browserSetBounds,
  browserShow,
  browserZoom,
  readClipboard,
  type BrowserAnnotation,
  type Rect,
} from "../lib/browser";
import { addLink } from "../lib/sidebar";
import { DEFAULT_PROFILE, addProfile, loadProfiles } from "../lib/profiles";
import { rememberUrl } from "../lib/browser-mem";
import { emitPaneNotification, type NotificationLevel } from "../lib/notifications";
import { onAiosDrag, openViewerFileInPane, registerPaneDropSink } from "../lib/paneBus";
import { PaneDropZone } from "./PaneDropZone";

// Extensions the WKWebView can render in-page as a navigation target. Everything
// else (a .docx, .xlsx, …) goes to the in-app viewer pane instead.
const BROWSER_VIEWABLE = /\.(pdf|html?|svg|png|jpe?g|gif|webp|txt|md|json|xml|css|js)$/i;

const ANNOT_SENTINEL = "AIOS_ANNOT:";
const ANNOT_POLL_MS = 700;

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

// If a navigation STARTS but no Finished arrives within this window we treat it
// as a connection failure (dead localhost port / DNS fail). wry/tauri 2.11 has
// no load-error callback, so this timeout is the only signal we get.
const LOAD_TIMEOUT_MS = 12000;

// Hosts that are dev/loopback → treat as a URL (not a search) AND default to
// http:// (local dev servers rarely have TLS). `localhost`, `127.0.0.1`,
// `[::1]`, and any bare `host:port` (a digits-only port after a colon) qualify.
const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i;
// `something:1234` or `1.2.3.4:8080` — a bare host with an explicit port, no
// scheme. These are almost always dev servers, so treat as a URL not a search.
const HOST_PORT = /^[\w.-]+:\d{1,5}(?:[/?#]|$)/;
// A bare IPv4 (with optional port already covered above) → URL.
const BARE_IP = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/;

function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  // file:// / about: / other explicit schemes pass through untouched.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^about:/i.test(t)) return t;
  // localhost / loopback / bare IPv4 / host:port → a real URL. Loopback + bare
  // IPs default to http:// (dev servers); a named host:port also http:// since
  // it's the dev-server shape. Everything else (a public host) keeps https://.
  if (LOOPBACK_HOST.test(t) || BARE_IP.test(t)) return `http://${t}`;
  if (HOST_PORT.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+/.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

const DEFAULT_URL = "https://google.com";

export function BrowserPane({
  label,
  active = true,
  initialUrl,
  initialProfile,
  memKey,
  onAnnotate,
  onProfileChange,
  onVideoFullscreen,
}: {
  label: string;
  active?: boolean;
  /** Optional starting url (e.g. a pinned-site sidebar item deep-links here). */
  initialUrl?: string;
  /** Stable id (pinned-site sidebar id) under which to remember this pane's last
   *  location, so reopening returns where it left off. Omit = no memory. */
  memKey?: string;
  /** Fired when an in-page video enters/exits HTML fullscreen, so the app can
   *  drive TRUE fullscreen (maximize pane + fullscreen the OS window). */
  onVideoFullscreen?: (on: boolean) => void;
  /** Cookie-partition profile this pane opens in (lets a second/third Google
   *  account stay logged in alongside the first). Defaults to the shared store. */
  initialProfile?: string;
  /** Fired when an annotation or page-selection is captured (clipboard-bridge),
   *  with a formatted, chat-ready string. App wires this to the active chat. */
  onAnnotate?: (text: string) => void;
  /** Fired when the user switches this pane's profile, so App persists it on the
   *  pane model (the login sticks if the pane is reopened). */
  onProfileChange?: (profile: string) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const start = initialUrl ? normalizeUrl(initialUrl) : DEFAULT_URL;
  const [input, setInput] = useState(start);
  const [current, setCurrent] = useState(start);
  const [profile, setProfile] = useState(initialProfile || DEFAULT_PROFILE);
  const [profiles, setProfiles] = useState<string[]>(() => loadProfiles());
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfile, setNewProfile] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [deviceMode, setDeviceMode] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Surfaces a browser_show failure instead of silently showing "loading…"
  // forever (the native child-webview can fail to attach on some platforms).
  const [showError, setShowError] = useState<string | null>(null);
  // Toolbar Back/Forward enablement, read from the live WKWebView history.
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  // Page-load progress (driven by the `browser-load` event) + a connection-error
  // affordance. `loading` flips on at nav-start and off at finish; if a nav
  // starts but never finishes within LOAD_TIMEOUT_MS we surface a retry card
  // (wry/tauri has no load-error callback, so a dead port = no Finished event).
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Find-in-page bar.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMiss, setFindMiss] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  const shownRef = useRef(false);
  const inputFocusedRef = useRef(false);
  // last url we observed from the live webview — dedupes the poll so we only
  // persist + update the address bar on a real navigation.
  const lastUrlRef = useRef(start);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last clipboard payload we already consumed — so the poll only fires
  // `onAnnotate` once per fresh annotation, never re-emitting stale text.
  const lastAnnotRef = useRef<string | null>(null);
  // Latest `onAnnotate` without making it a poll-effect dependency.
  const onAnnotateRef = useRef(onAnnotate);
  onAnnotateRef.current = onAnnotate;
  // Latest video-fullscreen callback + whether we're currently reporting "on",
  // so the fullscreen poll only fires on real enter/exit transitions.
  const onVideoFullscreenRef = useRef(onVideoFullscreen);
  onVideoFullscreenRef.current = onVideoFullscreen;
  const fsOnRef = useRef(false);

  // While an in-app path-drag is armed, hide the native webview so it stops
  // painting ABOVE the React layer — then the PaneDropZone overlay underneath
  // can actually capture the drop (the webview is a top-most native view that
  // otherwise swallows everything). Re-show + re-sync bounds on drag end.
  const [dragArmed, setDragArmed] = useState(false);
  useEffect(() => onAiosDrag(setDragArmed), []);

  const rect = useCallback((): Rect | null => {
    const el = slotRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, []);

  useEffect(() => {
    if (!active || dragArmed || loadError) {
      // loadError → shrink the webview so the React "couldn't connect" card
      // underneath is visible (the native view otherwise paints over it).
      if (shownRef.current) browserHide(label).catch(() => {});
      return;
    }
    let raf = 0;
    const sync = () => {
      const r = rect();
      if (!r) return;
      if (!shownRef.current) {
        shownRef.current = true;
        browserShow(label, current, r, profile)
          .then(() => setShowError(null))
          .catch((e) => {
            shownRef.current = false; // allow a retry on the next sync tick
            setShowError(typeof e === "string" ? e : String(e));
          });
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
  }, [active, dragArmed, loadError, current, label, profile, rect]);

  // Poll the webview's REAL url (catches in-page navigation the address bar never
  // sees). On a real change: remember it (pinned sites resume here) and sync the
  // address bar — unless the user is mid-edit in it.
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (!shownRef.current) return;
      browserCurrentUrl(label)
        .then((u) => {
          if (!u || u === "about:blank" || u === lastUrlRef.current) return;
          lastUrlRef.current = u;
          rememberUrl(memKey, u);
          if (!inputFocusedRef.current) {
            setCurrent(u);
            setInput(u);
          }
        })
        .catch(() => {});
    };
    const poll = setInterval(tick, 1500);
    return () => clearInterval(poll);
  }, [active, label, memKey]);

  // Poll WKWebView element-fullscreen state. A child webview's HTML fullscreen
  // only fills its own rect, so on enter we ask the app for TRUE fullscreen
  // (maximize pane + fullscreen OS window) and undo it on exit. 1/2 = entering/in,
  // 0/3 = exiting/none.
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (!shownRef.current) return;
      browserFullscreenState(label)
        .then((s) => {
          const on = s === 1 || s === 2;
          if (on === fsOnRef.current) return;
          fsOnRef.current = on;
          onVideoFullscreenRef.current?.(on);
        })
        .catch(() => {});
    };
    const poll = setInterval(tick, 350);
    return () => clearInterval(poll);
  }, [active, label]);

  // Load progress + error state (item 5). The backend emits `browser-load` with
  // {label, phase: started|finished, url} on every navigation. On `started` we
  // reflect the url to the address bar IMMEDIATELY (no more 1500ms poll lag),
  // flip the spinner on, and arm a timeout; on `finished` we clear both. A
  // `started` with no `finished` before LOAD_TIMEOUT_MS → connection error.
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<{ label: string; phase: string; url: string }>("browser-load", ({ payload }) => {
      if (payload.label !== label) return;
      if (payload.phase === "started") {
        const u = payload.url;
        if (u && u !== "about:blank") {
          lastUrlRef.current = u;
          rememberUrl(memKey, u);
          if (!inputFocusedRef.current) {
            setCurrent(u);
            setInput(u);
          }
        }
        setLoadError(null);
        setLoading(true);
        if (loadTimer.current) clearTimeout(loadTimer.current);
        loadTimer.current = setTimeout(() => {
          // Started but never finished → treat as a failed connection.
          setLoading(false);
          setLoadError(u || lastUrlRef.current);
        }, LOAD_TIMEOUT_MS);
      } else if (payload.phase === "finished") {
        setLoading(false);
        setLoadError(null);
        if (loadTimer.current) {
          clearTimeout(loadTimer.current);
          loadTimer.current = null;
        }
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
      if (loadTimer.current) {
        clearTimeout(loadTimer.current);
        loadTimer.current = null;
      }
    };
  }, [active, label, memKey]);

  // Poll the live WKWebView back/forward history so the toolbar buttons disable
  // when there's nowhere to go (they were always-enabled no-ops before).
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (!shownRef.current) return;
      browserNavState(label)
        .then(([back, fwd]) => {
          setCanGoBack(back);
          setCanGoForward(fwd);
        })
        .catch(() => {});
    };
    tick();
    const poll = setInterval(tick, 700);
    return () => clearInterval(poll);
  }, [active, label]);

  // Switch the pane to another cookie partition. The data store is fixed at
  // webview creation, so switching = destroy the current webview + let the show
  // effect recreate it in the new profile's jar (profile is in its deps).
  const switchProfile = useCallback(
    (next: string) => {
      setProfileMenuOpen(false);
      setAddingProfile(false);
      if (next === profile) return;
      browserClose(label).catch(() => {});
      shownRef.current = false;
      setProfile(next);
      onProfileChange?.(next);
    },
    [label, profile, onProfileChange],
  );

  const commitNewProfile = useCallback(() => {
    const name = addProfile(newProfile);
    setNewProfile("");
    if (!name) {
      setAddingProfile(false);
      return;
    }
    setProfiles(loadProfiles());
    switchProfile(name);
  }, [newProfile, switchProfile]);

  // Close the profile menu on outside click.
  useEffect(() => {
    if (!profileMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
        setAddingProfile(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [profileMenuOpen]);

  useEffect(() => {
    return () => {
      // Hide (shrink to 0×0) first so the native view stops compositing
      // immediately, then close — which stops media + blanks the page Rust-side.
      // Fire-and-forget but ordered: hide before close so nothing repaints a
      // half-torn-down webview during the async close.
      shownRef.current = false;
      browserHide(label).catch(() => {});
      browserClose(label).catch(() => {});
    };
  }, [label]);

  const go = useCallback(() => {
    const url = normalizeUrl(input);
    if (!url) return;
    setCurrent(url);
    setInput(url);
    if (shownRef.current) browserNavigate(label, url).catch(() => {});
  }, [input, label]);

  // Drop sink: a file dropped into a browser pane = "show me this in the page".
  // A viewable file (pdf/html/image/…) → navigate the webview to file://<path>;
  // anything else (a .docx/.xlsx) → open it in an in-app viewer pane. A dropped
  // URL string → navigate. Returns true once consumed.
  const onDropPath = useCallback(
    (raw: string): boolean => {
      const s = raw.trim();
      if (!s) return false;
      if (/^https?:\/\//i.test(s)) {
        setCurrent(s);
        setInput(s);
        browserNavigate(label, s).catch(() => {});
        return true;
      }
      // a filesystem path
      if (BROWSER_VIEWABLE.test(s)) {
        const url = `file://${encodeURI(s)}`;
        setCurrent(url);
        setInput(url);
        browserNavigate(label, url).catch(() => {});
      } else {
        const name = s.split("/").pop() ?? s;
        openViewerFileInPane(s, name);
      }
      return true;
    },
    [label],
  );
  useEffect(
    () =>
      registerPaneDropSink(label, (paths) => {
        const first = paths.find((p) => p && p.trim());
        return first ? onDropPath(first) : false;
      }),
    [label, onDropPath],
  );

  const showToast = useCallback((msg: string, level: NotificationLevel = "info", body?: string) => {
    setToast(msg);
    emitPaneNotification({
      paneId: label,
      paneLabel: "browser",
      title: msg,
      body,
      level,
    });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, [label]);

  // Pin the current site to the sidebar (favicon resolved by the store from the
  // host). Label defaults to the hostname; the user can rename it in the rail.
  const pinSite = useCallback(() => {
    const url = current || normalizeUrl(input);
    if (!url) return;
    addLink(url);
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* keep raw */
    }
    showToast(`pinned ${host} to sidebar`, "success", url);
  }, [current, input, showToast]);

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
        showToast(`saved ${file}`, "success", path);
      })
      .catch((e) => showToast(typeof e === "string" ? e : "screenshot failed", "error"));
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
    showToast("cleared cookies + storage", "success", "browser profile data was cleared for this pane.");
  }, [label, showToast]);

  const clearCache = useCallback(() => {
    browserClearCache(label).catch(() => {});
    setMenuOpen(false);
    showToast("cleared cache", "success", "disk + memory cache cleared for this pane.");
  }, [label, showToast]);

  const forceReload = useCallback(() => {
    browserForceReload(label).catch(() => {});
    setMenuOpen(false);
  }, [label]);

  const openDevtools = useCallback(() => {
    browserOpenDevtools(label).catch(() => {});
    setMenuOpen(false);
  }, [label]);

  // Retry a failed load by re-navigating to the current url.
  const retryLoad = useCallback(() => {
    setLoadError(null);
    const u = current || normalizeUrl(input);
    if (u && shownRef.current) browserNavigate(label, u).catch(() => {});
  }, [current, input, label]);

  // Run a native find for the current query in the given direction.
  const runFind = useCallback(
    (forward: boolean) => {
      const q = findQuery.trim();
      if (!q) {
        setFindMiss(false);
        return;
      }
      browserFind(label, q, forward)
        .then((found) => setFindMiss(!found))
        .catch(() => setFindMiss(false));
    },
    [findQuery, label],
  );

  const openFind = useCallback(() => {
    setFindOpen(true);
    setFindMiss(false);
    // focus the input next tick (after it mounts)
    setTimeout(() => findInputRef.current?.focus(), 0);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindMiss(false);
  }, []);

  // ⌘F opens find-in-page when THIS browser pane is the active one. App.tsx
  // detects "active pane is a browser" (the native ⌘F menu accelerator + the
  // in-React keydown both route there) and dispatches a window CustomEvent
  // `aios-browser-find` carrying the target pane label. We match on our label so
  // only the focused browser pane's find bar opens. This is the R5 reconciliation
  // of the R2a ⌘F→pane-fullscreen binding: browser focused → find; else → fs.
  useEffect(() => {
    if (!active) return;
    const onFind = (e: Event) => {
      const detail = (e as CustomEvent<{ label?: string }>).detail;
      if (detail?.label && detail.label !== label) return;
      openFind();
    };
    window.addEventListener("aios-browser-find", onFind as EventListener);
    return () => window.removeEventListener("aios-browser-find", onFind as EventListener);
  }, [active, label, openFind]);

  // Turn a captured annotation/selection into one chat-ready line.
  const formatAnnotation = useCallback((a: BrowserAnnotation): string => {
    const note = a.note || "(no note)";
    if (a.tagName === "selection" || !a.selector) {
      return `selection: "${note}" (${a.url})`;
    }
    const text = a.text ? ` — element text: "${a.text}"` : "";
    return `annotation on ${a.selector}: "${note}"${text} (${a.url})`;
  }, []);

  // Read the clipboard, and if it carries a FRESH AIOS_ANNOT payload, emit it.
  // Returns true when an annotation was consumed (so the caller can exit mode).
  const consumeAnnotation = useCallback((): Promise<boolean> => {
    return readClipboard()
      .then((raw) => {
        if (!raw || !raw.startsWith(ANNOT_SENTINEL)) return false;
        if (raw === lastAnnotRef.current) return false; // already handled
        lastAnnotRef.current = raw;
        let parsed: BrowserAnnotation;
        try {
          parsed = JSON.parse(raw.slice(ANNOT_SENTINEL.length)) as BrowserAnnotation;
        } catch {
          return false;
        }
        onAnnotateRef.current?.(formatAnnotation(parsed));
        return true;
      })
      .catch(() => false);
  }, [formatAnnotation]);

  const exitAnnotate = useCallback(() => {
    setAnnotating(false);
    browserExitAnnotate(label).catch(() => {});
  }, [label]);

  const toggleAnnotate = useCallback(() => {
    if (annotating) {
      exitAnnotate();
      return;
    }
    // Snapshot current clipboard as already-seen so we don't grab a stale
    // AIOS_ANNOT left over from a previous session as if it were new.
    readClipboard()
      .then((raw) => {
        lastAnnotRef.current = raw && raw.startsWith(ANNOT_SENTINEL) ? raw : null;
      })
      .catch(() => {})
      .finally(() => {
        setAnnotating(true);
        browserEnterAnnotate(label)
          .then(() => showToast("annotate: click an element on the page"))
          .catch((e) => {
            setAnnotating(false);
            showToast(typeof e === "string" ? e : "annotate failed", "error");
          });
      });
  }, [annotating, exitAnnotate, label, showToast]);

  // "Send selection to chat": copy the page's current text selection to the
  // clipboard (sentinel-tagged), then read it straight back and emit.
  const sendSelection = useCallback(() => {
    browserCopySelection(label)
      .then(() => new Promise((r) => setTimeout(r, 120))) // let clipboard settle
      .then(() => consumeAnnotation())
      .then((ok) => showToast(ok ? "selection sent to chat" : "no text selected", ok ? "success" : "warning"))
      .catch((e) => showToast(typeof e === "string" ? e : "selection failed", "error"));
  }, [consumeAnnotation, label, showToast]);

  // While annotating, poll the clipboard for a submitted annotation, then exit.
  useEffect(() => {
    if (!annotating) return;
    let stop = false;
    const id = setInterval(() => {
      if (stop) return;
      consumeAnnotation().then((ok) => {
        if (ok && !stop) exitAnnotate();
      });
    }, ANNOT_POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [annotating, consumeAnnotation, exitAnnotate]);

  // Tear down annotate mode if the pane is hidden or unmounts.
  useEffect(() => {
    if (!active && annotating) exitAnnotate();
  }, [active, annotating, exitAnnotate]);
  useEffect(() => {
    return () => {
      browserExitAnnotate(label).catch(() => {});
    };
  }, [label]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-2">
        <NavBtn
          title="Back"
          disabled={!canGoBack}
          onClick={() => browserBack(label).catch(() => {})}
        >
          <ArrowLeft size={14} />
        </NavBtn>
        <NavBtn
          title="Forward"
          disabled={!canGoForward}
          onClick={() => browserForward(label).catch(() => {})}
        >
          <ArrowRight size={14} />
        </NavBtn>
        <NavBtn
          title={loading ? "Stop" : "Reload"}
          onClick={() => browserReload(label).catch(() => {})}
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />}
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
            onFocus={() => (inputFocusedRef.current = true)}
            onBlur={() => (inputFocusedRef.current = false)}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 font-mono text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/50"
            placeholder="search or enter url"
          />
        </form>
        <NavBtn title="Pin this site to the sidebar" onClick={pinSite}>
          <Pin size={13} />
        </NavBtn>
        <NavBtn title="Open in system browser" onClick={() => openUrl(current).catch(() => {})}>
          <ExternalLink size={13} />
        </NavBtn>
        <NavBtn title="Screenshot" onClick={onScreenshot}>
          <Camera size={13} />
        </NavBtn>
        <NavBtn title="Open DevTools (Web Inspector)" onClick={openDevtools}>
          <Terminal size={13} />
        </NavBtn>
        <NavBtn title="Find in page (⌘F)" onClick={openFind}>
          <Search size={13} />
        </NavBtn>
        <NavBtn title="Send selection to chat" onClick={sendSelection}>
          <MessageSquarePlus size={14} />
        </NavBtn>
        <button
          type="button"
          onClick={toggleAnnotate}
          title={annotating ? "Stop annotating" : "Annotate page → chat"}
          aria-pressed={annotating}
          className={
            annotating
              ? "rounded p-1.5 bg-[var(--color-accent)]/15 text-[var(--color-accent)] transition-colors"
              : "rounded p-1.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          }
        >
          {annotating ? (
            <Crosshair size={14} />
          ) : (
            <SquareDashedMousePointer size={14} />
          )}
        </button>
        <div ref={profileMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setProfileMenuOpen((o) => !o)}
            title="Account profile (separate logins)"
            className={
              profile === DEFAULT_PROFILE
                ? "flex items-center gap-1 rounded p-1.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                : "flex items-center gap-1 rounded px-1.5 py-1 bg-[var(--color-accent)]/15 text-[var(--color-accent)] transition-colors"
            }
          >
            <Users size={14} />
            {profile !== DEFAULT_PROFILE && (
              <span className="max-w-[72px] truncate text-[11px] font-medium">{profile}</span>
            )}
          </button>
          {profileMenuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] py-1 text-[12px] text-[var(--color-text)] shadow-lg">
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
                account profile
              </div>
              {profiles.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => switchProfile(p)}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-[var(--color-panel)]"
                >
                  <span className="truncate">{p === DEFAULT_PROFILE ? "default" : p}</span>
                  {p === profile && <Check size={13} className="text-[var(--color-accent)]" />}
                </button>
              ))}
              <div className="my-1 border-t border-[var(--color-border)]" />
              {addingProfile ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitNewProfile();
                  }}
                  className="px-2 py-1"
                >
                  <input
                    autoFocus
                    value={newProfile}
                    onChange={(e) => setNewProfile(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setAddingProfile(false);
                        setNewProfile("");
                      }
                    }}
                    placeholder="name e.g. work"
                    spellCheck={false}
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/50"
                  />
                </form>
              ) : (
                <MenuItem
                  icon={<Plus size={13} />}
                  label="New account…"
                  onClick={() => {
                    setAddingProfile(true);
                    setNewProfile("");
                  }}
                />
              )}
            </div>
          )}
        </div>
        <div ref={menuRef} className="relative">
          <NavBtn title="Options" onClick={() => setMenuOpen((o) => !o)}>
            <MoreVertical size={14} />
          </NavBtn>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] py-1 text-[12px] text-[var(--color-text)] shadow-lg">
              <MenuItem
                icon={<Terminal size={13} />}
                label="Open DevTools"
                onClick={openDevtools}
              />
              <MenuItem
                icon={<Search size={13} />}
                label="Find in page"
                onClick={() => {
                  setMenuOpen(false);
                  openFind();
                }}
              />
              <MenuItem
                icon={<RotateCw size={13} />}
                label="Force reload (bypass cache)"
                onClick={forceReload}
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
                label="Clear cookies + storage"
                onClick={clearCookies}
              />
              <MenuItem
                icon={<Trash2 size={13} />}
                label="Clear cache"
                onClick={clearCache}
              />
            </div>
          )}
        </div>
      </div>

      {/* Find-in-page bar — lives in REACT chrome (a row under the toolbar), not
          over the native webview, so it's always visible regardless of the
          webview compositing above the React layer. */}
      {findOpen && (
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-2">
          <Search size={13} className="text-[var(--color-muted)]" />
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value);
              setFindMiss(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runFind(!e.shiftKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              }
            }}
            spellCheck={false}
            placeholder="find in page"
            className={
              "min-w-0 flex-1 rounded-md border bg-[var(--color-bg)] px-2.5 py-1 font-mono text-[12px] text-[var(--color-text)] outline-none " +
              (findMiss
                ? "border-[var(--color-danger)]"
                : "border-[var(--color-border)] focus:border-[var(--color-accent)]/50")
            }
          />
          {findMiss && findQuery.trim() && (
            <span className="text-[11px] text-[var(--color-danger)]">no match</span>
          )}
          <NavBtn title="Previous (⇧⏎)" onClick={() => runFind(false)}>
            <ChevronUp size={14} />
          </NavBtn>
          <NavBtn title="Next (⏎)" onClick={() => runFind(true)}>
            <ChevronDown size={14} />
          </NavBtn>
          <NavBtn title="Close (Esc)" onClick={closeFind}>
            <X size={14} />
          </NavBtn>
        </div>
      )}

      <div ref={slotRef} className="relative min-h-0 flex-1">
        {/* Thin top progress bar while a navigation is in flight. */}
        {loading && !loadError && (
          <div className="pointer-events-none absolute left-0 right-0 top-0 z-[60] h-0.5 overflow-hidden">
            <div className="h-full w-1/3 animate-[browserprog_1.1s_ease-in-out_infinite] bg-[var(--color-accent)]" />
          </div>
        )}
        <PaneDropZone onPath={onDropPath} label="drop to open in this page">
          <div className="absolute inset-0" />
        </PaneDropZone>
        {loadError ? (
          <div className="absolute inset-0 z-[55] grid place-items-center bg-[var(--color-pane)] px-6 text-center">
            <div className="max-w-sm">
              <div className="text-[13px] font-medium text-[var(--color-text)]">
                couldn't connect
              </div>
              <div className="mt-1 break-all font-mono text-[11px] text-[var(--color-muted)]">
                {loadError}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-faint)]">
                the server didn't respond. if this is a dev server, check it's
                running and on the right port.
              </p>
              <button
                type="button"
                onClick={retryLoad}
                className="mt-3 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white"
              >
                retry
              </button>
            </div>
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-[11px] text-[var(--color-faint)]">
            {showError ? (
              <span className="max-w-md text-[var(--color-danger)]">
                native browser failed to load: {showError}
              </span>
            ) : (
              "loading native browser…"
            )}
          </div>
        )}
        {annotating && (
          <div className="pointer-events-none absolute left-1/2 top-2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-panel-2)] px-3 py-1 text-[11px] text-[var(--color-accent)] shadow-lg">
            <Crosshair size={12} />
            annotating… click an element, then describe it
          </div>
        )}
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
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={
        disabled
          ? "rounded p-1.5 text-[var(--color-faint)] opacity-40 cursor-default"
          : "rounded p-1.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
      }
    >
      {children}
    </button>
  );
}
