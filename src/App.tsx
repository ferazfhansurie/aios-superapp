import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  Bot,
  Camera,
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  Folder,
  FolderPlus,
  Globe,
  GripVertical,
  History as HistoryIcon,
  Layers,
  Maximize2,
  Minimize2,
  MessageSquare,
  MessageCircle,
  MonitorUp,
  MoveRight,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  Radio,
  Search,
  Settings as SettingsIcon,
  TerminalSquare,
  Trash2,
  Wand2,
  Eye,
  EyeOff,
  X,
} from "lucide-react";

import { recallUrl, recallPaneUrl, forgetUrl } from "./lib/browser-mem";
import { browserOpenDevtools, setWindowFullscreen } from "./lib/browser";
import { AccountMenu } from "./components/AccountMenu";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { FileFinder } from "./components/FileFinder";
import { GlobalSearch } from "./components/GlobalSearch";
import { HistoryPane } from "./components/HistoryPane";
import { IdleDashboard } from "./components/IdleDashboard";
import { MissionBoard } from "./components/MissionBoard";
import { TicketPane } from "./components/TicketPane";
import { MirrorViewer } from "./components/MirrorViewer";
import { PaneErrorBoundary } from "./components/PaneErrorBoundary";
import { ResizableGrid } from "./components/ResizableGrid";
import { SidebarUsage } from "./components/SidebarUsage";
import { VoiceButton } from "./components/VoiceButton";
import type { PaneKind } from "./components/TerminalPane";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { appshotCapture, reapTerminals } from "./lib/pty";
import { listChatLive } from "./lib/chat";
import { initTheme } from "./lib/theme";
import { monitorStart, monitorStop } from "./lib/monitor";
import {
  chatHandles,
  detachBusyChats,
  paneWriters,
  paneSubmitters,
  registerOrchestrator,
  paneImageDrop,
  paneDropSink,
  registerPane,
  paneKeyAtPoint,
  openFileInPane,
  registerOpenFile,
  registerOpenEditorFile,
  registerOpenViewerFile,
  registerRevealFile,
  registerOpenUrl,
  registerOpenSettings,
  spawnPane as requestSpawnPane,
  registerSpawnPane,
  dispatchPaneNav,
  registerActivePane,
  type PaneNavEvent,
  type SpawnPaneKind,
  type SpawnCtx,
  type PayloadKind,
} from "./lib/paneBus";
import { containingDir, paneFileTarget } from "./lib/paneOpenActions";
import { loadSettings, saveSettings, applyFlashLevel, subscribe as subscribeSettings } from "./lib/settings";
import { fileSrc, homeDir, startupOpenPane } from "./lib/fs";
import { recordPaneHistory } from "./lib/paneHistory";
import { detectProject, type ProjectInfo } from "./lib/run";
import { isHttpPaneTarget, resolvePaneFileTarget, targetLabel } from "./lib/paneRouting";
import { buildAppCommands } from "./lib/appCommands";
import type { AgentAction } from "./lib/agentActions";
import type { ChatWorkspaceContext } from "./lib/chatPaneState";
import { isTauriRuntime } from "./lib/tauri";
import { reportDiag, reportUsage } from "./lib/diag";
import {
  ensureMirrorPairing,
  mirrorPairingFromLocation,
  mirrorShareUrl,
  mirrorWebSocketUrl,
  parseMirrorSocketMessage,
  type MirrorConnectionStatus,
  type MirrorPairing,
  type MirrorPresence,
} from "./lib/mirrorTransport";
import {
  createAgentController,
  type AgentController,
  type AgentDispatchInput,
  type AgentDispatchResult,
} from "./lib/agentController";
import type { AgentAuditEntry } from "./lib/agentActions";
import { buildMirrorSnapshot, type MirrorSnapshot } from "./lib/mirror";
import { gridTrackStorageKey, isCorePaneKind, migrateLayoutPanes, movePane, newPaneKey } from "./lib/paneLayout";
import { pushNotification } from "./lib/notifications";

import { SPAWN_BY_ID, type AppDef, type PaneContent } from "./lib/apps";
import {
  loadSidebar,
  reorder,
  addLink,
  removeItem,
  renameItem,
  setItemIcon,
  toggleHidden,
  setGroup,
  addSpace,
  renameSpace,
  removeSpace,
  toggleSpaceCollapsed,
  subscribe as subscribeSidebar,
  type SidebarItem,
  type SidebarSpace,
  type SidebarState,
} from "./lib/sidebar";

// re-export the catalog types so existing consumers (IdleDashboard) keep their
// `import { AppDef } from "../App"` path working without churn.
export type { AppDef, PaneContent };

const BrowserPane = lazy(() => import("./components/BrowserPane").then((m) => ({ default: m.BrowserPane })));
const ChatPane = lazy(() => import("./components/ChatPane").then((m) => ({ default: m.ChatPane })));
const FilesPane = lazy(() => import("./components/FilesPane").then((m) => ({ default: m.FilesPane })));
const Settings = lazy(() => import("./components/Settings").then((m) => ({ default: m.Settings })));
const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((m) => ({ default: m.TerminalPane })),
);

// Idle prefetch of the heavy lazy chunks. Opening a pane for the first time
// used to pay its chunk fetch + parse ON CLICK — worst case the editor pulls
// the ~3.7MB monaco chunk, a visible main-thread stall ("laggy when opening
// things"). Warm them after first paint instead, staggered so the warmup
// itself never competes with real interaction. Failures are ignored — this is
// purely an optimization.
if (typeof window !== "undefined") {
  // setTimeout staggers the tiers; requestIdleCallback then waits for an
  // actually-quiet frame within each window so the parse never lands mid-click.
  const warmAt = (delayMs: number, load: () => Promise<unknown>) => {
    window.setTimeout(() => {
      const go = () => void load().catch(() => {});
      if ("requestIdleCallback" in window) window.requestIdleCallback(go, { timeout: 3000 });
      else go();
    }, delayMs);
  };
  // core panes only. parse them after first paint so first use is fast without
  // restoring old feature chunks or monaco on machines that do not need them.
  warmAt(2000, () => Promise.all([
    import("./components/ChatPane"),
    import("./components/TerminalPane"),
    import("./components/FilesPane"),
    import("./components/BrowserPane"),
  ]));
}

interface Pane {
  key: string;
  label: string;
  kind: PaneContent;
}

const isTerminal = (k: PaneContent): k is PaneKind =>
  k.type === "shell" || k.type === "oracle" || k.type === "tmux";

function paneContextDetail(kind: PaneContent): string | undefined {
  switch (kind.type) {
    case "shell":
      return [kind.cwd, kind.cmd].filter(Boolean).join(" · ") || undefined;
    case "oracle":
      return kind.identity;
    case "tmux":
      return `${kind.socket}/${kind.session}`;
    case "files":
      return kind.root;
    case "browser":
      return kind.url;
    case "chat":
      return kind.cwd ?? kind.resume?.title ?? kind.agentLabel;
    case "history":
      return "opened panes";
    default:
      return undefined;
  }
}

function buildWorkspaceContext(
  current: Pane,
  panes: Pane[],
  projects: ProjectInfo[],
  activeKey: string | null,
  hiddenKeys: string[],
): ChatWorkspaceContext {
  const visible = panes.filter((pane) => !hiddenKeys.includes(pane.key));
  const toPane = (pane: Pane, active = false) => ({
    key: pane.key,
    label: pane.label,
    type: pane.kind.type,
    detail: paneContextDetail(pane.kind),
    active,
  });
  const activePane = visible.find((pane) => pane.key === activeKey) ?? current;
  return {
    activePane: toPane(activePane, true),
    openPanes: visible.slice(0, 12).map((pane) => toPane(pane, pane.key === activePane.key)),
    projects: projects.slice(0, 10).map((project) => ({
      name: project.name,
      root: project.root,
      kind: project.kind,
    })),
  };
}

const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='radio']",
  "[data-no-window-drag]",
].join(",");

/** Open files through the core browser pane. This keeps files useful without
 *  loading the editor/monaco surface on older machines. */
function paneForFile(path: string, _name: string): PaneContent {
  return { type: "browser", url: fileSrc(path), transient: true, memKey: `file:${path}` };
}

// STABLE PANE KEYS (wave 1B): keys are minted ONCE at spawn via
// paneLayout.newPaneKey (`k-<kind>-<shortid>`), persisted with the layout and
// REUSED on restore — never re-randomized per launch. Terminal panes derive
// their tmux session (`aios-term-<key>`) from the key, so key stability across
// restarts IS session reattach. Legacy `k<seq>-<rand>` keys restore verbatim
// (different shape → no collision with freshly minted ones).

/** Derives the `aios-term-<name>` session SUFFIX from a pane key — MUST match
 *  `termSessionName` in TerminalRuntime.tsx (kept inline here so the reaper
 *  doesn't pull xterm into the main bundle). Used to build the keep-set for the
 *  startup GC (B2) so a live pane's session is never reaped. */
function termSessionSuffix(paneKey: string): string {
  const base = paneKey
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base; // fallback case (no key) never reaches the reaper — keys exist here
}

// ── session layout persistence ───────────────────────────────────────────────
// Reopen whatever panes were open last time (mac-app muscle memory) — closing a
// pane with its X removes it from the saved set, so the layout reflects what you
// left up. Only kinds that can be cleanly re-spawned are persisted; transient
// one-shot fields (chat seed/resume/reattach) are stripped so a restored chat
// doesn't re-fire its launcher prompt or try to reattach a dead backend id.
const LAYOUT_KEY = "aios.layout";
const GRID_TRACK_KEY = "aios.grid.tracks";
const AGENT_AUDIT_KEY = "aios.agent.audit.v1";
const AGENT_AUDIT_LIMIT = 200;

function recordAgentAudit(entry: AgentAuditEntry) {
  try {
    const raw = localStorage.getItem(AGENT_AUDIT_KEY);
    const current = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(current) ? current : [];
    localStorage.setItem(
      AGENT_AUDIT_KEY,
      JSON.stringify([entry, ...list].slice(0, AGENT_AUDIT_LIMIT)),
    );
  } catch {
    /* quota / unavailable — skip */
  }
}

/** Strip a pane kind down to its restorable shape (drop one-shot fields). */
function persistableKind(kind: PaneContent): PaneContent | null {
  if (!isCorePaneKind(kind.type)) return null;
  if (kind.type === "chat") return { type: "chat", cwd: kind.cwd }; // fresh chat, no seed/resume/reattach
  // file/editor restore by path; everything else is self-describing.
  return kind;
}

function loadLayout(): Pane[] {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return [];
    // B1 + wave 1B: REUSE persisted keys so a restored terminal pane keeps its
    // original pane key → `termSessionName` derives the SAME `aios-term-<name>`
    // and reattaches to the session its claude/codex was running in. Layouts
    // saved BEFORE keys existed get one minted ONCE here (non-destructive —
    // migrateLayoutPanes never sheds entries or fields) and written straight
    // back, so the next launch sees the same keys.
    const { panes: saved, changed } = migrateLayoutPanes(JSON.parse(raw));
    if (changed) {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(saved));
      } catch {
        /* quota / unavailable — keys still stable for this session */
      }
    }
    return saved.map((p) => {
      const key = p.key;
      const kind = p.kind as PaneContent;
      // Session restore (item 4): a browser pane reopens at the LAST url it was
      // on, not its original landing page. BrowserPane records its live url under
      // its pane key (the same key persisted here, B1) via browser-mem, so we
      // read it back and seed the restored pane's url. Falls back to the
      // persisted url (e.g. a pinned-site deep-link) when there's no memory.
      if (kind.type === "browser") {
        const last = recallPaneUrl(key) ?? recallPaneUrl(kind.memKey);
        return { key, label: p.label, kind: last ? { ...kind, url: last } : kind };
      }
      return { key, label: p.label, kind };
    });
  } catch {
    return [];
  }
}

function saveLayout(panes: Pane[]) {
  try {
    const out = panes
      .map((p) => {
        const kind = persistableKind(p.kind);
        // Persist the pane KEY (B1) — it's the seed for `termSessionName`, so a
        // restored terminal pane must keep the same key to reattach its session.
        return kind ? { key: p.key, label: p.label, kind } : null;
      })
      .filter(Boolean);
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(out));
  } catch {
    /* quota / unavailable — skip */
  }
}

// ── recent-files MRU (⌘P empty-query list) ───────────────────────────────────
// Generalizes the old single `lastOpenPath` ref into a persisted most-recently-
// used list so the fuzzy finder can show "recent files" before you type. Newest
// first, de-duped, capped.
const MRU_KEY = "aios.files.mru";
const MRU_LIMIT = 40;

function loadMru(): string[] {
  try {
    const raw = localStorage.getItem(MRU_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushMru(path: string) {
  try {
    const next = [path, ...loadMru().filter((p) => p !== path)].slice(0, MRU_LIMIT);
    localStorage.setItem(MRU_KEY, JSON.stringify(next));
  } catch {
    /* quota / unavailable — skip */
  }
}

function startWindowDrag(e: React.MouseEvent<HTMLElement>) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement | null)?.closest(INTERACTIVE_SELECTOR)) return;
  if (!isTauriRuntime()) return;
  void getCurrentWindow().startDragging().catch((e) => reportDiag("app.window", e, { action: "startDragging" }));
}

function App() {
  const nativeRuntime = useMemo(() => isTauriRuntime(), []);
  const [webViewportCompact, setWebViewportCompact] = useState(() =>
    !nativeRuntime && window.matchMedia("(max-width: 1024px)").matches,
  );
  const [panes, setPanes] = useState<Pane[]>(() =>
    loadSettings().reopenLastLayout ? loadLayout() : [],
  );
  const [sidebarOpen, setSidebarOpen] = useState(() => !(!nativeRuntime && window.matchMedia("(max-width: 1024px)").matches));
  const [splash, setSplash] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // When a notification deep-links to Settings → a section, App opens the overlay
  // AND hands Settings the section to jump to (consumed once on open).
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [fileFinderOpen, setFileFinderOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  // Recent-files MRU (⌘P empty-query list); kept in state so opens repaint it.
  const [mru, setMru] = useState<string[]>(loadMru);
  const [remoteMirrorSnapshot, setRemoteMirrorSnapshot] = useState<MirrorSnapshot | null>(null);
  const [mirrorStatus, setMirrorStatus] = useState<MirrorConnectionStatus>("off");
  const [mirrorPresence, setMirrorPresence] = useState<MirrorPresence | null>(null);
  const mirrorWsRef = useRef<WebSocket | null>(null);
  const mirrorOpenRef = useRef(false);
  const agentControllerRef = useRef<AgentController | null>(null);
  const mirrorPairing = useMemo<MirrorPairing | null>(() => {
    if (nativeRuntime) return ensureMirrorPairing();
    return mirrorPairingFromLocation();
  }, [nativeRuntime]);
  const webMirrorMode = !nativeRuntime && mirrorPairing != null;
  const mirrorUrl = useMemo(
    () => (nativeRuntime && mirrorPairing ? mirrorShareUrl(mirrorPairing) : null),
    [nativeRuntime, mirrorPairing],
  );
  const compactWebLayout = !nativeRuntime && webViewportCompact;
  // mission-control-style pane overview: fan out every open pane to switch.
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // pane key pending a close-confirm (busy chat: keep-running vs kill).
  // pane currently under a native OS file drag (for the drop highlight).
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  // per-pane window controls. The maximized pane escapes the CSS grid to fill
  // the viewport (`fixed inset-2 z-30`); every OTHER pane must deactivate
  // (active=false) because native webviews paint ABOVE html and would overpaint
  // it. Hidden panes stay MOUNTED (out of layout via display:none) so their
  // terminal/webview state survives — restored from the dock bar.
  const [maximizedKey, setMaximizedKey] = useState<string | null>(null);
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([]);
  // the pane the user last interacted with — drives the "OPEN" rail highlight +
  // is where dictation / drops route. A ref alone wouldn't re-render the rail.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Live mirror of `panes` for closures (the control-command listener) that are
  // registered once and would otherwise read a stale panes snapshot.
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const toggleMax = useCallback(
    (key: string) => setMaximizedKey((cur) => (cur === key ? null : key)),
    [],
  );
  const toggleHide = useCallback((key: string) => {
    setHiddenKeys((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
    setMaximizedKey((cur) => (cur === key ? null : cur));
  }, []);
  const movePaneByKey = useCallback((key: string, delta: -1 | 1) => {
    setPanes((cur) => {
      const index = cur.findIndex((p) => p.key === key);
      const next = movePane(cur, index, delta);
      setFocusedPane(next.items[next.selected]?.key ?? key);
      return next.items;
    });
  }, []);
  // TRUE video fullscreen: a child webview's HTML fullscreen only fills its rect.
  // When a video enters fullscreen we maximize the pane (webview → whole window)
  // AND fullscreen the OS window (window → whole screen); on exit we restore the
  // prior maximize state. prevMax remembers what was maximized before the video.
  const prevMaxRef = useRef<string | null>(null);
  const onVideoFullscreen = useCallback((key: string, on: boolean) => {
    if (on) {
      // SEQUENCE, don't race: maximize the pane FIRST (webview grows to fill the
      // window via its rAF bounds-sync), then OS-fullscreen the window on the
      // NEXT frames once that layout has settled. Firing both at once made the
      // webview bounds resolve mid-transition, so the fullscreen <video> locked
      // to the small pane rect — which is why it only worked when the pane was
      // already maximized. Two rAFs ≈ the pane is laid out full-window before the
      // OS fullscreen space-transition begins.
      setMaximizedKey((cur) => {
        prevMaxRef.current = cur;
        return key;
      });
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setWindowFullscreen(true).catch((e) => reportDiag("app.window", e, { action: "enterFullscreen" }))),
      );
    } else {
      // reverse order on exit: drop OS fullscreen first, then restore the prior
      // maximize state once the window is back in-space.
      setWindowFullscreen(false).catch((e) => reportDiag("app.window", e, { action: "exitFullscreen" }));
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setMaximizedKey(() => prevMaxRef.current)),
      );
    }
  }, []);

  // ⌘F → fullscreen the SELECTED pane (any type — not just video). Uses the same
  // pane-maximize + OS-fullscreen path, so a browser pane goes true screen-fill
  // and a terminal/editor goes edge-to-edge. Target = the selected/focused pane,
  // else the single pane if there's only one. Toggle: a second ⌘F restores.
  const toggleFullscreenSelected = useCallback((): boolean => {
    if (panes.length === 0) return false;
    const sel = activeKey ?? focusedPane.current;
    const target =
      panes.find((p) => p.key === sel) ?? (panes.length === 1 ? panes[0] : null);
    if (!target) return false; // no clear target → let ⌘F fall through to find
    const isOn = maximizedKey === target.key;
    onVideoFullscreen(target.key, !isOn);
    return true;
  }, [panes, activeKey, maximizedKey, onVideoFullscreen]);

  // ⌘F reconciliation (R5 item 4 vs R2a pane-fullscreen). When the FOCUSED pane
  // is a browser, ⌘F means find-in-page → dispatch a window event the matching
  // BrowserPane listens for (its webview label = its pane key). Otherwise ⌘F
  // toggles pane fullscreen. Returns true if it handled ⌘F (so the caller
  // preventDefaults). The ⌘. exit-fullscreen path is untouched.
  const handleCmdF = useCallback((): boolean => {
    const sel = activeKey ?? focusedPane.current;
    const target =
      panes.find((p) => p.key === sel) ?? (panes.length === 1 ? panes[0] : null);
    if (target?.kind.type === "browser") {
      window.dispatchEvent(
        new CustomEvent("aios-browser-find", { detail: { label: target.key } }),
      );
      return true;
    }
    return toggleFullscreenSelected();
  }, [panes, activeKey, toggleFullscreenSelected]);
  // personalizable sidebar — items + order live in lib/sidebar (localStorage).
  const [sidebar, setSidebar] = useState<SidebarState>(loadSidebar);
  useEffect(() => subscribeSidebar(setSidebar), []);
  const [sidebarMode, setSidebarMode] = useState(() => loadSettings().sidebarMode);
  const [topBarMode, setTopBarMode] = useState(() => loadSettings().topBarMode);
  useEffect(() =>
    subscribeSettings((next) => {
      setSidebarMode(next.sidebarMode);
      setTopBarMode(next.topBarMode);
    }),
  []);
  const iconsOnly = sidebarMode === "icons";
  // "pin a site" inline prompt.
  // which space the pin-a-site modal targets (null = closed).
  const [pinSiteSpace, setPinSiteSpace] = useState<string | null>(null);
  // Native browser webviews paint ABOVE html, so any floating overlay (modals,
  // palette) must hide them or it gets occluded.
  const overlayOpen = settingsOpen || paletteOpen || pinSiteSpace != null || overviewOpen;

  useEffect(() => {
    const t = setTimeout(() => setSplash(false), 850);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (nativeRuntime) return;
    const mq = window.matchMedia("(max-width: 1024px)");
    const update = () => setWebViewportCompact(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [nativeRuntime]);

  useEffect(() => {
    if (compactWebLayout) setSidebarOpen(false);
  }, [compactWebLayout]);

  useEffect(() => {
    const teardown = initTheme();
    applyFlashLevel(); // reflect stored composer flash level on <html>
    return teardown;
  }, []);

  // Startup GC (B2): reap orphaned `aios-term-*` tmux sessions with no restored
  // pane. Build the keep-set from the panes present at mount (the restored
  // layout) — only shell-type terminal panes back a persistent `aios-term-*`
  // session, so those are the only suffixes we preserve. Mount-once; reads the
  // initial `panes` closure (== the restored layout). Conservative: the backend
  // kills only sessions outside the keep-set.
  useEffect(() => {
    if (!nativeRuntime) return;
    const keep = panes
      .filter((p) => p.kind.type === "shell")
      .map((p) => termSessionSuffix(p.key))
      .filter(Boolean);
    reapTerminals(keep).catch(() => {
      /* no tmux server / non-AIOS box → nothing to reap */
    });
    // mount-once: the restored layout is fixed at boot; later pane churn is
    // handled by detach/close, not the startup reaper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the open-pane layout whenever it changes, so the next launch reopens
  // exactly what's up now (X-ing a pane drops it from the saved set).
  useEffect(() => {
    saveLayout(panes);
  }, [panes]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const win = getCurrentWindow();

    win
      .onCloseRequested(async (event) => {
        const detachedNow = detachBusyChats(true);
        let alreadyBackgrounded = false;
        try {
          alreadyBackgrounded = (await listChatLive()).some((chat) => chat.busy);
        } catch {
          alreadyBackgrounded = false;
        }
        if (detachedNow === 0 && !alreadyBackgrounded) return;

        event.preventDefault();
        // The flash toast above is the only signal needed here — a backgrounded
        // chat fires a clickable `chat.done` notification when it actually
        // finishes (see the "aios-notify" listener), so this is not a notification.
        flash(
          detachedNow > 0
            ? `kept ${detachedNow} chat${detachedNow === 1 ? "" : "s"} running in background`
            : "chat still running in background",
        );
        await win.hide().catch((e) => reportDiag("app.window", e, { action: "hide" }));
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((e) => reportDiag("app.listen", e, { action: "statusEvent" }));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flash]);

  const spawn = useCallback((kind: PaneContent, label: string, explicitKey?: string): string => {
    if (!isCorePaneKind(kind.type)) {
      reportUsage("pane.spawn.blocked", kind.type);
      return "";
    }
    // Stable key, minted once for the pane's whole life (persists via saveLayout,
    // reused across relaunches — see the STABLE PANE KEYS note above).
    // `explicitKey` lets callers force a deterministic key (e.g. the persistent
    // agents runtime keys an agent's pane `agent:<id>` so reopen reattaches the
    // SAME pane instead of spawning a duplicate); minted otherwise.
    const key = explicitKey ?? newPaneKey(kind.type);
    // Light usage event (kind:"usage") — seeds the "what I use" prioritization.
    // Carries only the pane-type enum, never any argument/label content.
    reportUsage("pane.spawn", kind.type);
    recordPaneHistory(kind, label);
    // EXIT FULLSCREEN ON ANY NEW-PANE SPAWN (R2a FIX 3): if a pane currently owns
    // OS fullscreen / maximize, a freshly-spawned pane would be invisible behind
    // it (the maximized pane fills the window + every other pane deactivates). Drop
    // fullscreen first so the new pane actually appears in the grid and firaz SEES
    // it. Functional setState reads the live value without a deps dependency.
    setMaximizedKey((m) => {
      if (m !== null) setWindowFullscreen(false).catch((e) => reportDiag("app.window", e, { action: "exitFullscreen" }));
      return null;
    });
    setPanes((p) => {
      // Make every pane label identifiable at a glance:
      //  - shell/claude panes with a cwd → suffix the dir basename ("terminal · shell")
      //  - then de-dupe: if that label is already open, append " 2", " 3", …
      // so the OPEN rail + overview never show two indistinguishable "terminal"s.
      let base = label;
      if ((kind.type === "shell") && kind.cwd) {
        const dir = kind.cwd.replace(/\/+$/, "").split("/").pop();
        if (dir) base = `${label} · ${dir}`;
      }
      const taken = new Set(p.map((x) => x.label));
      let next = base;
      if (taken.has(next)) {
        let n = 2;
        while (taken.has(`${base} ${n}`)) n++;
        next = `${base} ${n}`;
      }
      return [...p, { key, kind, label: next }];
    });
    return key;
  }, []);

  const openUrl = useCallback(
    (url: string, label = "browser") => {
      spawn({ type: "browser", url }, label);
    },
    [spawn],
  );

  const openHistoryItem = useCallback(
    (kind: PaneContent, label: string) => {
      spawn(kind, label);
    },
    [spawn],
  );

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Debounce spawn spam: a link-heavy page (or a misbehaving site) can fire many
    // window.open / target=_blank requests in a burst. De-dupe identical urls
    // within a short window so one click can't spawn 10 panes.
    const recent = new Map<string, number>();
    const DEDUP_MS = 800;
    void listen<{ url: string; profile?: string; is_popup?: boolean }>(
      "browser-new-pane",
      ({ payload }) => {
        if (!payload.url) return;
        const now = Date.now();
        const last = recent.get(payload.url) ?? 0;
        if (now - last < DEDUP_MS) return; // burst from the same url → ignore
        recent.set(payload.url, now);
        // prune so the map can't grow unbounded on a long-lived session
        if (recent.size > 64) {
          for (const [u, t] of recent) if (now - t > DEDUP_MS) recent.delete(u);
        }
        // OAuth nuance: a popup (window.open with explicit size features — the
        // "sign in with Google/Apple" shape) is a TRANSIENT child of its opener.
        // We still open it as a pane (so the auth flow can complete in-app), but
        // tag it transient=true so it can be auto-reaped/associated with the opener
        // rather than stranding a permanent pane after the redirect closes it.
        spawn(
          {
            type: "browser",
            url: payload.url,
            profile: payload.profile,
            transient: payload.is_popup === true,
          },
          payload.is_popup ? "sign-in" : "browser",
        );
      },
    )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((e) => reportDiag("app.listen", e, { action: "browserEvent" }));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [spawn]);

  // A file downloaded inside a browser pane → open it in the right in-app pane
  // (pdf→viewer, code→editor via paneForFile). Net: download a PDF in a browser
  // pane and it pops open in a viewer pane.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ path: string; name?: string }>("browser-download", ({ payload }) => {
      if (!payload?.path) return;
      const name = payload.name || payload.path.split("/").pop() || payload.path;
      openFileInPane(payload.path, name);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((e) => reportDiag("app.listen", e, { action: "openFileEvent" }));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Backend → in-app notification bridge. The chat backend emits `aios-notify`
  // when a BACKGROUNDED chat finishes its turn (chat.rs notify_done). We turn it
  // into a clickable `chat.done` notification whose target reattaches that exact
  // session — firaz's #1 ask. (The OS toast still fires from the backend; this is
  // the in-app bell + record. Wiring the OS-toast CLICK is Phase 2.)
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ kind: string; session_id: number; title?: string }>("aios-notify", ({ payload }) => {
      if (!payload || typeof payload.session_id !== "number") return;
      const title = payload.title || "chat";
      if (payload.kind === "chat.done") {
        pushNotification({
          kind: "chat.done",
          level: "success",
          priority: "high",
          sourceLabel: "chat",
          title: "chat finished",
          body: `${title} — done. click to reopen.`,
          target: { type: "chat", sessionId: payload.session_id, title },
        });
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((e) => reportDiag("app.listen", e, { action: "aiosNotify" }));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Resolve a sidebar item to a spawn: built-in apps look up their kind from the
  // catalog; link items open the embedded browser already at their url.
  const spawnSidebarItem = useCallback(
    (item: SidebarItem) => {
      if (item.kind.type === "link") {
        // resume at the last place this pinned site was left, falling back to its
        // pinned url; memKey = the stable item id so the memory survives restarts.
        spawn(
          { type: "browser", url: recallUrl(item.id) ?? item.kind.url, memKey: item.id },
          item.label,
        );
        return;
      }
      const app = SPAWN_BY_ID[item.kind.appId];
      if (app) spawn(app.kind, item.label);
    },
    [spawn],
  );

  // remember the last file opened so F5 knows which project to run
  const lastOpenPath = useRef<string | null>(null);
  // voice dictation → the focused terminal pane, else clipboard. Declared up
  // here (not next to focusPane) because the finderRoot useMemo reads
  // focusedPane.current during render — a later `const` would be in its TDZ
  // and throw "cannot access before initialization" (black screen on mount).
  const focusedPane = useRef<string | null>(null);
  // UNIFIED FOCUS (wave 1B): `activeKey` state is the single source of truth;
  // `focusedPane` is its synchronously-updated mirror (a ref so render-time
  // readers like finderRoot and dependency-free callbacks get the live value
  // without re-render races). EVERY focus write goes through this setter — no
  // site may assign focusedPane.current or call setActiveKey for focus on its
  // own, or the two views drift apart again.
  const setFocusedPane = useCallback((key: string | null) => {
    focusedPane.current = key;
    setActiveKey(key);
  }, []);
  // Expose the focused pane to the keybind router + future panes via paneBus
  // (synchronous read, no prop-drilling).
  useEffect(() => registerActivePane(() => focusedPane.current), []);

  const recordMru = useCallback((path: string) => {
    lastOpenPath.current = path;
    pushMru(path);
    setMru(loadMru());
  }, []);
  const openFile = useCallback(
    (path: string, name: string) => {
      recordMru(path);
      const kind = paneForFile(path, name);
      spawn(kind, name);
    },
    [spawn, recordMru],
  );
  const openEditorFile = useCallback(
    (path: string, name: string, _at?: { line?: number; col?: number }) => {
      recordMru(path);
      spawn(paneForFile(path, name), name);
    },
    [spawn, recordMru],
  );
  const openViewerFile = useCallback(
    (path: string, name: string) => {
      recordMru(path);
      spawn(paneForFile(path, name), name);
    },
    [spawn, recordMru],
  );
  const revealFile = useCallback(
    (path: string, name: string) => {
      const root = containingDir(path);
      spawn({ type: "files", root }, `files · ${name}`);
    },
    [spawn],
  );

  // GENERIC cross-pane spawn (paneBus.spawnPane): any pane asks App to open a
  // fresh pane of a given kind carrying context. Maps (kind, ctx) → PaneContent +
  // a sensible label, then reuses `spawn` (so exit-fullscreen-on-spawn applies).
  const spawnPaneFromCtx = useCallback(
    (kind: SpawnPaneKind, ctx?: SpawnCtx) => {
      switch (kind) {
        case "terminal":
          // ctx.cmd (when present) seeds + runs a command in the new shell — the
          // shell pane's startup `cmd` fires once the PTY is ready, so a ChatPane
          // code-fence "run in terminal" lands its command without needing to look
          // the freshly-mounted pane up in the paneWriters registry.
          spawn({ type: "shell", cwd: ctx?.cwd, cmd: ctx?.cmd }, ctx?.label ?? "terminal");
          break;
        case "files": {
          const root = ctx?.path;
          const name = root ? root.split("/").filter(Boolean).pop() ?? root : "files";
          spawn({ type: "files", root }, ctx?.label ?? `files · ${name}`);
          break;
        }
        case "browser":
          spawn({ type: "browser", url: ctx?.url }, ctx?.label ?? "browser");
          break;
        case "chat":
          spawn({ type: "chat", cwd: ctx?.cwd, seed: ctx?.seed }, ctx?.label ?? "chat");
          break;
      }
    },
    [spawn],
  );
  // expose openFile to deep children (chat artifact cards) via paneBus, so a
  // produced file opens as an in-app viewer pane instead of the OS app.
  useEffect(() => registerOpenFile(openFile), [openFile]);
  useEffect(() => registerOpenEditorFile(openEditorFile), [openEditorFile]);
  useEffect(() => registerOpenViewerFile(openViewerFile), [openViewerFile]);
  useEffect(() => registerRevealFile(revealFile), [revealFile]);
  useEffect(() => registerOpenUrl(openUrl), [openUrl]);
  useEffect(() => registerSpawnPane(spawnPaneFromCtx), [spawnPaneFromCtx]);
  useEffect(
    () =>
      registerOpenSettings((section) => {
        setSettingsSection(section);
        setSettingsOpen(true);
      }),
    [],
  );

  const handledStartupOpen = useRef(false);
  useEffect(() => {
    if (handledStartupOpen.current) return;
    handledStartupOpen.current = true;
    startupOpenPane()
      .then((target) => {
        if (!target) return;
        if (isHttpPaneTarget(target)) openUrl(target);
        else {
          const path = resolvePaneFileTarget(target);
          openFile(path, targetLabel(path));
        }
      })
      .catch((e) => reportDiag("app.startup", e, { action: "openPane" }));
  }, [openFile, openUrl]);

  // F5 / Run — detect the project around the last-opened file (or $HOME) and
  // spawn a terminal running its default command in the project dir (logs +
  // flutter's own `r` hot-reload work right in that terminal, like VS Code).
  const runF5 = useCallback(async () => {
    try {
      const base = lastOpenPath.current ?? (await homeDir());
      const proj = await detectProject(base);
      if (!proj.root || !proj.commands.length) {
        flash("no runnable project found near the open file");
        return;
      }
      const c = proj.commands[0];
      spawn({ type: "shell", cmd: c.cmd, cwd: proj.root }, `▶ ${c.label}`);
      flash(`▶ ${c.cmd}`);
    } catch (e) {
      flash(`run failed: ${e}`);
    }
  }, [spawn, flash]);
  const addShell = useCallback(() => spawn({ type: "shell" }, "terminal"), [spawn]);
  // ⌘T / "New Pane" is CONTEXT-AWARE (R2a FIX 2): if the active/focused pane is a
  // BROWSER, ⌘T opens a fresh browser pane (tab=pane muscle memory) instead of a
  // terminal; otherwise it falls back to the normal new-terminal behavior. Reads
  // the live pane type so the menu accelerator and the keydown fallback agree.
  const newPaneForContext = useCallback(() => {
    const k = activeKey ?? focusedPane.current;
    const active = k ? panes.find((p) => p.key === k) : null;
    if (active?.kind.type === "browser") {
      spawn({ type: "browser" }, "browser");
    } else {
      addShell();
    }
  }, [activeKey, panes, addShell, spawn]);
  const closePane = useCallback((key: string) => {
    // If the pane being closed owns the OS fullscreen (e.g. a maximized browser
    // pane with a video in fullscreen), drop fullscreen first — otherwise the
    // window stays fullscreen with the owning pane gone ("bugs out on close").
    setMaximizedKey((m) => {
      if (m === key) setWindowFullscreen(false).catch((e) => reportDiag("app.window", e, { action: "exitFullscreen" }));
      return m === key ? null : m;
    });
    if (prevMaxRef.current === key) prevMaxRef.current = null;
    // unified focus: ref + state always agree, so one check covers both.
    if (focusedPane.current === key) setFocusedPane(null);
    // Drop any session-restore memory for this pane key — a pane closed on
    // purpose shouldn't have its last url linger in the browser-mem map (it
    // also won't be in the next layout, so this just keeps the map from
    // accumulating dead entries). No-op for non-browser keys.
    forgetUrl(key);
    setPanes((p) => p.filter((x) => x.key !== key));
    setHiddenKeys((h) => h.filter((k) => k !== key));
  }, [setFocusedPane]);
  // Closing must be visually instant. If a chat is still running, detach it in
  // the background with the existing completion notification, then remove the
  // pane immediately so the grid can fall back to idle without a modal pause.
  const requestClose = useCallback(
    (key: string) => {
      const handle = chatHandles.get(key);
      if (handle?.busy()) handle.detach(true);
      closePane(key);
    },
    [closePane],
  );
  const routePaneNav = useCallback(
    (ev: PaneNavEvent) => {
      const key = focusedPane.current ?? activeKey;
      if (dispatchPaneNav(key, ev)) return;
      switch (ev.action) {
        case "find":
          handleCmdF();
          break;
        case "close":
          if (key) requestClose(key);
          break;
        case "goto": {
          const idx = (ev.index ?? 0) - 1;
          const p = idx >= 0 ? panes[idx] : null;
          if (p) {
            setHiddenKeys((h) => h.filter((k) => k !== p.key));
            setFocusedPane(p.key);
          }
          break;
        }
        case "palette":
          setPaletteOpen((v) => !v);
          break;
        case "sidebar":
          setSidebarOpen((v) => !v);
          break;
        case "quickopen":
          setFileFinderOpen((v) => !v);
          break;
        case "globalsearch":
          setGlobalSearchOpen((v) => !v);
          break;
        case "newtab":
          newPaneForContext();
          break;
        case "save":
          break;
      }
    },
    [activeKey, handleCmdF, newPaneForContext, panes, requestClose, setFocusedPane],
  );
  // Workspace project context stays local and cheap. Full chat-session resume is
  // owned by the chat pane's `/resume` picker and the pane history surface.
  const projects = useMemo<ProjectInfo[]>(() => [], []);
  const [home, setHome] = useState<string>("");

  useEffect(() => {
    homeDir().then(setHome).catch((e) => reportDiag("app.load", e, { action: "homeDir" }));
  }, []);

  // Root for ⌘P file-finder + ⌘⇧F global search. Priority: the active/focused
  // files pane root → the dir of the last-opened file → $HOME.
  const finderRoot = useMemo(() => {
    const k = activeKey ?? focusedPane.current;
    const active = k ? panes.find((p) => p.key === k) : null;
    if (active?.kind.type === "files" && active.kind.root) return active.kind.root;
    const filesPane = panes.find((p) => p.kind.type === "files" && p.kind.root);
    if (filesPane && filesPane.kind.type === "files" && filesPane.kind.root) return filesPane.kind.root;
    if (lastOpenPath.current) return containingDir(lastOpenPath.current);
    return home;
  }, [panes, activeKey, home]);

  const fireAppshot = useCallback(async () => {
    const attachToChat = (key: string, path: string) =>
      new Promise<boolean>((resolve) => {
        const note = "appshot attached. use this image as visual context.";
        const tryAttach = () => {
          const imgSink = paneImageDrop.get(key);
          if (!imgSink) return false;
          imgSink([path]);
          paneWriters.get(key)?.(note);
          return true;
        };

        if (tryAttach()) {
          resolve(true);
          return;
        }

        const started = Date.now();
        const tick = () => {
          if (tryAttach()) {
            resolve(true);
            return;
          }
          if (Date.now() - started > 1200) {
            paneWriters.get(key)?.(`${note} ${path} `);
            resolve(false);
            return;
          }
          window.setTimeout(tick, 40);
        };
        window.setTimeout(tick, 40);
      });

    try {
      const path = await appshotCapture();
      const selectedKey = focusedPane.current ?? activeKey;
      const selectedChat = selectedKey
        ? panes.find((p) => p.key === selectedKey && p.kind.type === "chat")
        : null;
      const key =
        selectedChat?.key ??
        panes.find((p) => p.kind.type === "chat")?.key ??
        spawn({ type: "chat" }, "chat");

      setHiddenKeys((h) => h.filter((k) => k !== key));
      setFocusedPane(key);

      const attached = await attachToChat(key, path);
      flash(
        attached
          ? `appshot attached to chat · ${path.split("/").pop()}`
          : `appshot path inserted in chat · ${path.split("/").pop()}`,
      );
    } catch (e) {
      flash(`appshot failed: ${e}`);
    }
  }, [activeKey, panes, spawn, flash]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ source: string }>("global-appshot", () => {
      void fireAppshot();
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((e) => reportDiag("app.listen", e, { action: "globalAppshot" }));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [fireAppshot]);

  // Focus a pane from the "OPEN" rail: restore it if minimized, mark it active
  // so dictation / drops target it (and the rail row highlights).
  const focusPane = useCallback((key: string) => {
    setHiddenKeys((h) => h.filter((k) => k !== key));
    setFocusedPane(key);
  }, [setFocusedPane]);
  // Rename a pane (double-click its OPEN-rail row) — persists via the layout save.
  const renamePane = useCallback((key: string, label: string) => {
    const v = label.trim();
    if (!v) return;
    setPanes((p) => p.map((x) => (x.key === key ? { ...x, label: v } : x)));
  }, []);
  const handleTranscript = useCallback(
    (text: string) => {
      const k = focusedPane.current;
      const w = k ? paneWriters.get(k) : null;
      if (w) {
        w(text.endsWith(" ") ? text : `${text} `);
        flash("dictated → pane");
      } else {
        navigator.clipboard?.writeText(text).catch((e) => reportDiag("app.clipboard", e, { action: "dictate" }));
        flash("transcribed → ⌘V to paste");
      }
    },
    [flash],
  );

  // Browser annotations / selections → into a chat pane (the shell loop).
  const routeToChat = useCallback(
    (text: string) => {
      const chatPane = panes.find((p) => p.kind.type === "chat");
      const w = chatPane ? paneWriters.get(chatPane.key) : null;
      if (w) {
        w(text);
        flash("→ chat");
      } else {
        navigator.clipboard?.writeText(text).catch((e) => reportDiag("app.clipboard", e, { action: "toChat" }));
        spawn({ type: "chat" }, "chat");
        flash("opened chat · annotation copied (⌘V)");
      }
    },
    [panes, flash, spawn],
  );

  // ---- keyboard: ⌘B sidebar · ⌘K palette · ⌘T terminal · ⌘, settings · ⌘⌘ appshot
  const lastMeta = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        routePaneNav({ action: "palette" });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        // ⌘⇧F — global content search (must come BEFORE the bare ⌘F fullscreen
        // branch below, which also keys on "f").
        e.preventDefault();
        routePaneNav({ action: "globalsearch" });
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
        // ⌘P — fuzzy file finder ("go to file"). firaz's #1 pain.
        e.preventDefault();
        routePaneNav({ action: "quickopen" });
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        routePaneNav({ action: "sidebar" });
      } else if (mod && (e.key.toLowerCase() === "t" || e.key.toLowerCase() === "n")) {
        // ⌘T / ⌘N — new pane (context-aware: browser pane focused → new browser
        // pane; otherwise a new terminal).
        e.preventDefault();
        routePaneNav({ action: "newtab" });
      } else if (mod && e.key.toLowerCase() === "r") {
        // ⌘R — reload the cockpit fresh (re-init theme, re-poll all live data).
        e.preventDefault();
        window.location.reload();
      } else if (mod && e.key.toLowerCase() === "w") {
        // ⌘W — close the focused pane (mac muscle memory). Falls back to the
        // active pane; no-op when nothing's focused.
        e.preventDefault();
        routePaneNav({ action: "close" });
      } else if ((mod && e.key === "`") || (e.ctrlKey && e.key === "ArrowUp")) {
        // ⌘` / Ctrl+↑ — toggle the mission-control pane overview (switch panes).
        // Ctrl+↑ mirrors macOS Mission Control; ⌘` mirrors window-cycle.
        e.preventDefault();
        if (panes.length > 0) setOverviewOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === "f") {
        // ⌘F — context-aware: browser pane focused → find-in-page; else fullscreen
        // the selected pane. Only preventDefault when we actually handled it.
        e.preventDefault();
        routePaneNav({ action: "find" });
      } else if (mod && e.key.toLowerCase() === "m") {
        // ⌘M — minimize (hide) the selected pane to the OPEN rail. ⇧ restores all.
        e.preventDefault();
        if (e.shiftKey) {
          setHiddenKeys([]);
          setMaximizedKey(null);
        } else {
          const k = activeKey ?? focusedPane.current;
          if (k) toggleHide(k);
        }
      } else if (mod && /^[1-9]$/.test(e.key)) {
        // ⌘1..9 — jump to the Nth open pane (restore + select it).
        e.preventDefault();
        routePaneNav({ action: "goto", index: Number(e.key) });
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "F5") {
        // F5 — run the current project (VS Code's start-debugging muscle memory)
        e.preventDefault();
        runF5();
      } else if (e.key === "Escape" && maximizedKey) {
        // Esc — exit a maximized/fullscreen pane.
        setWindowFullscreen(false).catch((e) => reportDiag("app.window", e, { action: "exitFullscreen" }));
        setMaximizedKey(null);
      }
      if (e.key === "Meta") {
        const now = e.timeStamp || performance.now();
        if (now - lastMeta.current < 400) {
          lastMeta.current = 0;
          fireAppshot();
        } else {
          lastMeta.current = now;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addShell, fireAppshot, runF5, routePaneNav, toggleHide, activeKey, maximizedKey, panes]);

  // NATIVE PANE-NAV BRIDGE (wave 1B). Rust emits this frozen shortcut contract
  // for pane-routed actions so ⌘F/⌘W/⌘K/⌘1-9 still work when a native child
  // webview owns focus. Pane handlers get first refusal; App supplies defaults.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<PaneNavEvent>("pane-nav", ({ payload }) => {
      routePaneNav(payload);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((e) => reportDiag("app.listen", e, { action: "paneNav" }));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [routePaneNav]);

  // NATIVE MENU BRIDGE (R2a FIX 1 — the urgent fix). The `window.keydown` handler
  // above only fires when the REACT webview has focus. When focus is inside a
  // native child webview — a browser PANE (its own WKWebView) or a terminal
  // (xterm grabs keys) — those keystrokes never reach React, so Esc/⌘F/⌘W/⌘1-9/…
  // all DIE exactly when a pane is focused (firaz got stuck unable to exit a
  // fullscreen pane). A real app-MENU accelerator fires whenever the app is
  // frontmost REGARDLESS of which webview holds focus, so the Rust menu emits
  // `menu-action` and we dispatch into the SAME handlers as the keydown fallback.
  // The keydown handler stays as the in-React path; the handlers are idempotent
  // (functional setState / focusPane) so a double-fire is harmless.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ action: string; arg?: number | null }>("menu-action", ({ payload }) => {
      const { action } = payload;
      switch (action) {
        case "exit-fullscreen": {
          // THE URGENT PATH: unconditionally drop OS fullscreen + clear the
          // maximized pane. Works even when a browser webview has focus because
          // it arrives via the native menu, not a webview keystroke.
          setWindowFullscreen(false).catch((e) => reportDiag("app.window", e, { action: "exitFullscreen" }));
          setMaximizedKey(null);
          break;
        }
        case "toggle-fullscreen":
          // ⌘F via the native menu — context-aware: browser pane focused →
          // find-in-page; else maximize/restore the pane (the path firaz hit).
          // This is the webview-independent route (fires even when a child
          // webview holds focus), so ⌘F find works inside a focused browser pane.
          handleCmdF();
          break;
        case "open-devtools": {
          // DevTools for the focused browser pane (native menu item).
          const sel = activeKey ?? focusedPane.current;
          const target =
            panes.find((p) => p.key === sel) ??
            panes.find((p) => p.kind.type === "browser") ??
            null;
          if (target?.kind.type === "browser") browserOpenDevtools(target.key).catch((e) => reportDiag("app.browser", e, { action: "openDevtools" }));
          break;
        }
        case "new":
          newPaneForContext();
          break;
        case "close": {
          const k = focusedPane.current ?? activeKey;
          if (k) requestClose(k);
          break;
        }
        case "palette":
          setPaletteOpen((v) => !v);
          break;
        case "file-finder":
          setFileFinderOpen((v) => !v);
          break;
        case "global-search":
          setGlobalSearchOpen((v) => !v);
          break;
        case "sidebar":
          setSidebarOpen((v) => !v);
          break;
        case "minimize": {
          const k = activeKey ?? focusedPane.current;
          if (k) toggleHide(k);
          break;
        }
        case "overview":
          if (panes.length > 0) setOverviewOpen((v) => !v);
          break;
        case "jump": {
          const idx = (payload.arg ?? 0) - 1;
          const p = idx >= 0 ? panes[idx] : null;
          if (p) focusPane(p.key);
          break;
        }
        default:
          break;
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((e) => reportDiag("app.listen", e, { action: "menuAction" }));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    handleCmdF,
    newPaneForContext,
    requestClose,
    toggleHide,
    focusPane,
    activeKey,
    panes,
  ]);

  // Native OS drag-drop (Finder files/folders, e.g. a screenshot) → route to the
  // targeted pane. Because `dragDropEnabled` is true, macOS intercepts file drops
  // natively and the webview's HTML5 drag events never fire — so this Tauri
  // handler is the ONLY path for OS files (the in-app `application/x-aios-path`
  // handler on the panes covers Files-pane drags).
  useEffect(() => {
    if (!isTauriRuntime()) return;
    // Resolve the pane key under a physical (device-pixel) drop position via the
    // canonical pane-rect registry — robust over native child WKWebViews (which
    // `document.elementFromPoint` cannot resolve, so a browser pane was a dead
    // zone). Tauri reports the drop position in PHYSICAL pixels; the registry's
    // rects are in CSS pixels, so divide by the device-pixel ratio.
    const paneKeyAt = (x: number, y: number): string | null => {
      const dpr = window.devicePixelRatio || 1;
      return paneKeyAtPoint(x / dpr, y / dpr);
    };

    const un = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        // live highlight on the pane that would receive the drop.
        const key = paneKeyAt(p.position.x, p.position.y);
        setDropTargetKey((cur) => (cur === key ? cur : key));
        return;
      }
      if (p.type === "leave") {
        setDropTargetKey(null);
        return;
      }
      if (p.type !== "drop") return;
      setDropTargetKey(null);
      const { paths, position } = p;
      if (!paths?.length) return;
      const dropKey = paneKeyAt(position.x, position.y);
      // 1) A pane-specific drop sink (browser → navigate to file://, editor/
      // viewer → open it) gets first crack — it owns the meaning of "a file
      // dropped on me". Falls through to the writer logic only if it declines.
      if (dropKey) {
        const sink = paneDropSink.get(dropKey);
        if (sink && sink(paths)) {
          flash(`dropped ${paths.length} item${paths.length > 1 ? "s" : ""}`);
          return;
        }
      }
      // 2) Prefer the pane under the cursor; fall back to the focused pane so a
      // drop that lands on a gap / title bar still inserts (screenshots are easy
      // to miss-aim). Only fall back to a real terminal-backed pane.
      let key = dropKey;
      if (!key || !paneWriters.get(key)) {
        const fk = focusedPane.current;
        if (fk && paneWriters.get(fk)) key = fk;
      }
      const w = key ? paneWriters.get(key) : null;
      if (!w) {
        flash("open a terminal pane, then drop the file to insert its path");
        return;
      }
      // Split image files from the rest: images go to the pane's IMAGE sink (chat
      // → thumbnail chip, ready to send for vision), everything else inserts as a
      // quoted path. A pane with no image sink (a terminal) just gets all paths
      // as text, same as before.
      // Only formats the vision APIs actually accept. svg/bmp/heic/tiff would be
      // tagged image/png and rejected — corrupting the whole turn — so let them
      // fall through to the path-insert writer instead of attaching as an image.
      const isImage = (p: string) => /\.(png|jpe?g|gif|webp)$/i.test(p);
      const imgs = paths.filter(isImage);
      const rest = paths.filter((p) => !isImage(p));
      const imgSink = key ? paneImageDrop.get(key) : null;
      if (imgs.length && imgSink) {
        imgSink(imgs);
      } else if (imgs.length) {
        // no image sink on this pane → fall back to inserting their paths as text.
        rest.push(...imgs);
      }
      if (rest.length) {
        const text = rest
          .map((path) => (/[\s'"\\]/.test(path) ? `'${path.replace(/'/g, "'\\''")}' ` : `${path} `))
          .join("");
        w(text);
      }
      flash(`dropped ${paths.length} item${paths.length > 1 ? "s" : ""}`);
    });
    return () => {
      void un.then((f) => f()).catch((e) => reportDiag("app.listen", e, { action: "unlisten" }));
    };
  }, [flash]);

  // grid is sized to the VISIBLE panes — hidden ones are display:none (out of
  // grid flow), so they leave no empty cell behind.
  const visibleCount = panes.length - hiddenKeys.length;
  const { cols, rows } = useMemo(() => {
    const n = visibleCount || 1;
    if (compactWebLayout) return { cols: 1, rows: n };
    const c = Math.ceil(Math.sqrt(n));
    return { cols: c, rows: Math.ceil(n / c) };
  }, [visibleCount, compactWebLayout]);

  const commands: Command[] = useMemo(() => {
    return buildAppCommands({
      activeKey,
      panesCount: panes.length,
      spawn,
      runF5,
      setSidebarOpen,
      setTopBarMode: (mode) => {
        setTopBarMode(mode);
        saveSettings({ topBarMode: mode });
      },
      setOverviewOpen,
      setHiddenKeys,
      setMaximizedKey,
    });
  }, [spawn, runF5, panes.length, activeKey]);

  const agentController = useMemo(
    () =>
      createAgentController({
        getPanes: () =>
          panes.map((pane) => ({
            key: pane.key,
            label: pane.label,
            type: pane.kind.type,
            hidden: hiddenKeys.includes(pane.key),
            active: pane.key === activeKey,
          })),
        focusPane,
        hidePane: (key) => {
          setHiddenKeys((cur) => (cur.includes(key) ? cur : [...cur, key]));
          setMaximizedKey((cur) => (cur === key ? null : cur));
        },
        maximizePane: (key) => {
          setHiddenKeys((cur) => cur.filter((k) => k !== key));
          setMaximizedKey(key);
          setFocusedPane(key);
        },
        closePane,
        setSidebarOpen,
        setOverviewOpen,
        setSettingsOpen,
        stopChat: (key) => chatHandles.get(key)?.stop?.(),
        detachChat: (key) => chatHandles.get(key)?.detach(true),
        audit: recordAgentAudit,
      }),
    [panes, hiddenKeys, activeKey, focusPane, closePane],
  );

  useEffect(() => {
    agentControllerRef.current = agentController;
  }, [agentController]);

  useEffect(() => {
    const dispatchAgentAction = (input: AgentDispatchInput) => agentController.dispatch(input);
    (window as typeof window & {
      __aiosAgentControl?: (
        action: unknown,
        options?: { source?: AgentDispatchInput["source"]; confirmed?: boolean },
      ) => Promise<AgentDispatchResult>;
    }).__aiosAgentControl = (action, options = {}) =>
      dispatchAgentAction({
        source: options.source ?? "codex",
        action,
        confirmed: options.confirmed,
      });

    const onAgentAction = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { requestId?: string; source?: AgentDispatchInput["source"]; action?: unknown; confirmed?: boolean }
        | undefined;
      const requestId = detail?.requestId ?? `agent-${Date.now()}`;
      void dispatchAgentAction({
        source: detail?.source ?? "codex",
        action: detail?.action,
        confirmed: detail?.confirmed,
      }).then((result) => {
        window.dispatchEvent(new CustomEvent("aios-agent-action-result", { detail: { requestId, result } }));
      });
    };

    window.addEventListener("aios-agent-action", onAgentAction);
    return () => {
      window.removeEventListener("aios-agent-action", onAgentAction);
      delete (window as typeof window & { __aiosAgentControl?: unknown }).__aiosAgentControl;
    };
  }, [agentController]);

  const mirrorSnapshot = useMemo(
    () =>
      buildMirrorSnapshot({
        panes,
        hiddenKeys,
        activeKey,
        maximizedKey,
        sidebarOpen,
        overviewOpen,
        settingsOpen,
      }),
    [panes, hiddenKeys, activeKey, maximizedKey, sidebarOpen, overviewOpen, settingsOpen],
  );

  useEffect(() => {
    const w = window as typeof window & {
      __aiosMirrorSnapshot?: () => MirrorSnapshot;
    };
    w.__aiosMirrorSnapshot = () => mirrorSnapshot;

    const emit = (requestId?: string) => {
      window.dispatchEvent(
        new CustomEvent("aios-mirror-snapshot", {
          detail: { requestId, snapshot: mirrorSnapshot },
        }),
      );
    };
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent).detail as { requestId?: string } | undefined;
      emit(detail?.requestId);
    };

    window.addEventListener("aios-mirror-request", onRequest);
    emit();
    return () => {
      window.removeEventListener("aios-mirror-request", onRequest);
      delete w.__aiosMirrorSnapshot;
    };
  }, [mirrorSnapshot]);

  useEffect(() => {
    if (!mirrorPairing) {
      setMirrorStatus("off");
      return;
    }

    let disposed = false;
    let retryTimer: number | null = null;
    let retry = 0;
    const role = nativeRuntime ? "desktop" : "viewer";

    const connect = () => {
      if (disposed) return;
      setMirrorStatus("connecting");
      const ws = new WebSocket(mirrorWebSocketUrl(mirrorPairing));
      mirrorWsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        mirrorOpenRef.current = true;
        setMirrorStatus("connected");
        ws.send(JSON.stringify({ type: "hello", role, token: mirrorPairing.token }));
        if (role === "desktop") {
          ws.send(JSON.stringify({ type: "snapshot", snapshot: mirrorSnapshot }));
        }
      };

      ws.onmessage = (event) => {
        const msg = parseMirrorSocketMessage(event.data);
        if (!msg) return;
        if ((msg.type === "hello" || msg.type === "presence") && msg.presence) {
          setMirrorPresence(msg.presence);
        }
        if ((msg.type === "hello" || msg.type === "snapshot") && "snapshot" in msg && !nativeRuntime) {
          setRemoteMirrorSnapshot((msg.snapshot as MirrorSnapshot | null) ?? null);
        }
        if (msg.type === "control" && nativeRuntime) {
          const requestId = msg.requestId;
          void agentControllerRef.current
            ?.dispatch({ source: "mirror", action: msg.action, confirmed: true })
            .then((result) => {
              if (mirrorWsRef.current?.readyState === WebSocket.OPEN) {
                mirrorWsRef.current.send(
                  JSON.stringify({ type: "control_result", requestId, result }),
                );
              }
            });
        }
      };

      ws.onerror = () => {
        setMirrorStatus("error");
      };

      ws.onclose = () => {
        if (mirrorWsRef.current === ws) mirrorWsRef.current = null;
        mirrorOpenRef.current = false;
        if (disposed) return;
        setMirrorStatus("error");
        retryTimer = window.setTimeout(connect, Math.min(10_000, 1000 + retry++ * 1500));
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
      mirrorOpenRef.current = false;
      mirrorWsRef.current?.close(1000, "app closing");
      mirrorWsRef.current = null;
    };
    // connect once per pairing/role; snapshots publish through the separate effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeRuntime, mirrorPairing?.room, mirrorPairing?.token]);

  useEffect(() => {
    if (!nativeRuntime || !mirrorOpenRef.current || mirrorWsRef.current?.readyState !== WebSocket.OPEN) return;
    mirrorWsRef.current.send(JSON.stringify({ type: "snapshot", snapshot: mirrorSnapshot }));
  }, [nativeRuntime, mirrorSnapshot]);

  const sendMirrorControl = useCallback((action: AgentAction) => {
    if (!mirrorWsRef.current || mirrorWsRef.current.readyState !== WebSocket.OPEN) return;
    mirrorWsRef.current.send(
      JSON.stringify({
        type: "control",
        requestId: `mirror-${Date.now().toString(36)}`,
        action,
      }),
    );
  }, []);

  const askFromPalette = useCallback((query: string) => {
    spawn({ type: "chat", seed: query }, "ask");
  }, [spawn]);
  const talkToJarvis = useCallback((seed: string) => {
    spawn({ type: "chat", seed }, "jarvis");
  }, [spawn]);
  // The ONE capable AI: open/focus a stable orchestrator chat rooted in
  // ~/.aios/orchestrator (so it loads the orchestrator CLAUDE.md — board-aware,
  // can spawn agents + make loops). `prefill` seeds the composer WITHOUT sending
  // (firaz talks; no canned auto-dispatch). Stable key → reopen reattaches.
  const openOrchestrator = useCallback(
    (prefill?: string) => {
      const key = "chat:orchestrator";
      const cwd = home ? `${home}/.aios/orchestrator` : undefined;
      const writeSoon = (n = 0) => {
        if (!prefill) return;
        const w = paneWriters.get(key);
        if (w) w(prefill);
        else if (n < 25) window.setTimeout(() => writeSoon(n + 1), 120);
      };
      if (panesRef.current.some((p) => p.key === key)) {
        focusPane(key);
        writeSoon();
      } else {
        spawn({ type: "chat", cwd }, "AIOS", key);
        window.setTimeout(() => writeSoon(), 250);
      }
    },
    [spawn, focusPane, home],
  );
  useEffect(() => registerOrchestrator(openOrchestrator), [openOrchestrator]);
  // Control hook (control.rs → `control-command` event): allow external callers
  // to open core panes only.
  // De-dupe guard: a single control command can reach the handler twice (effect
  // re-registration during the async listen() window, or a double emit), which
  // spawned two identical panes. Ignore an identical command seen within a short
  // window so one POST = one pane.
  const lastControlCmdRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<Record<string, unknown>>("control-command", (event) => {
      const payload = event.payload || {};
      const cmd = String(payload.cmd ?? "");
      const dedupeKey = `${cmd}:${String(payload.paneType ?? "")}:${String(payload.seed ?? "")}`;
      const nowTs = Date.now();
      if (
        dedupeKey === lastControlCmdRef.current.key &&
        nowTs - lastControlCmdRef.current.at < 2500
      ) {
        return; // duplicate within the window — drop it
      }
      lastControlCmdRef.current = { key: dedupeKey, at: nowTs };
      if (cmd === "open-pane") {
        const paneType = String(payload.paneType ?? "");
        // Optional seed/cwd let an external caller (control plane / CLI / another
        // oracle) open a chat pane that auto-runs a prompt — the zero-paste
        // handoff path. seed flows into the same seeded-spawn used by the palette.
        const seed = payload.seed != null ? String(payload.seed) : undefined;
        const cwd = payload.cwd != null ? String(payload.cwd) : undefined;
        const label = payload.label != null ? String(payload.label) : undefined;
        // Optional stable key (e.g. aios-agent spawns `agent:<id>`) so a re-spawn
        // reattaches the SAME pane instead of duplicating. Focus it if it exists.
        const explicitKey = payload.key != null ? String(payload.key) : undefined;
        switch (paneType) {
          case "chat":
            if (explicitKey && panesRef.current.some((p) => p.key === explicitKey)) {
              focusPane(explicitKey);
              if (seed) {
                const sub = paneSubmitters.get(explicitKey);
                if (sub) sub(seed);
                else window.setTimeout(() => paneSubmitters.get(explicitKey)?.(seed), 250);
              }
            } else {
              spawn({ type: "chat", seed: seed || undefined, cwd }, label ?? "chat", explicitKey);
            }
            break;
          case "terminal":
          case "shell":
            spawn({ type: "shell", cwd, cmd: seed || undefined }, label ?? "terminal");
            break;
          case "browser":
            spawn({ type: "browser" }, "browser");
            break;
          case "files":
            spawn({ type: "files" }, "files");
            break;
          default:
            break;
        }
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((e) => reportDiag("app.listen", e, { action: "controlCommand" }));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeRuntime, spawn]);
  const deepSearchFromPalette = useCallback((query: string) => {
    spawn({
      type: "chat",
      seed: `search the aios shell context for this and answer with the most useful result. use available tools, memory, files, and current panes when relevant.\n\nquery: ${query}`,
    }, "search");
  }, [spawn]);
  const topBarHidden = topBarMode === "hidden";
  const topBarLeft = (
    <div className="flex items-center gap-1">
      <IconBtn title="Toggle sidebar (⌘B)" onClick={() => setSidebarOpen((v) => !v)} active={sidebarOpen}>
        <PanelLeft size={15} />
      </IconBtn>
      <IconBtn title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}>
        <Search size={15} />
      </IconBtn>
      <IconBtn
        title="Show all panes"
        onClick={() => {
          if (panes.length > 0) setOverviewOpen(true);
        }}
        active={overviewOpen}
      >
        <Layers size={15} />
      </IconBtn>
    </div>
  );
  const topBarRight = (
    <div className="flex items-center gap-1">
      {mirrorUrl && (
        <IconBtn
          title={`Copy desktop mirror link · ${mirrorStatus}`}
          onClick={() => {
            navigator.clipboard?.writeText(mirrorUrl).catch((e) => reportDiag("app.clipboard", e, { action: "mirrorUrl" }));
            flash("mirror link copied");
          }}
          active={mirrorStatus === "connected"}
        >
          <MonitorUp size={15} />
        </IconBtn>
      )}
      <VoiceButton onTranscript={handleTranscript} />
      <IconBtn title="Appshot — attach to chat (⌘⌘)" onClick={fireAppshot}>
        <Camera size={15} />
      </IconBtn>
    </div>
  );
  // Compact action row that lives in the SIDEBAR (the persistent chrome) now that
  // the hover top-bar pill is gone. Same handlers as the header variant; the
  // sidebar-toggle is dropped here (redundant inside the sidebar) and the
  // rarely-used desktop-mirror link moved into Settings → general.
  const sidebarActions = (
    <div className={`flex items-center ${iconsOnly ? "flex-col gap-0.5" : "gap-0.5"}`}>
      <IconBtn title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}>
        <Search size={15} />
      </IconBtn>
      <IconBtn
        title="Show all panes"
        onClick={() => {
          if (panes.length > 0) setOverviewOpen(true);
        }}
        active={overviewOpen}
      >
        <Layers size={15} />
      </IconBtn>
      <VoiceButton onTranscript={handleTranscript} />
      <IconBtn title="Appshot — attach to chat (⌘⌘)" onClick={fireAppshot}>
        <Camera size={15} />
      </IconBtn>
    </div>
  );

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      {splash && <Splash />}

      {topBarHidden ? (
        // No floating overlay — actions now live in the sidebar. Keep ONLY a thin
        // top drag strip so the window can still be moved by its top edge.
        <div
          className="absolute left-0 right-0 top-0 z-40 h-5"
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
        />
      ) : (
        <header
          className="glass flex h-7 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-panel)]/45 pl-20 pr-2"
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
        >
          {topBarLeft}
          <div className="min-w-4" data-tauri-drag-region />
          {topBarRight}
        </header>
      )}

      {/* body: sidebar + pane grid */}
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && !compactWebLayout && (
          <aside
            className={`flex shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)] transition-[width] ${
              iconsOnly ? "w-16" : "w-60"
            }`}
          >
            <div
              className={`flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2 ${
                topBarHidden ? "pt-8" : ""
              }`}
            >
              {panes.length > 0 && (
                <OpenPanesList
                  panes={panes}
                  hiddenKeys={hiddenKeys}
                  maximizedKey={maximizedKey}
                  activeKey={activeKey}
                  iconsOnly={iconsOnly}
                  onSelect={focusPane}
                  onToggleHide={toggleHide}
                  onClose={requestClose}
                  onRename={renamePane}
                />
              )}
              <SidebarRail
                state={sidebar}
                iconsOnly={iconsOnly}
                onSpawn={spawnSidebarItem}
                onPinSite={(spaceId) => setPinSiteSpace(spaceId)}
              />
            </div>
            <div className="flex flex-col gap-0.5 border-t border-[var(--color-border)] p-2">
              <div className={`flex pb-1 ${iconsOnly ? "justify-center" : "justify-center px-1.5"}`}>
                {sidebarActions}
              </div>
              <AccountMenu iconsOnly={iconsOnly} onOpenSettings={() => setSettingsOpen(true)} />
            </div>
          </aside>
        )}

        <main className="relative min-h-0 flex-1">
          {(() => {
            if (webMirrorMode) {
              return (
                <MirrorViewer
                  snapshot={remoteMirrorSnapshot}
                  status={mirrorPairing ? mirrorStatus : "off"}
                  presence={mirrorPresence}
                  onControl={sendMirrorControl}
                />
              );
            }
            const idleDash = (
              <IdleDashboard
                sidebar={sidebar}
                onSpawn={spawn}
                onOpenSidebarItem={spawnSidebarItem}
                onRevealSidebar={() => setSidebarOpen(true)}
                onOpenPalette={() => setPaletteOpen(true)}
                onTalkToJarvis={talkToJarvis}
              />
            );
            // No panes at all → idle. If panes exist but ALL are hidden, keep them
            // mounted (state-preserving) in the grid and overlay idle on top — else
            // the grid is all-`display:none` and the screen goes blank.
            if (panes.length === 0) return idleDash;
            return (
              <>
                {visibleCount === 0 && <div className="absolute inset-0 z-10">{idleDash}</div>}
            <ResizableGrid cols={cols} rows={rows} gap={8} storageKey={gridTrackStorageKey(GRID_TRACK_KEY, cols, rows)}>
              {panes.map((pane) => {
                const visibleIndex = panes
                  .filter((p) => !hiddenKeys.includes(p.key))
                  .findIndex((p) => p.key === pane.key);
                const paneStyle =
                  visibleCount === 3 && visibleIndex === 2
                    ? ({ gridColumn: "2", gridRow: "1 / span 2" } satisfies CSSProperties)
                    : undefined;
                return (
                <PaneCard
                  key={pane.key}
                  pane={pane}
                  defaultCwd={home}
                  active={
                    !overlayOpen &&
                    !hiddenKeys.includes(pane.key) &&
                    (maximizedKey === null || maximizedKey === pane.key)
                  }
                  maximized={maximizedKey === pane.key}
                  hidden={hiddenKeys.includes(pane.key)}
                  style={paneStyle}
                  dropTarget={dropTargetKey === pane.key}
                  onClose={() => requestClose(pane.key)}
                  onToggleMax={() => toggleMax(pane.key)}
                  onToggleHide={() => toggleHide(pane.key)}
                  onMoveLeft={() => movePaneByKey(pane.key, -1)}
                  onMoveRight={() => movePaneByKey(pane.key, 1)}
                  onFocus={() => {
                    setFocusedPane(pane.key);
                  }}
                  onAnnotate={routeToChat}
                  workspaceContext={buildWorkspaceContext(pane, panes, projects, activeKey, hiddenKeys)}
                  onOpenFile={openFile}
                  onOpenEditorFile={openEditorFile}
                  onOpenViewerFile={openViewerFile}
                  onRevealFile={revealFile}
                  onDuplicate={() => spawn(pane.kind, pane.label)}
                  onOpenHistoryItem={openHistoryItem}
                  onOpenUrl={openUrl}
                  onProfileChange={(profile) =>
                    setPanes((ps) =>
                      ps.map((p) =>
                        p.key === pane.key && p.kind.type === "browser"
                          ? { ...p, kind: { ...p.kind, profile } }
                          : p,
                      ),
                    )
                  }
                  onChatSession={(info) => {
                    // Stamp the live session into this pane's kind + re-record
                    // pane history WITH a resume handle, so reopening this chat
                    // from history CONTINUES it (and repaints prior turns).
                    if (pane.kind.type !== "chat") return;
                    if (pane.kind.resume?.id === info.id && pane.kind.resume?.title === info.title) return;
                    const kind: PaneContent = {
                      ...pane.kind,
                      resume: { id: info.id, title: info.title, engine: info.engine, model: info.model },
                    };
                    setPanes((ps) => ps.map((p) => (p.key === pane.key ? { ...p, kind } : p)));
                    recordPaneHistory(kind, pane.label);
                  }}
                  onVideoFullscreen={(on) => onVideoFullscreen(pane.key, on)}
                />
                );
              })}
            </ResizableGrid>
              </>
            );
          })()}
        </main>
      </div>

      {compactWebLayout && (
        <MobileBottomNav
          panesCount={panes.length}
          onNewChat={() => spawn({ type: "chat" }, "chat")}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenBrowser={() => spawn({ type: "browser" }, "browser")}
          onShowPanes={() => {
            if (panes.length > 0) setOverviewOpen(true);
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {toast && (
        <div className="modal-in glass absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/90 px-3 py-2 text-[12px] text-[var(--color-text)] shadow-2xl">
          {toast}
        </div>
      )}

      {/* minimized panes now live in the sidebar "OPEN" list (OpenPanesList) —
          no floating overlay. Restore / hide / close all happen from the rail. */}

      {settingsOpen && (
        <Suspense fallback={null}>
          <Settings
            open={settingsOpen}
            initialSection={settingsSection}
            onClose={() => {
              setSettingsOpen(false);
              setSettingsSection(null);
            }}
            mirrorUrl={mirrorUrl}
            mirrorStatus={mirrorStatus}
            onCopyMirrorUrl={() => {
              if (!mirrorUrl) return;
              navigator.clipboard?.writeText(mirrorUrl).catch((e) => reportDiag("app.clipboard", e, { action: "mirrorUrl" }));
              flash("mirror link copied");
            }}
          />
        </Suspense>
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        onAsk={askFromPalette}
        onDeepSearch={deepSearchFromPalette}
      />
      <FileFinder
        open={fileFinderOpen}
        root={finderRoot}
        mru={mru}
        onClose={() => setFileFinderOpen(false)}
        onPick={(abs) => openFile(abs, abs.split("/").filter(Boolean).pop() ?? abs)}
      />
      <GlobalSearch
        open={globalSearchOpen}
        root={finderRoot}
        onClose={() => setGlobalSearchOpen(false)}
        onPick={(abs, line, col) =>
          openEditorFile(abs, abs.split("/").filter(Boolean).pop() ?? abs, { line, col })
        }
      />
      <PinSiteModal spaceId={pinSiteSpace} onClose={() => setPinSiteSpace(null)} />
      <PaneOverview
        open={overviewOpen}
        panes={panes}
        hiddenKeys={hiddenKeys}
        activeKey={activeKey}
        onClose={() => setOverviewOpen(false)}
        onPick={(key) => {
          focusPane(key);
          setMaximizedKey(null);
          setOverviewOpen(false);
        }}
        onClosePane={requestClose}
        onShowAll={() => {
          // un-minimize + un-maximize everything (tile all panes into the grid).
          setHiddenKeys([]);
          setMaximizedKey(null);
          setOverviewOpen(false);
        }}
      />
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  active,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-md p-1.5 transition-colors ${
        active
          ? "bg-[var(--color-panel-2)] text-[var(--color-accent)]"
          : "text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
      }`}
    >
      {children}
    </button>
  );
}

function MobileBottomNav({
  panesCount,
  onNewChat,
  onOpenPalette,
  onOpenBrowser,
  onShowPanes,
  onOpenSettings,
}: {
  panesCount: number;
  onNewChat: () => void;
  onOpenPalette: () => void;
  onOpenBrowser: () => void;
  onShowPanes: () => void;
  onOpenSettings: () => void;
}) {
  const items = [
    { label: "chat", icon: MessageSquare, action: onNewChat },
    { label: "search", icon: Search, action: onOpenPalette },
    { label: "web", icon: Globe, action: onOpenBrowser },
    { label: "panes", icon: Layers, action: panesCount > 0 ? onShowPanes : onOpenPalette },
    { label: "settings", icon: SettingsIcon, action: onOpenSettings },
  ];
  return (
    <nav
      className="glass z-40 grid h-16 shrink-0 grid-cols-5 border-t border-[var(--color-border)] bg-[var(--color-panel)]/92 px-1 pb-[max(env(safe-area-inset-bottom),0px)]"
      aria-label="mobile navigation"
      data-no-window-drag
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.label}
            type="button"
            onClick={item.action}
            className="relative flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-[10px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title={item.label}
          >
            <Icon size={19} />
            <span className="w-full truncate text-center leading-none">{item.label}</span>
            {item.label === "panes" && panesCount > 0 && (
              <span className="absolute right-3 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--color-accent)] px-1 text-[9px] font-semibold leading-none text-black">
                {panesCount > 9 ? "9+" : panesCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/* ── personalizable sidebar rail ─────────────────────────────────────────── */

/** A collapsible space header: click the title to fold/unfold; hover reveals a
 *  ⋯ menu (rename always; delete only for custom spaces — the three built-ins
 *  are protected). Inline rename mirrors the row rename UX. */
function SpaceHeader({
  space,
  count,
  iconsOnly = false,
}: {
  space: SidebarSpace;
  count: number;
  iconsOnly?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(space.name);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const commit = () => {
    const v = draft.trim();
    if (v && v !== space.name) renameSpace(space.id, v);
    setRenaming(false);
  };

  if (renaming) {
    return (
      <div className="px-2.5 py-1">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              setDraft(space.name);
              setRenaming(false);
            }
          }}
          spellCheck={false}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60"
        />
      </div>
    );
  }

  return (
    <div className={`group/sh relative flex items-center ${iconsOnly ? "justify-center px-0" : "pl-1.5 pr-1"}`}>
      <button
        onClick={() => toggleSpaceCollapsed(space.id)}
        className={`flex min-w-0 items-center gap-1 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-faint)] transition-colors hover:text-[var(--color-muted)] ${
          iconsOnly ? "justify-center" : "flex-1 text-left"
        }`}
        title={`${space.name} · ${space.collapsed ? "expand" : "collapse"}`}
      >
        {space.collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        {!iconsOnly && <span className="truncate">{space.name}</span>}
        {!iconsOnly && space.collapsed && count > 0 && (
          <span className="text-[var(--color-faint)]">({count})</span>
        )}
      </button>
      {!iconsOnly && <div ref={menuRef} className="relative shrink-0">
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="grid h-5 w-5 place-items-center rounded text-[var(--color-faint)] opacity-0 transition-opacity hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] group-hover/sh:opacity-100"
          title="space options"
        >
          <EllipsisVertical size={12} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 w-36 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] py-1 text-[12px] text-[var(--color-text)] shadow-lg">
            <RowMenuItem
              icon={<Pencil size={13} />}
              label="rename"
              onClick={() => {
                setDraft(space.name);
                setRenaming(true);
                setMenuOpen(false);
              }}
            />
            {!space.system && (
              <RowMenuItem
                icon={<Trash2 size={13} />}
                label="delete space"
                onClick={() => {
                  removeSpace(space.id);
                  setMenuOpen(false);
                }}
              />
            )}
          </div>
        )}
      </div>}
    </div>
  );
}

/** The store-driven rail: built-in apps + pinned sites organized into SPACES
 *  (collapsible, user-creatable sections). Drag-to-reorder rows within/across
 *  spaces (native HTML5 DnD); per-row rename / hide / unpin / move-to-space;
 *  per-space rename / collapse / delete; "+ new space" at the foot. */
function SidebarRail({
  state,
  iconsOnly = false,
  onSpawn,
  onPinSite,
}: {
  state: SidebarState;
  iconsOnly?: boolean;
  onSpawn: (item: SidebarItem) => void;
  onPinSite: (spaceId: string) => void;
}) {
  // index of the row being dragged + the row currently hovered (drop target),
  // both into the FULL ordered items array (reorder() takes absolute indices).
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const items = state.items;
  const spaces = state.spaces;
  const indexOf = useCallback(
    (id: string) => items.findIndex((it) => it.id === id),
    [items],
  );

  // Drop onto a row: if it came from another space, reassign it to the target's
  // space first (that's how you sort an item into a space by dragging), then
  // reorder to the drop position.
  const onDrop = useCallback(
    (toId: string, toGroup: string) => {
      const from = dragIdx;
      const dragged = from != null ? items[from] : null;
      setDragIdx(null);
      setOverIdx(null);
      const to = indexOf(toId);
      if (from == null || to < 0 || !dragged) return;
      if (dragged.group !== toGroup) setGroup(dragged.id, toGroup);
      if (from !== to) reorder(from, to);
    },
    [dragIdx, items, indexOf],
  );

  // Drop onto an (empty area of a) space: just reassign space, keep order.
  const onDropToSpace = useCallback(
    (group: string) => {
      const from = dragIdx;
      const dragged = from != null ? items[from] : null;
      setDragIdx(null);
      setOverIdx(null);
      if (!dragged) return;
      if (dragged.group !== group) setGroup(dragged.id, group);
    },
    [dragIdx, items],
  );

  const spaceNames = spaces.map((s) => ({ id: s.id, name: s.name }));

  return (
    <>
      {!iconsOnly && <SidebarUsage />}
      {spaces.map((space, si) => {
        const rows = items.filter((it) => it.group === space.id && !it.hidden);
        const isPinned = space.id === "pinned";
        return (
          <div
            key={space.id}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDropToSpace(space.id)}
            className={`flex flex-col gap-0.5 ${si > 0 ? "border-t border-[var(--color-border)] pt-1.5" : ""}`}
          >
            <SpaceHeader space={space} count={rows.length} iconsOnly={iconsOnly} />
            {!space.collapsed && (
              <>
                {rows.map((it) => {
                  const idx = indexOf(it.id);
                  return (
                    <SidebarRow
                      key={it.id}
                      item={it}
                      spaces={spaceNames}
                      dragging={dragIdx === idx}
                      over={overIdx === idx && dragIdx !== idx}
                      onSpawn={() => onSpawn(it)}
                      onSetSpace={(g) => setGroup(it.id, g)}
                      onDragStart={() => setDragIdx(idx)}
                      onDragEnter={() => setOverIdx(idx)}
                      onDragEnd={() => {
                        setDragIdx(null);
                        setOverIdx(null);
                      }}
                      onDrop={() => onDrop(it.id, space.id)}
                      iconsOnly={iconsOnly}
                    />
                  );
                })}
                {isPinned && (
                  <button
                    onClick={() => onPinSite(space.id)}
                    className={`group flex w-full items-center rounded-md py-1.5 text-[12px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] ${
                      iconsOnly ? "justify-center px-0" : "gap-2.5 px-2.5 text-left"
                    }`}
                    title="pin a website to the sidebar"
                  >
                    <Plus size={14} className="shrink-0" />
                    {!iconsOnly && "pin a site"}
                  </button>
                )}
                {!iconsOnly && !isPinned && rows.length === 0 && (
                  <div className="px-2.5 py-1.5 text-[11px] italic text-[var(--color-faint)]">
                    drag items here
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      <button
        onClick={() => addSpace("new space")}
        className={`group mt-1.5 flex w-full items-center rounded-md border-t border-[var(--color-border)] pt-2.5 pb-1.5 text-[12px] text-[var(--color-faint)] transition-colors hover:text-[var(--color-text)] ${
          iconsOnly ? "justify-center px-0" : "gap-2.5 px-2.5 text-left"
        }`}
        title="create a new space"
      >
        <FolderPlus size={14} className="shrink-0" />
        {!iconsOnly && "new space"}
      </button>
    </>
  );
}

const SIDEBAR_ICON_CHOICES: { name: string; label: string; icon: typeof Folder }[] = [
  { name: "chat", label: "chat", icon: MessageSquare },
  { name: "terminal", label: "terminal", icon: TerminalSquare },
  { name: "bot", label: "agent", icon: Bot },
  { name: "files", label: "files", icon: Folder },
  { name: "browser", label: "web", icon: Globe },
  { name: "contacts", label: "people", icon: MessageCircle },
  { name: "studio", label: "studio", icon: Wand2 },
  { name: "pin", label: "pin", icon: Pin },
  { name: "settings", label: "settings", icon: SettingsIcon },
  { name: "layers", label: "layers", icon: Layers },
];

const SIDEBAR_ICON_BY_NAME: Record<string, typeof Folder> = Object.fromEntries(
  SIDEBAR_ICON_CHOICES.map((choice) => [choice.name, choice.icon]),
) as Record<string, typeof Folder>;

/** One sidebar row — draggable, resolves to a custom lucide icon or a cached
 *  favicon (links), with a hover ⋯ menu (rename / icon / hide / unpin). */
function SidebarRow({
  item,
  spaces,
  dragging,
  over,
  iconsOnly = false,
  onSpawn,
  onSetSpace,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
}: {
  item: SidebarItem;
  spaces: { id: string; name: string }[];
  dragging: boolean;
  over: boolean;
  iconsOnly?: boolean;
  onSpawn: () => void;
  onSetSpace: (spaceId: string) => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.label);
  const [favBroken, setFavBroken] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isLink = item.kind.type === "link";
  const app = item.kind.type === "app" ? SPAWN_BY_ID[item.kind.appId] : undefined;
  const Icon = SIDEBAR_ICON_BY_NAME[item.iconName] ?? app?.icon ?? Globe;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // close the nested move-to submenu whenever the parent menu closes.
  useEffect(() => {
    if (!menuOpen) setMoveOpen(false);
    if (!menuOpen) setIconOpen(false);
  }, [menuOpen]);

  const commitRename = () => {
    const v = draft.trim();
    if (v && v !== item.label) renameItem(item.id, v);
    setRenaming(false);
  };

  if (renaming) {
    return (
      <div className="flex items-center gap-2 rounded-md px-2.5 py-1">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") {
              setDraft(item.label);
              setRenaming(false);
            }
          }}
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60"
        />
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        // a transparent payload keeps Firefox/Safari happy with HTML5 DnD.
        e.dataTransfer.setData("text/plain", item.id);
        onDragStart();
      }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      title={item.label}
      className={`group relative flex items-center rounded-md transition-colors ${
        dragging ? "opacity-40" : ""
      } ${over ? "bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]/40" : "hover:bg-[var(--color-panel-2)]"}`}
    >
      <span className={`grid shrink-0 cursor-grab place-items-center text-[var(--color-faint)] opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing ${iconsOnly ? "w-0" : "w-4"}`}>
        <GripVertical size={12} />
      </span>
      <button
        onClick={onSpawn}
        className={`flex min-w-0 flex-1 items-center text-[13px] text-[var(--color-text-2)] transition-colors group-hover:text-[var(--color-text)] ${
          iconsOnly ? "min-h-11 justify-center px-0 py-2" : "gap-2.5 py-1.5 pr-1 text-left"
        }`}
      >
        {isLink && item.iconName === "favicon" && item.faviconUrl && !favBroken ? (
          <img
            src={item.faviconUrl}
            alt=""
            onError={() => setFavBroken(true)}
            className={`${iconsOnly ? "h-[22px] w-[22px]" : "h-[15px] w-[15px]"} shrink-0 rounded-sm`}
          />
        ) : (
          <Icon
            size={iconsOnly ? 23 : 15}
            className="shrink-0 text-[var(--color-muted)] group-hover:text-[var(--color-text)]"
          />
        )}
        {!iconsOnly && <span className="truncate">{item.label}</span>}
      </button>
      <div ref={menuRef} className={`relative shrink-0 ${iconsOnly ? "absolute right-0 top-0" : ""}`}>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className={`grid place-items-center rounded text-[var(--color-muted)] opacity-0 transition-opacity hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] group-hover:opacity-100 ${
            iconsOnly ? "h-5 w-5" : "h-6 w-6"
          }`}
          title="options"
        >
          <EllipsisVertical size={13} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] py-1 text-[12px] text-[var(--color-text)] shadow-lg">
            <RowMenuItem
              icon={<Pencil size={13} />}
              label="rename"
              onClick={() => {
                setDraft(item.label);
                setRenaming(true);
                setMenuOpen(false);
              }}
            />
            <div className="relative">
              <button
                type="button"
                onClick={() => setIconOpen((o) => !o)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-panel)]"
              >
                <Wand2 size={13} className="shrink-0 text-[var(--color-muted)]" />
                <span className="flex-1">change icon</span>
                <ChevronRight size={12} className="text-[var(--color-faint)]" />
              </button>
              {iconOpen && (
                <div className="grid grid-cols-5 gap-1 border-y border-[var(--color-border)] bg-[var(--color-panel)]/40 p-2">
                  {isLink && item.faviconUrl && (
                    <button
                      type="button"
                      onClick={() => {
                        setItemIcon(item.id, "favicon");
                        setMenuOpen(false);
                      }}
                      title="favicon"
                      className={`grid h-7 w-7 place-items-center rounded-md border ${
                        item.iconName === "favicon"
                          ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                          : "border-transparent hover:bg-[var(--color-panel-2)]"
                      }`}
                    >
                      <img src={item.faviconUrl} alt="" className="h-4 w-4 rounded-sm" />
                    </button>
                  )}
                  {SIDEBAR_ICON_CHOICES.map((choice) => {
                    const ChoiceIcon = choice.icon;
                    return (
                      <button
                        key={choice.name}
                        type="button"
                        onClick={() => {
                          setItemIcon(item.id, choice.name);
                          setMenuOpen(false);
                        }}
                        title={choice.label}
                        className={`grid h-7 w-7 place-items-center rounded-md border ${
                          item.iconName === choice.name
                            ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                            : "border-transparent text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <ChoiceIcon size={15} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setMoveOpen((o) => !o)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-panel)]"
              >
                <MoveRight size={13} className="shrink-0 text-[var(--color-muted)]" />
                <span className="flex-1">move to space</span>
                <ChevronRight size={12} className="text-[var(--color-faint)]" />
              </button>
              {moveOpen && (
                <div className="mb-1 ml-5 flex flex-col border-l border-[var(--color-border)] pl-1">
                  {spaces.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      disabled={s.id === item.group}
                      onClick={() => {
                        onSetSpace(s.id);
                        setMenuOpen(false);
                      }}
                      className={`truncate px-3 py-1 text-left ${
                        s.id === item.group
                          ? "text-[var(--color-accent)]"
                          : "text-[var(--color-text-2)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      {s.id === item.group ? "• " : ""}
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {isLink ? (
              <RowMenuItem
                icon={<Trash2 size={13} />}
                label="unpin"
                onClick={() => {
                  removeItem(item.id);
                  setMenuOpen(false);
                }}
              />
            ) : (
              <RowMenuItem
                icon={<EyeOff size={13} />}
                label="hide"
                onClick={() => {
                  toggleHidden(item.id, true);
                  setMenuOpen(false);
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RowMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[var(--color-text)] transition-colors hover:bg-[var(--color-panel)]"
    >
      <span className="text-[var(--color-muted)]">{icon}</span>
      {label}
    </button>
  );
}

/** Inline modal to pin a website by url (favicon resolved by the store). */
function PinSiteModal({ spaceId, onClose }: { spaceId: string | null; onClose: () => void }) {
  const open = spaceId != null;
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (open) {
      setUrl("");
      setLabel("");
    }
  }, [open]);
  if (!open) return null;
  const submit = () => {
    const u = url.trim();
    if (!u) return;
    addLink(u, label.trim() || undefined, undefined, spaceId ?? "pinned");
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-6 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="modal-in glass w-[380px] rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-panel)]/95 p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-[var(--color-text)]">
          <Pin size={14} className="text-[var(--color-accent)]" />
          pin a site
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-2"
        >
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder="youtube.com"
            spellCheck={false}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60"
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder="label (optional)"
            spellCheck={false}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60"
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-2)] hover:border-[var(--color-border-strong)]"
            >
              cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white"
            >
              pin
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Type → glyph for the overview cards (Mission-Control-style window thumbnails). */
const PANE_GLYPH: Record<string, typeof Folder> = {
  shell: TerminalSquare,
  oracle: Bot,
  tmux: TerminalSquare,
  files: Folder,
  history: HistoryIcon,
  browser: Globe,
  chat: MessageSquare,
};

/** Mission-control-style pane overview: a full-screen scrim that fans out every
 *  open pane as a big window-thumbnail card so you can SEE them all and switch.
 *  Opened by three-finger swipe-up (wheel-fling), ⌘` / Ctrl+↑, or the palette.
 *  Pick a card → focus that pane; "show all" → tile every pane back into the
 *  grid. ←/→/⏎ keyboard, Esc / click-scrim closes. Cards are styled previews
 *  (window chrome + big type glyph) — no live webview duplication. */
function PaneOverview({
  open,
  panes,
  hiddenKeys,
  activeKey,
  onClose,
  onPick,
  onClosePane,
  onShowAll,
}: {
  open: boolean;
  panes: Pane[];
  hiddenKeys: string[];
  activeKey: string | null;
  onClose: () => void;
  onPick: (key: string) => void;
  onClosePane: (key: string) => void;
  onShowAll: () => void;
}) {
  const [sel, setSel] = useState(0);

  useEffect(() => {
    if (!open) return;
    const start = Math.max(0, panes.findIndex((p) => p.key === activeKey));
    setSel(start);
  }, [open, activeKey, panes]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" || e.key === "Tab") {
        e.preventDefault();
        setSel((i) => (i + 1) % Math.max(1, panes.length));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSel((i) => (i - 1 + panes.length) % Math.max(1, panes.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const p = panes[sel];
        if (p) onPick(p.key);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, panes, sel, onClose, onPick]);

  if (!open) return null;

  // Card width adapts so 1-2 panes sit big + centered (not stretched), many panes
  // wrap into a tidy gallery — the Mission-Control feel at any count.
  const n = panes.length;
  const cardW = n <= 1 ? 460 : n <= 2 ? 400 : n <= 6 ? 340 : 280;

  return (
    <div
      className="modal-in fixed inset-0 z-[60] flex flex-col bg-black/55 backdrop-blur-2xl"
      onMouseDown={onClose}
    >
      {/* top bar — title centered like macOS "Desktop", controls on the right */}
      <div className="relative flex h-12 shrink-0 items-center justify-center px-6">
        <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--color-text-2)]">
          <Layers size={14} className="text-[var(--color-accent)]" />
          <span>{n} open {n === 1 ? "pane" : "panes"}</span>
          <span className="text-[var(--color-faint)]">· ←/→ ⏎ · esc</span>
        </div>
        <div className="absolute right-6 flex items-center gap-2" onMouseDown={(e) => e.stopPropagation()}>
          <button
            onMouseDown={(e) => { e.stopPropagation(); onShowAll(); }}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/70 px-3 py-1.5 text-[12px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
            title="tile every pane back into the grid"
          >
            show all
          </button>
          <button
            onMouseDown={(e) => { e.stopPropagation(); onClose(); }}
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="close (Esc)"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* the gallery — vertically + horizontally centered, wraps gracefully */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center justify-center gap-6">
          {panes.map((p, i) => {
            const hidden = hiddenKeys.includes(p.key);
            const isSel = i === sel;
            const Glyph = PANE_GLYPH[p.kind.type] ?? Layers;
            return (
              <div key={p.key} className="flex flex-col items-center gap-2" style={{ width: cardW }}>
                <button
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => { e.stopPropagation(); onPick(p.key); }}
                  style={{ width: cardW }}
                  className={`group relative flex aspect-[16/10] flex-col overflow-hidden rounded-xl border bg-[var(--color-pane)] text-left shadow-2xl shadow-black/50 transition-all duration-150 hover:-translate-y-1 ${
                    isSel
                      ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]/60 scale-[1.02]"
                      : "border-[var(--color-border-strong)] hover:border-[var(--color-accent)]/40"
                  } ${hidden ? "opacity-60" : ""}`}
                >
                  {/* window chrome strip */}
                  <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-3">
                    <span className={`status-dot shrink-0 ${hidden ? "status-dot--cold" : DOT[p.kind.type] ?? "status-dot--cold"}`} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-text-2)]">{p.label}</span>
                    <span
                      onMouseDown={(e) => { e.stopPropagation(); onClosePane(p.key); }}
                      className="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-faint)] opacity-0 transition-opacity hover:bg-[var(--color-panel-2)] hover:text-[var(--color-danger)] group-hover:opacity-100"
                      title="close pane"
                    >
                      <X size={12} />
                    </span>
                  </div>
                  {/* body — big type glyph on a faint gradient "screen" */}
                  <div className="relative flex min-h-0 flex-1 items-center justify-center bg-gradient-to-br from-[var(--color-pane)] to-[var(--color-bg)]">
                    <Glyph size={Math.round(cardW * 0.16)} className="text-[var(--color-faint)] opacity-50 transition-opacity group-hover:opacity-80" />
                    {hidden && (
                      <span className="absolute bottom-2 right-2 rounded bg-[var(--color-panel)]/80 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-faint)]">minimized</span>
                    )}
                    <span className="absolute left-2 top-2 rounded bg-[var(--color-panel)]/70 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-faint)]">⌘{i + 1}</span>
                  </div>
                </button>
                <span className={`max-w-full truncate text-[12px] ${isSel ? "text-[var(--color-text)]" : "text-[var(--color-muted)]"}`}>
                  {p.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const DOT: Record<string, string> = {
  oracle: "status-dot--active",
  tmux: "status-dot--dormant",
  shell: "status-dot--idle",
  files: "status-dot--cold",
  history: "status-dot--dormant",
  git: "status-dot--active",
  browser: "status-dot--cold",
  notes: "status-dot--cold",
  bridges: "status-dot--cold",
  plugins: "status-dot--cold",
  pulse: "status-dot--active",
  apps: "status-dot--cold",
  chat: "status-dot--active",
  file: "status-dot--cold",
  editor: "status-dot--cold",
};

function PaneLoading() {
  return (
    <div className="grid h-full place-items-center bg-[var(--color-bg)]">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-faint)]">
        loading pane
      </span>
    </div>
  );
}

function PaneActionItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[var(--color-text-2)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
    >
      <span className="text-[var(--color-muted)]">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The "OPEN" rail section — a live, CRUD-able list of every open pane (replaces
 *  the old floating "hidden" overlay). Click a row to focus it (restoring it from
 *  minimized first); the eye toggles minimize/restore; the X closes it. Minimized
 *  rows render dimmed. This is the window-manager for the deck, in the sidebar. */
function OpenPanesList({
  panes,
  hiddenKeys,
  maximizedKey,
  activeKey,
  iconsOnly = false,
  onSelect,
  onToggleHide,
  onClose,
  onRename,
}: {
  panes: Pane[];
  hiddenKeys: string[];
  maximizedKey: string | null;
  activeKey: string | null;
  iconsOnly?: boolean;
  onSelect: (key: string) => void;
  onToggleHide: (key: string) => void;
  onClose: (key: string) => void;
  onRename: (key: string, label: string) => void;
}) {
  // double-click a row → inline rename (this key + its draft text).
  const [editKey, setEditKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const commit = () => {
    if (editKey) onRename(editKey, draft);
    setEditKey(null);
  };
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className={`flex items-center py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-faint)] ${
          iconsOnly ? "justify-center px-0" : "gap-1.5 px-1.5"
        }`}
        title={`open panes (${panes.length})`}
      >
        <Layers size={11} />
        {!iconsOnly && <span>open</span>}
        {!iconsOnly && <span className="text-[var(--color-faint)]">({panes.length})</span>}
      </div>
      {panes.map((p, paneIdx) => {
        const hidden = hiddenKeys.includes(p.key);
        const active = activeKey === p.key && !hidden;
        const maximized = maximizedKey === p.key;
        if (editKey === p.key) {
          return (
            <div key={p.key} className="flex items-center gap-2 rounded-md px-2.5 py-1">
              <span className={`status-dot shrink-0 ${DOT[p.kind.type] ?? "status-dot--cold"}`} />
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  else if (e.key === "Escape") setEditKey(null);
                }}
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60"
              />
            </div>
          );
        }
        return (
          <div
            key={p.key}
            className={`group relative flex items-center rounded-md transition-colors ${
              active
                ? "bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]/40"
                : "hover:bg-[var(--color-panel-2)]"
            }`}
          >
            <button
              onClick={() => onSelect(p.key)}
              onDoubleClick={() => {
                setDraft(p.label);
                setEditKey(p.key);
              }}
              // middle-click closes — browser-tab muscle memory
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(p.key);
                }
              }}
              className={`flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                hidden ? "text-[var(--color-faint)]" : "text-[var(--color-text-2)] group-hover:text-[var(--color-text)]"
              } ${iconsOnly ? "justify-center gap-0 px-0 text-center" : ""}`}
              title={hidden ? `restore pane: ${p.label}` : `focus pane: ${p.label} · double-click to rename · middle-click to close`}
            >
              <span className={`status-dot shrink-0 ${hidden ? "status-dot--cold" : DOT[p.kind.type] ?? "status-dot--cold"}`} />
              {!iconsOnly && <span className="truncate">{p.label}</span>}
              {!iconsOnly && maximized && <Maximize2 size={10} className="shrink-0 text-[var(--color-accent)]" />}
              {/* ⌘N jump hint — teaches the existing shortcut, hover-only */}
              {!iconsOnly && paneIdx < 9 && (
                <span className="ml-auto shrink-0 pl-1 font-mono text-[9.5px] text-[var(--color-faint)] opacity-0 transition-opacity group-hover:opacity-100">
                  ⌘{paneIdx + 1}
                </span>
              )}
            </button>
            {!iconsOnly && <div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDraft(p.label);
                  setEditKey(p.key);
                }}
                className="grid h-6 w-6 place-items-center rounded text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                title="rename"
              >
                <Pencil size={11} />
              </button>
              <button
                onClick={(e) => (e.stopPropagation(), onToggleHide(p.key))}
                className="grid h-6 w-6 place-items-center rounded text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                title={hidden ? "restore" : "minimize"}
              >
                {hidden ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
              <button
                onClick={(e) => (e.stopPropagation(), onClose(p.key))}
                className="grid h-6 w-6 place-items-center rounded text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-danger)]"
                title="close"
              >
                <X size={12} />
              </button>
            </div>}
          </div>
        );
      })}
    </div>
  );
}

function PaneCard({
  pane,
  defaultCwd,
  active,
  maximized,
  hidden,
  style,
  dropTarget,
  onClose,
  onToggleMax,
  onToggleHide,
  onMoveLeft,
  onMoveRight,
  onFocus,
  onAnnotate,
  workspaceContext,
  onOpenFile,
  onOpenEditorFile,
  onOpenViewerFile,
  onRevealFile,
  onDuplicate,
  onOpenHistoryItem,
  onOpenUrl,
  onProfileChange,
  onChatSession,
  onVideoFullscreen,
}: {
  pane: Pane;
  defaultCwd?: string;
  active: boolean;
  maximized?: boolean;
  hidden?: boolean;
  style?: CSSProperties;
  dropTarget?: boolean;
  onClose: () => void;
  onToggleMax?: () => void;
  onToggleHide?: () => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  onFocus: () => void;
  onAnnotate: (text: string) => void;
  workspaceContext: ChatWorkspaceContext;
  onOpenFile: (path: string, name: string) => void;
  onOpenEditorFile: (path: string, name: string) => void;
  onOpenViewerFile: (path: string, name: string) => void;
  onRevealFile: (path: string, name: string) => void;
  onDuplicate: () => void;
  onOpenHistoryItem: (kind: PaneContent, label: string) => void;
  onOpenUrl?: (url: string) => void;
  onProfileChange: (profile: string) => void;
  onChatSession: (info: { id: string; title: string; engine?: string; model?: string }) => void;
  onVideoFullscreen?: (on: boolean) => void;
}) {
  const t = pane.kind.type;
  // Register this pane in the canonical rect registry so the OS-drop hit-test can
  // target it without `elementFromPoint` (which fails over native webviews). The
  // wrapper ref gives a live rect; canAccept lets a pane opt a payload out.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const canAccept = (_kind: PayloadKind): boolean => {
      return true;
    };
    return registerPane({
      key: pane.key,
      type: t,
      getRect: () => wrapRef.current?.getBoundingClientRect() ?? null,
      canAccept,
    });
  }, [pane.key, t]);
  const chatCwd = pane.kind.type === "chat" ? (pane.kind.cwd ?? defaultCwd) : undefined;
  const label =
    t === "oracle" ? `oracle: ${pane.label}` : t === "tmux" ? `tmux: ${pane.label}` : pane.label;
  // Monitoring works on real tmux sessions (oracle/tmux panes) — the watcher
  // capture-panes them and reports to WhatsApp.
  const monTarget =
    pane.kind.type === "oracle"
      ? { socket: "adletic", session: `aios-${pane.kind.identity}` }
      : pane.kind.type === "tmux"
        ? { socket: pane.kind.socket, session: pane.kind.session }
        : null;
  const [mon, setMon] = useState(false);
  const [openAsOpen, setOpenAsOpen] = useState(false);
  const fileTarget = paneFileTarget(pane.kind);
  const paneCwd =
    pane.kind.type === "shell"
      ? pane.kind.cwd
      : pane.kind.type === "chat"
        ? (pane.kind.cwd ?? defaultCwd)
        : pane.kind.type === "files"
          ? (pane.kind.root ?? defaultCwd)
          : fileTarget
            ? containingDir(fileTarget.path)
            : defaultCwd;
  const toggleMon = () => {
    if (!monTarget) return;
    if (mon) monitorStop(monTarget.session).catch((e) => reportDiag("app.monitor", e, { action: "stop" }));
    else monitorStart(monTarget.socket, monTarget.session).catch((e) => reportDiag("app.monitor", e, { action: "start" }));
    setMon((v) => !v);
  };
  return (
    <div
      ref={wrapRef}
      data-pane-key={pane.key}
      onMouseDownCapture={onFocus}
      style={hidden ? { display: "none" } : style}
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--color-pane)] transition-colors ${
        maximized
          ? // truly fullscreen — edge-to-edge over the top bar + sidebar, no chrome
            "fixed inset-0 z-40"
          : `relative rounded-lg border ${
              dropTarget
                ? "border-[var(--color-accent)]"
                : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
            }`
      }`}
    >
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-white/[0.02] px-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`status-dot ${DOT[t] ?? "status-dot--cold"}`} />
          <span className="truncate font-mono text-[11px] text-[var(--color-muted)]">{label}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {monTarget && (
            <button
              type="button"
              onClick={toggleMon}
              title={mon ? "monitoring → WhatsApp · click to stop" : "monitor this pane → WhatsApp"}
              className={`rounded p-0.5 transition-colors ${
                mon
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              }`}
            >
              <Radio size={12} className={mon ? "animate-pulse" : ""} />
            </button>
          )}
          <div className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpenAsOpen((v) => !v);
              }}
              className="rounded p-0.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              title="open as"
            >
              <EllipsisVertical size={12} />
            </button>
            {openAsOpen && (
              <div
                className="absolute right-0 top-6 z-30 w-44 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 text-[12px] shadow-2xl"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {fileTarget && (
                  <>
                    <PaneActionItem
                      icon={<Pencil size={13} />}
                      label="open editor"
                      onClick={() => {
                        onOpenEditorFile(fileTarget.path, fileTarget.name);
                        setOpenAsOpen(false);
                      }}
                    />
                    <PaneActionItem
                      icon={<Eye size={13} />}
                      label="open viewer"
                      onClick={() => {
                        onOpenViewerFile(fileTarget.path, fileTarget.name);
                        setOpenAsOpen(false);
                      }}
                    />
                    <PaneActionItem
                      icon={<Folder size={13} />}
                      label="reveal files"
                      onClick={() => {
                        onRevealFile(fileTarget.path, fileTarget.name);
                        setOpenAsOpen(false);
                      }}
                    />
                  </>
                )}
                <PaneActionItem
                  icon={<Layers size={13} />}
                  label="duplicate pane"
                  onClick={() => {
                    onDuplicate();
                    setOpenAsOpen(false);
                  }}
                />
                <div className="my-1 border-t border-[var(--color-border)]" />
                <PaneActionItem
                  icon={<Globe size={13} />}
                  label="new browser"
                  onClick={() => {
                    requestSpawnPane("browser", { url: "https://google.com", label: "browser" });
                    setOpenAsOpen(false);
                  }}
                />
                <PaneActionItem
                  icon={<TerminalSquare size={13} />}
                  label="terminal here"
                  onClick={() => {
                    requestSpawnPane("terminal", { cwd: paneCwd, label: paneCwd ? `terminal · ${paneCwd.split("/").filter(Boolean).pop()}` : "terminal" });
                    setOpenAsOpen(false);
                  }}
                />
                <PaneActionItem
                  icon={<Folder size={13} />}
                  label="files here"
                  onClick={() => {
                    requestSpawnPane("files", { path: paneCwd, label: paneCwd ? `files · ${paneCwd.split("/").filter(Boolean).pop()}` : "files" });
                    setOpenAsOpen(false);
                  }}
                />
                <PaneActionItem
                  icon={<MessageSquare size={13} />}
                  label="chat here"
                  onClick={() => {
                    requestSpawnPane("chat", { cwd: paneCwd, label: paneCwd ? `chat · ${paneCwd.split("/").filter(Boolean).pop()}` : "chat" });
                    setOpenAsOpen(false);
                  }}
                />
              </div>
            )}
          </div>
          {onToggleHide && (
            <button
              type="button"
              onClick={(e) => (e.stopPropagation(), onToggleHide())}
              className="rounded p-0.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              title="Hide pane (keeps running)"
            >
              <EyeOff size={12} />
            </button>
          )}
          {onMoveLeft && (
            <button
              type="button"
              onClick={(e) => (e.stopPropagation(), onMoveLeft())}
              className="rounded p-0.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              title="Move pane left"
            >
              <MoveRight size={12} className="rotate-180" />
            </button>
          )}
          {onMoveRight && (
            <button
              type="button"
              onClick={(e) => (e.stopPropagation(), onMoveRight())}
              className="rounded p-0.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              title="Move pane right"
            >
              <MoveRight size={12} />
            </button>
          )}
          {onToggleMax && (
            <button
              type="button"
              onClick={(e) => (e.stopPropagation(), onToggleMax())}
              className="rounded p-0.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              title={maximized ? "Restore pane" : "Maximize pane"}
            >
              {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-0.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="Close pane"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <PaneErrorBoundary
          label={pane.label || pane.kind.type}
          onError={(err, info) =>
            reportDiag(`react.${pane.kind.type}`, err, {
              action: "render",
              info: info.componentStack ?? "",
            })
          }
        >
          <Suspense fallback={<PaneLoading />}>
            {isTerminal(pane.kind) ? (
            <TerminalPane kind={pane.kind} paneKey={pane.key} />
          ) : pane.kind.type === "files" ? (
            <FilesPane initialRoot={pane.kind.root} onOpenFile={onOpenFile} />
          ) : pane.kind.type === "history" ? (
            <HistoryPane onOpenHistoryItem={onOpenHistoryItem} />
          ) : pane.kind.type === "mission" ? (
            <div className="h-full overflow-y-auto p-3">
              <MissionBoard />
            </div>
          ) : pane.kind.type === "ticket" ? (
            <TicketPane />
          ) : pane.kind.type === "browser" ? (
            <BrowserPane
              label={pane.key}
              active={active}
              initialUrl={pane.kind.url}
              initialProfile={pane.kind.profile}
              memKey={pane.kind.memKey}
              onAnnotate={onAnnotate}
              onProfileChange={onProfileChange}
              onVideoFullscreen={onVideoFullscreen}
            />
          ) : !chatCwd ? (
            <PaneLoading />
          ) : (
            <ChatPane
              paneKey={pane.key}
              active={active}
              hidden={hidden}
              cwd={chatCwd}
              seed={pane.kind.type === "chat" ? pane.kind.seed : undefined}
              modelId={pane.kind.type === "chat" ? pane.kind.modelId : undefined}
              agentLabel={pane.kind.type === "chat" ? pane.kind.agentLabel : undefined}
              resume={pane.kind.type === "chat" ? pane.kind.resume : undefined}
              reattach={pane.kind.type === "chat" ? pane.kind.reattach : undefined}
              workspaceContext={workspaceContext}
              onOpenUrl={onOpenUrl}
              onChatSession={onChatSession}
            />
          )}
          </Suspense>
        </PaneErrorBoundary>
      </div>
      {dropTarget && isTerminal(pane.kind) && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center border-2 border-dashed border-[var(--color-accent)]/70 bg-[var(--color-accent)]/10">
          <span className="rounded-md bg-[var(--color-panel)]/90 px-3 py-1.5 text-[12px] text-[var(--color-text)]">
            drop to insert path
          </span>
        </div>
      )}
    </div>
  );
}

function Splash() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[var(--color-bg)]">
      <span className="brand-logo--splash font-mono text-5xl font-bold tracking-tighter text-[var(--color-accent)] [text-shadow:0_0_32px_color-mix(in_srgb,var(--color-accent)_50%,transparent)]">
        aios
      </span>
    </div>
  );
}

export default App;
