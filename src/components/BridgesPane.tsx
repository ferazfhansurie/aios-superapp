/** Bridges — at-a-glance health of every channel bridge AIOS runs. Today the
 *  WhatsApp bridge; the shape is extensible so future bridges just appear. Each
 *  card: a big ALIVE/DOWN status (pulsing dot), the bridge name + type chip, an
 *  activity stat row (sent · today · last seen), and faint pid/launchd/log meta. */
import { useCallback, useEffect, useState } from "react";

import { Activity, MessageCircle, Plug, Radio, RefreshCw, Zap } from "lucide-react";

import { listBridges, type Bridge, type Bridges } from "../lib/bridges";

/** Icon for a bridge's channel type. */
function kindIcon(kind: string) {
  if (kind === "whatsapp") return <MessageCircle size={13} className="text-[var(--color-success)]" />;
  return <Plug size={13} className="text-[var(--color-info)]" />;
}

/** True when a bridge surfaced zero useful data from any source. */
function hasNoData(b: Bridge): boolean {
  return (
    !b.alive &&
    b.pid == null &&
    !b.loaded &&
    b.messagesTotal == null &&
    b.lastActivity == null
  );
}

export function BridgesPane() {
  const [data, setData] = useState<Bridges | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setData(await listBridges());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // bridges should feel live — poll fast.
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const bridges = data?.bridges ?? [];
  const aliveCount = bridges.filter((b) => b.alive).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex items-center gap-2">
          <Radio size={14} className="text-[var(--color-accent)]" />
          <span className="text-[13px] font-medium text-[var(--color-text)]">bridges</span>
          {bridges.length > 0 && (
            <span className="text-[11px] text-[var(--color-muted)]">
              {aliveCount}/{bridges.length} alive
            </span>
          )}
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
        <p className="mb-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
          channel bridges connecting AIOS to the outside — is each one alive, and what's it been doing.
        </p>

        {error && <p className="text-[12px] text-[var(--color-danger)]">{error}</p>}

        {bridges.length === 0 && !loading && !error && (
          <p className="text-[11px] text-[var(--color-muted)]/60">no bridges detected.</p>
        )}

        <div className="flex flex-col gap-2.5">
          {bridges.map((b) => (
            <BridgeCard key={b.id} bridge={b} />
          ))}
        </div>
      </div>
    </div>
  );
}

function BridgeCard({ bridge: b }: { bridge: Bridge }) {
  const noData = hasNoData(b);
  // status-dot--active (green pulse) when alive, --cold (greyed) when down.
  const dot = b.alive ? "status-dot--active" : "status-dot--cold";
  const statusLabel = b.alive ? (b.uptime ? `alive · up ${b.uptime}` : "alive") : "down";
  const statusColor = b.alive ? "text-[var(--color-success)]" : "text-[var(--color-danger)]";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/30 px-3 py-2.5">
      {/* header row: status + name + type chip */}
      <div className="flex items-center gap-2.5">
        <span className={`status-dot shrink-0 ${dot}`} />
        <span className={`text-[12px] font-medium ${statusColor}`}>{statusLabel}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="truncate text-[12px] text-[var(--color-text)]">{b.name}</span>
          <span className="flex items-center gap-1 rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-2)]">
            {kindIcon(b.kind)}
            {b.kind}
          </span>
        </span>
      </div>

      {noData ? (
        <p className="text-[11px] text-[var(--color-muted)]/70">no data — bridge may be offline.</p>
      ) : (
        <>
          {/* activity stat row */}
          <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-2)]">
            <Activity size={12} className="text-[var(--color-accent)]" />
            <span className="font-mono">{b.messagesTotal ?? "–"}</span>
            <span className="text-[var(--color-muted)]">sent ·</span>
            <span className="font-mono">{b.today ?? "–"}</span>
            <span className="text-[var(--color-muted)]">today</span>
            {b.lastActivityAgo && (
              <>
                <span className="text-[var(--color-muted)]">· last</span>
                <span className="font-mono">{b.lastActivityAgo}</span>
                <span className="text-[var(--color-muted)]">ago</span>
              </>
            )}
          </div>

          {/* faint meta: pid · launchd · log path */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-[var(--color-faint)]">
            {b.pid != null && (
              <span className="flex items-center gap-1">
                <Zap size={9} />
                <span className="font-mono">pid {b.pid}</span>
              </span>
            )}
            {b.launchd && <span className="font-mono">{b.launchd}</span>}
            {b.lastActivity && <span className="font-mono">last {b.lastActivity}</span>}
            {b.logPath && <span className="truncate font-mono">{b.logPath}</span>}
          </div>
        </>
      )}
    </div>
  );
}
