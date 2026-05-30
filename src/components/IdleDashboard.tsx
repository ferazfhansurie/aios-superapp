/**
 * IdleDashboard — the AIOS homescreen, shown when no panes are open.
 *
 * Not wallpaper: a live status board you launch + glance + continue from. The
 * research (raycast / cursor 3 / windsurf / warp / linear / spotlight) converges
 * hard — kill the clock-as-centerpiece (vanity), make every tile carry live
 * state AND be a launch point, and let the fleet + "continue where you left off"
 * be the heroes. So:
 *
 *   - omni-input anchor (⌘K) — the never-empty surface that launches anything
 *   - FLEET (hero) — your oracles, running first, click a node to attach
 *   - CONTINUE (hero) — recent chats, one click resumes the conversation
 *   - APPS — the full launch dock (every tool a tile)
 *   - INBOX — latest customers waiting, click into the inbox
 *   - FOCUS — current phase + active task from goals/active.json
 *   - PULSE — clock · streak · 5h/7d rate rings · activity heatmap (demoted to
 *     one small tile; it survives as glance, not as the star)
 *
 * Bento discipline: size == importance (2 heroes max), one radius token, uniform
 * gutters, monochrome surfaces with the accent reserved for "live / attention".
 * Motion is one staggered entrance then stillness; reduce-motion (Settings sets
 * `data-reduce-motion` on :root) fades instead. Every data source degrades to an
 * action-oriented empty state — never a blank or a lying number.
 *
 * Live lists (oracles / chats / customers) come down as props from App so the
 * homescreen and the ⌘K palette share one polled source. Usage/rate/focus are
 * self-loaded here (cheap, defensive).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  ArrowRight,
  Battery,
  BatteryCharging,
  Cpu,
  Flame,
  MessageCircle,
  MessageSquare,
  Radio,
  Search,
  Target,
  Zap,
} from "lucide-react";

import type { AppDef } from "../App";
import type { OracleInfo } from "../lib/pty";
import type { ChatSessionInfo } from "../lib/chat";
import type { Customer } from "../lib/inbox";
import { deviceStats, type DeviceStats } from "../lib/device";
import { usageExtras, type UsageExtras } from "../lib/stats";
import {
  idleRate,
  memoryFocus,
  resetIn,
  type IdleRate,
  type MemoryFocus,
} from "../lib/dashboard";

interface IdleDashboardProps {
  apps: AppDef[];
  oracles: OracleInfo[];
  chats: ChatSessionInfo[];
  customers: Customer[];
  onSpawn: (kind: AppDef["kind"], label: string) => void;
  onAttachOracle: (identity: string) => void;
  onResumeChat: (s: ChatSessionInfo) => void;
  onOpenPalette: () => void;
}

export function IdleDashboard({
  apps,
  oracles,
  chats,
  customers,
  onSpawn,
  onAttachOracle,
  onResumeChat,
  onOpenPalette,
}: IdleDashboardProps) {
  const [extras, setExtras] = useState<UsageExtras | null>(null);
  const [rate, setRate] = useState<IdleRate | null>(null);
  const [focus, setFocus] = useState<MemoryFocus | null>(null);
  const [device, setDevice] = useState<DeviceStats | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      usageExtras().then((v) => alive && setExtras(v)).catch(() => {});
      idleRate().then((v) => alive && setRate(v)).catch(() => {});
      memoryFocus().then((v) => alive && setFocus(v)).catch(() => {});
      deviceStats().then((v) => alive && setDevice(v)).catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const awake = oracles.filter((o) => o.running).length;

  return (
    <div className="relative flex h-full flex-col overflow-hidden p-4">
      {/* faint ambient drift — identity, not decoration; reduce-motion kills it */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-70">
        <div
          className="aios-drift-a absolute h-[48vh] w-[48vh] rounded-full blur-[100px]"
          style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--color-accent) 16%, transparent), transparent 70%)" }}
        />
        <div
          className="aios-drift-b absolute h-[40vh] w-[40vh] rounded-full blur-[100px]"
          style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--color-highlight) 12%, transparent), transparent 70%)" }}
        />
      </div>

      {/* ── header: greeting + omni-input anchor ─────────────────────────── */}
      <div className="relative mb-4 flex shrink-0 items-center gap-4">
        <Greeting />
        <OmniInput onClick={onOpenPalette} />
      </div>

      {/* ── bento grid ───────────────────────────────────────────────────── */}
      <div className="relative grid min-h-0 flex-1 grid-cols-6 grid-rows-3 gap-3">
        {/* PULSE — hero (c1-3, r1-2) — click opens the full pulse detail pane */}
        <Tile
          className="col-span-3 row-span-2"
          delay={40}
          icon={<Zap size={12} className="text-[var(--color-highlight)]" />}
          label="pulse"
          onClick={() => onSpawn({ type: "pulse" }, "pulse")}
        >
          <Pulse extras={extras} rate={rate} focus={focus} />
        </Tile>

        {/* CONTINUE — hero (c4-6, r1) */}
        <Tile
          className="col-span-3"
          delay={80}
          icon={<MessageSquare size={12} className="text-[var(--color-highlight)]" />}
          label="continue"
        >
          <ContinueRail chats={chats} onResume={onResumeChat} onNew={() => onSpawn({ type: "chat" }, "chat")} />
        </Tile>

        {/* INBOX (c4-5, r2) */}
        <Tile
          className="col-span-2"
          delay={120}
          icon={<MessageCircle size={12} className="text-[var(--color-info)]" />}
          label="inbox"
          right={customers.length ? <span className="font-mono text-[10px] text-[var(--color-muted)]">{customers.length}</span> : undefined}
          onClick={() => onSpawn({ type: "customers" }, "customers")}
        >
          <InboxGlance customers={customers} />
        </Tile>

        {/* FOCUS (c6, r2) */}
        <Tile
          className="col-span-1"
          delay={160}
          icon={<Target size={12} className="text-[var(--color-accent)]" />}
          label="focus"
        >
          <FocusGlance focus={focus} />
        </Tile>

        {/* APPS — launch dock (c1-3, r3) */}
        <Tile className="col-span-3" delay={200} icon={<ArrowRight size={12} className="text-[var(--color-muted)]" />} label="apps">
          <AppDock apps={apps} onSpawn={onSpawn} />
        </Tile>

        {/* DEVICE — laptop monitor (c4-5, r3) */}
        <Tile className="col-span-2" delay={240} icon={<Cpu size={12} className="text-[var(--color-info)]" />} label="device">
          <DeviceTile dev={device} />
        </Tile>

        {/* FLEET — oracle roster (c6, r3) */}
        <Tile
          className="col-span-1"
          delay={280}
          icon={<Radio size={12} className="text-[var(--color-accent)]" />}
          label="fleet"
          right={
            <span className="font-mono text-[10px] text-[var(--color-muted)]">
              <span className="text-[var(--color-accent)]">{awake}</span>/{oracles.length}
            </span>
          }
        >
          <FleetBoard oracles={oracles} onAttach={onAttachOracle} />
        </Tile>
      </div>

      <span className="pointer-events-none absolute bottom-1.5 right-4 font-mono text-[10px] tracking-wide text-[var(--color-faint)]">
        ⌘K launch anything · ⌘B rail
      </span>
    </div>
  );
}

// ── tile shell ─────────────────────────────────────────────────────────────────

function Tile({
  label,
  icon,
  right,
  onClick,
  children,
  className,
  delay = 0,
}: {
  label: string;
  icon?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const interactive = !!onClick;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onClick!()) : undefined}
      style={{ animationDelay: `${delay}ms` }}
      className={`aios-fade-in flex min-h-0 min-w-0 flex-col rounded-[var(--aios-radius-lg)] border border-[var(--color-border)] bg-[var(--color-panel)]/45 p-3 backdrop-blur-sm ${
        interactive ? "cursor-pointer transition-all hover:-translate-y-0.5 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel)]/75" : ""
      } ${className ?? ""}`}
    >
      <div className="mb-2 flex shrink-0 items-center gap-1.5">
        {icon}
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-muted)]">{label}</span>
        {right != null && <span className="ml-auto">{right}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

// ── greeting + omni-input ────────────────────────────────────────────────────

function Greeting() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const h = now.getHours();
  const part = h < 5 ? "still up" : h < 12 ? "good morning" : h < 18 ? "good afternoon" : "good evening";
  return (
    <div className="aios-fade-in flex shrink-0 flex-col">
      <span className="text-[18px] font-medium leading-tight tracking-tight text-[var(--color-text)]">{part}, firaz</span>
      <span className="font-mono text-[11px] text-[var(--color-muted)]">
        {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }).toLowerCase()}
      </span>
    </div>
  );
}

function OmniInput({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="aios-fade-in group flex h-10 flex-1 items-center gap-2.5 rounded-[var(--aios-radius-pill)] border border-[var(--color-border)] bg-[var(--color-panel)]/50 px-4 text-left backdrop-blur-sm transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel)]/80"
      style={{ animationDelay: "20ms" }}
    >
      <Search size={15} className="shrink-0 text-[var(--color-muted)] group-hover:text-[var(--color-text)]" />
      <span className="flex-1 truncate text-[13px] text-[var(--color-faint)]">launch, ask, or resume anything…</span>
      <kbd className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">⌘K</kbd>
    </button>
  );
}

// ── FLEET ───────────────────────────────────────────────────────────────────

function FleetBoard({ oracles, onAttach }: { oracles: OracleInfo[]; onAttach: (identity: string) => void }) {
  // master pinned, then running, then the rest — by name within each tier.
  const sorted = [...oracles].sort((a, b) => {
    if (a.is_master !== b.is_master) return a.is_master ? -1 : 1;
    if (a.running !== b.running) return a.running ? -1 : 1;
    return a.display_name.localeCompare(b.display_name);
  });
  if (!sorted.length) {
    return <Empty>no oracles · ⌘K to spawn one</Empty>;
  }
  return (
    <div className="flex h-full flex-col gap-0.5 overflow-y-auto pr-0.5">
      {sorted.map((o) => (
        <button
          key={o.identity}
          onClick={() => onAttach(o.identity)}
          title={`attach ${o.display_name}`}
          className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-panel-2)]"
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${o.running ? "aios-node-live" : ""}`}
            style={{ background: o.running ? "var(--color-accent)" : "var(--color-cold)", opacity: o.running ? 1 : 0.4 }}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
            {o.display_name}
            {o.is_master && <span className="ml-1.5 text-[9px] uppercase tracking-wider text-[var(--color-accent)]">master</span>}
          </span>
          <span className={`shrink-0 font-mono text-[10px] ${o.running ? "text-[var(--color-accent)]" : "text-[var(--color-faint)]"}`}>
            {o.running ? "running" : "idle"}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── CONTINUE ──────────────────────────────────────────────────────────────────

function ago(ts: number): string {
  if (!ts) return "";
  const ms = ts > 1e12 ? ts : ts * 1000;
  const rem = Date.now() - ms;
  if (rem < 60_000) return "now";
  const m = Math.floor(rem / 60_000);
  if (m < 60) return `${m}m`;
  const hh = Math.floor(m / 60);
  if (hh < 24) return `${hh}h`;
  return `${Math.floor(hh / 24)}d`;
}

function ContinueRail({
  chats,
  onResume,
  onNew,
}: {
  chats: ChatSessionInfo[];
  onResume: (s: ChatSessionInfo) => void;
  onNew: () => void;
}) {
  if (!chats.length) {
    return (
      <button onClick={onNew} className="flex h-full w-full items-center justify-center rounded-md text-[12px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]">
        no recent chats · start one →
      </button>
    );
  }
  return (
    <div className="flex h-full flex-col gap-0.5 overflow-y-auto pr-0.5">
      {chats.slice(0, 6).map((c) => (
        <button
          key={c.id}
          onClick={() => onResume(c)}
          title={`resume · ${c.cwd}`}
          className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-panel-2)]"
        >
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
            {c.title || "untitled chat"}
          </span>
          {c.cwd && (
            <span className="hidden shrink-0 truncate font-mono text-[10px] text-[var(--color-faint)] sm:inline">
              {c.cwd.split("/").pop()}
            </span>
          )}
          <span className="shrink-0 font-mono text-[10px] text-[var(--color-muted)]">{ago(c.mtime)}</span>
        </button>
      ))}
    </div>
  );
}

// ── INBOX ─────────────────────────────────────────────────────────────────────

function InboxGlance({ customers }: { customers: Customer[] }) {
  if (!customers.length) return <Empty>inbox clear</Empty>;
  return (
    <div className="flex h-full flex-col gap-0.5 overflow-hidden">
      {customers.slice(0, 4).map((c) => (
        <div key={c.id} className="flex items-center gap-2 rounded-md px-1.5 py-1">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-text-2)]">{c.name}</span>
          {c.lastAgo && <span className="shrink-0 font-mono text-[10px] text-[var(--color-faint)]">{c.lastAgo}</span>}
        </div>
      ))}
    </div>
  );
}

// ── FOCUS ─────────────────────────────────────────────────────────────────────

function FocusGlance({ focus }: { focus: MemoryFocus | null }) {
  if (!focus?.title) return <Empty>no recent memory</Empty>;
  return (
    <div className="flex h-full flex-col justify-center gap-1">
      {focus.tag && (
        <span className="truncate text-[9px] uppercase tracking-[0.16em] text-[var(--color-accent)]" title={focus.tag}>
          {focus.tag}
        </span>
      )}
      <span className="line-clamp-4 text-[12px] leading-snug text-[var(--color-text-2)]" title={focus.title}>
        {focus.title}
      </span>
    </div>
  );
}

// ── PULSE (clock · streak · rate rings · heatmap) ───────────────────────────────

function useCountUp(target: number | null, ms = 900): number {
  const [val, setVal] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (target == null) return;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min((t - start) / ms, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(target * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, ms]);
  return val;
}

function ringColor(pct: number): string {
  if (pct >= 90) return "var(--color-danger)";
  if (pct >= 70) return "var(--color-warning)";
  return "var(--color-accent)";
}

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

/** Compact number formatter for the pulse stat row: 1234 → 1.2k, 3.4M. */
function fmtNum(n: number): string {
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

/** A small stacked value+label cell for the pulse secondary-stat strip — mirrors
 *  the muted-label / text-2-value rhythm of the existing stat row. */
function MetaStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="font-mono text-[13px] text-[var(--color-text-2)]">{value}</span>
      <span className="text-[9px] uppercase tracking-[0.12em] text-[var(--color-muted)]">{label}</span>
    </div>
  );
}

function heatColor(count: number, max: number): string {
  if (count <= 0) return "var(--color-panel-2)";
  const t = max > 0 ? count / max : 0;
  if (t > 0.78) return "var(--color-highlight)";
  const pct = Math.round(35 + Math.min(t, 1) * 60);
  return `color-mix(in srgb, var(--color-accent) ${pct}%, transparent)`;
}

function Pulse({
  extras,
  rate,
  focus,
}: {
  extras: UsageExtras | null;
  rate: IdleRate | null;
  focus: MemoryFocus | null;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const streak = useCountUp(extras?.currentStreak ?? null);
  const hasRate = rate && (rate.fiveHour.pct != null || rate.sevenDay.pct != null);

  const best = extras?.longestStreak ?? 0;

  // up to ~18 weeks of the heatmap to fill the hero's width.
  const days = (extras?.heatmap ?? []).slice(-126);
  const max = Math.max(1, ...days.map((d) => d.count));
  const weeks: { date: string; count: number }[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");

  return (
    <div className="flex h-full items-stretch gap-6">
      {/* left column — clock, streak, stats, rings; vertically centered */}
      <div className="flex shrink-0 flex-col justify-center gap-4">
        {/* clock — alive (ticking seconds + blinking colon) */}
        <div className="flex flex-col">
          <div className="flex items-baseline gap-1.5 font-mono font-semibold tracking-tight text-[var(--color-text)]">
            <span className="text-[clamp(40px,6vw,60px)] leading-none">{hh}</span>
            <span className="aios-colon text-[clamp(40px,6vw,60px)] leading-none text-[var(--color-accent)]">:</span>
            <span className="text-[clamp(40px,6vw,60px)] leading-none">{mm}</span>
            <span className="ml-1.5 self-end font-mono text-[15px] leading-none text-[var(--color-faint)]">{ss}</span>
          </div>
          <span className="mt-1.5 font-mono text-[12px] text-[var(--color-muted)]">
            {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }).toLowerCase()}
          </span>
        </div>

        {/* streak — hero stat */}
        <div className="flex items-center gap-2.5">
          <Flame
            size={26}
            className={streak > 0 ? "aios-flame text-[var(--color-accent)]" : "text-[var(--color-faint)]"}
            fill={streak > 0 ? "currentColor" : "none"}
          />
          <span className="font-mono text-[36px] font-semibold leading-none text-[var(--color-text)]">{Math.round(streak)}</span>
          <div className="flex flex-col leading-tight">
            <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-muted)]">day streak</span>
            {best > 0 && <span className="font-mono text-[10px] text-[var(--color-faint)]">best {best}</span>}
          </div>
        </div>

        {/* stat row — active days + lifetime tokens */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-[var(--color-muted)]">
          {extras?.active7d != null && (
            <span>
              <span className="text-[var(--color-text-2)]">{extras.active7d}</span>/7d active
            </span>
          )}
          {extras?.active30d != null && (
            <span>
              <span className="text-[var(--color-text-2)]">{extras.active30d}</span>/30d
            </span>
          )}
          {extras?.tokensTotal != null && extras.tokensTotal > 0 && (
            <span>
              <span className="text-[var(--color-text-2)]">{fmtNum(extras.tokensTotal)}</span> tok
            </span>
          )}
        </div>

        {/* rate rings — large, labeled (+ context fill as a third ring) */}
        {hasRate && (
          <div className="mt-1 flex gap-6">
            <Ring label="5h" pct={rate!.fiveHour.pct} resetsAt={rate!.fiveHour.resetsAt} size={66} />
            <Ring label="7d" pct={rate!.sevenDay.pct} resetsAt={rate!.sevenDay.resetsAt} size={66} />
            {rate!.contextPct != null && (
              <Ring label="ctx" pct={rate!.contextPct} resetsAt={null} size={66} />
            )}
          </div>
        )}

        {/* secondary stats — fills the previously dead lower-left space with the
            UsageExtras fields the tile didn't surface (sessions / messages /
            top model / active-since) + the freshest memory focus line. */}
        {extras && (
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
            {extras.totalSessions != null && (
              <MetaStat value={fmtNum(extras.totalSessions)} label="sessions" />
            )}
            {extras.totalMessages != null && (
              <MetaStat value={fmtNum(extras.totalMessages)} label="messages" />
            )}
            {extras.favoriteModel && (
              <MetaStat value={shortModel(extras.favoriteModel)} label="top model" />
            )}
            {extras.firstSessionDate && (
              <MetaStat value={shortDate(extras.firstSessionDate)} label="since" />
            )}
          </div>
        )}

        {focus?.title && (
          <div className="flex items-baseline gap-1.5 font-mono text-[10px] leading-tight text-[var(--color-faint)]">
            <span className="uppercase tracking-[0.14em] text-[var(--color-muted)]">focus</span>
            <span className="min-w-0 truncate text-[var(--color-text-2)]" title={focus.title}>
              {focus.title}
            </span>
          </div>
        )}
      </div>

      {/* right column — heatmap tiles the remaining width & height. Each cell is
          flex-1 on BOTH axes so the grid always fits the box exactly: no
          overflow, no dead gap, at any window size. (max-h caps cell size on
          very tall windows so they don't balloon.) */}
      {!!weeks.length && (
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
          <div className="flex max-h-[150px] min-h-[70px] flex-1 gap-[3px]">
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-1 flex-col gap-[3px]">
                {week.map((d, di) => (
                  <span
                    key={d.date}
                    title={`${d.date} · ${d.count}`}
                    className="aios-cell flex-1 rounded-[2px]"
                    style={{ background: heatColor(d.count, max), animationDelay: `${(wi * 7 + di) * 6}ms` }}
                  />
                ))}
              </div>
            ))}
          </div>
          <span className="shrink-0 font-mono text-[9px] text-[var(--color-faint)]">{days.length}-day activity</span>
        </div>
      )}
    </div>
  );
}

// ── DEVICE monitor ──────────────────────────────────────────────────────────────

const GB = (b: number) => b / 1_000_000_000;

/** A thin labelled usage bar — accent under 65%, warning to 85%, danger above. */
function Meter({ label, pct, right, sub }: { label: string; pct: number; right: string; sub?: string }) {
  const color = pct >= 85 ? "var(--color-danger)" : pct >= 65 ? "var(--color-warning)" : "var(--color-accent)";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="uppercase tracking-[0.14em] text-[var(--color-muted)]">{label}</span>
        <span className="font-mono text-[var(--color-text-2)]">{right}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-panel-2)]">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.min(Math.max(pct, 0), 100)}%`, background: color }} />
      </div>
      {sub && <span className="text-[9px] text-[var(--color-faint)]">{sub}</span>}
    </div>
  );
}

function uptimeStr(secs: number): string {
  if (!secs) return "";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function DeviceTile({ dev }: { dev: DeviceStats | null }) {
  if (!dev) return <Empty>device stats unavailable</Empty>;
  const memPct = dev.memTotal ? (dev.memUsed / dev.memTotal) * 100 : 0;
  const diskPct = dev.diskTotal ? (dev.diskUsed / dev.diskTotal) * 100 : 0;
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      <Meter
        label="cpu"
        pct={dev.cpuPct}
        right={`${Math.round(dev.cpuPct)}%`}
        sub={`${dev.cores} cores · load ${dev.load1.toFixed(1)}${dev.uptimeSecs ? ` · up ${uptimeStr(dev.uptimeSecs)}` : ""}`}
      />
      <Meter label="mem" pct={memPct} right={`${GB(dev.memUsed).toFixed(1)} / ${GB(dev.memTotal).toFixed(0)} GB`} />
      <Meter label="disk" pct={diskPct} right={`${GB(dev.diskUsed).toFixed(0)} / ${GB(dev.diskTotal).toFixed(0)} GB`} />
      {dev.batteryPct != null && (
        <div className="flex items-center gap-1.5 text-[10px]">
          {dev.batteryCharging ? (
            <BatteryCharging size={13} className="text-[var(--color-accent)]" />
          ) : (
            <Battery size={13} className={dev.batteryPct <= 20 ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"} />
          )}
          <span className="font-mono text-[var(--color-text-2)]">{Math.round(dev.batteryPct)}%</span>
          <span className="text-[var(--color-faint)]">{dev.batteryCharging ? "charging" : "battery"}</span>
        </div>
      )}
    </div>
  );
}

// ── APPS dock ─────────────────────────────────────────────────────────────────

function AppDock({ apps, onSpawn }: { apps: AppDef[]; onSpawn: (kind: AppDef["kind"], label: string) => void }) {
  return (
    <div className="flex h-full flex-wrap content-start items-start gap-1.5 overflow-y-auto">
      {apps.map((a) => (
        <button
          key={a.label}
          onClick={() => onSpawn(a.kind, a.label)}
          title={`new ${a.label}`}
          className="group flex min-w-[68px] flex-1 flex-col items-center justify-center gap-1.5 rounded-[var(--aios-radius-md)] border border-transparent bg-[var(--color-panel-2)]/40 px-2 py-2 transition-all hover:-translate-y-0.5 hover:border-[var(--color-border)] hover:bg-[var(--color-panel-2)]"
        >
          <a.icon size={18} className="text-[var(--color-muted)] transition-colors group-hover:text-[var(--color-accent)]" />
          <span className="text-[10.5px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">{a.label}</span>
        </button>
      ))}
    </div>
  );
}

// ── shared empty state ──────────────────────────────────────────────────────────

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-2 text-center text-[11.5px] text-[var(--color-faint)]">
      {children}
    </div>
  );
}

// Shared with PulsePane (the click-to-detail view) so the rich pane reuses the
// exact same ring + heatmap + formatting the tile uses — no duplication.
export { Ring, heatColor, fmtNum, shortModel, shortDate };
