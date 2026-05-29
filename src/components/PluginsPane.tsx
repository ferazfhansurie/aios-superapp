/** Plugins / skills — "make AIOS work your way". Lists the canonical AIOS skill
 *  catalog (grouped) + connected MCP servers, searchable. Read-only catalog. */
import { useCallback, useEffect, useMemo, useState } from "react";

import { Blocks, Plug, RefreshCw, Search } from "lucide-react";

import { listPlugins, type Plugins, type Skill } from "../lib/plugins";

export function PluginsPane() {
  const [data, setData] = useState<Plugins | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await listPlugins());
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const groups = useMemo(() => {
    const skills = data?.skills ?? [];
    const f = q.trim().toLowerCase();
    const filtered = !f
      ? skills
      : skills.filter(
          (s) => s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f),
        );
    const by = new Map<string, Skill[]>();
    for (const s of filtered) {
      const arr = by.get(s.group) ?? [];
      arr.push(s);
      by.set(s.group, arr);
    }
    return [...by.entries()];
  }, [data, q]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex items-center gap-2">
          <Blocks size={14} className="text-[var(--color-accent)]" />
          <span className="text-[13px] font-medium text-[var(--color-text)]">plugins · skills</span>
          <span className="text-[11px] text-[var(--color-muted)]">
            {data?.skills.length ?? 0} skills · {data?.mcps.length ?? 0} mcp
          </span>
        </div>
        <button
          onClick={refresh}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-3 text-center text-[15px] font-semibold text-[var(--color-text)]">
          make aios work your way
        </p>
        <div className="mx-auto mb-4 flex max-w-md items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-3 py-2">
          <Search size={13} className="text-[var(--color-faint)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search skills…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
          />
        </div>

        {data && data.mcps.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
              <Plug size={11} /> connected mcp servers
            </div>
            <div className="flex flex-wrap gap-2">
              {data.mcps.map((m) => (
                <span
                  key={m}
                  className="rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] px-2.5 py-1 font-mono text-[11px] text-[var(--color-text)]"
                >
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}

        {groups.map(([group, skills]) => (
          <div key={group} className="mb-4">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
              {group}
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {skills.map((s) => (
                <div
                  key={`${group}-${s.name}`}
                  className="flex flex-col gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/30 px-3 py-2"
                >
                  <span className="font-mono text-[12px] text-[var(--color-accent)]">{s.name}</span>
                  <span className="text-[11px] leading-snug text-[var(--color-muted)]">
                    {s.description}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}

        {!loading && groups.length === 0 && (
          <p className="text-center text-[12px] text-[var(--color-muted)]/60">no skills match.</p>
        )}
      </div>
    </div>
  );
}
