/**
 * The oracle roster — the clickable fleet of bridge-managed oracle sessions.
 * Self-polls `list_oracles` so newly-spawned oracles appear automatically.
 */
import { useCallback, useEffect, useState } from "react";

import { RefreshCw } from "lucide-react";

import { listOracles, type OracleInfo } from "../lib/pty";

export function OracleRoster({ onAttach }: { onAttach: (identity: string) => void }) {
  const [oracles, setOracles] = useState<OracleInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOracles(await listOracles());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
          oracles
        </span>
        <button
          type="button"
          onClick={refresh}
          className="rounded p-1 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          aria-label="Refresh oracles"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && <p className="text-[11px] text-red-400">{error}</p>}

      {!loading && oracles.length === 0 && !error && (
        <p className="text-[11px] leading-relaxed text-[var(--color-muted)]/60">
          no live oracles. start the bridge or spawn one.
        </p>
      )}

      <div className="flex flex-col gap-1">
        {oracles.map((o) => (
          <button
            key={o.session}
            type="button"
            onClick={() => onAttach(o.identity)}
            className="group flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2.5 py-2 text-left transition-colors hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-panel-2)]"
            title={`Attach ${o.session}`}
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                o.attached ? "bg-green-500" : "bg-[var(--color-muted)]/40"
              }`}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] text-[var(--color-text)]">{o.display_name}</span>
              <span className="truncate text-[10px] text-[var(--color-muted)]">{o.session}</span>
            </div>
            <span className="text-[9px] uppercase tracking-wide text-[var(--color-muted)] opacity-0 transition-opacity group-hover:opacity-100">
              attach
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
