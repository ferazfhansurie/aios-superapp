/**
 * LoopPane — firaz's cockpit for every AIOS loop. A glance answers "is anything
 * about to change my code, deploy prod, or post in public?" then lets him stop /
 * start / inspect any loop. Chatpane is where he COMMANDS loops; this pane is
 * where he WATCHES them.
 *
 * Design language matches the idle dashboard + chatpane: glass cards
 * (white/10 over backdrop-blur), inner rows (white/[0.06]), uppercase-tracked
 * section headers, aios-fade-in stagger, status dots + chip badges, and
 * meaningful status color (danger/warning/info/success/muted) — restraint, not
 * more orange.
 *
 * Rows come from loop_list (~/.aios/state/loops/*.meta + launchd state + last
 * log line) and reuse the SAME LoopRow control the board used — status pill,
 * start/stop toggle, inline cadence edit — so control behavior stays in
 * lockstep. The cockpit adds: a blast-radius badge per loop (classified from the
 * loop audit), a clickable tier breakdown that doubles as a filter, danger-first
 * sort, and an honest note on what the master switch actually halts.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  FolderGit2,
  FolderPlus,
  MessageSquare,
  Plus,
  Power,
  Repeat,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  Zap,
  X,
} from "lucide-react";

import {
  addLoop,
  addLoopProject,
  deleteLoop,
  getLoopGlobalStatus,
  getLoopLog,
  listLoopChanges,
  listLoopProjects,
  listLoops,
  setLoopGlobalDisabled,
  type LoopChange,
  type LoopGlobalStatus,
  type LoopInfo,
  type LoopProject,
} from "../lib/agents";
import { formatRelativeRunAge } from "../lib/controlCenter";
import { talkToOrchestrator } from "../lib/paneBus";
import { LoopRow } from "./MissionBoard";

// ── design tokens (mirror IdleControlCenter) ─────────────────────────────────
const GLASS_CARD = "rounded-xl border border-white/10 bg-white/[0.04] p-3 backdrop-blur-md";
const INNER_ROW = "rounded-lg border border-white/[0.06] bg-white/[0.03]";

// ── blast-radius classification ───────────────────────────────────────────────
// Severity is what makes this a CONTROL centre, not a list: each loop is tagged
// by what it can DO to firaz's world, so danger is visible before he enables.
// Explicit danger-list (straight from the loop audit) — everything else defaults
// to `safe`. Color follows the locked design direction: strong color (red/amber)
// ONLY for the genuinely risky tiers; outward-but-reversible = info(blue);
// internal spend = muted; safe = subtle green.
type TierKey = "prod" | "code" | "public" | "spend" | "safe";
interface Tier {
  rank: number;
  key: TierKey;
  label: string;
  color: string;
  hint: string;
}
const TIERS: Record<TierKey, Tier> = {
  prod: {
    rank: 4,
    key: "prod",
    label: "prod / main",
    color: "var(--color-danger)",
    hint: "deploys to production or merges into your main branch — the loops that can change what runs",
  },
  code: {
    rank: 3,
    key: "code",
    label: "writes code",
    color: "var(--color-warning)",
    hint: "edits repos / creates loop branches — review & cherry-pick before you keep",
  },
  public: {
    rank: 2,
    key: "public",
    label: "posts public",
    color: "var(--color-info)",
    hint: "publishes to your public social channels (threads / linkedin / x)",
  },
  spend: {
    rank: 1,
    key: "spend",
    label: "spends tokens",
    color: "var(--color-muted)",
    hint: "spawns an LLM thread — burns tokens, no external footprint",
  },
  safe: {
    rank: 0,
    key: "safe",
    label: "safe",
    color: "var(--color-success)",
    hint: "background data / monitors / messages to you only — can't touch code, prod, or public",
  },
};
const TIER_ORDER: TierKey[] = ["prod", "code", "public", "spend", "safe"];

// ── functional categories ─────────────────────────────────────────────────────
// What a loop is FOR (vs the blast-radius badge = what it can DO). Grouping by
// these keeps the cockpit readable + maintainable as the loop count grows.
// Explicit keyword rules; default bucket = "system".
type CatKey = "content" | "dev" | "comms" | "community" | "system";
interface Category {
  key: CatKey;
  label: string;
  hint: string;
}
const CATEGORIES: Record<CatKey, Category> = {
  content: { key: "content", label: "content", hint: "writes + publishes posts / essays to your channels" },
  dev: { key: "dev", label: "dev", hint: "self-improving loops that touch code (branch-isolated unless flagged)" },
  comms: { key: "comms", label: "comms", hint: "messages to you + leads — proactive pings, digests, follow-ups" },
  community: { key: "community", label: "community", hint: "discord + traffic + activity broadcasting" },
  system: { key: "system", label: "system", hint: "infra + monitors + housekeeping daemons" },
};
const CAT_ORDER: CatKey[] = ["content", "dev", "comms", "community", "system"];

/** Bucket a loop into a functional category. Ordered keyword rules. */
function categorize(loop: LoopInfo): Category {
  const n = (loop.name || "").toLowerCase();
  const has = (s: string) => n.includes(s);

  if (
    has("seo-essay") ||
    /(threads|linkedin|x)-discord-funnel/.test(n) ||
    has("audience-engine") ||
    has("daily-threads")
  )
    return CATEGORIES.content;

  if (
    has("shell-improve") ||
    has("shell-selfheal") ||
    has("dogfood") ||
    has("maintainer") ||
    has("goal-dispatch") ||
    has("goal-tick") ||
    has("dream") ||
    n === "evolve" ||
    has("aios-evolve") ||
    has("skill-synthesizer")
  )
    return CATEGORIES.dev;

  if (
    has("discord-bridge") ||
    has("commit-watch") ||
    has("heartbeat") ||
    has("landing-traffic")
  )
    return CATEGORIES.community;

  // comms = the OPTIONAL pings you can prune. The WA/oracle TRANSPORT
  // (inbox-worker / bridge-bsg / personal-listener / exec-tick) is load-bearing —
  // it lives in `system` so it's never confused with a deletable ping.
  if (
    has("proactive") ||
    has("news-watcher") ||
    has("lead-followup") ||
    has("nightly-planner") ||
    has("checkin") ||
    has("daily-brief") ||
    has("wakeup") ||
    has("pnl") ||
    has("memento") ||
    has("reminder") ||
    has("mirror")
  )
    return CATEGORIES.comms;

  return CATEGORIES.system;
}

// ── per-loop descriptions (what it does when it runs) ─────────────────────────
// Curated from the loop audit so the detail panel reads in plain language. Keyed
// by slug; unknown loops fall back to the command they fire.
const LOOP_DESCRIPTIONS: Record<string, string> = {
  "seo-essay-loop": "writes a full SEO essay, builds the marketing site, and deploys it to prod (vercel). $1 token cap per run.",
  "threads-discord-funnel": "picks the best draft from the audience pack and publishes one Threads post (gated: cap 3/day, 4h spacing, cross-day dedup, engagement gate).",
  "linkedin-discord-funnel": "publishes one LinkedIn post from the variant set (same gating as threads).",
  "x-discord-funnel": "publishes one tweet (same gating). currently blocked on X api credits.",
  "audience-engine": "builds the daily content/approval pack + briefs and drops an approval note in the discord drafts channel. does NOT auto-post.",
  "daily-threads": "drops a synthesized inbox for the next threads draft (9pm).",
  "aios-dogfood": "AIOS-uses-AIOS flywheel: finds friction in the shell repo, fixes it, and (currently) can merge low-risk to main every 3 min.",
  "aios-maintainer": "sweeps the aios repo family hourly and can autonomously merge low-risk changes to your repos.",
  "wrms-maintainer": "sweeps WRMS repos (Mon-Fri 9-19h), preps fixes on local branches only — never pushes.",
  "shell-improve": "picks one backlog item, builds it in an isolated /tmp worktree, verifies, commits to a loop/* branch. never installs.",
  "shell-selfheal": "scans the app's diag log for new errors and spawns a fix thread in a fresh worktree (branch only).",
  "goal-dispatch": "drives active goals — spawns a worker pane per goal every 10 min.",
  "dream-cycle": "nightly multi-phase claude orchestration that edits live bridge scripts + skills (uncommitted).",
  evolve: "nightly: claude prunes/archives your memory files (reversible archive).",
  "skill-synthesizer": "every 15 min: drafts a SKILL.md from a clean transcript and pings you to keep/revise/drop.",
  "inbox-worker": "THE ORACLE — bundles your WhatsApp bursts and runs the claude session. core transport, do not delete.",
  "bridge-bsg": "the bisnesgpt WhatsApp listener that routes inbound to the oracle. core transport.",
  "personal-listener": "watches your personal WhatsApp number. core transport.",
  "exec-tick": "fires today's scheduled proactive plan items via WhatsApp (every 15 min).",
  "proactive-morning": "07:30 scan→decide→ping: surfaces what matters to start your day (opus thread).",
  "proactive-evening": "19:00 evening wrap nudge (only if there's something concrete).",
  "news-watcher": "06:00 AI-news digest (haiku) → WhatsApp.",
  "lead-followup": "every 10 min: tiered WhatsApp follow-ups to leads (haiku).",
  "nightly-planner": "00:15: designs tomorrow's 2-5 proactive interventions into the plan file.",
  "checkin-gym": "19:35 gym check-in WA question.",
  "checkin-meal": "21:25 meal check-in WA question.",
  "checkin-wake": "07:25 wake check-in WA question.",
  "daily-brief": "06:00 yesterday brief (reddit/HN) → WhatsApp.",
  "wakeup-digest": "06:30 per-user digest push.",
  wakeup: "07:00 WA ping then self-destructs.",
  "pnl-prompt": "07:00 PnL photo prompt → WhatsApp.",
  "memento-mori": "Sunday 21:00 weekly pulse (week N/4680, streaks).",
  "reminder-shell": "08:30 one-off reminder check-in.",
  "reminder-chit-hotfix": "one-time Monday 09:00 reminder (self-destructs).",
  "discord-bridge": "the discord.js gateway bot — reuses the WA brain. discord transport.",
  "commit-watch": "every 2 min: polls 5 repos for new commits → posts to discord #commits.",
  heartbeat: "every 5 min: samples loop logs → posts a delta to discord #heartbeat.",
  "landing-traffic-monitor": "every 5 min: Neon landing traffic → discord digest (feeds the funnel engagement gate).",
  "memory-sleep": "03:30: extracts durable memories via a local model (no token cost).",
  "wa-health-monitor": "every 1 min: WA health check; escalates to an auto-fix thread on failure.",
  "web-grid": "localhost agent grid; spawns an oracle only on request.",
  "activity-ledger": "every 5 min: reads tool transcripts → activity-ledger.db + digest.",
  "claude-janitor": "every 15 min: reaps idle claude TUI processes (>2h).",
  janitor: "03:15 daily file/log cleanup.",
  loot: "03:00 daily capabilities scan → aios.db.",
  caffeinate: "keeps the mac awake (daemon).",
  tunnel: "cloudflared tunnel (daemon).",
  whisper: "whisper STT server :9000 (daemon).",
  kokoro: "kokoro TTS GPU service (daemon).",
  "headroom-proxy": "token-compression proxy :8899 (daemon).",
  "hud-pusher": "watches current.json → POSTs to the HUD (daemon).",
  "session-rotation-monitor": "every 30 min: flags bloated sessions (recommend only).",
  "wa-active-watch": "every 1 min: sweeps stale session ids.",
  "wrms-ai-assign-nightly-audit": "22:00 read-only WRMS AI-assign audit → discord.",
  "ai-assign-monitor": "every 1 min: polls Neon for AI-assign approvals → WA.",
  "ai-assign-tonight": "every 5 min: SZB-2 readiness one-pass snapshot.",
  "agency-outreach-scout": "every 2h: outreach scout.",
  "growth-agents": "growth agents runner (daemon).",
  "ajim-blast": "one TG DM burst for the Ajim project.",
  brief: "06:30: writes the engine-v2 section into the overnight brief.",
};

function loopDescription(loop: LoopInfo): string {
  return (
    LOOP_DESCRIPTIONS[loop.name] ||
    (loop.command ? `runs: ${loop.command}` : "no description recorded.")
  );
}

/** Humanize a cadence token for the detail panel. */
function humanCadence(c: string): string {
  const t = (c || "").trim();
  const m = t.match(/^(\d+)\s*([smhd])$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = { s: "sec", m: "min", h: "hour", d: "day" }[m[2].toLowerCase()] || m[2];
    return `every ${n} ${unit}${n > 1 ? "s" : ""}`;
  }
  if (/^daily/i.test(t)) return t.replace(/^daily/i, "daily at").trim();
  if (/^at load$/i.test(t) || t === "") return "on load (long-running daemon)";
  return t;
}

/** Loops the master kill-switch (~/.aios/state/loops/DISABLED) actually halts —
 *  only the managed `*-tick` primitives check it. Everything else runs from its
 *  own launchd plist regardless. Surfaced so "disabled" never lies. */
const HONORS_SWITCH = new Set([
  "aios-dogfood",
  "aios-maintainer",
  "wrms-maintainer",
  "goal-dispatch",
  "commit-watch",
  "heartbeat",
  "shell-improve",
  "shell-selfheal",
]);

/** Classify a loop by blast radius. Ordered rules — most specific first (e.g.
 *  wrms-maintainer is branch-only `code`, the other maintainers can merge to
 *  main = `prod`). Matches on the slug the Rust side hands us. */
function classifyLoop(loop: LoopInfo): Tier {
  const n = (loop.name || "").toLowerCase();
  const has = (s: string) => n.includes(s);

  // tier 4 — can deploy prod or merge to your main
  if (has("seo-essay") || has("dogfood")) return TIERS.prod;
  if (has("maintainer") && !has("wrms")) return TIERS.prod; // aios/self maintainer auto-merge

  // tier 3 — writes code (branches / live trees), review-then-keep
  if (
    has("wrms-maintainer") ||
    has("shell-improve") ||
    has("shell-selfheal") ||
    has("goal-dispatch") ||
    has("dream-cycle") ||
    n === "evolve" ||
    has("aios-evolve")
  )
    return TIERS.code;

  // tier 2 — posts to public socials
  if (/(threads|linkedin|x)-discord-funnel/.test(n)) return TIERS.public;

  // tier 1 — spawns an LLM thread (token spend, internal only)
  if (
    has("inbox-worker") ||
    has("bridge-bsg") ||
    has("proactive") ||
    has("news-watcher") ||
    has("lead-followup") ||
    has("skill-synthesizer") ||
    has("nightly-planner") ||
    has("memory-sleep") ||
    has("web-grid") ||
    has("personal-listener") ||
    has("wa-health") ||
    has("dream") // any other dream-* spawns claude
  )
    return TIERS.spend;

  // default — background data / monitors / pings to firaz
  return TIERS.safe;
}

// ── result classification (changes.jsonl `result` is free-form text) ──────────
function isReadyResult(result: string): boolean {
  return /\b(ready|done|ok|success|merged|pass|landed|green)\b/i.test(result);
}
function isProblemResult(result: string): boolean {
  return /\b(fail|failed|error|broke|broken|block|blocked|skip|skipped|hold)\b/i.test(result);
}
/** Border/text color for a result badge. */
function resultColor(result: string): string {
  if (isReadyResult(result)) return "var(--color-success)";
  if (/\b(fail|failed|error|broke|broken)\b/i.test(result)) return "var(--color-danger)";
  if (/\b(block|blocked|skip|skipped|hold)\b/i.test(result)) return "var(--color-warning)";
  return "var(--color-muted)";
}

export function LoopPane() {
  const [loops, setLoops] = useState<LoopInfo[]>([]);
  const [projects, setProjects] = useState<LoopProject[]>([]);
  const [addingProject, setAddingProject] = useState(false);
  const [changes, setChanges] = useState<LoopChange[]>([]);
  const [globalStatus, setGlobalStatus] = useState<LoopGlobalStatus>({
    disabled: false,
    disabledPath: "",
    disabledSince: null,
  });
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "running" | "needs-eye" | "stopped">("all");
  const [tierFilter, setTierFilter] = useState<TierKey | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const refresh = async () => {
    setLoading(true);
    const [nextLoops, nextStatus, nextChanges, nextProjects] = await Promise.all([
      listLoops(),
      getLoopGlobalStatus(),
      listLoopChanges(100),
      listLoopProjects(),
    ]);
    setLoops(nextLoops);
    setGlobalStatus(nextStatus);
    setChanges(nextChanges);
    setProjects(nextProjects);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const hasProblem = (loop: LoopInfo) =>
    changes.some((c) => c.loop === loop.name && isProblemResult(c.result));
  const running = loops.filter((l) => (l.status ?? "running") === "running").length;
  const idle = loops.filter((l) => {
    const s = l.status ?? "running";
    return s === "paused" || s === "stopped";
  }).length;
  const problemCount = loops.filter(hasProblem).length;
  const latestTs = changes.reduce((m, c) => Math.max(m, c.ts || 0), 0);
  const latest = latestTs ? formatRelativeRunAge(latestTs * 1000) : "—";

  // tier counts (for the blast-radius breakdown chips) + master-switch coverage.
  const tierCounts = useMemo(() => {
    const counts: Record<TierKey, number> = { prod: 0, code: 0, public: 0, spend: 0, safe: 0 };
    for (const l of loops) counts[classifyLoop(l).key] += 1;
    return counts;
  }, [loops]);
  const halts = loops.filter((l) => HONORS_SWITCH.has(l.name)).length;

  // every loop name claimed by a project — used so the functional categories
  // only show loops NOT already grouped under a project.
  const projectedNames = useMemo(() => {
    const s = new Set<string>();
    for (const p of projects) for (const n of p.loops || []) s.add(n);
    return s;
  }, [projects]);

  const q = query.trim().toLowerCase();
  const filteredLoops = useMemo(() => {
    const out = loops.filter((loop) => {
      const status = loop.status ?? "running";
      const matchesQuery =
        !q ||
        loop.name.toLowerCase().includes(q) ||
        (loop.label || "").toLowerCase().includes(q) ||
        (loop.command || "").toLowerCase().includes(q);
      const matchesView =
        view === "all" ||
        (view === "running" && status === "running") ||
        (view === "stopped" && (status === "stopped" || status === "paused")) ||
        (view === "needs-eye" && hasProblem(loop));
      const matchesTier = !tierFilter || classifyLoop(loop).key === tierFilter;
      return matchesQuery && matchesView && matchesTier;
    });
    // danger-first: problems, then blast-radius rank desc, then name.
    return out.sort((a, b) => {
      const pa = hasProblem(a) ? 1 : 0;
      const pb = hasProblem(b) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const ra = classifyLoop(a).rank;
      const rb = classifyLoop(b).rank;
      if (ra !== rb) return rb - ra;
      return a.name.localeCompare(b.name);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loops, q, view, tierFilter, changes]);

  const disabled = globalStatus.disabled;
  const since =
    typeof globalStatus.disabledSince === "number"
      ? new Date(globalStatus.disabledSince * 1000).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  const toggleGlobal = async () => {
    if (toggling) return;
    setToggling(true);
    try {
      const next = await setLoopGlobalDisabled(!disabled);
      setGlobalStatus(next);
      setLoops(await listLoops());
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-[var(--color-pane)] p-3">
      {/* header */}
      <div className="aios-fade-in flex items-center gap-2">
        <Repeat size={14} className="shrink-0 text-[var(--color-accent)]" />
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-[var(--color-text)]">loops</div>
          <div className="truncate text-[10px] text-[var(--color-faint)]">
            {loops.length} total · {running} running · {idle} idle · {problemCount} need eye · latest {latest}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!disabled}
          onClick={() => void toggleGlobal()}
          disabled={toggling}
          className={`ml-auto flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-medium transition-colors disabled:opacity-50 ${
            disabled
              ? "border-[var(--color-danger)]/50 bg-[var(--color-danger)]/10 text-[var(--color-danger)]"
              : "border-white/10 bg-white/[0.04] text-[var(--color-text)] hover:border-[var(--color-accent)]/60"
          }`}
          title={disabled ? "enable every managed loop again" : "disable every managed loop until flipped back"}
        >
          <Power size={12} />
          {disabled ? "disabled" : "enabled"}
        </button>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="flex items-center gap-1 rounded-full px-1.5 py-1 text-[10px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)]"
          title="create a new loop"
        >
          {creating ? <X size={12} /> : <Plus size={12} />}
        </button>
        <button
          type="button"
          onClick={() => setAddingProject((v) => !v)}
          className="flex items-center gap-1 rounded-full px-1.5 py-1 text-[10px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)]"
          title="register a new project"
        >
          {addingProject ? <X size={12} /> : <FolderPlus size={12} />}
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="flex items-center gap-1 rounded-full px-1.5 py-1 text-[10px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
          title="reload loop state"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* master-switch honesty: what it actually halts */}
      {disabled ? (
        <div className="aios-fade-in rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/10 px-2.5 py-2 text-[11px] text-[var(--color-danger)]">
          {halts} managed loop{halts === 1 ? "" : "s"} disabled{since ? ` since ${since}` : ""}.
          {loops.length - halts > 0 && (
            <span className="text-[var(--color-danger)]/80">
              {" "}
              {loops.length - halts} others run on their own schedule — stop those individually.
            </span>
          )}
        </div>
      ) : (
        loops.length - halts > 0 && (
          <div className="aios-fade-in flex items-center gap-1.5 px-0.5 text-[9.5px] text-[var(--color-faint)]">
            <Zap size={10} className="shrink-0 text-[var(--color-warning)]" />
            master switch halts {halts} managed loop{halts === 1 ? "" : "s"} · {loops.length - halts}{" "}
            run independently (stop per-loop)
          </div>
        )
      )}

      {creating && (
        <NewLoopForm
          onCreated={() => {
            setCreating(false);
            void refresh();
          }}
        />
      )}

      {addingProject && (
        <AddProjectForm
          onCreated={() => {
            setAddingProject(false);
            void refresh();
          }}
        />
      )}

      {/* blast-radius breakdown — the at-a-glance hero. each chip filters. */}
      <div className="aios-fade-in flex flex-wrap items-center gap-1.5" style={{ animationDelay: "40ms" }}>
        {TIER_ORDER.map((key) => {
          const tier = TIERS[key];
          const count = tierCounts[key];
          if (count === 0) return null;
          const active = tierFilter === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setTierFilter(active ? null : key)}
              title={tier.hint}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[9.5px] font-medium transition-colors ${
                active ? "bg-white/[0.08]" : "bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
              style={{
                borderColor: active ? tier.color : "color-mix(in srgb, var(--color-border) 80%, transparent)",
                color: tier.color,
              }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: tier.color }} />
              {tier.label}
              <span className="font-mono text-[var(--color-faint)]">{count}</span>
            </button>
          );
        })}
        {tierFilter && (
          <button
            type="button"
            onClick={() => setTierFilter(null)}
            className="rounded-full px-1.5 py-1 text-[9.5px] text-[var(--color-faint)] hover:text-[var(--color-text)]"
          >
            clear
          </button>
        )}
      </div>

      {/* status filter + search */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex rounded-full border border-white/10 bg-white/[0.02] p-0.5">
          {[
            ["all", "all"],
            ["running", "running"],
            ["needs-eye", "needs eye"],
            ["stopped", "idle"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id as typeof view)}
              className={`rounded-full px-2 py-1 text-[10px] font-medium transition-colors ${
                view === id
                  ? "bg-white/[0.08] text-[var(--color-text)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex min-w-[160px] flex-1 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-2.5 py-1 text-[10px] text-[var(--color-faint)] focus-within:border-[var(--color-accent)]/60">
          <Search size={11} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter loops"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
          />
        </label>
      </div>

      {/* loop list (glass card) */}
      <section className={`aios-fade-in ${GLASS_CARD}`} style={{ animationDelay: "80ms" }}>
        <div className="mb-2 flex items-center gap-2 px-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
            loops
          </span>
          <span className="text-[9px] text-[var(--color-faint)]">{filteredLoops.length} shown</span>
        </div>
        {loops.length === 0 ? (
          <div className="px-1 py-1 text-[11px] text-[var(--color-faint)]">
            no loops yet. create one with the + button above.
          </div>
        ) : filteredLoops.length === 0 ? (
          <div className="px-1 py-1 text-[11px] text-[var(--color-faint)]">
            no loops match this filter.
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {/* PROJECT groups first — each project owns the loops in its `loops` list */}
            {projects.map((proj) => {
              const names = new Set(proj.loops || []);
              const rows = filteredLoops.filter((l) => names.has(l.name));
              if (rows.length === 0) return null;
              const gid = `proj:${proj.key}`;
              const isCollapsed = collapsed[gid];
              const prep = proj.posture === "prep-only";
              return (
                <div key={gid} className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => setCollapsed((c) => ({ ...c, [gid]: !c[gid] }))}
                    className="flex items-center gap-1.5 px-0.5 text-left"
                    title={proj.note || proj.owner || proj.key}
                  >
                    {isCollapsed ? (
                      <ChevronRight size={11} className="text-[var(--color-faint)]" />
                    ) : (
                      <ChevronDown size={11} className="text-[var(--color-faint)]" />
                    )}
                    <FolderGit2 size={10} className="text-[var(--color-accent)]" />
                    <span className="text-[9.5px] font-semibold uppercase tracking-wider text-[var(--color-text-2)]">
                      {proj.label || proj.key}
                    </span>
                    <span
                      className="rounded-full border px-1.5 py-px text-[8px] font-medium uppercase tracking-wide"
                      style={{
                        color: prep ? "var(--color-danger)" : "var(--color-info)",
                        borderColor: `color-mix(in srgb, ${prep ? "var(--color-danger)" : "var(--color-info)"} 50%, transparent)`,
                      }}
                      title={prep ? "employer prod — local prep only, never touches prod" : "your product — loops build on branches you cherry-pick"}
                    >
                      {prep ? "prep-only · never prod" : "branch-only"}
                    </span>
                    <span className="font-mono text-[9px] text-[var(--color-faint)]">{rows.length}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="flex flex-col gap-1.5">
                      {rows.map((loop) => (
                        <ExpandableLoopRow
                          key={`${loop.source || "managed"}:${loop.name}`}
                          loop={loop}
                          tier={classifyLoop(loop)}
                          honorsSwitch={HONORS_SWITCH.has(loop.name)}
                          changes={changes}
                          onChanged={() => void refresh()}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* then functional categories for loops NOT claimed by any project */}
            {CAT_ORDER.map((catKey) => {
              const cat = CATEGORIES[catKey];
              const rows = filteredLoops.filter(
                (l) => !projectedNames.has(l.name) && categorize(l).key === catKey,
              );
              if (rows.length === 0) return null;
              const isCollapsed = collapsed[catKey];
              return (
                <div key={catKey} className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => setCollapsed((c) => ({ ...c, [catKey]: !c[catKey] }))}
                    className="flex items-center gap-1.5 px-0.5 text-left"
                    title={cat.hint}
                  >
                    {isCollapsed ? (
                      <ChevronRight size={11} className="text-[var(--color-faint)]" />
                    ) : (
                      <ChevronDown size={11} className="text-[var(--color-faint)]" />
                    )}
                    <span className="text-[9.5px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                      {cat.label}
                    </span>
                    <span className="font-mono text-[9px] text-[var(--color-faint)]">{rows.length}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="flex flex-col gap-1.5">
                      {rows.map((loop) => (
                        <ExpandableLoopRow
                          key={`${loop.source || "managed"}:${loop.name}`}
                          loop={loop}
                          tier={classifyLoop(loop)}
                          honorsSwitch={HONORS_SWITCH.has(loop.name)}
                          changes={changes}
                          onChanged={() => void refresh()}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* recent activity (glass card) */}
      <section className={`aios-fade-in ${GLASS_CARD}`} style={{ animationDelay: "120ms" }}>
        <div className="mb-2 flex items-center gap-2 px-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
            recent activity
          </span>
          <span className="text-[9px] text-[var(--color-faint)]">
            {changes.length} change{changes.length === 1 ? "" : "s"}
          </span>
        </div>
        {changes.length === 0 ? (
          <div className="px-1 py-1 text-[11px] text-[var(--color-faint)]">
            no loop activity recorded yet
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {changes.slice(0, 30).map((c, i) => (
              <LedgerRow key={`${c.ts}-${c.loop}-${i}`} change={c} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** Uppercase micro-label for the detail panel sections. */
function DetailLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-0.5 text-[9px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
      {children}
    </div>
  );
}

/** A small blast-radius chip. */
function BlastBadge({ tier }: { tier: Tier }) {
  return (
    <span
      className="shrink-0 rounded-full border px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-wide"
      style={{ color: tier.color, borderColor: `color-mix(in srgb, ${tier.color} 55%, transparent)` }}
      title={tier.hint}
    >
      {tier.label}
    </span>
  );
}

/** One row of the activity ledger — result badge, loop, item, summary, branch,
 *  relative time. Pure display; keep/skip/diff actions land in phase 2. */
function LedgerRow({ change }: { change: LoopChange }) {
  const color = resultColor(change.result);
  return (
    <div className={`${INNER_ROW} px-2.5 py-1.5`}>
      <div className="flex items-center gap-2">
        <span
          className="shrink-0 rounded-full border px-1.5 py-0.5 text-[8.5px] font-medium uppercase tracking-wide"
          style={{ color, borderColor: color }}
        >
          {change.result || "?"}
        </span>
        <span className="truncate text-[10px] font-medium text-[var(--color-muted)]">
          {change.loop}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[9px] text-[var(--color-faint)]">
          {change.ts ? formatRelativeRunAge(change.ts * 1000) : ""}
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--color-text-2)]">
        {change.item}
      </div>
      {change.summary && (
        <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-[var(--color-faint)]">
          {change.summary}
        </div>
      )}
      {change.branch && (
        <span className="mt-1 inline-block rounded-full bg-white/[0.04] px-1.5 py-0.5 font-mono text-[8.5px] text-[var(--color-faint)]">
          {change.branch}
        </span>
      )}
    </div>
  );
}

/** A LoopRow (reused, so control behavior stays in lockstep) prefixed with an
 *  expand toggle + blast-radius badge, and an expandable detail (recent changes
 *  + tail of the run log, fetched lazily on first open). */
function ExpandableLoopRow({
  loop,
  tier,
  honorsSwitch,
  changes,
  onChanged,
}: {
  loop: LoopInfo;
  tier: Tier;
  honorsSwitch: boolean;
  changes: LoopChange[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const mine = changes.filter((c) => c.loop === loop.name).slice(0, 8);
  const cat = categorize(loop);

  const toggleOpen = async () => {
    const next = !open;
    setOpen(next);
    if (next && log === null) {
      setLoadingLog(true);
      try {
        setLog(await getLoopLog(loop.name, 20));
      } finally {
        setLoadingLog(false);
      }
    }
  };

  const doDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setDelErr(null);
    try {
      await deleteLoop(loop.name);
      onChanged();
    } catch (e) {
      setDelErr(String((e as Error)?.message ?? e));
      setDeleting(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => void toggleOpen()}
          className="grid h-6 w-5 shrink-0 place-items-center text-[var(--color-faint)] transition-colors hover:text-[var(--color-text)]"
          title={open ? "hide detail" : "show recent work + log"}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {/* left rail: blast-radius accent + badge */}
        <span
          className="h-7 w-0.5 shrink-0 rounded-full"
          style={{ background: `color-mix(in srgb, ${tier.color} 70%, transparent)` }}
          title={tier.hint}
        />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="min-w-0 flex-1">
            <LoopRow loop={loop} onChanged={onChanged} />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!honorsSwitch && tier.rank >= 2 && (
              <span title="the master switch does NOT stop this loop — it runs on its own schedule">
                <Zap size={10} className="text-[var(--color-warning)]" />
              </span>
            )}
            <BlastBadge tier={tier} />
          </div>
        </div>
      </div>
      {open && (
        <div className="ml-5 mt-1.5 flex flex-col gap-2.5 border-l border-white/10 pl-2.5">
          {/* what it does */}
          <div>
            <DetailLabel>what it does</DetailLabel>
            <div className="text-[11px] leading-snug text-[var(--color-text-2)]">
              {loopDescription(loop)}
            </div>
          </div>

          {/* schedule + classification grid */}
          <div className="grid grid-cols-2 gap-2">
            <div className={`${INNER_ROW} px-2.5 py-1.5`}>
              <DetailLabel>
                <Clock size={9} className="mr-1 inline -translate-y-px" />
                schedule
              </DetailLabel>
              <div className="text-[11px] text-[var(--color-text-2)]">{humanCadence(loop.cadence)}</div>
              {loop.cadence && (
                <div className="font-mono text-[9px] text-[var(--color-faint)]">{loop.cadence}</div>
              )}
            </div>
            <div className={`${INNER_ROW} px-2.5 py-1.5`}>
              <DetailLabel>classification</DetailLabel>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-[var(--color-text-2)]">{cat.label}</span>
                <span className="text-[var(--color-faint)]">·</span>
                <span className="text-[10px]" style={{ color: tier.color }}>
                  {tier.label}
                </span>
              </div>
              <div className="text-[9px] text-[var(--color-faint)]">
                {honorsSwitch ? "master switch stops it" : "ignores master switch"}
              </div>
            </div>
          </div>

          {/* command */}
          {loop.command && (
            <div>
              <DetailLabel>
                <Terminal size={9} className="mr-1 inline -translate-y-px" />
                command
              </DetailLabel>
              <div className={`${INNER_ROW} overflow-x-auto px-2 py-1 font-mono text-[9px] text-[var(--color-faint)]`}>
                {loop.command}
              </div>
            </div>
          )}

          {/* recent changes */}
          {mine.length > 0 && (
            <div className="flex flex-col gap-1">
              <DetailLabel>recent work</DetailLabel>
              {mine.map((c, i) => (
                <LedgerRow key={`${c.ts}-${i}`} change={c} />
              ))}
            </div>
          )}

          {/* log tail */}
          <div>
            <DetailLabel>recent log</DetailLabel>
            {loadingLog ? (
              <div className="text-[10px] text-[var(--color-faint)]">loading…</div>
            ) : log && log.length > 0 ? (
              <pre className={`max-h-40 overflow-y-auto whitespace-pre-wrap ${INNER_ROW} px-2 py-1.5 font-mono text-[9px] leading-relaxed text-[var(--color-faint)]`}>
                {log.join("\n")}
              </pre>
            ) : (
              <div className="text-[10px] text-[var(--color-faint)]">no log output.</div>
            )}
          </div>

          {/* danger zone — delete */}
          <div className="flex items-center gap-2 border-t border-white/[0.06] pt-2">
            {!confirmDel ? (
              <button
                type="button"
                onClick={() => setConfirmDel(true)}
                className="flex items-center gap-1.5 rounded-full border border-[var(--color-danger)]/30 px-2.5 py-1 text-[10px] text-[var(--color-danger)]/80 transition-colors hover:border-[var(--color-danger)]/60 hover:text-[var(--color-danger)]"
              >
                <Trash2 size={11} />
                delete loop
              </button>
            ) : (
              <div className="flex w-full flex-col gap-1.5">
                <span className="text-[10px] text-[var(--color-text-2)]">
                  delete <span className="font-mono text-[var(--color-text)]">{loop.name}</span>?
                  {tier.rank >= 3 && (
                    <span className="text-[var(--color-danger)]"> this loop can touch prod/code — gone for good.</span>
                  )}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void doDelete()}
                    disabled={deleting}
                    className="rounded-full bg-[var(--color-danger)] px-2.5 py-1 text-[10px] font-medium text-white transition-transform hover:scale-[1.03] disabled:opacity-50"
                  >
                    {deleting ? "deleting…" : "yes, delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmDel(false);
                      setDelErr(null);
                    }}
                    className="rounded-full px-2.5 py-1 text-[10px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  >
                    cancel
                  </button>
                </div>
                {delErr && <div className="text-[9.5px] text-[var(--color-danger)]">⚠ {delErr}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** "+ new loop" creator — two ways in:
 *  • agent (the easy default): name + cadence + prompt + optional cwd → a
 *    scheduled `aios-agent <prompt> <cwd>` loop (most loops are exactly this).
 *  • describe: a natural-language box → opens the orchestrator with a starter so
 *    it mints the loop via aios-loop create (firaz reviews + sends; never auto). */
function NewLoopForm({ onCreated }: { onCreated: () => void }) {
  const [mode, setMode] = useState<"agent" | "describe">("agent");
  const [name, setName] = useState("");
  const [cadence, setCadence] = useState("30m");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const createAgent = async () => {
    const n = name.trim();
    const c = cadence.trim();
    const p = prompt.trim();
    if (!n || !c || !p || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const command = ["aios-agent", p, ...(cwd.trim() ? [cwd.trim()] : [])];
      await addLoop(n, c, command);
      onCreated();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const describeToOrchestrator = () => {
    const d = desc.trim();
    if (!d) return;
    // Hand the orchestrator a ready-to-send starter; firaz reviews + sends it.
    talkToOrchestrator(
      `mint a new AIOS loop for this and confirm it back to me: "${d}". ` +
        `use \`aios-loop create <name> <cadence> ...\` (most loops wrap an aios-agent spawn — ` +
        `\`aios-loop create <name> <cadence> aios-agent "<prompt>" <cwd>\`). pick a sensible name + cadence.`,
    );
    onCreated();
  };

  const tabCls = (active: boolean) =>
    `rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
      active
        ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
        : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
    }`;
  const inputCls =
    "w-full rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60";

  return (
    <div className={`aios-fade-in ${GLASS_CARD}`}>
      <div className="mb-2 flex items-center gap-1">
        <button type="button" className={tabCls(mode === "agent")} onClick={() => setMode("agent")}>
          agent loop
        </button>
        <button type="button" className={tabCls(mode === "describe")} onClick={() => setMode("describe")}>
          describe it
        </button>
      </div>

      {mode === "agent" ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void createAgent();
          }}
        >
          <div className="flex gap-1.5">
            <input className={inputCls} placeholder="name (e.g. pr-watch)" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="w-24 shrink-0 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60" placeholder="30m" value={cadence} onChange={(e) => setCadence(e.target.value)} />
          </div>
          <input className={inputCls} placeholder="prompt — what the loop should do each fire" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <input className={inputCls} placeholder="cwd (optional, e.g. /path/to/project)" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          {err && <div className="text-[10px] text-[var(--color-danger)]">⚠ {err}</div>}
          <button
            type="submit"
            disabled={!name.trim() || !cadence.trim() || !prompt.trim() || busy}
            className="self-end rounded-full bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent-fg)] transition-transform hover:scale-[1.03] disabled:opacity-40"
          >
            create loop
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-1.5">
          <textarea
            className={`${inputCls} h-16 resize-none`}
            placeholder="describe the loop — e.g. 'every 30m check open PRs on the wrms repos and summarize'"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <button
            type="button"
            onClick={describeToOrchestrator}
            disabled={!desc.trim()}
            className="flex items-center gap-1.5 self-end rounded-full bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent-fg)] transition-transform hover:scale-[1.03] disabled:opacity-40"
          >
            <MessageSquare size={12} />
            hand to AIOS
          </button>
        </div>
      )}
    </div>
  );
}

/** "register a project" — appends to the projects registry so a new project gets
 *  its own grouping (and, once a maintainer's `loops` includes it, coverage).
 *  posture gates what loops may do: branch-only (your product) vs prep-only
 *  (employer prod — local prep, never touches prod). */
function AddProjectForm({ onCreated }: { onCreated: () => void }) {
  const [key, setKey] = useState("");
  const [posture, setPosture] = useState<"branch-only" | "prep-only">("branch-only");
  const [repos, setRepos] = useState("");
  const [loops, setLoops] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    const k = key.trim();
    if (!k || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await addLoopProject({
        key: k,
        label: k,
        posture,
        repos: repos.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
        loops: loops.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
      });
      onCreated();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60";

  return (
    <div className={`aios-fade-in ${GLASS_CARD}`}>
      <div className="mb-2 flex items-center gap-1.5">
        <FolderPlus size={12} className="text-[var(--color-accent)]" />
        <span className="text-[11px] font-medium text-[var(--color-text)]">register a project</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex gap-1.5">
          <input className={inputCls} placeholder="key (e.g. crm)" value={key} onChange={(e) => setKey(e.target.value)} />
          <div className="flex shrink-0 rounded-lg border border-white/10 bg-white/[0.02] p-0.5">
            {(["branch-only", "prep-only"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPosture(p)}
                className={`rounded-md px-2 py-1 text-[9.5px] font-medium transition-colors ${
                  posture === p ? "bg-white/[0.08] text-[var(--color-text)]" : "text-[var(--color-muted)]"
                }`}
                title={p === "prep-only" ? "employer prod — local prep only, never touches prod" : "your product — branch-only, you cherry-pick"}
              >
                {p === "prep-only" ? "prep-only" : "branch-only"}
              </button>
            ))}
          </div>
        </div>
        <input className={inputCls} placeholder="repos (comma-separated abs paths)" value={repos} onChange={(e) => setRepos(e.target.value)} />
        <input className={inputCls} placeholder="loops (comma-separated names, e.g. wrms-maintainer)" value={loops} onChange={(e) => setLoops(e.target.value)} />
        {err && <div className="text-[10px] text-[var(--color-danger)]">⚠ {err}</div>}
        <button
          type="button"
          onClick={() => void create()}
          disabled={!key.trim() || busy}
          className="self-end rounded-full bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent-fg)] transition-transform hover:scale-[1.03] disabled:opacity-40"
        >
          {busy ? "adding…" : "add project"}
        </button>
      </div>
    </div>
  );
}
