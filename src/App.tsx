import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  Brain,
  Camera,
  Clock,
  Folder,
  Globe,
  PanelLeft,
  Play,
  Plus,
  Radio,
  Search,
  Settings as SettingsIcon,
  TerminalSquare,
  X,
} from "lucide-react";

import { AccountMenu } from "./components/AccountMenu";
import { AutomationsPane } from "./components/AutomationsPane";
import { BridgesPane } from "./components/BridgesPane";
import { BrowserPane } from "./components/BrowserPane";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { FilesPane } from "./components/FilesPane";
import { MemoryPane } from "./components/MemoryPane";
import { OracleRoster } from "./components/OracleRoster";
import { Settings } from "./components/Settings";
import { TerminalPane, type PaneKind } from "./components/TerminalPane";
import { appshot } from "./lib/pty";
import { monitorStart, monitorStop } from "./lib/monitor";

/** A pane's content — terminal-backed (shell/oracle/tmux) or a view. */
type PaneContent =
  | PaneKind
  | { type: "files" }
  | { type: "browser" }
  | { type: "memory" }
  | { type: "automations" }
  | { type: "bridges" };
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
  { kind: { type: "shell" }, icon: TerminalSquare, label: "terminal" },
  { kind: { type: "files" }, icon: Folder, label: "files" },
  { kind: { type: "browser" }, icon: Globe, label: "browser" },
  { kind: { type: "memory" }, icon: Brain, label: "memory" },
  { kind: { type: "automations" }, icon: Clock, label: "automations" },
  { kind: { type: "bridges" }, icon: Radio, label: "bridges" },
];

function App() {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [splash, setSplash] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Native browser webviews paint ABOVE html, so any floating overlay (modals,
  // the +new dropdown, the account popup) must hide them or it gets occluded.
  const overlayOpen = settingsOpen || paletteOpen || spawnOpen || accountOpen;

  useEffect(() => {
    const t = setTimeout(() => setSplash(false), 850);
    return () => clearTimeout(t);
  }, []);

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
          <img src="/mascot.png" alt="aios" className="brand-logo h-[22px] w-[22px] object-contain" />
          <span className="font-mono text-sm font-semibold tracking-tight">cockpit</span>
          <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--color-accent)]">
            aios
          </span>
        </div>

        <div className="relative flex items-center gap-1">
          <button
            onClick={() => setSpawnOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1 text-[11px] transition-colors hover:border-[var(--color-accent)]/50"
          >
            <Plus size={12} /> new
          </button>
          {spawnOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setSpawnOpen(false)} />
              <div className="modal-in absolute right-9 top-9 z-50 w-44 overflow-hidden rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] p-1 shadow-2xl">
                {SPAWN.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => {
                      spawn(s.kind, s.label);
                      setSpawnOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--color-text-2)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                  >
                    <s.icon size={13} className="text-[var(--color-muted)]" /> {s.label}
                  </button>
                ))}
              </div>
            </>
          )}
          <IconBtn title="Appshot — screenshot to oracle (⌘⌘)" onClick={fireAppshot}>
            <Camera size={15} />
          </IconBtn>
        </div>
      </header>

      {/* body: sidebar + pane grid */}
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <OracleRoster
                onAttachOracle={addOracle}
                onAttachTmux={addTmux}
                onAttachRoot={() => spawn({ type: "shell", cmd: "aios" }, "root")}
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
            <EmptyState onSpawn={spawn} onStart={() => spawn({ type: "shell", cmd: "aios" }, "root")} />
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
};

function PaneCard({ pane, active, onClose }: { pane: Pane; active: boolean; onClose: () => void }) {
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
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-pane)] transition-colors hover:border-[var(--color-border-strong)]">
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
          <TerminalPane kind={pane.kind} />
        ) : pane.kind.type === "files" ? (
          <FilesPane />
        ) : pane.kind.type === "browser" ? (
          <BrowserPane label={pane.key} active={active} />
        ) : pane.kind.type === "memory" ? (
          <MemoryPane />
        ) : pane.kind.type === "automations" ? (
          <AutomationsPane />
        ) : (
          <BridgesPane />
        )}
      </div>
    </div>
  );
}

function EmptyState({
  onSpawn,
  onStart,
}: {
  onSpawn: (kind: PaneContent, label: string) => void;
  onStart: () => void;
}) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden">
      {/* layered radial glow — game-menu backdrop */}
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
          backgroundImage:
            "radial-gradient(var(--color-text) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
        }}
      />

      <div className="relative flex flex-col items-center gap-10">
        {/* wordmark */}
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
            your command deck
          </p>
        </div>

        {/* START — boots the master AIOS session */}
        <button
          onClick={onStart}
          className="group relative flex items-center gap-3 rounded-2xl border border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10 px-10 py-4 transition-all hover:-translate-y-0.5 hover:bg-[var(--color-accent)] hover:shadow-[0_0_40px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
        >
          <Play size={18} className="text-[var(--color-accent)] transition-colors group-hover:text-[var(--color-bg)]" fill="currentColor" />
          <span className="text-lg font-bold uppercase tracking-[0.2em] text-[var(--color-accent)] transition-colors group-hover:text-[var(--color-bg)]">
            start
          </span>
        </button>
        <p className="-mt-6 text-[10px] text-[var(--color-faint)]">boots your master aios session</p>

        {/* spawn tiles */}
        <div className="flex flex-wrap items-stretch justify-center gap-2.5">
          {SPAWN.filter((s) => s.label !== "terminal").map((s) => (
            <button
              key={s.label}
              onClick={() => onSpawn(s.kind, s.label)}
              className="group flex w-24 flex-col items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]/40 px-3 py-3.5 transition-all hover:-translate-y-0.5 hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-panel-2)]"
            >
              <s.icon
                size={20}
                className="text-[var(--color-muted)] transition-colors group-hover:text-[var(--color-accent)]"
              />
              <span className="text-[11px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
                {s.label}
              </span>
            </button>
          ))}
        </div>

        <p className="font-mono text-[10px] tracking-wide text-[var(--color-faint)]">
          ⌘T terminal · ⌘K palette · ⌘B sidebar · ⌘⌘ appshot
        </p>
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[var(--color-bg)]">
      <img src="/mascot.png" alt="aios" className="brand-logo brand-logo--splash h-24 w-24 object-contain" />
    </div>
  );
}

export default App;
