/** IdleDashboard — pure entry point for the instant home screen. */
import type { AppDef } from "../App";
import type { SidebarState, SidebarItem } from "../lib/sidebar";
import { resetIn } from "../lib/dashboard";
import { IdleControlCenter } from "./IdleControlCenter";

interface IdleDashboardProps {
  sidebar: SidebarState;
  onSpawn: (kind: AppDef["kind"], label: string) => void;
  onOpenSidebarItem: (item: SidebarItem) => void;
  onRevealSidebar: () => void;
  onOpenPalette: () => void;
  onTalkToJarvis: (seed: string) => void;
}

export function IdleDashboard({
  sidebar,
  onSpawn,
  onOpenSidebarItem,
  onRevealSidebar,
  onOpenPalette,
  onTalkToJarvis,
}: IdleDashboardProps) {
  return (
    <IdleControlCenter
      sidebar={sidebar}
      onSpawn={onSpawn}
      onOpenSidebarItem={onOpenSidebarItem}
      onRevealSidebar={onRevealSidebar}
      onOpenPalette={onOpenPalette}
      onTalkToJarvis={onTalkToJarvis}
    />
  );
}

// ── shared render primitives (reused by PulsePane) ───────────────────────────
// These keep PulsePane's rings + heatmap + stat formatting pixel-matched to the
// idle surface. They're the only render helpers that live here now.

function ringColor(pct: number): string {
  if (pct >= 90) return "var(--color-danger)";
  if (pct >= 70) return "var(--color-warning)";
  return "var(--color-accent)";
}

/** An animated %-ring with a centred number + label, used by PulsePane. */
function Ring({
  label,
  pct,
  resetsAt,
  size = 38,
}: {
  label: string;
  pct: number | null;
  resetsAt: number | null;
  size?: number;
}) {
  if (pct == null) return null;
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const sw = size >= 46 ? 3.5 : 3;
  const filled = Math.min(Math.max(pct, 0), 100) / 100;
  const mid = size / 2;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative grid place-items-center" style={{ height: size, width: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90">
          <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--color-panel-2)" strokeWidth={sw} />
          <circle
            cx={mid}
            cy={mid}
            r={r}
            fill="none"
            stroke={ringColor(pct)}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - filled)}
            className="aios-ring"
            style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(0.16,1,0.3,1)" }}
          />
        </svg>
        <span
          className="absolute font-mono font-semibold text-[var(--color-text)]"
          style={{ fontSize: Math.max(10, Math.round(size * 0.27)) }}
        >
          {Math.round(pct)}
        </span>
      </div>
      <span className="font-mono text-[var(--color-muted)]" style={{ fontSize: size >= 60 ? 11 : 9 }}>
        {label}
        {resetsAt ? ` ${resetIn(resetsAt)}` : ""}
      </span>
    </div>
  );
}

/** Compact number formatter: 1234 → 1.2k, 3.4M. */
function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Short label for a model id: "claude-sonnet-4-5-20250101" → "sonnet 4.5". */
function shortModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{6,}$/, "")
    .replace(/-(\d)-(\d)$/, " $1.$2")
    .replace(/-/g, " ");
}

/** Compact "since" date: an ISO/date string → "may '25". */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mon = d.toLocaleDateString(undefined, { month: "short" }).toLowerCase();
  return `${mon} '${String(d.getFullYear()).slice(-2)}`;
}

/** Heatmap cell color ramp by relative count. */
function heatColor(count: number, max: number): string {
  if (count <= 0) return "var(--color-panel-2)";
  const t = max > 0 ? count / max : 0;
  if (t > 0.78) return "var(--color-highlight)";
  const pct = Math.round(35 + Math.min(t, 1) * 60);
  return `color-mix(in srgb, var(--color-accent) ${pct}%, transparent)`;
}

// Shared with PulsePane (the click-to-detail view) so the rich pane reuses the
// exact same ring + heatmap + formatting — no duplication.
export { Ring, heatColor, fmtNum, shortModel, shortDate };
