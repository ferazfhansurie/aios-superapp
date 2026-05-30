import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  Camera,
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
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
  PanelLeft,
  Pencil,
  Pin,
  Play,
  Plus,
  Radio,
  Search,
  Settings as SettingsIcon,
  Trash2,
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
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { appshot, listOracles, type OracleInfo } from "./lib/pty";
import { listChatLive, listChatSessions, type ChatSessionInfo, type LiveChat } from "./lib/chat";
import { listCustomers, type Customer } from "./lib/inbox";
import { initTheme } from "./lib/theme";
import { monitorStart, monitorStop } from "./lib/monitor";
import { chatHandles, paneWriters, paneSubmitters } from "./lib/paneBus";
import { loadSettings } from "./lib/settings";
import { homeDir } from "./lib/fs";
import { detectProject, listProjects, type ProjectInfo } from "./lib/run";
import { loadProjectsStore, mergeProjects, subscribeProjects } from "./lib/projects";

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

function App() {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [splash, setSplash] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
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
  const overlayOpen = settingsOpen || paletteOpen || pinSiteSpace != null;

  useEffect(() => {
    const t = setTimeout(() => setSplash(false), 850);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => initTheme(), []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const spawn = useCallback((kind: PaneContent, label: string): string => {
    const key = nextKey();
    setPanes((p) => [...p, { key, kind, label }]);
    return key;
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

  // remember the last file opened in the editor so F5 knows which project to run
  const lastOpenPath = useRef<string | null>(null);
  const openFile = useCallback(
    (path: string, name: string) => {
      lastOpenPath.current = path;
      spawn(paneForFile(path, name), name);
    },
    [spawn],
  );

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
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "F5") {
        // F5 — run the current project (VS Code's start-debugging muscle memory)
        e.preventDefault();
        runF5();
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
  }, [addShell, fireAppshot, runF5]);

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
      const text = paths
        .map((path) => (/[\s'"\\]/.test(path) ? `'${path.replace(/'/g, "'\\''")}' ` : `${path} `))
        .join("");
      w(text);
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

  const commands: Command[] = useMemo(
    () => [
      ...SPAWN.map((s) => ({
        id: `spawn-${s.label}`,
        title: `new ${s.label}`,
        group: "open",
        icon: <s.icon size={14} />,
        keywords: "open pane spawn launch new",
        actionLabel: "open",
        run: () => spawn(s.kind, s.label),
      })),
      // resume any recent chat — the highest-value dynamic entry (raycast-style:
      // one box launches, asks, and continues). cwd as the faint right column.
      ...chats.map((c) => ({
        id: `resume-${c.id}`,
        title: c.title || "untitled chat",
        subtitle: c.cwd ? c.cwd.split("/").pop() : undefined,
        group: "resume",
        icon: <MessageSquare size={14} />,
        keywords: `chat session continue resume ${c.cwd}`,
        actionLabel: "resume",
        run: () => resumeChat(c),
      })),
      // attach any live/known oracle from the fleet.
      ...oracles.map((o) => ({
        id: `oracle-${o.identity}`,
        title: `oracle: ${o.display_name}`,
        subtitle: o.running ? "running" : "idle",
        group: "fleet",
        icon: <Radio size={14} />,
        keywords: `oracle agent attach session ${o.identity}`,
        actionLabel: "attach",
        run: () => addOracle(o.identity),
      })),
      // jump straight to a customer thread (opens the inbox).
      ...customers.slice(0, 8).map((c) => ({
        id: `customer-${c.id}`,
        title: c.name,
        subtitle: c.lastAgo ? `${c.lastAgo} ago` : undefined,
        group: "customers",
        icon: <MessageCircle size={14} />,
        keywords: `customer message whatsapp inbox ${c.handle}`,
        actionLabel: "open inbox",
        run: () => spawn({ type: "customers" }, "customers"),
      })),
      // one "run <name>" per discovered ~/Repo project — type a repo name in ⌘K
      // and ⏎ launches its primary command in a fresh run terminal.
      ...projects.map((p) => {
        const rel = home && p.root.startsWith(home)
          ? p.root.slice(home.length).replace(/^\//, "")
          : p.root;
        return {
          id: `run-project-${p.root}`,
          title: `run ${p.name}`,
          subtitle: `${p.kind} · ${rel}`,
          group: "run",
          icon: <Play size={14} />,
          keywords: `run start launch project ${p.name} ${p.kind} ${rel}`,
          actionLabel: "run",
          run: () => runProject(p),
        };
      }),
      { id: "sidebar", title: "toggle sidebar", subtitle: "⌘B", group: "view", icon: <PanelLeft size={14} />, keywords: "rail hide show", actionLabel: "toggle", run: () => setSidebarOpen((v) => !v) },
      { id: "run", title: "run focused project", subtitle: "F5", group: "actions", icon: <Play size={14} />, keywords: "f5 run debug start flutter npm dev build terminal focused open file — type a repo name for a specific project", actionLabel: "run", run: () => runF5() },
      { id: "appshot", title: "appshot — screenshot to oracle", subtitle: "⌘⌘", group: "actions", icon: <Camera size={14} />, keywords: "screenshot capture", actionLabel: "run", run: fireAppshot },
      { id: "settings", title: "settings", subtitle: "⌘,", group: "app", icon: <SettingsIcon size={14} />, keywords: "preferences theme appearance", actionLabel: "open", run: () => setSettingsOpen(true) },
    ],
    [spawn, fireAppshot, chats, oracles, customers, resumeChat, addOracle, runF5, projects, home, runProject],
  );

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
                  onOpenUrl={(url) => spawn({ type: "browser", url }, "browser")}
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
}: {
  panes: Pane[];
  hiddenKeys: string[];
  maximizedKey: string | null;
  activeKey: string | null;
  onSelect: (key: string) => void;
  onToggleHide: (key: string) => void;
  onClose: (key: string) => void;
}) {
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
              className={`flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                hidden ? "text-[var(--color-faint)]" : "text-[var(--color-text-2)] group-hover:text-[var(--color-text)]"
              }`}
              title={hidden ? "restore pane" : "focus pane"}
            >
              <span className={`status-dot shrink-0 ${hidden ? "status-dot--cold" : DOT[p.kind.type] ?? "status-dot--cold"}`} />
              <span className="truncate">{p.label}</span>
              {maximized && <Maximize2 size={10} className="shrink-0 text-[var(--color-accent)]" />}
            </button>
            <div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-hover:opacity-100">
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
