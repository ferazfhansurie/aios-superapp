import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  Blocks,
  Bot,
  Brain,
  Camera,
  Clock,
  Code,
  Folder,
  Globe,
  HelpCircle,
  MessageSquare,
  PanelLeft,
  Power,
  Radio,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { AccountMenu } from "./components/AccountMenu";
import { AutomationsPane } from "./components/AutomationsPane";
import { BridgesPane } from "./components/BridgesPane";
import { BrowserPane } from "./components/BrowserPane";
import { ChatPane } from "./components/ChatPane";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { FilesPane } from "./components/FilesPane";
import { MemoryPane } from "./components/MemoryPane";
import { OracleRoster } from "./components/OracleRoster";
import { PluginsPane } from "./components/PluginsPane";
import { Settings } from "./components/Settings";
import { TerminalPane, type PaneKind } from "./components/TerminalPane";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { VoiceButton } from "./components/VoiceButton";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { appshot } from "./lib/pty";
import { initTheme } from "./lib/theme";
import { monitorStart, monitorStop } from "./lib/monitor";
import { paneWriters } from "./lib/paneBus";

/** A pane's content — terminal-backed (shell/oracle/tmux) or a view. */
type PaneContent =
  | PaneKind
  | { type: "files" }
  | { type: "browser" }
  | { type: "memory" }
  | { type: "automations" }
  | { type: "bridges" }
  | { type: "plugins" }
  | { type: "chat" };
interface Pane {
  key: string;
  label: string;
  kind: PaneContent;
}

const isTerminal = (k: PaneContent): k is PaneKind =>
  k.type === "shell" || k.type === "oracle" || k.type === "tmux";

let seq = 0;
const nextKey = () => `k${++seq}-${Math.random().toString(36).slice(2, 6)}`;

const SPAWN: { kind: PaneContent; icon: typeof Folder; label: string }[] = [
  { kind: { type: "chat" }, icon: MessageSquare, label: "chat" },
  { kind: { type: "shell" }, icon: TerminalSquare, label: "terminal" },
  { kind: { type: "files" }, icon: Folder, label: "files" },
  { kind: { type: "browser" }, icon: Globe, label: "browser" },
  { kind: { type: "memory" }, icon: Brain, label: "memory" },
  { kind: { type: "automations" }, icon: Clock, label: "automations" },
  { kind: { type: "bridges" }, icon: Radio, label: "bridges" },
  { kind: { type: "plugins" }, icon: Blocks, label: "plugins" },
];

function App() {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [splash, setSplash] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Native browser webviews paint ABOVE html, so any floating overlay (modals,
  // the account popup) must hide them or it gets occluded.
  const overlayOpen = settingsOpen || paletteOpen || accountOpen;

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
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
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
  }, [addShell, fireAppshot]);

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
        group: "spawn",
        icon: <s.icon size={14} />,
        keywords: "open pane spawn",
        run: () => spawn(s.kind, s.label),
      })),
      { id: "sidebar", title: "toggle sidebar", subtitle: "⌘B", group: "view", icon: <PanelLeft size={14} />, run: () => setSidebarOpen((v) => !v) },
      { id: "appshot", title: "appshot — screenshot to oracle", subtitle: "⌘⌘", group: "actions", icon: <Camera size={14} />, keywords: "screenshot capture", run: fireAppshot },
      { id: "settings", title: "settings", subtitle: "⌘,", group: "app", icon: <SettingsIcon size={14} />, run: () => setSettingsOpen(true) },
    ],
    [spawn, fireAppshot],
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
            cockpit
          </span>
          <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--color-muted)]">
            aios
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
              {/* Codex-style nav list */}
              <div className="flex flex-col gap-0.5">
                {SPAWN.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => spawn(s.kind, s.label)}
                    className="group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--color-text-2)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                  >
                    <s.icon size={15} className="shrink-0 text-[var(--color-muted)] group-hover:text-[var(--color-text)]" />
                    {s.label === "chat" ? "new chat" : s.label}
                  </button>
                ))}
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--color-text-2)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                >
                  <SettingsIcon size={15} className="shrink-0 text-[var(--color-muted)] group-hover:text-[var(--color-text)]" />
                  settings
                </button>
              </div>
              <OracleRoster
                onAttachOracle={addOracle}
                onAttachTmux={addTmux}
                onAttachRoot={() => spawn({ type: "shell", cmd: "aios" }, "master")}
              />
            </div>
            <div className="border-t border-[var(--color-border)] p-2">
              <AccountMenu
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenChange={setAccountOpen}
              />
            </div>
          </aside>
        )}

        <main className="min-h-0 flex-1">
          {panes.length === 0 ? (
            <EmptyState
              onSpawn={spawn}
              onHelp={() => setPaletteOpen(true)}
              onQuit={() => void getCurrentWindow().close()}
            />
          ) : (
            <div
              className="grid h-full w-full gap-2 p-2"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
              }}
            >
              {panes.map((pane) => (
                <PaneCard
                  key={pane.key}
                  pane={pane}
                  active={!overlayOpen}
                  onClose={() => closePane(pane.key)}
                  onFocus={() => (focusedPane.current = pane.key)}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {toast && (
        <div className="modal-in glass absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/90 px-3 py-2 text-[12px] text-[var(--color-text)] shadow-2xl">
          {toast}
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
  chat: "status-dot--active",
};

function PaneCard({
  pane,
  active,
  onClose,
  onFocus,
}: {
  pane: Pane;
  active: boolean;
  onClose: () => void;
  onFocus: () => void;
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
          <FilesPane />
        ) : pane.kind.type === "browser" ? (
          <BrowserPane label={pane.key} active={active} />
        ) : pane.kind.type === "memory" ? (
          <MemoryPane />
        ) : pane.kind.type === "automations" ? (
          <AutomationsPane />
        ) : pane.kind.type === "bridges" ? (
          <BridgesPane />
        ) : pane.kind.type === "plugins" ? (
          <PluginsPane />
        ) : (
          <ChatPane />
        )}
      </div>
    </div>
  );
}

/** Start engines — picked on the idle page. "aios" = our Codex-style chat pane
 *  (claude under the hood); the rest open a session running that CLI. */
const ENGINES: {
  id: string;
  label: string;
  sub: string;
  icon: typeof Bot;
  primary?: boolean;
  spawn: (s: (k: PaneContent, l: string) => void) => void;
}[] = [
  { id: "aios", label: "aios chat", sub: "codex-style · claude", icon: MessageSquare, primary: true, spawn: (s) => s({ type: "chat" }, "chat") },
  { id: "claude", label: "claude", sub: "claude code", icon: Sparkles, spawn: (s) => s({ type: "shell", cmd: "claude" }, "claude") },
  { id: "codex", label: "codex", sub: "openai codex", icon: Bot, spawn: (s) => s({ type: "shell", cmd: "codex" }, "codex") },
  { id: "opencode", label: "opencode", sub: "open-source", icon: Code, spawn: (s) => s({ type: "shell", cmd: "opencode" }, "opencode") },
];

function EmptyState({
  onSpawn,
  onHelp,
  onQuit,
}: {
  onSpawn: (kind: PaneContent, label: string) => void;
  onHelp: () => void;
  onQuit: () => void;
}) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(55% 45% at 50% 38%, color-mix(in srgb, var(--color-accent) 13%, transparent), transparent 70%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage: "radial-gradient(var(--color-text) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
        }}
      />

      <div className="relative flex flex-col items-center gap-9">
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-6xl font-bold tracking-tighter text-[var(--color-accent)] [text-shadow:0_0_32px_color-mix(in_srgb,var(--color-accent)_50%,transparent)]">
              cockpit
            </span>
            <span className="text-[11px] font-medium uppercase tracking-[0.4em] text-[var(--color-muted)]">
              aios
            </span>
          </div>
          <p className="text-[12px] tracking-wide text-[var(--color-faint)]">
            your command deck · pick an engine
          </p>
        </div>

        {/* engine picker */}
        <div className="flex flex-wrap items-stretch justify-center gap-3">
          {ENGINES.map((e) => (
            <button
              key={e.id}
              onClick={() => e.spawn(onSpawn)}
              className={`group flex w-36 flex-col items-center gap-2 rounded-2xl border px-4 py-5 transition-all hover:-translate-y-0.5 ${
                e.primary
                  ? "border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10 hover:bg-[var(--color-accent)]/20 hover:shadow-[0_0_32px_color-mix(in_srgb,var(--color-accent)_30%,transparent)]"
                  : "border-[var(--color-border)] bg-[var(--color-panel)]/40 hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-panel-2)]"
              }`}
            >
              <e.icon
                size={24}
                className={
                  e.primary
                    ? "text-[var(--color-accent)]"
                    : "text-[var(--color-muted)] transition-colors group-hover:text-[var(--color-accent)]"
                }
              />
              <span className="text-[13px] font-medium text-[var(--color-text)]">{e.label}</span>
              <span className="text-[10px] text-[var(--color-muted)]">{e.sub}</span>
            </button>
          ))}
        </div>

        {/* resume · help · quit */}
        <div className="flex items-center gap-2 text-[12px]">
          <IdleAction icon={<RotateCcw size={13} />} label="resume" onClick={() => onSpawn({ type: "shell", cmd: "claude --continue" }, "resume")} />
          <span className="text-[var(--color-faint)]">·</span>
          <IdleAction icon={<HelpCircle size={13} />} label="help" onClick={onHelp} />
          <span className="text-[var(--color-faint)]">·</span>
          <IdleAction icon={<Power size={13} />} label="quit" onClick={onQuit} />
        </div>

        <p className="font-mono text-[10px] tracking-wide text-[var(--color-faint)]">
          ⌘T terminal · ⌘K palette · ⌘B sidebar · ⌘⌘ appshot
        </p>
      </div>
    </div>
  );
}

function IdleAction({
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
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
    >
      {icon}
      {label}
    </button>
  );
}

function Splash() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[var(--color-bg)]">
      <span className="brand-logo--splash font-mono text-5xl font-bold tracking-tighter text-[var(--color-accent)] [text-shadow:0_0_32px_color-mix(in_srgb,var(--color-accent)_50%,transparent)]">
        cockpit
      </span>
    </div>
  );
}

export default App;
