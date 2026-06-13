/**
 * BoxCockpit — the bisnesgpt box's idle home screen, styled as a Vercel-style
 * server cockpit. Shown INSTEAD of IdleControlCenter only on the box (gated by
 * the parent: pm2Processes.length > 0). Pure presentation — IdleDashboard owns
 * the 30s poll and hands the live pm2 fleet (and usage extras) down as props.
 *
 * Layout mirrors the approved mock
 * (adletic/aios-firaz/outputs/2026-06-13-bisnesgpt-cockpit-mock.html) but every
 * colour/spacing/radius traces to the App.css @theme tokens + shared classes
 * (.aios-tile / .surface-card / .pill / pane labels) — no invented hex.
 *
 * v1: header strip + aggregate tiles + service-card grid. The live-log panel is
 * intentionally deferred (see the marked spot near the bottom).
 */
import type { Pm2Process } from "../lib/pm2";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Human "20d 14h" / "5h 12m" / "12m" from a pm_uptime epoch-ms relative to now. */
function humanizeUptime(ms: number): string {
  if (!ms) return "—";
  const rem = Date.now() - ms;
  if (rem <= 0) return "now";
  const m = Math.floor(rem / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/** Known service → port map; everything else renders "—". */
function portFor(name: string): string {
  if (name === "bisnesgpt-api") return ":3000";
  if (name === "bisnesgpt-wwebjs") return ":3001";
  if (name === "bisnesgpt-meta") return ":3002";
  return "—";
}

/** 1234 MB → "1.2 G" parts so the unit can render muted/smaller. */
function fmtMem(totalMb: number): { value: string; unit: string } {
  if (totalMb >= 1024) return { value: (totalMb / 1024).toFixed(1), unit: "G" };
  return { value: String(Math.round(totalMb)), unit: "MB" };
}

/** A tiny deterministic sparkline so cards don't jump between polls. */
function Sparkline({ seed, online }: { seed: number; online: boolean }) {
  const n = 22;
  const w = 92;
  const h = 28;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const y = h - 3 - Math.abs(Math.sin(i * 0.6 + seed) * 0.7 + 0.18) * (h - 9);
    pts.push(`${((i * w) / (n - 1)).toFixed(1)},${y.toFixed(1)}`);
  }
  return (
    <svg
      className="ml-auto shrink-0"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
    >
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={online ? "var(--color-success)" : "var(--color-danger)"}
        strokeWidth={1.5}
        strokeLinejoin="round"
        opacity={0.7}
      />
    </svg>
  );
}

const LABEL = "text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-muted)]";

// ── tiles ──────────────────────────────────────────────────────────────────

function AggTile({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "success" | "danger" | "warning";
}) {
  const color =
    tone === "success"
      ? "var(--color-success)"
      : tone === "danger"
        ? "var(--color-danger)"
        : tone === "warning"
          ? "var(--color-warning)"
          : "var(--color-text)";
  return (
    <div className="aios-tile px-4 py-3">
      <div className={LABEL}>{label}</div>
      <div
        className="mt-2 font-mono text-[25px] font-semibold leading-none tabular-nums tracking-tight"
        style={{ color }}
      >
        {value}
        {unit && (
          <span className="ml-0.5 text-[14px] font-normal text-[var(--color-muted)]">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

// ── service card ─────────────────────────────────────────────────────────────

function ServiceCard({ proc, seed }: { proc: Pm2Process; seed: number }) {
  const online = proc.status === "online";
  const dot = online ? "var(--color-success)" : "var(--color-danger)";
  const restartsHot = proc.restarts > 3;
  return (
    <div className="aios-tile aios-tile--int p-4">
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-[var(--color-text)]">
          {proc.name}
        </span>
        <span
          className="pill shrink-0 px-2.5 py-1 text-[11px]"
          style={
            online
              ? {
                  borderColor: "color-mix(in srgb, var(--color-success) 40%, transparent)",
                  background: "color-mix(in srgb, var(--color-success) 12%, transparent)",
                  color: "var(--color-success)",
                }
              : {
                  borderColor: "color-mix(in srgb, var(--color-danger) 40%, transparent)",
                  background: "color-mix(in srgb, var(--color-danger) 12%, transparent)",
                  color: "var(--color-danger)",
                }
          }
        >
          <span className="size-1.5 rounded-full" style={{ background: dot }} />
          {online ? "online" : "errored"}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-[var(--color-muted)]">
          {portFor(proc.name)}
        </span>
      </div>

      <div className="mt-3.5 flex items-center gap-5">
        <Stat label="cpu" value={`${proc.cpu.toFixed(0)}%`} />
        <Stat label="mem" value={`${proc.memoryMb} MB`} />
        <Stat label="uptime" value={humanizeUptime(proc.uptimeMs)} />
        <Stat
          label="↻ restarts"
          value={String(proc.restarts)}
          color={restartsHot ? "var(--color-warning)" : undefined}
        />
        <Sparkline seed={seed} online={online} />
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
        {label}
      </span>
      <span
        className="font-mono text-[13px] tabular-nums"
        style={{ color: color ?? "var(--color-text-2)" }}
      >
        {value}
      </span>
    </div>
  );
}

// ── cockpit ──────────────────────────────────────────────────────────────────

export function BoxCockpit({
  pm2Processes,
  secondsSinceUpdate,
}: {
  pm2Processes: Pm2Process[];
  /** "updated Ns ago" — driven by the parent's poll clock. */
  secondsSinceUpdate: number | null;
}) {
  const online = pm2Processes.filter((p) => p.status === "online").length;
  const degraded = pm2Processes.length - online;
  const totalMem = pm2Processes.reduce((sum, p) => sum + p.memoryMb, 0);
  const totalCpu = pm2Processes.reduce((sum, p) => sum + p.cpu, 0);
  const totalRestarts = pm2Processes.reduce((sum, p) => sum + p.restarts, 0);
  const mem = fmtMem(totalMem);

  return (
    <div className="relative flex h-full flex-col overflow-y-auto">
      {/* ── header strip ── */}
      <header className="sticky top-0 z-10 flex items-center gap-3.5 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_82%,transparent)] px-7 py-3.5 backdrop-blur-md">
        <div className="grid size-6 place-items-center rounded-md bg-[var(--color-accent)] font-mono text-[12px] font-bold text-[var(--color-bg)]">
          A
        </div>
        <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-text)]">
          bisnesgpt
          <span className="text-[var(--color-faint)]">/</span>
          <span className="text-[var(--color-text-2)]">server</span>
        </div>
        <span className="pill px-2.5 py-1 font-mono text-[11px] text-[var(--color-muted)]">
          prod · box
        </span>
        <div className="ml-auto flex items-center gap-2 font-mono text-[12px] text-[var(--color-text-2)]">
          <span className="status-dot status-dot--active" />
          {secondsSinceUpdate == null
            ? "live"
            : `updated ${secondsSinceUpdate}s ago`}
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1160px] px-7 pb-12 pt-6">
        {/* ── aggregate tiles ── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <AggTile label="services" value={String(pm2Processes.length)} />
          <AggTile label="online" value={String(online)} tone="success" />
          <AggTile
            label="degraded"
            value={String(degraded)}
            tone={degraded > 0 ? "danger" : undefined}
          />
          <AggTile label="total mem" value={mem.value} unit={mem.unit} />
          <AggTile label="cpu" value={totalCpu.toFixed(1)} unit="%" />
          <AggTile
            label="restarts"
            value={String(totalRestarts)}
            tone={totalRestarts > 3 ? "warning" : undefined}
          />
        </div>

        {/* ── services ── */}
        <div className="mb-3.5 mt-7 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--color-text)]">
            Services
          </h2>
          <span className="font-mono text-[12px] text-[var(--color-faint)]">
            pm2 · {pm2Processes.length} processes
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {pm2Processes.map((proc, i) => (
            <ServiceCard key={proc.pmId} proc={proc} seed={i + 1} />
          ))}
        </div>

        {/*
          v1 stops here. DEFERRED: a live runtime-log tail panel goes below —
          a .surface-card with a level filter (all/info/warn/error), a service
          select, and a mono log stream. Needs a pm2 log-tail bridge command
          first; leaving the slot reserved so the cockpit grows in place.
        */}
      </div>
    </div>
  );
}
