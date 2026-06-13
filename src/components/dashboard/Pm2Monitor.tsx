/**
 * Pm2Monitor — a quiet idle-dashboard tile listing the live pm2 fleet on the
 * box (bisnesgpt, bisnesgpt-api ×2, bisnesgpt-wwebjs, bisnesgpt-meta ×2,
 * ajim-bot). Pure presentation: the parent (IdleDashboard) drives the 30s poll
 * and passes the list down as a prop — no polling here.
 *
 * On the laptop pm2 is absent → the parent gets an empty list and this returns
 * null, so the tile is invisible. Style mirrors UsageGlance / RecentProjects:
 * a "server · pm2" uppercase tracking label, one row per process with a status
 * dot, truncated name, and a right-aligned mono stat line.
 */
import type { Pm2Process } from "../../lib/pm2";

/** Human "3d 2h" / "5h" / "12m" from a pm_uptime epoch-ms relative to now. */
function uptime(ms: number): string {
  if (!ms) return "";
  const rem = Date.now() - ms;
  if (rem <= 0) return "now";
  const m = Math.floor(rem / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h`;
  if (h >= 1) return `${h}h`;
  return `${m}m`;
}

export function Pm2Monitor({ processes }: { processes: Pm2Process[] }) {
  // Invisible on the laptop (no pm2) — keeps the idle home clean off the box.
  if (processes.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-muted)]">
        server · pm2
      </span>
      {processes.map((p) => {
        const online = p.status === "online";
        const up = uptime(p.uptimeMs);
        return (
          <div
            key={p.pmId}
            title={`${p.name} · pid ${p.pid} · ${p.status}`}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left"
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{
                background: online ? "var(--color-accent)" : "var(--color-danger)",
              }}
            />
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-2)]">
              {p.name}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-[var(--color-muted)]">
              {p.cpu.toFixed(0)}% · {p.memoryMb}MB · ↻{p.restarts}
              {up && ` · ${up}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
