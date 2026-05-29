import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  Folder,
  Globe,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";

import { AccountMenu } from "./components/AccountMenu";
import { BrowserPane } from "./components/BrowserPane";
import { FilesPane } from "./components/FilesPane";
import { OracleRoster } from "./components/OracleRoster";
import { TerminalPane, type PaneKind } from "./components/TerminalPane";

interface Pane {
  key: string;
  kind: PaneKind;
  label: string;
}
type DockKind = "files" | "browser" | "terminal";
interface DockTab {
  key: string;
  kind: DockKind;
}
type DockPos = "bottom" | "right";

let seq = 0;
const nextKey = () => `k${++seq}-${Math.random().toString(36).slice(2, 6)}`;

function App() {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dockOpen, setDockOpen] = useState(false);
  const [dockPos, setDockPos] = useState<DockPos>("bottom");
  const [dockTabs, setDockTabs] = useState<DockTab[]>([]);
  const [activeDock, setActiveDock] = useState<string | null>(null);
  const [splash, setSplash] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setSplash(false), 850);
    return () => clearTimeout(t);
  }, []);

  const addShell = useCallback(() => {
    setPanes((p) => [...p, { key: nextKey(), kind: { type: "shell" }, label: "terminal" }]);
  }, []);
  const addOracle = useCallback((identity: string) => {
    setPanes((p) => [...p, { key: nextKey(), kind: { type: "oracle", identity }, label: identity }]);
  }, []);
  const closePane = useCallback((key: string) => {
    setPanes((p) => p.filter((x) => x.key !== key));
  }, []);

  const openDock = useCallback((kind: DockKind) => {
    const tab = { key: nextKey(), kind };
    setDockTabs((t) => [...t, tab]);
    setActiveDock(tab.key);
    setDockOpen(true);
  }, []);
  const closeDockTab = useCallback((key: string) => {
    setDockTabs((t) => {
      const next = t.filter((x) => x.key !== key);
      setActiveDock((a) => (a === key ? (next[next.length - 1]?.key ?? null) : a));
      if (next.length === 0) setDockOpen(false);
      return next;
    });
  }, []);

  const { cols, rows } = useMemo(() => {
    const n = panes.length || 1;
    const c = Math.ceil(Math.sqrt(n));
    return { cols: c, rows: Math.ceil(n / c) };
  }, [panes.length]);

  const sidebar = (
    <div className="flex h-full min-h-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <OracleRoster onAttach={addOracle} />
      </div>
      <div className="border-t border-[var(--color-border)] p-2">
        <AccountMenu />
      </div>
    </div>
  );

  const mainGrid =
    panes.length === 0 ? (
      <EmptyState onAddShell={addShell} />
    ) : (
      <div
        className="grid h-full w-full gap-2 p-2"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
        {panes.map((pane) => (
          <PaneCard key={pane.key} pane={pane} onClose={() => closePane(pane.key)} />
        ))}
      </div>
    );

  const dock = (
    <Dock
      tabs={dockTabs}
      active={activeDock}
      onSelect={setActiveDock}
      onOpen={openDock}
      onCloseTab={closeDockTab}
      onCloseDock={() => setDockOpen(false)}
      pos={dockPos}
      onTogglePos={() => setDockPos((p) => (p === "bottom" ? "right" : "bottom"))}
    />
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
        </div>

        <div className="flex items-center gap-2">
          <img src="/mascot.png" alt="aios" className="brand-logo h-[22px] w-[22px] object-contain" />
          <span className="font-mono text-sm font-semibold tracking-tight">aios</span>
          <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--color-accent)]">
            cockpit
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={addShell}
            className="mr-1 flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1 text-[11px] transition-colors hover:border-[var(--color-accent)]/50"
          >
            <Plus size={12} /> terminal
          </button>
          <IconBtn
            title="Bottom dock"
            active={dockOpen && dockPos === "bottom"}
            onClick={() => {
              setDockPos("bottom");
              setDockOpen((v) => (dockPos === "bottom" ? !v : true));
            }}
          >
            <PanelBottom size={15} />
          </IconBtn>
          <IconBtn
            title="Right dock"
            active={dockOpen && dockPos === "right"}
            onClick={() => {
              setDockPos("right");
              setDockOpen((v) => (dockPos === "right" ? !v : true));
            }}
          >
            <PanelRight size={15} />
          </IconBtn>
        </div>
      </header>

      {/* body */}
      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="aios-cockpit-h">
          {sidebarOpen && (
            <>
              <Panel id="sidebar" order={1} defaultSize={18} minSize={12} maxSize={32}>
                {sidebar}
              </Panel>
              <PanelResizeHandle className="w-1" />
            </>
          )}

          <Panel id="main" order={2} minSize={30}>
            <PanelGroup direction="vertical" autoSaveId="aios-cockpit-v">
              <Panel id="grid" order={1} minSize={20}>
                <div className="h-full min-h-0">{mainGrid}</div>
              </Panel>
              {dockOpen && dockPos === "bottom" && (
                <>
                  <PanelResizeHandle className="h-1" />
                  <Panel id="dock-bottom" order={2} defaultSize={36} minSize={15}>
                    {dock}
                  </Panel>
                </>
              )}
            </PanelGroup>
          </Panel>

          {dockOpen && dockPos === "right" && (
            <>
              <PanelResizeHandle className="w-1" />
              <Panel id="dock-right" order={3} defaultSize={34} minSize={18}>
                {dock}
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
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

function PaneCard({ pane, onClose }: { pane: Pane; onClose: () => void }) {
  const isOracle = pane.kind.type === "oracle";
  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-pane)] transition-colors hover:border-[var(--color-border-strong)]">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-white/[0.02] px-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`status-dot ${isOracle ? "status-dot--active" : "status-dot--idle"}`} />
          <span className="truncate font-mono text-[11px] text-[var(--color-muted)]">
            {isOracle ? `oracle: ${pane.label}` : pane.label}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="Close pane"
        >
          <X size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalPane kind={pane.kind} />
      </div>
    </div>
  );
}

const DOCK_LAUNCH: { kind: DockKind; icon: typeof Folder; title: string; sub: string }[] = [
  { kind: "files", icon: Folder, title: "Files", sub: "Browse the filesystem" },
  { kind: "browser", icon: Globe, title: "Browser", sub: "Open a website" },
  { kind: "terminal", icon: TerminalSquare, title: "Terminal", sub: "Start an interactive shell" },
];

function Dock({
  tabs,
  active,
  onSelect,
  onOpen,
  onCloseTab,
  onCloseDock,
  pos,
  onTogglePos,
}: {
  tabs: DockTab[];
  active: string | null;
  onSelect: (key: string) => void;
  onOpen: (kind: DockKind) => void;
  onCloseTab: (key: string) => void;
  onCloseDock: () => void;
  pos: DockPos;
  onTogglePos: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-panel)]">
      {/* tab strip */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-1.5">
        {tabs.map((t) => (
          <div
            key={t.key}
            onClick={() => onSelect(t.key)}
            className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${
              active === t.key
                ? "bg-[var(--color-panel-2)] text-[var(--color-text)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            <span className="capitalize">{t.kind}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(t.key);
              }}
              className="opacity-0 transition-opacity group-hover:opacity-100"
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button
          onClick={() => onOpen("terminal")}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="New terminal in dock"
        >
          <Plus size={13} />
        </button>
        <div className="flex-1" />
        <IconBtn title="Move dock" onClick={onTogglePos}>
          {pos === "bottom" ? <PanelRight size={13} /> : <PanelBottom size={13} />}
        </IconBtn>
        <button
          onClick={onCloseDock}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="Close dock"
        >
          <X size={13} />
        </button>
      </div>

      {/* content */}
      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div className="grid h-full place-items-center p-4">
            <div className="grid w-full max-w-2xl grid-cols-3 gap-2">
              {DOCK_LAUNCH.map((l) => (
                <button
                  key={l.kind}
                  onClick={() => onOpen(l.kind)}
                  className="flex flex-col items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-4 py-6 transition-colors hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-panel-2)]"
                >
                  <l.icon size={22} className="text-[var(--color-muted)]" />
                  <span className="text-[13px] font-medium text-[var(--color-text)]">{l.title}</span>
                  <span className="text-[10px] text-[var(--color-muted)]">{l.sub}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          tabs.map((t) => (
            <div
              key={t.key}
              className="absolute inset-0"
              style={{ display: active === t.key ? "block" : "none" }}
            >
              {t.kind === "files" && <FilesPane />}
              {t.kind === "browser" && <BrowserPane />}
              {t.kind === "terminal" && <TerminalPane kind={{ type: "shell" }} />}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function EmptyState({ onAddShell }: { onAddShell: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
      <img src="/mascot/surprised.webp" alt="" className="mascot-idle h-20 w-20 object-contain" />
      <div className="flex flex-col gap-1">
        <p className="text-sm text-[var(--color-text)]">no panes open</p>
        <p className="text-xs text-[var(--color-muted)]">click an oracle on the left, or open a terminal</p>
      </div>
      <button
        type="button"
        onClick={onAddShell}
        className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-bg)] transition-colors hover:bg-[var(--color-accent-hover)]"
      >
        <Plus size={13} /> new terminal
      </button>
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
