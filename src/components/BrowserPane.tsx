/** Browser pane — drives a NATIVE child webview (real WebKit, renders any site,
 *  no iframe blocking). Each pane owns its own webview keyed by `label`. The
 *  component is just the chrome (url bar + nav) plus a placeholder div whose
 *  on-screen rect the webview tracks. `active=false` (a modal is open, or the
 *  pane is hidden) shrinks the webview to 0 so HTML modals aren't occluded. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronUp,
  Clock,
  Crosshair,
  Download,
  ExternalLink,
  Folder,
  FolderOpen,
  Globe,
  Loader2,
  MessageSquarePlus,
  MoreVertical,
  Pin,
  Check,
  Copy,
  Plus,
  RotateCw,
  Search,
  Smartphone,
  SquareDashedMousePointer,
  Star,
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
  browserHistoryRecord,
  browserInstallContextProbe,
  browserHistoryQuery,
  browserBookmarkAdd,
  browserBookmarkRemove,
  browserBookmarkList,
  browserDownloadList,
  browserDownloadForget,
  browserDownloadClear,
  browserRevealInFinder,
  onBrowserLoadError,
  onBrowserNavState,
  readClipboard,
  type BrowserAnnotation,
  type BrowserContextPayload,
  type Bookmark,
  type DownloadRecord,
  type HistoryEntry,
  type Rect,
} from "../lib/browser";
import { addLink } from "../lib/sidebar";
import { DEFAULT_PROFILE, addProfile, loadProfiles } from "../lib/profiles";
import { rememberUrl } from "../lib/browser-mem";
import { type NotificationLevel } from "../lib/notifications";
import { onAiosDrag, openViewerFileInPane, registerPaneDropSink, spawnPane, taskSpawnContext } from "../lib/paneBus";
import type { TaskId } from "../lib/taskWorkspace";
import { homeDir } from "../lib/fs";
import { PaneDropZone } from "./PaneDropZone";
import { reportDiag, reportError } from "../lib/diag";
import { isLikelySearch, normalizeUrl } from "../lib/urlNormalize";

// Extensions the WKWebView can render in-page as a navigation target. Everything
// else (a .docx, .xlsx, …) goes to the in-app viewer pane instead.
const BROWSER_VIEWABLE = /\.(pdf|html?|svg|png|jpe?g|gif|webp|txt|md|json|xml|css|js)$/i;

const ANNOT_SENTINEL = "AIOS_ANNOT:";
const CONTEXT_SENTINEL = "AIOS_CONTEXT:";
const ANNOT_POLL_MS = 700;

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

// If a navigation STARTS but no Finished arrives within this window we treat it
// as a connection failure (dead localhost port / DNS fail). wry/tauri 2.11 has
// no load-error callback, so this timeout is the only signal we get.
const LOAD_TIMEOUT_MS = 12000;
const SUGGESTION_RESERVE_PX = 320;

type OmniboxRow =
  | { type: "search"; query: string }
  | { type: "go"; url: string; label: string }
  | { type: "bookmark"; bookmark: Bookmark }
  | { type: "history"; entry: HistoryEntry }
  | { type: "action"; action: "new-pane" | "send-chat" | "curl-terminal" | "downloads"; label: string; detail: string };

/** Origin of a URL, or null if unparseable. Used to tell a main-frame navigation
 *  from a cross-origin sub-frame (auth/widget iframes like studio.youtube.com or
 *  ogs.google.com) — `on_navigation` fires for BOTH, but only the main frame
 *  should drive the address bar + the connection-error timeout. */
function originOf(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

// normalizeUrl / isLikelySearch moved to src/lib/urlNormalize.ts (pure, unit-
// tested): dev/loopback shapes (localhost, 127.0.0.1, 0.0.0.0, *.local, raw
// IPs, host:port) navigate directly over http://, dotted public hosts get
// https://, everything else goes to the search engine.

const DEFAULT_URL = "https://google.com";

function escapeShellSingleQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

const SEARCH_SUGGESTIONS = [
  "google meet",
  "google drive",
  "google sheets",
  "gmail",
  "youtube",
  "whatsapp web",
  "github",
  "product hunt",
  "neon console",
  "cloudflare dashboard",
  "vercel dashboard",
];

function suggestedSearchesFor(input: string): string[] {
  const q = input.trim().toLowerCase();
  if (!q || q.length < 2) return [];
  return SEARCH_SUGGESTIONS.filter((item) => item.includes(q) && item !== q).slice(0, 4);
}

export function BrowserPane({
  label,
  active = true,
  initialUrl,
  initialProfile,
  memKey,
  onAnnotate,
  onProfileChange,
  onVideoFullscreen,
  taskId,
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
  /** Optional owner carried into panes explicitly opened from this browser. */
  taskId?: TaskId;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  // Memory key for "resume where I left off". A pinned site passes its stable
  // sidebar id as `memKey`; a generic browser pane has none, so fall back to the
  // pane `label` (= the pane key, which the layout persists + reuses on restore —
  // App.tsx B1). Either way the pane's last url is recorded under this key, and
  // App reads it back via recallPaneUrl on restore so the pane reopens in place.
  const mem = memKey ?? label;
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
  // Address-bar autocomplete (item 1): history matches for the current input,
  // a dropdown open flag, and the highlighted row index (↑/↓ navigation).
  const [suggestions, setSuggestions] = useState<HistoryEntry[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(-1);
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bookmarks (item 2): the full list + whether the CURRENT page is bookmarked
  // (drives the star fill), plus the bookmarks dropdown open flag.
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const bookmarksRef = useRef<HTMLDivElement>(null);
  // Downloads (item 3): the persisted list + the panel open flag.
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const downloadsRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(false);
  const inputFocusedRef = useRef(false);
  // last url we observed from the live webview — dedupes the poll so we only
  // persist + update the address bar on a real navigation.
  const lastUrlRef = useRef(start);
  // Origin of the main-frame navigation the user actually initiated. Set on a
  // user navigation (go / drop-url) and locked in on the first matching `started`.
  // Cross-origin `started` events (sub-frame auth/widget iframes) are ignored so
  // a slow/blocked iframe can't falsely "couldn't connect" the whole page.
  const navTargetOriginRef = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last clipboard payload we already consumed — so the poll only fires
  // `onAnnotate` once per fresh annotation, never re-emitting stale text.
  const lastAnnotRef = useRef<string | null>(null);
  const lastContextRef = useRef<string | null>(null);
  const [contextMenu, setContextMenu] = useState<BrowserContextPayload | null>(null);
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

  // Any toolbar dropdown / omnibox open ⇒ the native webview (a top-most native
  // view) would paint OVER the panel and clip it — the exact "buttons up here
  // don't work" bug: the panel opens but is invisible behind the page. AppCastPane
  // hit the identical problem with its window-picker and solved it by hiding the
  // native view while the picker is open; we do the same. Cheap: the page is
  // preserved (hide = shrink to 0×0), restored the instant you dismiss.
  //   findOpen is intentionally NOT here — the find-bar is a chrome row that
  //   pushes the slot DOWN (it never overlaps the page), and hiding the webview
  //   would hide the very matches you're searching for.
  const overlayOpen =
    bookmarksOpen || downloadsOpen || menuOpen || profileMenuOpen || suggestOpen;

  useEffect(() => {
    if (!active || dragArmed || loadError || contextMenu || overlayOpen) {
      // loadError → shrink the webview so the React "couldn't connect" card
      // underneath is visible (the native view otherwise paints over it).
      // overlayOpen → same reason: let a toolbar dropdown show through.
      if (shownRef.current) browserHide(label).catch((e) => reportDiag("browser.hide", e, { action: "hide" }));
      return;
    }
    let raf = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const settleTimers: ReturnType<typeof setTimeout>[] = [];
    const sync = () => {
      const r = rect();
      if (!r) return;
      if (!shownRef.current) {
        shownRef.current = true;
        browserShow(label, current, r, profile)
          .then(() => {
            setShowError(null);
            browserInstallContextProbe(label).catch((e) =>
              reportDiag("browser.context", e, { action: "installProbe" }),
            );
          })
          .catch((e) => {
            shownRef.current = false; // allow a retry on the next sync tick
            setShowError(typeof e === "string" ? e : String(e));
          });
      } else {
        browserSetBounds(label, r).catch((e) => reportDiag("browser.bounds", e, { action: "setBounds" }));
      }
    };
    // Resize/fullscreen changes are bursty (one per animation frame during a
    // window drag). Debounce so we fire ONE bounds-sync after motion settles
    // instead of a setTimeout storm per event — the storm is a big lag source and
    // makes the webview visibly judder as it chases the rect mid-drag.
    const syncSettled = () => {
      sync(); // immediate, so the webview tracks during the drag
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sync, 120); // one final settle after motion stops
    };
    raf = requestAnimationFrame(() => requestAnimationFrame(sync));
    // The ResizeObserver already fires on every real slot-size change, so it —
    // not a tight interval — is the primary bounds driver. The old 250ms poll
    // hammered a browser_set_bounds IPC ~4×/sec FOREVER even when nothing moved
    // (pure lag with no benefit). A slow 1s safety poll catches the rare case a
    // layout shift moves the slot's screen position without resizing it (e.g. a
    // sibling pane closing) which the RO can't see.
    const ro = new ResizeObserver(sync);
    if (slotRef.current) ro.observe(slotRef.current);
    window.addEventListener("resize", syncSettled);
    document.addEventListener("fullscreenchange", syncSettled);
    const poll = setInterval(sync, 1000);
    return () => {
      cancelAnimationFrame(raf);
      if (resizeTimer) clearTimeout(resizeTimer);
      settleTimers.forEach(clearTimeout);
      ro.disconnect();
      window.removeEventListener("resize", syncSettled);
      document.removeEventListener("fullscreenchange", syncSettled);
      clearInterval(poll);
    };
  }, [active, dragArmed, loadError, contextMenu, overlayOpen, current, label, profile, rect]);

  // Push-driven nav state from the native WKWebView KVO/delegate observer. This
  // is the hot path for back/fwd enablement, address-bar sync, loading state and
  // real load errors; the old polls below stay only as slow safety fallbacks.
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let unNav: (() => void) | undefined;
    let unErr: (() => void) | undefined;
    const applyUrl = (u: string) => {
      if (!u || u === "about:blank") return;
      const changed = u !== lastUrlRef.current;
      if (changed) {
        lastUrlRef.current = u;
        rememberUrl(mem, u);
        browserHistoryRecord(u).catch((e) =>
          reportError("browser.history", e, { action: "record" }),
        );
      }
      if (!inputFocusedRef.current) {
        setCurrent(u);
        setInput(u);
      }
    };
    void onBrowserNavState((payload) => {
      if (payload.label !== label) return;
      setCanGoBack(payload.canBack);
      setCanGoForward(payload.canFwd);
      setLoading(payload.loading);
      applyUrl(payload.url);
      if (payload.loading) setLoadError(null);
      else if (loadTimer.current) {
        clearTimeout(loadTimer.current);
        loadTimer.current = null;
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unNav = stop;
      })
      .catch((e) => reportDiag("browser.listen", e, { action: "navStatePush" }));
    void onBrowserLoadError((payload) => {
      if (payload.label !== label) return;
      if (loadTimer.current) {
        clearTimeout(loadTimer.current);
        loadTimer.current = null;
      }
      const u = payload.url || lastUrlRef.current;
      setLoading(false);
      setLoadError(u || payload.description || "navigation failed");
    })
      .then((stop) => {
        if (disposed) stop();
        else unErr = stop;
      })
      .catch((e) => reportDiag("browser.listen", e, { action: "loadErrorPush" }));
    return () => {
      disposed = true;
      unNav?.();
      unErr?.();
    };
  }, [active, label, mem]);

  // Slow safety poll for the webview's REAL url (non-mac fallback / missed event
  // guard). Push events above do the normal address-bar work instantly.
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (!shownRef.current) return;
      browserCurrentUrl(label)
        .then((u) => {
          if (!u || u === "about:blank" || u === lastUrlRef.current) return;
          lastUrlRef.current = u;
          rememberUrl(mem, u);
          // Record to persistent history (title best-effort; the load-finished
          // path fills a better one in). Dedup is server-side (bumps visit_count).
          browserHistoryRecord(u).catch((e) => reportError("browser.history", e, { action: "record" }));
          if (!inputFocusedRef.current) {
            setCurrent(u);
            setInput(u);
          }
        })
        .catch((e) => reportDiag("browser.url", e, { action: "currentUrl" }));
    };
    const poll = setInterval(tick, 5000);
    return () => clearInterval(poll);
  }, [active, label, mem]);

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
        .catch((e) => reportDiag("browser.fullscreen", e, { action: "statePoll" }));
    };
    const poll = setInterval(tick, 350);
    return () => clearInterval(poll);
  }, [active, label]);

  const trimmedInput = input.trim();
  const omniboxRows = useMemo<OmniboxRow[]>(() => {
    if (!suggestOpen) return [];
    const q = trimmedInput;
    const qLower = q.toLowerCase();
    const rows: OmniboxRow[] = [];

    if (isLikelySearch(q)) {
      rows.push({ type: "search", query: q });
      for (const suggested of suggestedSearchesFor(q)) {
        rows.push({ type: "search", query: suggested });
      }
    } else if (q) {
      const url = normalizeUrl(q);
      if (url && url !== current) rows.push({ type: "go", url, label: q });
    }

    const seen = new Set<string>();
    for (const s of suggestions) {
      seen.add(s.url);
    }
    for (const b of bookmarks) {
      if (!qLower) break;
      const title = (b.title || "").toLowerCase();
      const url = b.url.toLowerCase();
      if (!title.includes(qLower) && !url.includes(qLower)) continue;
      if (seen.has(b.url)) continue;
      rows.push({ type: "bookmark", bookmark: b });
      seen.add(b.url);
      if (rows.filter((r) => r.type === "bookmark").length >= 3) break;
    }

    for (const entry of suggestions) {
      rows.push({ type: "history", entry });
    }

    if (current && current !== "about:blank") {
      rows.push(
        { type: "action", action: "new-pane", label: "open current page in new browser", detail: current },
        { type: "action", action: "send-chat", label: "send current page to chat", detail: current },
        { type: "action", action: "curl-terminal", label: "inspect page in terminal", detail: "curl -L current url" },
      );
    }
    rows.push({ type: "action", action: "downloads", label: "open downloads in files", detail: "~/downloads" });

    return rows.slice(0, 12);
  }, [bookmarks, current, suggestions, suggestOpen, trimmedInput]);
  const visibleSuggestionCount = omniboxRows.length;
  const suggestionsVisible = suggestOpen && visibleSuggestionCount > 0;
  const suggestionReserveHeight = suggestionsVisible ? Math.min(SUGGESTION_RESERVE_PX, 50 + visibleSuggestionCount * 38) : 0;

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
        if (!u || u === "about:blank") return;
        // Main frame = same origin as the navigation the user initiated. A null
        // target means we haven't locked one yet (initial load / back-fwd), so the
        // first started establishes it. Cross-origin starteds = sub-frame iframes
        // (studio.youtube.com, ogs.google.com, …) → ignore them: they must NOT
        // hijack the address bar or arm the connection-error timer (the bug where
        // a slow auth iframe falsely "couldn't connect" the whole loaded page).
        const origin = originOf(u);
        const isMainFrame =
          navTargetOriginRef.current == null || origin === navTargetOriginRef.current;
        if (!isMainFrame) return;
        navTargetOriginRef.current = origin; // lock the main-frame origin
        lastUrlRef.current = u;
        rememberUrl(mem, u);
        browserHistoryRecord(u).catch((e) => reportError("browser.history", e, { action: "record" }));
        if (!inputFocusedRef.current) {
          setCurrent(u);
          setInput(u);
        }
        setLoadError(null);
        setLoading(true);
        if (loadTimer.current) clearTimeout(loadTimer.current);
        loadTimer.current = setTimeout(() => {
          // Main frame started but never finished → real connection failure.
          setLoading(false);
          setLoadError(u || lastUrlRef.current);
        }, LOAD_TIMEOUT_MS);
      } else if (payload.phase === "finished") {
        setLoading(false);
        setLoadError(null);
        browserInstallContextProbe(label).catch((e) =>
          reportDiag("browser.context", e, { action: "installProbe" }),
        );
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
      .catch((e) => reportDiag("browser.listen", e, { action: "navState" }));
    return () => {
      disposed = true;
      unlisten?.();
      if (loadTimer.current) {
        clearTimeout(loadTimer.current);
        loadTimer.current = null;
      }
    };
  }, [active, label, mem]);

  // Slow safety poll for back/forward enablement. Native KVO push above is the
  // primary path; this catches non-mac fallback / missed observer events.
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (!shownRef.current) return;
      browserNavState(label)
        .then(([back, fwd]) => {
          setCanGoBack(back);
          setCanGoForward(fwd);
        })
        .catch((e) => reportDiag("browser.nav", e, { action: "navState" }));
    };
    tick();
    const poll = setInterval(tick, 5000);
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
      browserClose(label).catch((e) => reportDiag("browser.close", e, { action: "close" }));
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
      browserHide(label).catch((e) => reportDiag("browser.hide", e, { action: "cleanup" }));
      browserClose(label).catch((e) => reportDiag("browser.close", e, { action: "cleanup" }));
    };
  }, [label]);

  const go = useCallback(() => {
    const url = normalizeUrl(input);
    if (!url) return;
    setSuggestOpen(false);
    setSuggestIdx(-1);
    setCurrent(url);
    setInput(url);
    if (shownRef.current) browserNavigate(label, url).catch((e) => reportDiag("browser.nav", e, { action: "navigate" }));
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
        browserNavigate(label, s).catch((e) => reportDiag("browser.nav", e, { action: "navigate" }));
        return true;
      }
      // a filesystem path
      if (BROWSER_VIEWABLE.test(s)) {
        const url = `file://${encodeURI(s)}`;
        setCurrent(url);
        setInput(url);
        browserNavigate(label, url).catch((e) => reportDiag("browser.nav", e, { action: "navigate" }));
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

  const showToast = useCallback((msg: string, _level: NotificationLevel = "info", _body?: string) => {
    // Local toast only. Mirroring every browser toast ("screenshot saved",
    // "couldn't reveal file", etc.) into the bell was noise — the pane already
    // shows them. Download-complete as a real, deep-linking notification is wired
    // separately (Phase 2) off the `browser-download` event, not here.
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

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

  // ── Bookmarks (item 2) ──────────────────────────────────────────────────
  // Load once on mount so the star reflects state immediately.
  useEffect(() => {
    browserBookmarkList()
      .then(setBookmarks)
      .catch((e) => reportDiag("browser.bookmark", e, { action: "list" }));
  }, []);

  // Is the CURRENT page bookmarked? (drives the star fill). Computed from the
  // live list + current url — no extra round-trip.
  const isBookmarked = bookmarks.some((b) => b.url === current);

  // Star toggle: bookmark the current page, or remove it if already bookmarked.
  const toggleBookmark = useCallback(() => {
    const url = current || normalizeUrl(input);
    if (!url || url === "about:blank") return;
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* keep raw */
    }
    const already = bookmarks.some((b) => b.url === url);
    if (already) {
      browserBookmarkRemove({ url })
        .then(setBookmarks)
        .catch((e) => reportDiag("browser.bookmark", e, { action: "remove" }));
      showToast(`removed bookmark`, "info");
    } else {
      browserBookmarkAdd(url, host)
        .then(setBookmarks)
        .catch((e) => reportDiag("browser.bookmark", e, { action: "add" }));
      showToast(`bookmarked ${host}`, "success", url);
    }
  }, [bookmarks, current, input, showToast]);

  // Open a bookmark in THIS pane (matches the tab=pane convention — a fresh pane
  // is one ⌘T away; a bookmark click navigates the current pane).
  const openBookmark = useCallback(
    (url: string) => {
      setBookmarksOpen(false);
      setCurrent(url);
      setInput(url);
      if (shownRef.current) browserNavigate(label, url).catch((e) => reportDiag("browser.nav", e, { action: "openBookmark" }));
    },
    [label],
  );

  const removeBookmark = useCallback((bm: Bookmark) => {
    browserBookmarkRemove({ id: bm.id })
      .then(setBookmarks)
      .catch((e) => reportDiag("browser.bookmark", e, { action: "remove" }));
  }, []);

  // Close the bookmarks dropdown on outside click.
  useEffect(() => {
    if (!bookmarksOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (bookmarksRef.current && !bookmarksRef.current.contains(e.target as Node)) {
        setBookmarksOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [bookmarksOpen]);

  // ── Downloads (item 3) ──────────────────────────────────────────────────
  // Load the persisted list on mount.
  useEffect(() => {
    browserDownloadList()
      .then(setDownloads)
      .catch((e) => reportDiag("browser.download", e, { action: "list" }));
  }, []);

  // Refresh the downloads list whenever a new download finishes (the backend
  // emits `browser-download` after persisting it). Any pane refreshes — the
  // store is global — so the panel is live regardless of which pane downloaded.
  // Gated on `active`: an inactive/hidden pane can't download, and the panel
  // re-loads fresh on mount + on becoming active, so an idle pane needn't keep a
  // live event subscription burning (background-work discipline).
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<{ path: string; name?: string }>("browser-download", () => {
      browserDownloadList()
        .then(setDownloads)
        .catch((e) => reportError("browser.download", e, { action: "refresh" }));
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((e) => reportDiag("browser.download", e, { action: "listen" }));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active]);

  const revealDownload = useCallback(
    (d: DownloadRecord) => {
      browserRevealInFinder(d.path).catch((e) => {
        reportError("browser.reveal", e, { action: "revealInFinder" });
        showToast(typeof e === "string" ? e : "couldn't reveal file", "error");
      });
    },
    [showToast],
  );

  const openDownload = useCallback((d: DownloadRecord) => {
    setDownloadsOpen(false);
    const name = d.name || d.path.split("/").pop() || d.path;
    openViewerFileInPane(d.path, name);
  }, []);

  const forgetDownload = useCallback((id: string) => {
    browserDownloadForget(id)
      .then(setDownloads)
      .catch((e) => reportDiag("browser.download", e, { action: "forget" }));
  }, []);

  const clearDownloads = useCallback(() => {
    browserDownloadClear()
      .then(() => setDownloads([]))
      .catch((e) => reportDiag("browser.download", e, { action: "clear" }));
  }, []);

  // Open the containing folder of a download in a files pane (cross-pane spawn).
  const openDownloadInFiles = useCallback((d: DownloadRecord) => {
    setDownloadsOpen(false);
    const dir = d.path.replace(/\/[^/]*$/, "");
    spawnPane("files", { path: dir || d.path, ...taskSpawnContext(taskId) });
  }, [taskId]);

  // Close the downloads panel on outside click.
  useEffect(() => {
    if (!downloadsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (downloadsRef.current && !downloadsRef.current.contains(e.target as Node)) {
        setDownloadsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [downloadsOpen]);

  // ── Address-bar autocomplete (item 1) ───────────────────────────────────
  // Query history as the user types (debounced). Only when the input is focused
  // AND differs from the committed url (i.e. actually editing). The dropdown
  // closes on blur/escape/enter.
  const refreshSuggestions = useCallback((q: string) => {
    browserHistoryQuery(q, 8)
      .then((rows) => {
        setSuggestions(rows);
        setSuggestOpen(rows.length > 0 || q.trim().length > 0);
        setSuggestIdx(-1);
      })
      .catch(() => {
        setSuggestions([]);
        setSuggestOpen(q.trim().length > 0);
      });
  }, []);

  // Pick a suggestion: navigate to its url immediately.
  const pickSuggestion = useCallback(
    (url: string) => {
      setSuggestOpen(false);
      setSuggestIdx(-1);
      const norm = normalizeUrl(url);
      setCurrent(norm);
      setInput(norm);
      if (shownRef.current) browserNavigate(label, norm).catch((e) => reportDiag("browser.nav", e, { action: "pickSuggestion" }));
    },
    [label],
  );

  const sendCurrentPageToChat = useCallback(() => {
    const url = current || normalizeUrl(input);
    if (!url || url === "about:blank") return;
    onAnnotateRef.current?.(`browser page: ${url}`);
    showToast("page sent to chat", "success");
  }, [current, input, showToast]);

  const openCurrentInNewPane = useCallback(() => {
    const url = current || normalizeUrl(input);
    if (!url || url === "about:blank") return;
    spawnPane("browser", { url, label: "browser", ...taskSpawnContext(taskId) });
    showToast("opened page in new browser", "success");
  }, [current, input, showToast]);

  const inspectCurrentInTerminal = useCallback(() => {
    const url = current || normalizeUrl(input);
    if (!url || url === "about:blank") return;
    spawnPane("terminal", {
      cmd: `curl -L ${escapeShellSingleQuote(url)} | sed -n '1,160p'`,
      label: "terminal · web inspect",
      ...taskSpawnContext(taskId),
    });
    showToast("opened terminal inspector", "success");
  }, [current, input, showToast, taskId]);

  const openUrlInNewPane = useCallback(
    (url: string) => {
      if (!url || url === "about:blank") return;
      spawnPane("browser", { url, label: "browser", ...taskSpawnContext(taskId) });
      setContextMenu(null);
      showToast("opened link in new browser", "success");
    },
    [showToast, taskId],
  );

  const sendContextToChat = useCallback(
    (ctx: BrowserContextPayload) => {
      const target = ctx.linkUrl || ctx.url;
      const text = ctx.text ? `\nselection: "${ctx.text}"` : "";
      onAnnotateRef.current?.(`browser context: ${target}${text}`);
      setContextMenu(null);
      showToast("context sent to chat", "success");
    },
    [showToast],
  );

  const inspectUrlInTerminal = useCallback(
    (url: string) => {
      if (!url || url === "about:blank") return;
      spawnPane("terminal", {
        cmd: `curl -L ${escapeShellSingleQuote(url)} | sed -n '1,160p'`,
        label: "terminal · web inspect",
        ...taskSpawnContext(taskId),
      });
      setContextMenu(null);
      showToast("opened terminal inspector", "success");
    },
    [showToast, taskId],
  );

  const copyContextTarget = useCallback(
    (ctx: BrowserContextPayload) => {
      const target = ctx.text || ctx.linkUrl || ctx.url;
      navigator.clipboard?.writeText(target).catch((e) => reportDiag("browser.clipboard", e, { action: "copyContext" }));
      setContextMenu(null);
      showToast("copied", "success");
    },
    [showToast],
  );


  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (suggestTimer.current) clearTimeout(suggestTimer.current);
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
      browserZoom(label, clamped / 100).catch((e) => reportDiag("browser.zoom", e, { action: "zoom" }));
    },
    [label],
  );

  const toggleDeviceMode = useCallback(() => {
    const next = !deviceMode;
    setDeviceMode(next);
    browserDeviceMode(label, next).catch((e) => reportDiag("browser.device", e, { action: "deviceMode" }));
  }, [deviceMode, label]);

  const clearCookies = useCallback(() => {
    browserClearCookies(label).catch((e) => reportDiag("browser.cookies", e, { action: "clearCookies" }));
    setMenuOpen(false);
    showToast("cleared cookies + storage", "success", "browser profile data was cleared for this pane.");
  }, [label, showToast]);

  const clearCache = useCallback(() => {
    browserClearCache(label).catch((e) => reportDiag("browser.cache", e, { action: "clearCache" }));
    setMenuOpen(false);
    showToast("cleared cache", "success", "disk + memory cache cleared for this pane.");
  }, [label, showToast]);

  const forceReload = useCallback(() => {
    browserForceReload(label).catch((e) => reportDiag("browser.reload", e, { action: "forceReload" }));
    setMenuOpen(false);
  }, [label]);

  const openDevtools = useCallback(() => {
    browserOpenDevtools(label).catch((e) => reportDiag("browser.devtools", e, { action: "openDevtools" }));
    setMenuOpen(false);
  }, [label]);

  // Cross-pane spawn: open a files pane rooted at ~/Downloads (where browser
  // downloads land), so you can act on what you just downloaded.
  const openDownloadsInFiles = useCallback(() => {
    setMenuOpen(false);
    homeDir()
      .then((h) => spawnPane("files", { path: `${h}/Downloads`, ...taskSpawnContext(taskId) }))
      .catch((e) => {
        reportError("browser.reveal", e, { action: "openDownloadsInFiles" });
        spawnPane("files", taskSpawnContext(taskId)); // still open SOMETHING (just not ~/Downloads)
      });
  }, [taskId]);

  const runOmniboxRow = useCallback(
    (row: OmniboxRow) => {
      setSuggestOpen(false);
      setSuggestIdx(-1);
      switch (row.type) {
        case "search":
          pickSuggestion(normalizeUrl(row.query));
          return;
        case "go":
          pickSuggestion(row.url);
          return;
        case "bookmark":
          pickSuggestion(row.bookmark.url);
          return;
        case "history":
          pickSuggestion(row.entry.url);
          return;
        case "action":
          if (row.action === "new-pane") openCurrentInNewPane();
          else if (row.action === "send-chat") sendCurrentPageToChat();
          else if (row.action === "curl-terminal") inspectCurrentInTerminal();
          else openDownloadsInFiles();
      }
    },
    [inspectCurrentInTerminal, openCurrentInNewPane, openDownloadsInFiles, pickSuggestion, sendCurrentPageToChat],
  );

  // Retry a failed load by re-navigating to the current url.
  const retryLoad = useCallback(() => {
    setLoadError(null);
    const u = current || normalizeUrl(input);
    if (u && shownRef.current) browserNavigate(label, u).catch((e) => reportDiag("browser.nav", e, { action: "navigate" }));
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

  const consumeContextPayload = useCallback((): Promise<boolean> => {
    return readClipboard()
      .then((raw) => {
        if (!raw || !raw.startsWith(CONTEXT_SENTINEL)) return false;
        if (raw === lastContextRef.current) return false;
        lastContextRef.current = raw;
        try {
          setContextMenu(JSON.parse(raw.slice(CONTEXT_SENTINEL.length)) as BrowserContextPayload);
          return true;
        } catch {
          return false;
        }
      })
      .catch((e) => {
        reportError("browser.clipboard", e, { action: "contextProbe" });
        return false;
      });
  }, []);

  useEffect(() => {
    if (!active) return;
    let stop = false;
    const id = setInterval(() => {
      if (!stop) consumeContextPayload();
    }, 220);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [active, consumeContextPayload]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

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
      .catch((e) => {
        reportError("browser.clipboard", e, { action: "consumeAnnotation" });
        return false;
      });
  }, [formatAnnotation]);

  const exitAnnotate = useCallback(() => {
    setAnnotating(false);
    browserExitAnnotate(label).catch((e) => reportDiag("browser.annotate", e, { action: "exit" }));
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
      .catch((e) => reportDiag("browser.clipboard", e, { action: "readClipboard" }))
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
      browserExitAnnotate(label).catch((e) => reportDiag("browser.annotate", e, { action: "exit" }));
    };
  }, [label]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-2">
        <div className="flex shrink-0 items-center gap-1">
          <NavBtn
            title="Back"
            disabled={!canGoBack}
            onClick={() => browserBack(label).catch((e) => reportDiag("browser.nav", e, { action: "back" }))}
          >
            <ArrowLeft size={14} />
          </NavBtn>
          <NavBtn
            title="Forward"
            disabled={!canGoForward}
            onClick={() => browserForward(label).catch((e) => reportDiag("browser.nav", e, { action: "forward" }))}
          >
            <ArrowRight size={14} />
          </NavBtn>
          <NavBtn
            title={loading ? "Stop" : "Reload"}
            onClick={() => browserReload(label).catch((e) => reportDiag("browser.reload", e, { action: "reload" }))}
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />}
          </NavBtn>
        </div>
        <div className="relative flex min-w-0 flex-1 items-center">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              // If a suggestion is highlighted, pick it; else navigate the input.
              if (suggestionsVisible && suggestIdx >= 0) {
                const row = omniboxRows[suggestIdx];
                if (row) {
                  runOmniboxRow(row);
                  return;
                }
                go();
              } else {
                go();
              }
            }}
            className="flex min-w-0 flex-1 items-center"
          >
            <input
              value={input}
              onChange={(e) => {
                const v = e.target.value;
                setInput(v);
                // Debounce the history query so each keystroke isn't a round-trip.
                if (suggestTimer.current) clearTimeout(suggestTimer.current);
                suggestTimer.current = setTimeout(() => refreshSuggestions(v), 90);
              }}
              onFocus={(e) => {
                inputFocusedRef.current = true;
                e.target.select();
                refreshSuggestions(e.target.value);
              }}
              onBlur={() => {
                inputFocusedRef.current = false;
                // Delay close so a mousedown on a suggestion row still registers.
                setTimeout(() => setSuggestOpen(false), 150);
              }}
              onKeyDown={(e) => {
                if (!suggestionsVisible || visibleSuggestionCount === 0) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSuggestIdx((i) => (i + 1) % visibleSuggestionCount);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSuggestIdx((i) => (i <= 0 ? visibleSuggestionCount - 1 : i - 1));
                } else if (e.key === "Escape") {
                  setSuggestOpen(false);
                  setSuggestIdx(-1);
                }
              }}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 font-mono text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/50"
              placeholder="search or enter url"
            />
          </form>
          {suggestionsVisible && (
            <div className="absolute left-0 right-0 top-full z-[70] mt-1 max-h-80 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] py-1 text-[12px] shadow-2xl">
              {omniboxRows.map((row, rowIndex) => {
                const activeRow = rowIndex === suggestIdx;
                let icon = <Search size={12} className="shrink-0 text-[var(--color-faint)]" />;
                let primary = "";
                let secondary = "";
                let meta: string | null = null;

                if (row.type === "search") {
                  primary = "search google";
                  secondary = row.query;
                } else if (row.type === "go") {
                  icon = <Globe size={12} className="shrink-0 text-[var(--color-faint)]" />;
                  primary = "go to";
                  secondary = row.label;
                } else if (row.type === "bookmark") {
                  icon = <Star size={12} className="shrink-0 text-[var(--color-accent)]" />;
                  primary = row.bookmark.title || "bookmark";
                  secondary = row.bookmark.url;
                } else if (row.type === "history") {
                  icon = <Clock size={12} className="shrink-0 text-[var(--color-faint)]" />;
                  primary = row.entry.title || row.entry.url;
                  secondary = row.entry.title ? row.entry.url : "";
                  meta = row.entry.visit_count > 1 ? `${row.entry.visit_count}x` : null;
                } else {
                  if (row.action === "new-pane") icon = <Plus size={12} className="shrink-0 text-[var(--color-faint)]" />;
                  if (row.action === "send-chat") icon = <MessageSquarePlus size={12} className="shrink-0 text-[var(--color-faint)]" />;
                  if (row.action === "curl-terminal") icon = <Terminal size={12} className="shrink-0 text-[var(--color-faint)]" />;
                  if (row.action === "downloads") icon = <Folder size={12} className="shrink-0 text-[var(--color-faint)]" />;
                  primary = row.label;
                  secondary = row.detail;
                }

                return (
                  <button
                    key={`${row.type}-${rowIndex}-${primary}-${secondary}`}
                    type="button"
                    // onMouseDown (not onClick) so it fires before the input blur closes us.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      runOmniboxRow(row);
                    }}
                    onMouseEnter={() => setSuggestIdx(rowIndex)}
                    className={
                      "flex w-full items-center gap-2 px-3 py-2 text-left " +
                      (activeRow
                        ? "bg-[var(--color-accent)]/15 text-[var(--color-text)]"
                        : "text-[var(--color-text)] hover:bg-[var(--color-panel)]")
                    }
                  >
                    {icon}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-[var(--color-text)]">{primary}</span>
                      {secondary && <span className="ml-2 font-mono text-[11px] text-[var(--color-faint)]">{secondary}</span>}
                    </span>
                    {meta && <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-faint)]">{meta}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
        {/* ONE bookmark control (was two: a star toggle + a confusing globe-icon
            list). The star fills when the current page is bookmarked; clicking
            opens the panel whose first row toggles this page, with the saved list
            below. Fewer, clearer buttons — Firaz's ask. */}
        <div ref={bookmarksRef} className="relative">
          <NavBtn
            title="Bookmarks"
            onClick={() => { setBookmarksOpen((o) => !o); setDownloadsOpen(false); }}
          >
            <Star
              size={13}
              className={isBookmarked ? "fill-[var(--color-accent)] text-[var(--color-accent)]" : ""}
            />
          </NavBtn>
          {bookmarksOpen && (
            <div className="absolute right-0 top-full z-[70] mt-1 max-h-96 w-72 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] py-1 text-[12px] shadow-2xl">
              <button
                type="button"
                onClick={toggleBookmark}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-panel)]"
              >
                <Star
                  size={13}
                  className={"shrink-0 " + (isBookmarked ? "fill-[var(--color-accent)] text-[var(--color-accent)]" : "text-[var(--color-muted)]")}
                />
                <span className="text-[var(--color-text)]">
                  {isBookmarked ? "remove this page" : "bookmark this page"}
                </span>
              </button>
              <div className="my-1 border-t border-[var(--color-border)]" />
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
                bookmarks
              </div>
              {bookmarks.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-[var(--color-faint)]">no bookmarks yet — star a page</div>
              ) : (
                bookmarks.map((bm) => {
                  let host = bm.url;
                  try {
                    host = new URL(bm.url).hostname.replace(/^www\./, "");
                  } catch {
                    /* keep raw */
                  }
                  return (
                    <div
                      key={bm.id}
                      className="group flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-panel)]"
                    >
                      <button
                        type="button"
                        onClick={() => openBookmark(bm.url)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <Star size={11} className="shrink-0 fill-[var(--color-accent)] text-[var(--color-accent)]" />
                        <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">
                          {bm.title || host}
                        </span>
                      </button>
                      <button
                        type="button"
                        title="Remove"
                        onClick={() => removeBookmark(bm)}
                        className="shrink-0 rounded p-0.5 text-[var(--color-faint)] opacity-0 transition-opacity hover:text-[var(--color-danger)] group-hover:opacity-100"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
        <div ref={downloadsRef} className="relative">
          <NavBtn title="Downloads" onClick={() => { setDownloadsOpen((o) => !o); setBookmarksOpen(false); }}>
            <Download size={13} />
          </NavBtn>
          {downloadsOpen && (
            <div className="absolute right-0 top-full z-[70] mt-1 max-h-96 w-80 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] py-1 text-[12px] shadow-2xl">
              <div className="flex items-center justify-between px-3 py-1">
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-faint)]">downloads</span>
                {downloads.length > 0 && (
                  <button
                    type="button"
                    onClick={clearDownloads}
                    className="text-[10px] text-[var(--color-faint)] hover:text-[var(--color-danger)]"
                  >
                    clear all
                  </button>
                )}
              </div>
              {downloads.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-[var(--color-faint)]">no downloads yet</div>
              ) : (
                downloads.map((d) => (
                  <div key={d.id} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-panel)]">
                    <Download size={12} className="shrink-0 text-[var(--color-faint)]" />
                    <button
                      type="button"
                      onClick={() => openDownload(d)}
                      title="Open"
                      className="flex min-w-0 flex-1 flex-col text-left"
                    >
                      <span className="truncate text-[var(--color-text)]">{d.name}</span>
                      <span className="truncate font-mono text-[10px] text-[var(--color-faint)]">{d.path}</span>
                    </button>
                    <button
                      type="button"
                      title="Reveal in Finder"
                      onClick={() => revealDownload(d)}
                      className="shrink-0 rounded p-1 text-[var(--color-faint)] opacity-0 transition-opacity hover:text-[var(--color-text)] group-hover:opacity-100"
                    >
                      <FolderOpen size={12} />
                    </button>
                    <button
                      type="button"
                      title="Open folder in files pane"
                      onClick={() => openDownloadInFiles(d)}
                      className="shrink-0 rounded p-1 text-[var(--color-faint)] opacity-0 transition-opacity hover:text-[var(--color-text)] group-hover:opacity-100"
                    >
                      <Folder size={12} />
                    </button>
                    <button
                      type="button"
                      title="Remove from list"
                      onClick={() => forgetDownload(d.id)}
                      className="shrink-0 rounded p-1 text-[var(--color-faint)] opacity-0 transition-opacity hover:text-[var(--color-danger)] group-hover:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        {/* Standalone Find button removed — redundant with ⌘F and the "Find in
            page" item already in the ⋮ menu. Fewer toolbar buttons. */}
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
                icon={<Camera size={13} />}
                label="Screenshot"
                onClick={() => {
                  setMenuOpen(false);
                  onScreenshot();
                }}
              />
              <MenuItem
                icon={<SquareDashedMousePointer size={13} />}
                label={annotating ? "Stop annotating" : "Annotate page → chat"}
                trailing={
                  annotating ? <Crosshair size={12} className="text-[var(--color-accent)]" /> : undefined
                }
                onClick={() => {
                  setMenuOpen(false);
                  toggleAnnotate();
                }}
              />
              <MenuItem
                icon={<MessageSquarePlus size={13} />}
                label="Send selection to chat"
                onClick={() => {
                  setMenuOpen(false);
                  sendSelection();
                }}
              />
              <MenuItem
                icon={<Pin size={13} />}
                label="Pin site to sidebar"
                onClick={() => {
                  setMenuOpen(false);
                  pinSite();
                }}
              />
              <MenuItem
                icon={<ExternalLink size={13} />}
                label="Open in system browser"
                onClick={() => {
                  setMenuOpen(false);
                  openUrl(current).catch((e) => reportDiag("browser.open", e, { action: "systemBrowser" }));
                }}
              />
              <div className="my-1 border-t border-[var(--color-border)]" />
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
                icon={<FolderOpen size={13} />}
                label="Open downloads in files"
                onClick={openDownloadsInFiles}
              />
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
      </div>

      {suggestionsVisible && (
        <div
          aria-hidden="true"
          className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-pane)]"
          style={{ height: suggestionReserveHeight }}
        />
      )}

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
                className="mt-3 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-accent-fg)]"
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
            ) : overlayOpen || contextMenu || dragArmed ? (
              /* the webview is INTENTIONALLY hidden so an HTML overlay (menu /
                 context menu / drop zone) can paint above the native view —
                 saying "loading…" here read like the page was lost. */
              <span>page hidden while a menu is open</span>
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
        {contextMenu && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute z-[80] w-64 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] py-1 text-[12px] text-[var(--color-text)] shadow-2xl"
            style={{
              left: Math.min(Math.max(contextMenu.x, 8), Math.max(8, (slotRef.current?.clientWidth ?? 280) - 272)),
              top: Math.min(Math.max(contextMenu.y, 8), Math.max(8, (slotRef.current?.clientHeight ?? 280) - 238)),
            }}
          >
            <div className="border-b border-[var(--color-border)] px-3 py-2">
              <div className="truncate text-[11px] font-medium text-[var(--color-text)]">
                {contextMenu.linkUrl ? "link actions" : contextMenu.text ? "selection actions" : "page actions"}
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-faint)]">
                {contextMenu.text || contextMenu.linkUrl || contextMenu.url}
              </div>
            </div>
            {(contextMenu.linkUrl || contextMenu.url) && (
              <MenuItem
                icon={<Plus size={13} />}
                label={contextMenu.linkUrl ? "Open link in new browser pane" : "Open page in new browser pane"}
                onClick={() => openUrlInNewPane(contextMenu.linkUrl || contextMenu.url)}
              />
            )}
            {(contextMenu.linkUrl || contextMenu.url) && (
              <MenuItem
                icon={<Globe size={13} />}
                label={contextMenu.linkUrl ? "Open link in this pane" : "Reload this page"}
                onClick={() => {
                  const target = contextMenu.linkUrl || contextMenu.url;
                  setContextMenu(null);
                  pickSuggestion(target);
                }}
              />
            )}
            <MenuItem
              icon={<MessageSquarePlus size={13} />}
              label="Send context to chat"
              onClick={() => sendContextToChat(contextMenu)}
            />
            {(contextMenu.linkUrl || contextMenu.url) && (
              <MenuItem
                icon={<Terminal size={13} />}
                label="Inspect with terminal"
                onClick={() => inspectUrlInTerminal(contextMenu.linkUrl || contextMenu.url)}
              />
            )}
            <MenuItem
              icon={<FolderOpen size={13} />}
              label="Open downloads in files"
              onClick={() => {
                setContextMenu(null);
                openDownloadsInFiles();
              }}
            />
            <div className="my-1 border-t border-[var(--color-border)]" />
            <MenuItem
              icon={<Copy size={13} />}
              label={contextMenu.text ? "Copy selection" : contextMenu.linkUrl ? "Copy link" : "Copy page url"}
              onClick={() => copyContextTarget(contextMenu)}
            />
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
