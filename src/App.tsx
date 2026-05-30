import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  Database,
  Camera,
  Clock,
  Folder,
  Globe,
  MessageCircle,
  MessageSquare,
  PanelLeft,
  Play,
  Radio,
  Search,
  Settings as SettingsIcon,
  TerminalSquare,
  Wand2,
  X,
} from "lucide-react";

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
import { chatHandles, paneWriters } from "./lib/paneBus";
import { homeDir } from "./lib/fs";
import { detectProject } from "./lib/run";

/** A pane's content — terminal-backed (shell/oracle/tmux) or a view. */
type PaneContent =
  | PaneKind
  | { type: "files" }
  | { type: "browser" }
  | { type: "memory" }
  | { type: "automations" }
  | { type: "bridges" }
  | { type: "plugins" }
  | { type: "pulse" }
  | { type: "chat"; seed?: string; resume?: { id: string; title: string }; reattach?: number }
  | { type: "customers" }
  | { type: "motion" }
  | { type: "file"; path: string; name: string }
  | { type: "editor"; path: string; name: string };
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

export type AppDef = { kind: PaneContent; icon: typeof Folder; label: string };
const SPAWN: AppDef[] = [
  { kind: { type: "chat" }, icon: MessageSquare, label: "chat" },
  { kind: { type: "shell" }, icon: TerminalSquare, label: "terminal" },
  { kind: { type: "files" }, icon: Folder, label: "files" },
  { kind: { type: "browser" }, icon: Globe, label: "browser" },
  { kind: { type: "memory" }, icon: Database, label: "database" },
  { kind: { type: "automations" }, icon: Clock, label: "automations" },
  { kind: { type: "customers" }, icon: MessageCircle, label: "contacts" },
  { kind: { type: "motion" }, icon: Wand2, label: "studio" },
];

function App() {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [splash, setSplash] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // pane key pending a close-confirm (busy chat: keep-running vs kill).
  const [closePrompt, setClosePrompt] = useState<string | null>(null);
  // backgrounded chat sessions still running after their pane closed.
  const [liveChats, setLiveChats] = useState<LiveChat[]>([]);
  // Native browser webviews paint ABOVE html, so any floating overlay (modals,
  // palette) must hide them or it gets occluded.
  const overlayOpen = settingsOpen || paletteOpen;

  useEffect(() => {
    const t = setTimeout(() => setSplash(false), 850);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => initTheme(), []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const spawn = useCallback((kind: PaneContent, label: string) => {
    setPanes((p) => [...p, { key: nextKey(), kind, label }]);
  }, []);

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
      } else if (mod && e.key.toLowerCase() === "t") {
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

  // Native OS drag-drop (Finder files/folders) → insert paths into the terminal
  // pane under the cursor. Tauri gives real filesystem paths the webview can't.
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const { paths, position } = event.payload;
      if (!paths?.length) return;
      const dpr = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(position.x / dpr, position.y / dpr);
      const key = el?.closest<HTMLElement>("[data-pane-key]")?.getAttribute("data-pane-key");
      const w = key ? paneWriters.get(key) : null;
      if (!w) {
        flash("drop onto a terminal pane to insert the path");
        return;
      }
      const text = paths
        .map((p) => (/[\s'"\\]/.test(p) ? `'${p.replace(/'/g, "'\\''")}' ` : `${p} `))
        .join("");
      w(text);
      flash(`dropped ${paths.length} item${paths.length > 1 ? "s" : ""}`);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [flash]);

  const { cols, rows } = useMemo(() => {
    const n = panes.length || 1;
    const c = Math.ceil(Math.sqrt(n));
    return { cols: c, rows: Math.ceil(n / c) };
  }, [panes.length]);

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
      { id: "sidebar", title: "toggle sidebar", subtitle: "⌘B", group: "view", icon: <PanelLeft size={14} />, keywords: "rail hide show", actionLabel: "toggle", run: () => setSidebarOpen((v) => !v) },
      { id: "run", title: "run project", subtitle: "F5", group: "actions", icon: <Play size={14} />, keywords: "f5 run debug start flutter npm dev build terminal", actionLabel: "run", run: () => runF5() },
      { id: "appshot", title: "appshot — screenshot to oracle", subtitle: "⌘⌘", group: "actions", icon: <Camera size={14} />, keywords: "screenshot capture", actionLabel: "run", run: fireAppshot },
      { id: "settings", title: "settings", subtitle: "⌘,", group: "app", icon: <SettingsIcon size={14} />, keywords: "preferences theme appearance", actionLabel: "open", run: () => setSettingsOpen(true) },
    ],
    [spawn, fireAppshot, chats, oracles, customers, resumeChat, addOracle, runF5],
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
              {/* sessions */}
              <div className="flex flex-col gap-0.5">
                {SPAWN.filter((s) => s.label === "chat" || s.label === "terminal").map((s) => (
                  <NavRow key={s.label} icon={s.icon} label={s.label === "chat" ? "new chat" : s.label} onClick={() => spawn(s.kind, s.label)} />
                ))}
              </div>
              {/* tools */}
              <div className="flex flex-col gap-0.5 border-t border-[var(--color-border)] pt-2">
                {SPAWN.filter((s) => s.label !== "chat" && s.label !== "terminal").map((s) => (
                  <NavRow key={s.label} icon={s.icon} label={s.label} onClick={() => spawn(s.kind, s.label)} />
                ))}
              </div>
              <OracleRoster onAttachOracle={addOracle} onAttachTmux={addTmux} />
            </div>
            <div className="flex flex-col gap-0.5 border-t border-[var(--color-border)] p-2">
              <NavRow icon={SettingsIcon} label="settings" onClick={() => setSettingsOpen(true)} />
              <AccountMenu onOpenSettings={() => setSettingsOpen(true)} />
            </div>
          </aside>
        )}

        <main className="min-h-0 flex-1">
          {panes.length === 0 ? (
            <IdleDashboard
              apps={SPAWN}
              oracles={oracles}
              chats={chats}
              customers={customers}
              onSpawn={spawn}
              onAttachOracle={addOracle}
              onResumeChat={resumeChat}
              onOpenPalette={() => setPaletteOpen(true)}
            />
          ) : (
            <ResizableGrid cols={cols} rows={rows} gap={8}>
              {panes.map((pane) => (
                <PaneCard
                  key={pane.key}
                  pane={pane}
                  active={!overlayOpen}
                  onClose={() => requestClose(pane.key)}
                  onFocus={() => (focusedPane.current = pane.key)}
                  onAnnotate={routeToChat}
                  onOpenFile={openFile}
                />
              ))}
            </ResizableGrid>
          )}
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

const DOT: Record<string, string> = {
  oracle: "status-dot--active",
  tmux: "status-dot--dormant",
  shell: "status-dot--idle",
  files: "status-dot--cold",
  browser: "status-dot--cold",
  memory: "status-dot--cold",
  automations: "status-dot--cold",
  bridges: "status-dot--cold",
  plugins: "status-dot--cold",
  pulse: "status-dot--active",
  chat: "status-dot--active",
  customers: "status-dot--active",
  motion: "status-dot--cold",
  file: "status-dot--cold",
};

function PaneCard({
  pane,
  active,
  onClose,
  onFocus,
  onAnnotate,
  onOpenFile,
}: {
  pane: Pane;
  active: boolean;
  onClose: () => void;
  onFocus: () => void;
  onAnnotate: (text: string) => void;
  onOpenFile: (path: string, name: string) => void;
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
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-pane)] transition-colors hover:border-[var(--color-border-strong)]"
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
          <BrowserPane label={pane.key} active={active} onAnnotate={onAnnotate} />
        ) : pane.kind.type === "memory" ? (
          <DatabasePane />
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
          />
        )}
      </div>
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
