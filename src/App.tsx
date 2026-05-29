import { useCallback, useMemo, useState } from "react";

import { Plus, TerminalSquare, X } from "lucide-react";

import { OracleRoster } from "./components/OracleRoster";
import { TerminalPane, type PaneKind } from "./components/TerminalPane";

interface Pane {
  key: string;
  kind: PaneKind;
  label: string;
}

let paneSeq = 0;
const nextKey = () => `pane-${++paneSeq}-${Math.random().toString(36).slice(2, 7)}`;

function App() {
  const [panes, setPanes] = useState<Pane[]>([]);

  const addShell = useCallback(() => {
    setPanes((p) => [...p, { key: nextKey(), kind: { type: "shell" }, label: "terminal" }]);
  }, []);

  const addOracle = useCallback((identity: string) => {
    setPanes((p) => [
      ...p,
      { key: nextKey(), kind: { type: "oracle", identity }, label: identity },
    ]);
  }, []);

  const closePane = useCallback((key: string) => {
    setPanes((p) => p.filter((x) => x.key !== key));
  }, []);

  // Balanced grid: columns ≈ √n, rows fill the rest.
  const { cols, rows } = useMemo(() => {
    const n = panes.length || 1;
    const c = Math.ceil(Math.sqrt(n));
    const r = Math.ceil(n / c);
    return { cols: c, rows: r };
  }, [panes.length]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Header (drag region; leaves room for macOS traffic lights) */}
      <header
        className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-panel)] pl-20 pr-3"
        data-tauri-drag-region
      >
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight">aios</span>
          <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--color-accent)]">
            cockpit
          </span>
        </div>
        <button
          type="button"
          onClick={addShell}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1 text-[11px] text-[var(--color-text)] transition-colors hover:border-[var(--color-accent)]/50"
        >
          <Plus size={12} /> terminal
        </button>
      </header>

      {/* Body: rail + pane grid */}
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-panel)] p-3">
          <OracleRoster onAttach={addOracle} />
        </aside>

        <main className="min-h-0 flex-1 overflow-hidden p-2">
          {panes.length === 0 ? (
            <EmptyState onAddShell={addShell} />
          ) : (
            <div
              className="grid h-full w-full gap-2"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
              }}
            >
              {panes.map((pane) => (
                <PaneCard key={pane.key} pane={pane} onClose={() => closePane(pane.key)} />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function PaneCard({ pane, onClose }: { pane: Pane; onClose: () => void }) {
  const isOracle = pane.kind.type === "oracle";
  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[#0a0a0c]">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-panel)] px-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              isOracle ? "bg-[var(--color-accent)]" : "bg-[var(--color-muted)]/50"
            }`}
          />
          <span className="truncate text-[11px] text-[var(--color-muted)]">
            {isOracle ? `oracle: ${pane.label}` : pane.label}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          aria-label="Close pane"
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

function EmptyState({ onAddShell }: { onAddShell: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <TerminalSquare size={40} strokeWidth={1.2} className="text-[var(--color-accent)]" />
      <div className="flex flex-col gap-1">
        <p className="text-sm text-[var(--color-text)]">no panes open</p>
        <p className="text-xs text-[var(--color-muted)]">
          click an oracle on the left, or open a terminal
        </p>
      </div>
      <button
        type="button"
        onClick={onAddShell}
        className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs transition-colors hover:border-[var(--color-accent)]/50"
      >
        <Plus size={13} /> new terminal
      </button>
    </div>
  );
}

export default App;
