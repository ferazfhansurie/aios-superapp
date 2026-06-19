/**
 * LoopPane — firaz's dedicated control panel for every running AIOS loop (a
 * first-class pane, registered in CORE_PANE_TYPES + the SPAWN catalog like
 * `mission` / `ticket`). Supersedes the in-MissionBoard loops section: this is
 * the full surface.
 *
 * Rows come from loop_list (~/.aios/state/loops/*.meta + launchd state + last
 * log line) and reuse the SAME LoopRow control the board used — status pill,
 * start/stop toggle, inline cadence edit — so behavior stays in lockstep. The
 * pane adds room to breathe: a header with counts + refresh, and the full list
 * (not the compact board subset).
 *
 * NOTE (follow-up, ticket firaz-20260619-200309): a "+ new loop" creator (loop_create
 * Rust cmd + structured/NL form) lands on top of this pane next.
 */
import { useEffect, useState } from "react";
import { Repeat, RefreshCw } from "lucide-react";

import { listLoops, type LoopInfo } from "../lib/agents";
import { LoopRow } from "./MissionBoard";

export function LoopPane() {
  const [loops, setLoops] = useState<LoopInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setLoops(await listLoops());
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const running = loops.filter((l) => (l.status ?? "running") === "running").length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)] p-3">
      <div className="mb-2.5 flex items-center gap-2">
        <Repeat size={14} className="shrink-0 text-[var(--color-accent)]" />
        <span className="text-[12px] font-medium text-[var(--color-text)]">loops</span>
        <span className="text-[10px] text-[var(--color-faint)]">
          {running} running · {loops.length} total
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
          title="reload loop state"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {loops.length === 0 ? (
          <div className="px-1 text-[11px] text-[var(--color-faint)]">
            no loops yet — create one with `aios-loop create &lt;name&gt; &lt;cadence&gt; &lt;command&gt;`.
          </div>
        ) : (
          loops.map((loop) => (
            <LoopRow key={loop.name} loop={loop} onChanged={() => void refresh()} />
          ))
        )}
      </div>
    </div>
  );
}
