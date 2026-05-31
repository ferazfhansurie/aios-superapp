import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  Bot,
  Camera,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  EllipsisVertical,
  FileText,
  Folder,
  FolderPlus,
  Globe,
  GripVertical,
  Layers,
  Maximize2,
  Minimize2,
  MessageSquare,
  MessageCircle,
  MoveRight,
  NotebookPen,
  PanelLeft,
  Pencil,
  Pin,
  Play,
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

import { recallUrl } from "./lib/browser-mem";
import { setWindowFullscreen } from "./lib/browser";
import { AccountMenu } from "./components/AccountMenu";
import { AutomationsPane } from "./components/AutomationsPane";
import { BridgesPane } from "./components/BridgesPane";
import { BrowserPane } from "./components/BrowserPane";
import { ChatPane } from "./components/ChatPane";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { CrmPane } from "./components/CrmPane";
import { FilesPane } from "./components/FilesPane";
import { FileViewerPane } from "./components/FileViewerPane";
import { IdleDashboard } from "./components/IdleDashboard";
import { DatabasePane } from "./components/DatabasePane";
import { MotionPane } from "./components/MotionPane";
import { NotesPane } from "./components/NotesPane";
import { OracleRoster } from "./components/OracleRoster";
import { PluginsPane } from "./components/PluginsPane";
import { PulsePane } from "./components/PulsePane";
import { ResizableGrid } from "./components/ResizableGrid";
import { Settings } from "./components/Settings";
import { TerminalPane, type PaneKind } from "./components/TerminalPane";
import { EditorPane } from "./components/EditorPane";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { VoiceButton } from "./components/VoiceButton";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { appshot, listOracles, type OracleInfo } from "./lib/pty";
import { listChatLive, listChatSessions, type ChatSessionInfo, type LiveChat } from "./lib/chat";
import { listCustomers, type Customer } from "./lib/inbox";
import { initTheme } from "./lib/theme";
import { monitorStart, monitorStop } from "./lib/monitor";
import { chatHandles, paneWriters, paneSubmitters, paneImageDrop, registerOpenFile, registerOpenUrl } from "./lib/paneBus";
import { loadSettings, applyFlashLevel } from "./lib/settings";
import { homeDir, startupOpenPane } from "./lib/fs";
import { detectProject, listProjects, type ProjectInfo } from "./lib/run";
import { loadProjectsStore, mergeProjects, subscribeProjects } from "./lib/projects";
import { isHttpPaneTarget, resolvePaneFileTarget, targetLabel } from "./lib/paneRouting";
import { commandToPaletteCommand, createCommand, type AiosCommand } from "./lib/commands";

import { SPAWN, SPAWN_BY_ID, type AppDef, type PaneContent } from "./lib/apps";
import {
  loadSidebar,
  reorder,
  addLink,
  removeItem,
  renameItem,
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

interface Pane {
  key: string;
  label: string;
  kind: PaneContent;
}

const isTerminal = (k: PaneContent): k is PaneKind =>
  k.type === "shell" || k.type === "oracle" || k.type === "tmux";

// Files that render in the viewer (images / pdf / office / binary); everything
// else opens in the Monaco editor pane (the editor itself falls back to "open
// externally" if the file turns out to be binary).
const VIEWER_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico",
  "md", "markdown",
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "key", "numbers", "pages",
  "zip", "gz", "tar", "dmg", "app", "mp4", "mov", "mp3", "wav", "woff", "woff2", "ttf",
]);

/** Pick the pane kind for opening a file: viewer for media/binaries, else the
 *  code editor. */
function paneForFile(path: string, name: string): PaneContent {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return VIEWER_EXT.has(ext)
    ? { type: "file", path, name }
    : { type: "editor", path, name };
}

let seq = 0;
const nextKey = () => `k${++seq}-${Math.random().toString(36).slice(2, 6)}`;

// ── session layout persistence ───────────────────────────────────────────────
// Reopen whatever panes were open last time (mac-app muscle memory) — closing a
// pane with its X removes it from the saved set, so the layout reflects what you
// left up. Only kinds that can be cleanly re-spawned are persisted; transient
// one-shot fields (chat seed/resume/reattach) are stripped so a restored chat
// doesn't re-fire its launcher prompt or try to reattach a dead backend id.
const LAYOUT_KEY = "aios.layout";

/** Strip a pane kind down to its restorable shape (drop one-shot fields). */
function persistableKind(kind: PaneContent): PaneContent | null {
  if (kind.type === "chat") return { type: "chat" }; // fresh chat, no seed/resume/reattach
  // file/editor restore by path; everything else is self-describing.
  return kind;
}

function loadLayout(): Pane[] {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return [];
    const saved = JSON.parse(raw) as { label: string; kind: PaneContent }[];
    if (!Array.isArray(saved)) return [];
    return saved.map((p) => ({ key: nextKey(), label: p.label, kind: p.kind }));
  } catch {
    return [];
  }
}

function saveLayout(panes: Pane[]) {
  try {
    const out = panes
      .map((p) => {
        const kind = persistableKind(p.kind);
        return kind ? { label: p.label, kind } : null;
      })
      .filter(Boolean);
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(out));
  } catch {
    /* quota / unavailable — skip */
  }
}

function App() {
  const [panes, setPanes] = useState<Pane[]>(() =>
    loadSettings().reopenLastLayout ? loadLayout() : [],
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [splash, setSplash] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // mission-control-style pane overview: fan out every open pane to switch.
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // pane key pending a close-confirm (busy chat: keep-running vs kill).
  const [closePrompt, setClosePrompt] = useState<string | null>(null);
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
  const toggleMax = useCallback(
    (key: string) => setMaximizedKey((cur) => (cur === key ? null : key)),
    [],
  );
  const toggleHide = useCallback((key: string) => {
    setHiddenKeys((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
    setMaximizedKey((cur) => (cur === key ? null : cur));
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
        requestAnimationFrame(() => setWindowFullscreen(true).catch(() => {})),
      );
    } else {
      // reverse order on exit: drop OS fullscreen first, then restore the prior
      // maximize state once the window is back in-space.
      setWindowFullscreen(false).catch(() => {});
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
  // backgrounded chat sessions still running after their pane closed.
  const [liveChats, setLiveChats] = useState<LiveChat[]>([]);
  // personalizable sidebar — items + order live in lib/sidebar (localStorage).
  const [sidebar, setSidebar] = useState<SidebarState>(loadSidebar);
  useEffect(() => subscribeSidebar(setSidebar), []);
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
    const teardown = initTheme();
    applyFlashLevel(); // reflect stored composer flash level on <html>
    return teardown;
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

  const spawn = useCallback((kind: PaneContent, label: string): string => {
    const key = nextKey();
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

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ url: string; profile?: string }>("browser-new-pane", ({ payload }) => {
      if (!payload.url) return;
      spawn({ type: "browser", url: payload.url, profile: payload.profile }, "browser");
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [spawn]);

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

  // remember the last file opened in the editor so F5 knows which project to run
  const lastOpenPath = useRef<string | null>(null);
  const openFile = useCallback(
    (path: string, name: string) => {
      lastOpenPath.current = path;
      spawn(paneForFile(path, name), name);
    },
    [spawn],
  );
  // expose openFile to deep children (chat artifact cards) via paneBus, so a
  // produced file opens as an in-app viewer pane instead of the OS app.
  useEffect(() => registerOpenFile(openFile), [openFile]);
  useEffect(() => registerOpenUrl(openUrl), [openUrl]);

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
      .catch(() => {});
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
  const addOracle = useCallback(
    (identity: string) => spawn({ type: "oracle", identity }, identity),
    [spawn],
  );
  const addTmux = useCallback(
    (socket: string, session: string) => spawn({ type: "tmux", socket, session }, session),
    [spawn],
  );
  const closePane = useCallback((key: string) => {
    setPanes((p) => p.filter((x) => x.key !== key));
    setHiddenKeys((h) => h.filter((k) => k !== key));
    setMaximizedKey((m) => (m === key ? null : m));
    setActiveKey((a) => (a === key ? null : a));
  }, []);
  // Closing a chat pane whose claude is mid-task → prompt to keep it running in
  // the background (with optional done-notification) instead of killing it.
  const requestClose = useCallback(
    (key: string) => {
      const handle = chatHandles.get(key);
      if (handle?.busy()) {
        setClosePrompt(key);
        return;
      }
      closePane(key);
    },
    [closePane],
  );
  const resumeChat = useCallback(
    (s: ChatSessionInfo) =>
      spawn({ type: "chat", resume: { id: s.id, title: s.title } }, s.title || "chat"),
    [spawn],
  );

  // Shared live data for the idle homescreen + the ⌘K palette: the fleet, the
  // recent chats to resume, and the customer inbox. One source, polled gently;
  // every getter is defensive so a missing backend just yields an empty list.
  const [oracles, setOracles] = useState<OracleInfo[]>([]);
  const [chats, setChats] = useState<ChatSessionInfo[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  // every runnable project under ~/Repo (auto-scanned), merged with the user's
  // project store (custom adds / hides / name+cmd overrides — CRUD from Settings).
  const [scanned, setScanned] = useState<ProjectInfo[]>([]);
  const [projStore, setProjStore] = useState(loadProjectsStore);
  useEffect(() => subscribeProjects(() => setProjStore(loadProjectsStore())), []);
  const projects = useMemo(() => mergeProjects(scanned, projStore), [scanned, projStore]);
  const [home, setHome] = useState<string>("");
  useEffect(() => {
    let alive = true;
    const load = () => {
      listOracles().then((v) => alive && setOracles(v)).catch(() => {});
      listChatSessions(12).then((v) => alive && setChats(v)).catch(() => {});
      listCustomers().then((v) => alive && setCustomers(v)).catch(() => {});
      listChatLive().then((v) => alive && setLiveChats(v)).catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Discover every runnable project under ~/Repo once on mount so each one gets
  // its own ⌘K "run <name>" entry. Cheap (bounded scan), so no polling — a stale
  // list just misses a brand-new repo until next launch.
  const loadProjects = useCallback(() => {
    listProjects().then(setScanned).catch(() => {});
  }, []);
  useEffect(() => {
    homeDir().then(setHome).catch(() => {});
    loadProjects();
  }, [loadProjects]);

  // spawn a run terminal for a discovered project, exactly like F5 (logs stream
  // + flutter `r` hot-reload work in-pane). Uses the project's primary command.
  const runProject = useCallback(
    (p: ProjectInfo) => {
      const c = p.commands[0];
      if (!c) {
        flash(`no run command for ${p.name}`);
        return;
      }
      spawn({ type: "shell", cmd: c.cmd, cwd: p.root }, `▶ ${p.name}`);
      flash(`▶ ${c.cmd}`);
    },
    [spawn, flash],
  );

  // background chat tray refreshes faster so a finished/closed task shows up
  // (and drops off on reattach) without waiting on the 30s data loop.
  useEffect(() => {
    let alive = true;
    const t = setInterval(() => {
      listChatLive().then((v) => alive && setLiveChats(v)).catch(() => {});
    }, 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const fireAppshot = useCallback(async () => {
    try {
      const path = await appshot();
      flash(`appshot → master oracle · ${path.split("/").pop()}`);
    } catch (e) {
      flash(`appshot failed: ${e}`);
    }
  }, [flash]);

  // voice dictation → the focused terminal pane, else clipboard.
  const focusedPane = useRef<string | null>(null);
  // Focus a pane from the "OPEN" rail: restore it if minimized, mark it active
  // so dictation / drops target it (and the rail row highlights).
  const focusPane = useCallback((key: string) => {
    setHiddenKeys((h) => h.filter((k) => k !== key));
    focusedPane.current = key;
    setActiveKey(key);
  }, []);
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
        navigator.clipboard?.writeText(text).catch(() => {});
        flash("transcribed → ⌘V to paste");
      }
    },
    [flash],
  );

  // Browser annotations / selections → into a chat pane (the superapp loop).
  const routeToChat = useCallback(
    (text: string) => {
      const chatPane = panes.find((p) => p.kind.type === "chat");
      const w = chatPane ? paneWriters.get(chatPane.key) : null;
      if (w) {
        w(text);
        flash("→ chat");
      } else {
        navigator.clipboard?.writeText(text).catch(() => {});
        spawn({ type: "chat" }, "chat");
        flash("opened chat · annotation copied (⌘V)");
      }
    },
    [panes, flash, spawn],
  );

  // "Send to AI" (notes pane → the configured default AI). Routes by the
  // `defaultAi` setting: claude-code terminal (firaz's default), a plain
  // terminal, or the in-app chat. Reuses each pane's SUBMITTER (paneSubmitters)
  // so the text is pasted AND actually sent (terminal: text + Enter; chat: real
  // submit). Restores a minimized target, or spawns a fresh pane and fires once
  // it's live (claude's TUI needs a beat to boot, so a freshly-spawned terminal
  // gets a delayed submit).
  const sendToAi = useCallback(
    (text: string) => {
      const body = text.trim();
      if (!body) return;
      const ai = loadSettings().defaultAi;

      // submit into an EXISTING pane (restore it from minimized first).
      const fireExisting = (key: string): boolean => {
        const s = paneSubmitters.get(key);
        if (!s) return false;
        setHiddenKeys((h) => h.filter((k) => k !== key));
        focusedPane.current = key;
        setActiveKey(key);
        s(body);
        return true;
      };

      // spawn a fresh pane, then poll for its submitter and fire (after a boot
      // grace for CLI TUIs like claude that aren't ready the instant they mount).
      const spawnAndFire = (kind: PaneContent, label: string, bootMs: number) => {
        const key = spawn(kind, label);
        let tries = 0;
        const tick = () => {
          const s = paneSubmitters.get(key);
          if (s) {
            setTimeout(() => s(body), bootMs);
            return;
          }
          if (tries++ < 50) setTimeout(tick, 150);
        };
        tick();
      };

      if (ai === "chat") {
        const cp = panes.find((p) => p.kind.type === "chat");
        if (cp && fireExisting(cp.key)) {
          flash("sent → chat");
          return;
        }
        // a fresh chat auto-sends its `seed` once claude is ready — cleanest path.
        spawn({ type: "chat", seed: body }, "chat");
        flash("sent → new chat");
        return;
      }

      // claude-code: a shell pane whose command launches claude. terminal: any
      // plain shell pane (no claude command).
      const wantClaude = ai === "claude-code";
      const match = panes.find(
        (p) =>
          p.kind.type === "shell" &&
          (wantClaude
            ? (p.kind.cmd ?? "").includes("claude")
            : !(p.kind.cmd ?? "").includes("claude")),
      );
      if (match && fireExisting(match.key)) {
        flash(wantClaude ? "sent → claude code" : "sent → terminal");
        return;
      }
      // none open → spawn the right one and fire when it's live.
      if (wantClaude) {
        spawnAndFire(
          { type: "shell", cmd: "claude --dangerously-skip-permissions" },
          "claude code",
          3200,
        );
        flash("opening claude code → sending…");
      } else {
        spawnAndFire({ type: "shell" }, "terminal", 600);
        flash("opening terminal → sending…");
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
        setPaletteOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (mod && (e.key.toLowerCase() === "t" || e.key.toLowerCase() === "n")) {
        // ⌘T / ⌘N — new terminal
        e.preventDefault();
        addShell();
      } else if (mod && e.key.toLowerCase() === "r") {
        // ⌘R — reload the cockpit fresh (re-init theme, re-poll all live data).
        e.preventDefault();
        window.location.reload();
      } else if (mod && e.key.toLowerCase() === "w") {
        // ⌘W — close the focused pane (mac muscle memory). Falls back to the
        // active pane; no-op when nothing's focused.
        e.preventDefault();
        const k = focusedPane.current ?? activeKey;
        if (k) requestClose(k);
      } else if ((mod && e.key === "`") || (e.ctrlKey && e.key === "ArrowUp")) {
        // ⌘` / Ctrl+↑ — toggle the mission-control pane overview (switch panes).
        // Ctrl+↑ mirrors macOS Mission Control; ⌘` mirrors window-cycle.
        e.preventDefault();
        if (panes.length > 0) setOverviewOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === "f") {
        // ⌘F — fullscreen the SELECTED pane (true screen-fill, any type). Only
        // intercept when panes exist; otherwise let ⌘F pass (in-page find etc).
        if (toggleFullscreenSelected()) e.preventDefault();
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
        const idx = Number(e.key) - 1;
        const p = panes[idx];
        if (p) focusPane(p.key);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "F5") {
        // F5 — run the current project (VS Code's start-debugging muscle memory)
        e.preventDefault();
        runF5();
      } else if (e.key === "Escape" && maximizedKey) {
        // Esc — exit a maximized/fullscreen pane.
        setWindowFullscreen(false).catch(() => {});
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
  }, [addShell, fireAppshot, runF5, toggleFullscreenSelected, requestClose, toggleHide, focusPane, activeKey, maximizedKey, panes]);

  // ---- trackpad swipe-UP → open the pane overview (mac Mission Control muscle
  // memory). macOS reserves the LITERAL 3-finger swipe for its own Mission
  // Control, so a true 3-finger gesture never reaches the webview — all we get
  // is wheel events from a 2-finger scroll. To keep ordinary scrolling (reading
  // terminal backlog, a webpage, notes) from popping the overview, we require a
  // genuine HARD FLICK: a long burst of travel (FLING) that ALSO contains at
  // least one high-velocity event (FLICK_VEL). Slow/precise reading-scroll never
  // hits the velocity floor, so it can't trigger no matter how far it travels.
  // Swipe-DOWN with the same force while open closes it.
  const wheelAccum = useRef(0);
  const wheelPeak = useRef(0); // strongest single-event |deltaY| this gesture
  const wheelLast = useRef(0);
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      // ignore pinch-zoom (ctrl) and horizontal-dominant gestures
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const now = e.timeStamp || performance.now();
      if (now - wheelLast.current > 150) {
        wheelAccum.current = 0; // new gesture
        wheelPeak.current = 0;
      }
      wheelLast.current = now;
      wheelAccum.current += e.deltaY;
      wheelPeak.current = Math.max(wheelPeak.current, Math.abs(e.deltaY));
      const FLING = 600; // px of accumulated travel — a long, decisive throw
      const FLICK_VEL = 80; // a single fast event must be in the burst (a flick)
      if (wheelPeak.current < FLICK_VEL) return; // slow scroll → never a gesture
      if (!overviewOpen && wheelAccum.current < -FLING && panes.length > 0) {
        wheelAccum.current = 0;
        wheelPeak.current = 0;
        setOverviewOpen(true);
      } else if (overviewOpen && wheelAccum.current > FLING) {
        wheelAccum.current = 0;
        wheelPeak.current = 0;
        setOverviewOpen(false);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [overviewOpen, panes.length]);

  // Native OS drag-drop (Finder files/folders, e.g. a screenshot) → insert paths
  // into the targeted terminal pane. Because `dragDropEnabled` is true, macOS
  // intercepts file drops natively and the webview's HTML5 drag events never
  // fire — so this Tauri handler is the ONLY path for OS files (the in-app
  // `application/x-aios-path` handler on TerminalPane covers Files-pane drags).
  useEffect(() => {
    // Resolve the pane key under a physical (device-pixel) drop position. xterm's
    // canvas/textarea sit inside the [data-pane-key] wrapper, so closest() walks
    // up to the pane regardless of which internal node is hit-tested.
    const paneKeyAt = (x: number, y: number): string | null => {
      const dpr = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(x / dpr, y / dpr);
      return el?.closest<HTMLElement>("[data-pane-key]")?.getAttribute("data-pane-key") ?? null;
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
      // Prefer the pane under the cursor; fall back to the focused pane so a drop
      // that lands on a gap / title bar still inserts (screenshots are easy to
      // miss-aim). Only fall back to a real terminal-backed pane.
      let key = paneKeyAt(position.x, position.y);
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
      const isImage = (p: string) => /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?)$/i.test(p);
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
      void un.then((f) => f());
    };
  }, [flash]);

  // grid is sized to the VISIBLE panes — hidden ones are display:none (out of
  // grid flow), so they leave no empty cell behind.
  const visibleCount = panes.length - hiddenKeys.length;
  const { cols, rows } = useMemo(() => {
    const n = visibleCount || 1;
    const c = Math.ceil(Math.sqrt(n));
    return { cols: c, rows: Math.ceil(n / c) };
  }, [visibleCount]);

  const commands: Command[] = useMemo(() => {
    const ctx = { source: "palette" as const, activePaneKey: activeKey };
    const toPalette = (
      command: AiosCommand,
      group: string,
      actionLabel: string,
      subtitle?: string,
    ) =>
      commandToPaletteCommand(command, {
        context: ctx,
        group,
        actionLabel,
        subtitle,
      });
    const registry = [
      ...SPAWN.map((s) => ({
        command: createCommand({
          id: `pane.open.${s.id}`,
          label: `new ${s.label}`,
          scope: "pane",
          icon: <s.icon size={14} />,
          keywords: ["open", "pane", "spawn", "launch", "new"],
          run: () => spawn(s.kind, s.label),
        }),
        group: "open",
        actionLabel: "open",
      })),
      ...chats.map((c) => ({
        command: createCommand({
          id: `chat.resume.${c.id}`,
          label: c.title || "untitled chat",
          description: c.cwd ? c.cwd.split("/").pop() : undefined,
          scope: "chat",
          icon: <MessageSquare size={14} />,
          keywords: ["chat", "session", "continue", "resume", c.cwd ?? ""],
          run: () => resumeChat(c),
        }),
        group: "resume",
        actionLabel: "resume",
      })),
      ...oracles.map((o) => ({
        command: createCommand({
          id: `oracle.attach.${o.identity}`,
          label: `oracle: ${o.display_name}`,
          description: o.running ? "running" : "idle",
          scope: "global",
          icon: <Radio size={14} />,
          keywords: ["oracle", "agent", "attach", "session", o.identity],
          run: () => addOracle(o.identity),
        }),
        group: "fleet",
        actionLabel: "attach",
      })),
      ...customers.slice(0, 8).map((c) => ({
        command: createCommand({
          id: `customer.open.${c.id}`,
          label: c.name,
          description: c.lastAgo ? `${c.lastAgo} ago` : undefined,
          scope: "global",
          icon: <MessageCircle size={14} />,
          keywords: ["customer", "message", "whatsapp", "inbox", c.handle],
          run: () => spawn({ type: "customers" }, "customers"),
        }),
        group: "customers",
        actionLabel: "open inbox",
      })),
      ...projects.map((p) => {
        const rel = home && p.root.startsWith(home)
          ? p.root.slice(home.length).replace(/^\//, "")
          : p.root;
        return {
          command: createCommand({
            id: `project.run.${p.root}`,
            label: `run ${p.name}`,
            description: `${p.kind} · ${rel}`,
            scope: "run",
            icon: <Play size={14} />,
            keywords: ["run", "start", "launch", "project", p.name, p.kind, rel],
            run: () => runProject(p),
          }),
          group: "run",
          actionLabel: "run",
        };
      }),
      {
        command: createCommand({
          id: "view.sidebar.toggle",
          label: "toggle sidebar",
          description: "⌘B",
          scope: "global",
          icon: <PanelLeft size={14} />,
          hotkeys: ["mod+b"],
          keywords: ["rail", "hide", "show"],
          run: () => setSidebarOpen((v) => !v),
        }),
        group: "view",
        actionLabel: "toggle",
      },
      {
        command: createCommand({
          id: "view.overview.open",
          label: "show all panes",
          description: "⌘`",
          scope: "pane",
          icon: <Layers size={14} />,
          keywords: ["overview", "mission", "control", "switch", "panes", "windows", "fan", "out"],
          enabled: () => panes.length > 0,
          run: () => setOverviewOpen(true),
        }),
        group: "view",
        actionLabel: "open",
      },
      {
        command: createCommand({
          id: "pane.tile.all",
          label: "tile all panes",
          scope: "pane",
          icon: <Maximize2 size={14} />,
          keywords: ["show", "all", "restore", "unminimize", "tile", "grid", "every", "pane", "visible"],
          run: () => {
            setHiddenKeys([]);
            setMaximizedKey(null);
          },
        }),
        group: "view",
        actionLabel: "tile",
      },
      {
        command: createCommand({
          id: "project.run.focused",
          label: "run focused project",
          description: "F5",
          scope: "run",
          icon: <Play size={14} />,
          hotkeys: ["f5"],
          keywords: ["f5", "run", "debug", "start", "flutter", "npm", "dev", "build", "terminal", "focused", "open", "file"],
          run: () => runF5(),
        }),
        group: "actions",
        actionLabel: "run",
      },
      {
        command: createCommand({
          id: "oracle.appshot",
          label: "appshot — screenshot to oracle",
          description: "⌘⌘",
          scope: "global",
          danger: "external",
          icon: <Camera size={14} />,
          keywords: ["screenshot", "capture", "oracle"],
          run: fireAppshot,
        }),
        group: "actions",
        actionLabel: "run",
      },
      {
        command: createCommand({
          id: "app.settings.open",
          label: "settings",
          description: "⌘,",
          scope: "global",
          icon: <SettingsIcon size={14} />,
          keywords: ["preferences", "theme", "appearance"],
          run: () => setSettingsOpen(true),
        }),
        group: "app",
        actionLabel: "open",
      },
    ];
    return registry.map((entry) =>
      toPalette(entry.command, entry.group, entry.actionLabel, entry.command.description),
    );
  }, [spawn, fireAppshot, chats, oracles, customers, resumeChat, addOracle, runF5, projects, home, runProject, panes.length, activeKey]);

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      {splash && <Splash />}

      {/* top bar */}
      <header
        className="glass flex h-10 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-panel)]/70 pl-20 pr-3"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-1">
          <IconBtn title="Toggle sidebar (⌘B)" onClick={() => setSidebarOpen((v) => !v)} active={sidebarOpen}>
            <PanelLeft size={15} />
          </IconBtn>
          <IconBtn title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}>
            <Search size={15} />
          </IconBtn>
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold tracking-tight text-[var(--color-accent)]">
            aios
          </span>
          <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--color-muted)]">
            superapp
          </span>
        </div>

        <div className="flex items-center gap-1">
          <ThemeSwitcher />
          <span className="mx-0.5 h-4 w-px bg-[var(--color-border)]" />
          <VoiceButton onTranscript={handleTranscript} />
          <IconBtn title="Appshot — screenshot to oracle (⌘⌘)" onClick={fireAppshot}>
            <Camera size={15} />
          </IconBtn>
        </div>
      </header>

      {/* body: sidebar + pane grid */}
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2">
              {panes.length > 0 && (
                <OpenPanesList
                  panes={panes}
                  hiddenKeys={hiddenKeys}
                  maximizedKey={maximizedKey}
                  activeKey={activeKey}
                  onSelect={focusPane}
                  onToggleHide={toggleHide}
                  onClose={requestClose}
                  onRename={renamePane}
                />
              )}
              <SidebarRail
                state={sidebar}
                onSpawn={spawnSidebarItem}
                onPinSite={(spaceId) => setPinSiteSpace(spaceId)}
              />
              <OracleRoster onAttachOracle={addOracle} onAttachTmux={addTmux} />
            </div>
            <div className="flex flex-col gap-0.5 border-t border-[var(--color-border)] p-2">
              <NavRow icon={SettingsIcon} label="settings" onClick={() => setSettingsOpen(true)} />
              <AccountMenu onOpenSettings={() => setSettingsOpen(true)} />
            </div>
          </aside>
        )}

        <main className="relative min-h-0 flex-1">
          {(() => {
            const idleDash = (
              <IdleDashboard
                apps={SPAWN}
                oracles={oracles}
                projects={projects}
                sidebar={sidebar}
                onSpawn={spawn}
                onAttachOracle={addOracle}
                onOpenProject={(p) => spawn({ type: "shell", cwd: p.root }, p.name)}
                onOpenSidebarItem={spawnSidebarItem}
                onRevealSidebar={() => setSidebarOpen(true)}
                onOpenPalette={() => setPaletteOpen(true)}
              />
            );
            // No panes at all → idle. If panes exist but ALL are hidden, keep them
            // mounted (state-preserving) in the grid and overlay idle on top — else
            // the grid is all-`display:none` and the screen goes blank.
            if (panes.length === 0) return idleDash;
            return (
              <>
                {visibleCount === 0 && <div className="absolute inset-0 z-10">{idleDash}</div>}
            <ResizableGrid cols={cols} rows={rows} gap={8}>
              {panes.map((pane) => (
                <PaneCard
                  key={pane.key}
                  pane={pane}
                  active={
                    !overlayOpen &&
                    !hiddenKeys.includes(pane.key) &&
                    (maximizedKey === null || maximizedKey === pane.key)
                  }
                  maximized={maximizedKey === pane.key}
                  hidden={hiddenKeys.includes(pane.key)}
                  dropTarget={dropTargetKey === pane.key}
                  onClose={() => requestClose(pane.key)}
                  onToggleMax={() => toggleMax(pane.key)}
                  onToggleHide={() => toggleHide(pane.key)}
                  onFocus={() => {
                    focusedPane.current = pane.key;
                    setActiveKey(pane.key);
                  }}
                  onAnnotate={routeToChat}
                  onSendToAi={sendToAi}
                  onOpenFile={openFile}
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
                  onVideoFullscreen={(on) => onVideoFullscreen(pane.key, on)}
                />
              ))}
            </ResizableGrid>
              </>
            );
          })()}
        </main>
      </div>

      {toast && (
        <div className="modal-in glass absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/90 px-3 py-2 text-[12px] text-[var(--color-text)] shadow-2xl">
          {toast}
        </div>
      )}

      {/* background chat sessions — still running after their pane closed */}
      {liveChats.length > 0 && (
        <div className="absolute bottom-4 right-4 z-40 flex w-64 flex-col gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/95 p-2 shadow-2xl backdrop-blur">
          <div className="px-1 text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
            running in background
          </div>
          {liveChats.map((lc) => (
            <button
              key={lc.id}
              onClick={() => spawn({ type: "chat", reattach: lc.id }, lc.title || "chat")}
              className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1.5 text-left hover:border-[var(--color-accent)]/40"
              title="reopen — reattach + replay"
            >
              <span className={`status-dot shrink-0 ${lc.busy ? "status-dot--active" : "status-dot--cold"}`} />
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-2)]">
                {lc.title || "chat"}
              </span>
              <span className="shrink-0 text-[9px] text-[var(--color-faint)]">{lc.busy ? "working" : "done"}</span>
            </button>
          ))}
        </div>
      )}

      {/* minimized panes now live in the sidebar "OPEN" list (OpenPanesList) —
          no floating overlay. Restore / hide / close all happen from the rail. */}

      {/* close a busy chat: keep running in background, or kill */}
      {closePrompt && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-black/50" onClick={() => setClosePrompt(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="modal-in w-[400px] rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-4 shadow-2xl"
          >
            <div className="text-[13px] font-medium text-[var(--color-text)]">this chat is still working</div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-muted)]">
              keep it running in the background so it finishes the task, or stop it?
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => {
                  chatHandles.get(closePrompt)?.detach(true);
                  closePane(closePrompt);
                  setClosePrompt(null);
                }}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white"
              >
                keep running + notify me when done
              </button>
              <button
                onClick={() => {
                  chatHandles.get(closePrompt)?.detach(false);
                  closePane(closePrompt);
                  setClosePrompt(null);
                }}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] hover:border-[var(--color-accent)]/50"
              >
                keep running (no notification)
              </button>
              <button
                onClick={() => {
                  closePane(closePrompt);
                  setClosePrompt(null);
                }}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-danger)] hover:border-[var(--color-danger)]/50"
              >
                stop &amp; close
              </button>
            </div>
          </div>
        </div>
      )}

      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
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

function NavRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Folder;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--color-text-2)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
    >
      <Icon size={15} className="shrink-0 text-[var(--color-muted)] group-hover:text-[var(--color-text)]" />
      {label}
    </button>
  );
}

/* ── personalizable sidebar rail ─────────────────────────────────────────── */

/** A collapsible space header: click the title to fold/unfold; hover reveals a
 *  ⋯ menu (rename always; delete only for custom spaces — the three built-ins
 *  are protected). Inline rename mirrors the row rename UX. */
function SpaceHeader({ space, count }: { space: SidebarSpace; count: number }) {
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
    <div className="group/sh relative flex items-center pl-1.5 pr-1">
      <button
        onClick={() => toggleSpaceCollapsed(space.id)}
        className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-[var(--color-faint)] transition-colors hover:text-[var(--color-muted)]"
        title={space.collapsed ? "expand" : "collapse"}
      >
        {space.collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        <span className="truncate">{space.name}</span>
        {space.collapsed && count > 0 && (
          <span className="text-[var(--color-faint)]">({count})</span>
        )}
      </button>
      <div ref={menuRef} className="relative shrink-0">
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
      </div>
    </div>
  );
}

/** The store-driven rail: built-in apps + pinned sites organized into SPACES
 *  (collapsible, user-creatable sections). Drag-to-reorder rows within/across
 *  spaces (native HTML5 DnD); per-row rename / hide / unpin / move-to-space;
 *  per-space rename / collapse / delete; "+ new space" at the foot. */
function SidebarRail({
  state,
  onSpawn,
  onPinSite,
}: {
  state: SidebarState;
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
            <SpaceHeader space={space} count={rows.length} />
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
                    />
                  );
                })}
                {isPinned && (
                  <button
                    onClick={() => onPinSite(space.id)}
                    className="group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                    title="pin a website to the sidebar"
                  >
                    <Plus size={14} className="shrink-0" />
                    pin a site
                  </button>
                )}
                {!isPinned && rows.length === 0 && (
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
        className="group mt-1.5 flex w-full items-center gap-2.5 rounded-md border-t border-[var(--color-border)] px-2.5 pt-2.5 pb-1.5 text-left text-[12px] text-[var(--color-faint)] transition-colors hover:text-[var(--color-text)]"
        title="create a new space"
      >
        <FolderPlus size={14} className="shrink-0" />
        new space
      </button>
    </>
  );
}

/** One sidebar row — draggable, resolves to a lucide icon (apps) or a cached
 *  favicon (links), with a hover ⋯ menu (rename / hide / unpin). */
function SidebarRow({
  item,
  spaces,
  dragging,
  over,
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
  onSpawn: () => void;
  onSetSpace: (spaceId: string) => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.label);
  const [favBroken, setFavBroken] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isLink = item.kind.type === "link";
  const app = item.kind.type === "app" ? SPAWN_BY_ID[item.kind.appId] : undefined;
  const Icon = app?.icon ?? Globe;

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
      className={`group relative flex items-center rounded-md transition-colors ${
        dragging ? "opacity-40" : ""
      } ${over ? "bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]/40" : "hover:bg-[var(--color-panel-2)]"}`}
    >
      <span className="grid w-4 shrink-0 cursor-grab place-items-center text-[var(--color-faint)] opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing">
        <GripVertical size={12} />
      </span>
      <button
        onClick={onSpawn}
        className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-1 text-left text-[13px] text-[var(--color-text-2)] transition-colors group-hover:text-[var(--color-text)]"
      >
        {isLink && item.faviconUrl && !favBroken ? (
          <img
            src={item.faviconUrl}
            alt=""
            onError={() => setFavBroken(true)}
            className="h-[15px] w-[15px] shrink-0 rounded-sm"
          />
        ) : (
          <Icon size={15} className="shrink-0 text-[var(--color-muted)] group-hover:text-[var(--color-text)]" />
        )}
        <span className="truncate">{item.label}</span>
      </button>
      <div ref={menuRef} className="relative shrink-0">
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="grid h-6 w-6 place-items-center rounded text-[var(--color-muted)] opacity-0 transition-opacity hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] group-hover:opacity-100"
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
  browser: Globe,
  memory: Database,
  notes: NotebookPen,
  automations: Clock,
  bridges: Radio,
  plugins: Layers,
  pulse: Radio,
  chat: MessageSquare,
  customers: MessageCircle,
  motion: Wand2,
  file: FileText,
  editor: FileText,
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
  browser: "status-dot--cold",
  memory: "status-dot--cold",
  notes: "status-dot--cold",
  automations: "status-dot--cold",
  bridges: "status-dot--cold",
  plugins: "status-dot--cold",
  pulse: "status-dot--active",
  chat: "status-dot--active",
  customers: "status-dot--active",
  motion: "status-dot--cold",
  file: "status-dot--cold",
};

/** The "OPEN" rail section — a live, CRUD-able list of every open pane (replaces
 *  the old floating "hidden" overlay). Click a row to focus it (restoring it from
 *  minimized first); the eye toggles minimize/restore; the X closes it. Minimized
 *  rows render dimmed. This is the window-manager for the deck, in the sidebar. */
function OpenPanesList({
  panes,
  hiddenKeys,
  maximizedKey,
  activeKey,
  onSelect,
  onToggleHide,
  onClose,
  onRename,
}: {
  panes: Pane[];
  hiddenKeys: string[];
  maximizedKey: string | null;
  activeKey: string | null;
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
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
        <Layers size={11} />
        <span>open</span>
        <span className="text-[var(--color-faint)]">({panes.length})</span>
      </div>
      {panes.map((p) => {
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
              className={`flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                hidden ? "text-[var(--color-faint)]" : "text-[var(--color-text-2)] group-hover:text-[var(--color-text)]"
              }`}
              title={hidden ? "restore pane" : "focus pane · double-click to rename"}
            >
              <span className={`status-dot shrink-0 ${hidden ? "status-dot--cold" : DOT[p.kind.type] ?? "status-dot--cold"}`} />
              <span className="truncate">{p.label}</span>
              {maximized && <Maximize2 size={10} className="shrink-0 text-[var(--color-accent)]" />}
            </button>
            <div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-hover:opacity-100">
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
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PaneCard({
  pane,
  active,
  maximized,
  hidden,
  dropTarget,
  onClose,
  onToggleMax,
  onToggleHide,
  onFocus,
  onAnnotate,
  onSendToAi,
  onOpenFile,
  onOpenUrl,
  onProfileChange,
  onVideoFullscreen,
}: {
  pane: Pane;
  active: boolean;
  maximized?: boolean;
  hidden?: boolean;
  dropTarget?: boolean;
  onClose: () => void;
  onToggleMax?: () => void;
  onToggleHide?: () => void;
  onFocus: () => void;
  onAnnotate: (text: string) => void;
  onSendToAi: (text: string) => void;
  onOpenFile: (path: string, name: string) => void;
  onOpenUrl?: (url: string) => void;
  onProfileChange: (profile: string) => void;
  onVideoFullscreen?: (on: boolean) => void;
}) {
  const t = pane.kind.type;
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
  const toggleMon = () => {
    if (!monTarget) return;
    if (mon) monitorStop(monTarget.session).catch(() => {});
    else monitorStart(monTarget.socket, monTarget.session).catch(() => {});
    setMon((v) => !v);
  };
  return (
    <div
      data-pane-key={pane.key}
      onMouseDownCapture={onFocus}
      style={hidden ? { display: "none" } : undefined}
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
        {isTerminal(pane.kind) ? (
          <TerminalPane kind={pane.kind} paneKey={pane.key} />
        ) : pane.kind.type === "files" ? (
          <FilesPane onOpenFile={onOpenFile} />
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
        ) : pane.kind.type === "memory" ? (
          <DatabasePane onOpenUrl={onOpenUrl} />
        ) : pane.kind.type === "notes" ? (
          <NotesPane onSend={onSendToAi} />
        ) : pane.kind.type === "automations" ? (
          <AutomationsPane />
        ) : pane.kind.type === "bridges" ? (
          <BridgesPane />
        ) : pane.kind.type === "plugins" ? (
          <PluginsPane />
        ) : pane.kind.type === "pulse" ? (
          <PulsePane />
        ) : pane.kind.type === "customers" ? (
          <CrmPane />
        ) : pane.kind.type === "motion" ? (
          <MotionPane />
        ) : pane.kind.type === "file" ? (
          <FileViewerPane path={pane.kind.path} />
        ) : pane.kind.type === "editor" ? (
          <EditorPane path={pane.kind.path} name={pane.kind.name} />
        ) : (
          <ChatPane
            paneKey={pane.key}
            seed={pane.kind.type === "chat" ? pane.kind.seed : undefined}
            resume={pane.kind.type === "chat" ? pane.kind.resume : undefined}
            reattach={pane.kind.type === "chat" ? pane.kind.reattach : undefined}
            onOpenUrl={onOpenUrl}
          />
        )}
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
