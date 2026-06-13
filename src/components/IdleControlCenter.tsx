/**
 * IdleControlCenter — the AIOS home screen, shown when no panes are open.
 *
 * Minimal in structure, premium in finish (Option B). One clear focal hierarchy:
 *
 *   clock  →  command line  →  usage glance  →  launch row
 *
 * A gorgeous hero clock + calm greeting is the centre of gravity. Below it the
 * one thing you touch: a composer-grade "start something…" input that seeds a
 * fresh chat with whatever you type. Claude + codex usage sit quiet to the right
 * of the clock (the shared UsageGlance ProviderBlock — ONE source with the
 * sidebar). One launch row near the bottom — recent projects + quick actions +
 * pinned chips + a thin status footer — is the "jump back into work" affordance.
 *
 * Everything else the old control center carried (jarvis lane, notification
 * cards, the agent-ops grid, charts, the 8-metric vanity band, the duplicate
 * heatmap) is gone — that's pane material, opened on purpose, not home-at-rest
 * noise.
 *
 * Craft language is borrowed from the chat-pane composer (TerminalComposer):
 * the rounded glass surface (radius-xl), the focus glow + accent top-edge sheen,
 * the gradient accent send button, refined type hierarchy on the theme vars.
 *
 * The faint ambient drift + entrance fade respect Settings' reduce-motion
 * (`data-reduce-motion` on :root) via the shared App.css rules.
 *
 * TDZ note (this caused a black idle screen historically): every derived const
 * (`recent`, the count expressions, `weeks`) is declared at the top of the
 * component BEFORE any JSX or hook reads it — never forward-referenced. The data
 * loading lives one level up in IdleDashboard; this component is presentation +
 * the command-line local state only.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  Flame,
  FolderGit2,
  GitBranch,
  Layers,
  Search,
  Sparkles,
  Target,
  Terminal,
} from "lucide-react";

import type { AppDef } from "../App";
import type { IdleRate, MemoryFocus } from "../lib/dashboard";
import type { RepoPulse } from "../lib/fs";
import type { MoneyAgentSummary } from "../lib/moneyAgents";
import type { AiosNotification } from "../lib/notifications";
import type { ProjectInfo } from "../lib/run";
import type { SidebarItem, SidebarState } from "../lib/sidebar";
import type { UsageExtras } from "../lib/stats";
import { ProviderBlock, useUsageRates } from "./dashboard/UsageGlance";
import { Pm2Monitor } from "./dashboard/Pm2Monitor";
import type { Pm2Process } from "../lib/pm2";

export function IdleControlCenter({
  projects,
  sidebar,
  extras,
  rate,
  focus,
  pulse,
  moneyAgents,
  pm2Processes,
  notifications,
  onSpawn,
  onOpenProject,
  onOpenSidebarItem,
  onRevealSidebar,
  onOpenMoneyAgents,
  onOpenPalette,
  onTalkToJarvis,
}: {
  projects: ProjectInfo[];
  sidebar: SidebarState;
  extras: UsageExtras | null;
  /** claude's 5h/7d/ctx — kept for the ctx glance; bars come from useUsageRates. */
  rate: IdleRate | null;
  focus: MemoryFocus | null;
  pulse: RepoPulse[];
  moneyAgents: MoneyAgentSummary[];
  pm2Processes: Pm2Process[];
  notifications: AiosNotification[];
  onSpawn: (kind: AppDef["kind"], label: string) => void;
  onOpenProject: (p: ProjectInfo) => void;
  onOpenSidebarItem: (item: SidebarItem) => void;
  onRevealSidebar: () => void;
  onOpenMoneyAgents: () => void;
  onOpenPalette: () => void;
  /** seed a fresh chat pane with the command-line text (spawns a chat). */
  onTalkToJarvis: (seed: string) => void;
}) {
  // ── derived state — declared BEFORE any JSX/hook that reads them (TDZ-safe) ──
  const recent = [...projects].sort((a, b) => b.mtime - a.mtime).slice(0, 5);
  const activeAgents = moneyAgents.filter(
    (agent) => agent.health === "running" || agent.health === "scheduled",
  ).length;
  const unread = notifications.filter((item) => !item.read).length;
  const dirtyProjects = pulse.filter(
    (repo) => repo.dirty || repo.ahead || repo.behind,
  ).length;
  const pinned = sidebar.items
    .filter((item) => item.group === "pinned" && !item.hidden)
    .slice(0, 6);
  const streak = extras?.currentStreak ?? 0;
  const ctxPct = rate?.contextPct ?? null;

  const { claude, codex, hasClaude, hasCodex } = useUsageRates();
  const hasUsage = hasClaude || hasCodex;

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* faint ambient drift — identity, not decoration; reduce-motion kills it */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-70">
        <div
          className="aios-drift-a absolute h-[48vh] w-[48vh] rounded-full blur-[110px]"
          style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--color-accent) 14%, transparent), transparent 70%)" }}
        />
        <div
          className="aios-drift-b absolute h-[40vh] w-[40vh] rounded-full blur-[110px]"
          style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--color-highlight) 11%, transparent), transparent 70%)" }}
        />
      </div>

      {/* ── centred hero stack: clock → command → usage. Generous breathing room.
          Caps at a comfortable reading width and floats slightly above centre. */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8">
        <div className="flex w-full max-w-[760px] flex-col items-center gap-7">
          {/* greeting + clock — the focal point */}
          <div className="flex flex-col items-center gap-3 text-center">
            <Greeting />
            <HeroClock />
          </div>

          {/* command line — the one obvious primary action */}
          <CommandLine onSeedChat={onTalkToJarvis} onOpenPalette={onOpenPalette} />

          {/* usage glance — claude + codex, quiet, side-by-side */}
          {hasUsage && (
            <div className="aios-fade-in flex w-full flex-wrap items-start justify-center gap-x-12 gap-y-4" style={{ animationDelay: "120ms" }}>
              {hasClaude && (
                <div className="min-w-[200px] flex-1 sm:max-w-[280px]">
                  <ProviderBlock name="claude" fiveHour={claude!.fiveHour} sevenDay={claude!.sevenDay} />
                </div>
              )}
              {hasCodex && (
                <div className="min-w-[200px] flex-1 sm:max-w-[280px]">
                  <ProviderBlock name="codex" fiveHour={codex!.fiveHour} sevenDay={codex!.sevenDay} />
                </div>
              )}
            </div>
          )}

          {/* one quiet ambient line — streak · focus · ctx */}
          <AmbientLine streak={streak} bestStreak={extras?.longestStreak ?? 0} focus={focus} ctxPct={ctxPct} />
        </div>
      </div>

      {/* ── launch row — pinned to the bottom: recent · quick · pinned + status ── */}
      <div className="relative z-10 shrink-0 border-t border-[var(--color-border)] px-6 pb-4 pt-4 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-3">
          <div className="grid gap-x-10 gap-y-4 lg:grid-cols-2">
            <RecentProjects projects={recent} onOpen={onOpenProject} />
            <QuickActions
              onSpawn={onSpawn}
              onOpenPalette={onOpenPalette}
              onRevealSidebar={onRevealSidebar}
            />
          </div>

          {/* pm2 fleet — only on the box (empty + invisible on the laptop) */}
          {pm2Processes.length > 0 && <Pm2Monitor processes={pm2Processes} />}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--color-border)] pt-3">
            {pinned.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                {pinned.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onOpenSidebarItem(item)}
                    className="rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]/40 px-2.5 py-1 text-[11px] text-[var(--color-text-2)] transition-colors hover:border-[color-mix(in_srgb,var(--color-accent)_45%,var(--color-border))] hover:text-[var(--color-text)]"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
            <StatusFooter
              activeAgents={activeAgents}
              totalAgents={moneyAgents.length}
              unread={unread}
              dirtyProjects={dirtyProjects}
              onOpenMoneyAgents={onOpenMoneyAgents}
              onRevealSidebar={onRevealSidebar}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── greeting + clock ─────────────────────────────────────────────────────────

/** Whole-window visibility. The home screen is full-viewport when shown, so the
 *  clock/greeting ticks only matter while the app window is actually visible —
 *  no point re-rendering 1×/sec into a minimized/occluded window. Returns true
 *  on the server / when the Page Visibility API is unavailable. */
function useWindowVisible(): boolean {
  const [vis, setVis] = useState(
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setVis(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return vis;
}

/** Time-of-day greeting + lowercased date. 30s tick — cheap, isolated, paused
 *  while the window is hidden. */
function Greeting() {
  const [now, setNow] = useState(() => new Date());
  const visible = useWindowVisible();
  useEffect(() => {
    if (!visible) return;
    setNow(new Date()); // snap on re-show
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, [visible]);
  const h = now.getHours();
  const part =
    h < 5 ? "still up" : h < 12 ? "good morning" : h < 18 ? "good afternoon" : "good evening";
  return (
    <div className="aios-fade-in flex flex-col items-center gap-1">
      <span className="text-[15px] font-medium tracking-tight text-[var(--color-text-2)]">
        {part}, <span className="aios-greet-name">firaz</span>
      </span>
      <span className="font-mono text-[11px] tracking-[0.08em] text-[var(--color-muted)]">
        {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }).toLowerCase()}
      </span>
    </div>
  );
}

/** The hero clock. Isolated 1Hz re-render (its own state) so the tick never
 *  reconciles the rest of the home. Hairline-weight numerals, CSS colon blink,
 *  seconds demoted to a quiet trailing tick. clamp() scales it across windows. */
function HeroClock() {
  const [now, setNow] = useState(() => new Date());
  const visible = useWindowVisible();
  useEffect(() => {
    // Pause the 1Hz tick while the window is hidden; snap to current time the
    // instant it's shown again so the clock is never stale on return.
    if (!visible) return;
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [visible]);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return (
    <div className="aios-fade-in flex items-baseline justify-center gap-2 font-mono tabular-nums text-[var(--color-text)]" style={{ animationDelay: "40ms" }}>
      <span className="text-[clamp(72px,13vw,140px)] font-light leading-none tracking-[-0.03em]">{hh}</span>
      <span className="aios-colon text-[clamp(72px,13vw,140px)] font-light leading-none tracking-[-0.03em] text-[var(--color-accent)]">:</span>
      <span className="text-[clamp(72px,13vw,140px)] font-light leading-none tracking-[-0.03em]">{mm}</span>
      <span className="self-end pb-[0.9vw] font-mono text-[clamp(16px,2vw,22px)] font-light leading-none tracking-tight text-[var(--color-faint)]">{ss}</span>
    </div>
  );
}

// ── command line — composer-grade seed-a-chat input ───────────────────────────

/**
 * The single primary action. Looks + feels like the chat-pane composer surface:
 * rounded glass (radius-xl), focus glow + accent top-edge sheen, accent caret,
 * gradient send button that lifts on hover. Submitting seeds a fresh chat pane
 * with the text; an empty submit (or the ⌘K kbd) opens the full command palette
 * so the input is never a dead end.
 */
function CommandLine({
  onSeedChat,
  onOpenPalette,
}: {
  onSeedChat: (seed: string) => void;
  onOpenPalette: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text) {
      onOpenPalette();
      return;
    }
    onSeedChat(text);
    setValue("");
  }, [value, onSeedChat, onOpenPalette]);

  const hasContent = value.trim().length > 0;

  return (
    <form
      className="aios-fade-in w-full"
      style={{ animationDelay: "80ms" }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="group/cmd relative flex items-center gap-3 overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-gradient-to-b from-[var(--color-panel-2)]/80 to-[var(--color-panel-2)]/55 px-4 py-3 shadow-2xl shadow-black/40 backdrop-blur transition-all duration-300 focus-within:border-[var(--color-accent)]/60 focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_50%,transparent),0_18px_50px_-12px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]">
        {/* accent sheen sweeping the top edge when focused — mirrors the composer */}
        <span className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-gradient-to-r from-transparent via-[var(--color-accent)] to-transparent opacity-0 transition-opacity duration-500 group-focus-within/cmd:opacity-80" />
        <Search
          size={17}
          className="shrink-0 text-[var(--color-muted)] transition-colors group-focus-within/cmd:text-[var(--color-accent)]"
        />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          placeholder="start something… ask, launch, or resume"
          className="min-w-0 flex-1 bg-transparent font-sans text-[15px] leading-relaxed text-[var(--color-text)] caret-[var(--color-accent)] placeholder:text-[var(--color-faint)] focus:outline-none"
        />
        {hasContent ? (
          <button
            type="submit"
            title="start a chat with this"
            className="group/send grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[var(--color-accent)] to-[color-mix(in_srgb,var(--color-accent)_62%,#000)] text-[var(--color-accent-fg)] shadow-[0_2px_12px_-2px_color-mix(in_srgb,var(--color-accent)_70%,transparent)] transition-all duration-200 hover:scale-110 hover:shadow-[0_4px_22px_-2px_var(--color-accent)] active:scale-90"
          >
            <ArrowUp size={16} className="transition-transform duration-200 group-hover/send:-translate-y-0.5" />
          </button>
        ) : (
          <kbd className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
            ⌘K
          </kbd>
        )}
      </div>
    </form>
  );
}

// ── ambient line — streak · focus · ctx ───────────────────────────────────────

function AmbientLine({
  streak,
  bestStreak,
  focus,
  ctxPct,
}: {
  streak: number;
  bestStreak: number;
  focus: MemoryFocus | null;
  ctxPct: number | null;
}) {
  const parts: ReactNode[] = [];
  if (streak > 0) {
    parts.push(
      <span key="streak" className="inline-flex items-center gap-1.5">
        <Flame size={13} className="aios-flame text-[var(--color-accent)]" fill="currentColor" />
        <span className="font-mono text-[var(--color-text-2)]">{Math.round(streak)}</span>
        <span>day streak{bestStreak > streak ? ` · best ${bestStreak}` : ""}</span>
      </span>,
    );
  }
  if (focus?.title) {
    parts.push(
      <span key="focus" className="inline-flex min-w-0 items-baseline gap-1.5">
        <span className="text-[var(--color-muted)]">focus</span>
        <span className="truncate text-[var(--color-text-2)]" title={focus.title}>
          {focus.title}
        </span>
      </span>,
    );
  }
  if (ctxPct != null) {
    parts.push(
      <span key="ctx" className="font-mono">
        <span className="text-[var(--color-text-2)]">{Math.round(ctxPct)}%</span> ctx
      </span>,
    );
  }
  if (!parts.length) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-[11.5px] text-[var(--color-faint)]">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-5">
          {i > 0 && <span className="text-[var(--color-border-strong)]">·</span>}
          {part}
        </span>
      ))}
    </div>
  );
}

// ── relative-time helper ──────────────────────────────────────────────────────
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

// ── recent projects ────────────────────────────────────────────────────────────

function RecentProjects({
  projects,
  onOpen,
}: {
  projects: ProjectInfo[];
  onOpen: (p: ProjectInfo) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-muted)]">recent</span>
      {projects.length === 0 ? (
        <div className="px-1 py-1.5 text-[12px] text-[var(--color-faint)]">no projects under ~/Repo</div>
      ) : (
        projects.map((p) => (
          <button
            key={p.root}
            onClick={() => onOpen(p)}
            title={`open terminal in ${p.root}`}
            className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-panel-2)]"
          >
            <FolderGit2 size={13} className="shrink-0 text-[var(--color-muted)] group-hover:text-[var(--color-accent)]" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
              {p.name}
            </span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">{p.kind}</span>
            <span className="shrink-0 font-mono text-[10px] text-[var(--color-muted)]">{ago(p.mtime)}</span>
          </button>
        ))
      )}
    </div>
  );
}

// ── quick actions ──────────────────────────────────────────────────────────────

function QuickActions({
  onSpawn,
  onOpenPalette,
  onRevealSidebar,
}: {
  onSpawn: (kind: AppDef["kind"], label: string) => void;
  onOpenPalette: () => void;
  onRevealSidebar: () => void;
}) {
  const actions: Array<{ label: string; hint: string; icon: ReactNode; run: () => void }> = [
    { label: "new chat", hint: "ask aios", icon: <Sparkles size={13} />, run: () => onSpawn({ type: "chat" }, "chat") },
    { label: "terminal", hint: "shell pane", icon: <Terminal size={13} />, run: () => onSpawn({ type: "shell" }, "terminal") },
    { label: "palette", hint: "⌘K", icon: <Search size={13} />, run: onOpenPalette },
    { label: "rail", hint: "spaces", icon: <Layers size={13} />, run: onRevealSidebar },
  ];
  return (
    <div className="flex flex-col gap-1">
      <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-muted)]">quick</span>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={action.run}
          className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-panel-2)]"
        >
          <span className="text-[var(--color-muted)] group-hover:text-[var(--color-accent)]">{action.icon}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">{action.label}</span>
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">{action.hint}</span>
        </button>
      ))}
    </div>
  );
}

// ── status footer — quiet counts, each a launch point ─────────────────────────

function StatusFooter({
  activeAgents,
  totalAgents,
  unread,
  dirtyProjects,
  onOpenMoneyAgents,
  onRevealSidebar,
}: {
  activeAgents: number;
  totalAgents: number;
  unread: number;
  dirtyProjects: number;
  onOpenMoneyAgents: () => void;
  onRevealSidebar: () => void;
}) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10.5px] text-[var(--color-faint)]">
      {totalAgents > 0 && (
        <button
          type="button"
          onClick={onOpenMoneyAgents}
          className="inline-flex items-center gap-1.5 transition-colors hover:text-[var(--color-text-2)]"
          title="open agent monitor"
        >
          <Target size={11} />
          <span className="text-[var(--color-text-2)]">{activeAgents}</span>/{totalAgents} agents
        </button>
      )}
      {unread > 0 && (
        <button
          type="button"
          onClick={onRevealSidebar}
          className="inline-flex items-center gap-1.5 transition-colors hover:text-[var(--color-text-2)]"
          title="open the rail"
        >
          <span className="text-[var(--color-text-2)]">{unread}</span> notif
        </button>
      )}
      {dirtyProjects > 0 && (
        <span className="inline-flex items-center gap-1.5" title={`${dirtyProjects} repos with uncommitted/unpushed changes`}>
          <GitBranch size={11} />
          <span className="text-[var(--color-text-2)]">{dirtyProjects}</span> dirty
        </span>
      )}
    </div>
  );
}
