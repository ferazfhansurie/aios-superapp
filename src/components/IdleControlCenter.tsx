/** Instant home screen for the core shell. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  PanelLeft,
  Search,
} from "lucide-react";

import type { AppDef } from "../App";
import type { SidebarItem, SidebarState } from "../lib/sidebar";
import { AppSvgIcon, iconKeyForPane, iconKeyForSidebarItem, type AppIconKey } from "./AppSvgIcon";
import {
  loadPaneHistory,
  hydratePaneHistoryStore,
  subscribePaneHistory,
  type PaneHistoryItem,
} from "../lib/paneHistory";
import {
  agentPaneKey,
  isLoopThread,
  listDiskAgents,
  listLoopChanges,
  listTickets,
  type AgentConfig,
  type LoopChange,
  type TicketInfo,
} from "../lib/agents";
import { Repeat } from "lucide-react";
import { listBridges, type Channel } from "../lib/bridges";
import { formatRelativeRunAge } from "../lib/controlCenter";
import { useSharedTicker, useSharedInterval } from "../lib/ticker";
import { loadSettings, subscribe as subscribeSettings } from "../lib/settings";

const CORE_LAUNCHERS: Array<{
  label: string;
  hint: string;
  icon: AppIconKey;
  kind: AppDef["kind"];
}> = [
  { label: "new chat", hint: "chat", icon: "chat", kind: { type: "chat" } },
  { label: "new terminal", hint: "shell", icon: "terminal", kind: { type: "shell" } },
  { label: "new browser", hint: "web", icon: "browser", kind: { type: "browser" } },
  { label: "new files", hint: "files", icon: "files", kind: { type: "files" } },
  { label: "history", hint: "open", icon: "history", kind: { type: "history" } },
];

export function IdleControlCenter({
  sidebar,
  onSpawn,
  onOpenSidebarItem,
  onRevealSidebar,
  onOpenPalette,
  onTalkToJarvis,
}: {
  sidebar: SidebarState;
  onSpawn: (kind: AppDef["kind"], label: string, explicitKey?: string) => void;
  onOpenSidebarItem: (item: SidebarItem) => void;
  onRevealSidebar: () => void;
  onOpenPalette: () => void;
  onTalkToJarvis: (seed: string) => void;
}) {
  const pinned = sidebar.items
    .filter((item) => item.group === "pinned" && !item.hidden)
    .slice(0, 8);

  return (
    <div className="relative h-full min-h-0 overflow-y-auto">
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-[1100px] flex-col gap-4 px-6 py-6">
        <div className="flex shrink-0 flex-col items-center gap-5">
          <div className="flex flex-col items-center gap-2 text-center">
            <Greeting />
            <HeroClock />
          </div>

          <div className="w-full max-w-[760px]">
            <CommandLine onSeedChat={onTalkToJarvis} onOpenPalette={onOpenPalette} />
          </div>
        </div>

        <RecentPanes onSpawn={onSpawn} />

        <ActiveLoops onSpawn={onSpawn} />

        <div className="grid gap-3 lg:grid-cols-2">
          <Tickets onSpawn={onSpawn} />
          <LoopOutputs onSpawn={onSpawn} />
        </div>

        <Channels onSpawn={onSpawn} />

        <QuickActions onSpawn={onSpawn} onOpenPalette={onOpenPalette} onRevealSidebar={onRevealSidebar} />
        {pinned.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center justify-center gap-1.5 border-t border-[var(--color-border)] pt-3">
            {pinned.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpenSidebarItem(item)}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]/40 px-2.5 py-1 text-[11px] text-[var(--color-text-2)] transition-colors hover:border-[color-mix(in_srgb,var(--color-accent)_45%,var(--color-border))] hover:text-[var(--color-text)]"
              >
                <AppSvgIcon name={iconKeyForSidebarItem(item)} size={14} className="shrink-0" />
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Greeting() {
  useSharedTicker(30_000);
  const now = new Date();
  // single source of truth for the user's name — the same `userName` Settings
  // edits. Subscribe so changing it in Settings reflects here live.
  const [name, setName] = useState(() => loadSettings().userName.trim());
  useEffect(() => subscribeSettings((s) => setName(s.userName.trim())), []);
  const h = now.getHours();
  const part =
    h < 5 ? "still up" : h < 12 ? "good morning" : h < 18 ? "good afternoon" : "good evening";
  return (
    <div className="aios-fade-in flex flex-col items-center gap-1">
      <span className="text-[15px] font-medium tracking-tight text-[var(--color-text-2)]">
        {part}{name ? <>, <span className="aios-greet-name">{name}</span></> : null}
      </span>
      <span className="font-mono text-[11px] tracking-[0.08em] text-[var(--color-muted)]">
        {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }).toLowerCase()}
      </span>
    </div>
  );
}

function HeroClock() {
  useSharedTicker(1000);
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return (
    <div className="aios-fade-in flex items-baseline justify-center gap-2 font-mono tabular-nums text-[var(--color-text)]" style={{ animationDelay: "40ms" }}>
      <span className="text-[clamp(44px,7vw,86px)] font-light leading-none">{hh}</span>
      <span className="aios-colon text-[clamp(44px,7vw,86px)] font-light leading-none text-[var(--color-accent-dim)]">:</span>
      <span className="text-[clamp(44px,7vw,86px)] font-light leading-none">{mm}</span>
      <span className="self-end pb-[0.45vw] font-mono text-[clamp(13px,1.5vw,18px)] font-light leading-none tracking-tight text-[var(--color-faint)]">{ss}</span>
    </div>
  );
}

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
      <div className="group/cmd relative flex items-center gap-3 overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] px-4 py-3 transition-all duration-300 focus-within:border-[var(--color-accent)]/60 focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_50%,transparent),0_18px_50px_-12px_color-mix(in_srgb,var(--color-accent)_40%,transparent)]">
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
          placeholder="start something... ask, launch, or resume"
          className="min-w-0 flex-1 bg-transparent font-sans text-[15px] leading-relaxed text-[var(--color-text)] caret-[var(--color-accent)] placeholder:text-[var(--color-faint)] focus:outline-none"
        />
        {hasContent ? (
          <button
            type="submit"
            title="start a chat with this"
            className="group/send grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-accent)] text-[var(--color-accent-fg)] transition-colors duration-200 hover:bg-[var(--color-accent-hover)] active:scale-95"
          >
            <ArrowUp size={16} className="transition-transform duration-200 group-hover/send:-translate-y-0.5" />
          </button>
        ) : (
          <kbd className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
            cmd k
          </kbd>
        )}
      </div>
    </form>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="mb-2 flex items-center gap-2 px-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
        {title}
      </span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="ml-auto text-[10px] text-[var(--color-faint)] transition-colors hover:text-[var(--color-text)]"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

const GLASS_CARD =
  "rounded-xl border border-white/10 bg-white/[0.04] p-3 backdrop-blur-md";

// ── recent panes (resume) ────────────────────────────────────────────────────

function RecentPanes({ onSpawn }: { onSpawn: (kind: AppDef["kind"], label: string) => void }) {
  const [items, setItems] = useState<PaneHistoryItem[]>(() => loadPaneHistory());

  useEffect(() => {
    let alive = true;
    void hydratePaneHistoryStore()
      .then((next) => {
        if (alive) setItems(next);
      })
      .catch(() => undefined);
    const unsubscribe = subscribePaneHistory(() => setItems(loadPaneHistory()));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const recent = items.slice(0, 6);
  if (recent.length === 0) return null;

  return (
    <section className={`aios-fade-in ${GLASS_CARD}`} style={{ animationDelay: "120ms" }}>
      <SectionHeader title="recent panes" />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {recent.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSpawn(item.kind, item.label)}
            className="group flex min-w-0 items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-2 text-left transition-colors hover:border-white/15 hover:bg-white/[0.06]"
          >
            <AppSvgIcon
              name={iconKeyForPane(item.kind, item.label)}
              size={18}
              className="shrink-0"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
                {item.label}
              </span>
              <span className="block truncate text-[10px] text-[var(--color-faint)]">
                {item.detail}
              </span>
            </span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">
              {formatRelativeRunAge(item.openedAt)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ── tickets (jira-like backlog) ──────────────────────────────────────────────
// Open tickets at a glance — who filed it, priority, status, when. Click → the
// ticket pane. The ticket-writer loop fills this; firaz prunes + the fixer drains.

function ticketStatusColor(status: string): string {
  if (status === "in-progress") return "var(--color-accent)";
  if (status === "done") return "var(--color-success)";
  if (status === "ready-for-go") return "var(--color-info)";
  return "var(--color-warning)";
}
function ticketWhen(created: string): string {
  if (!created) return "";
  const ts = Date.parse(created.replace(" ", "T"));
  if (Number.isNaN(ts)) return "";
  return new Date(ts)
    .toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    .toLowerCase();
}

function Tickets({
  onSpawn,
}: {
  onSpawn: (kind: AppDef["kind"], label: string, explicitKey?: string) => void;
}) {
  const [tickets, setTickets] = useState<TicketInfo[]>([]);

  useEffect(() => {
    let alive = true;
    listTickets()
      .then((t) => {
        if (alive) setTickets(t);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const open = tickets.filter((t) => t.queue === "open");
  const done = tickets.filter((t) => t.queue === "done").length;

  return (
    <section className={`aios-fade-in ${GLASS_CARD}`} style={{ animationDelay: "150ms" }}>
      <SectionHeader
        title={`tickets · ${open.length} open${done ? ` · ${done} done` : ""}`}
        action={{ label: "open tickets", onClick: () => onSpawn({ type: "ticket" }, "tickets") }}
      />
      {open.length === 0 ? (
        <div className="px-0.5 py-1 text-[11px] text-[var(--color-faint)]">
          no open tickets — the writer loop will file work here
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {open.slice(0, 5).map((t) => {
            const sc = t.source === "firaz" ? "var(--color-accent)" : t.source === "loop" ? "var(--color-info)" : "var(--color-muted)";
            const when = ticketWhen(t.created);
            return (
              <button
                key={`${t.queue}:${t.name}`}
                type="button"
                onClick={() => onSpawn({ type: "ticket" }, "tickets")}
                className="group flex min-w-0 flex-col gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.06]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: ticketStatusColor(t.status) }} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
                    {t.title}
                  </span>
                  {when && <span className="shrink-0 font-mono text-[9px] text-[var(--color-faint)]">{when}</span>}
                </div>
                <div className="flex items-center gap-1 pl-3.5">
                  <span
                    className="rounded-full border px-1.5 py-px text-[8px] font-medium uppercase tracking-wide"
                    style={{ color: sc, borderColor: `color-mix(in srgb, ${sc} 50%, transparent)` }}
                  >
                    {t.source || "?"}
                  </span>
                  {t.priority === "urgent" && (
                    <span className="rounded-full border border-[var(--color-danger)]/50 px-1.5 py-px text-[8px] font-medium uppercase tracking-wide text-[var(--color-danger)]">
                      urgent
                    </span>
                  )}
                  <span className="text-[9px] uppercase tracking-wide" style={{ color: ticketStatusColor(t.status) }}>
                    {t.status}
                  </span>
                </div>
              </button>
            );
          })}
          {open.length > 5 && (
            <button
              type="button"
              onClick={() => onSpawn({ type: "ticket" }, "tickets")}
              className="px-0.5 text-left text-[10px] text-[var(--color-faint)] hover:text-[var(--color-text)]"
            >
              +{open.length - 5} more →
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ── active loops (live threads) ──────────────────────────────────────────────
// Loops doing work RIGHT NOW = on-disk chat-agents that are loop threads with
// status "running". Click → reattach that loop's chat pane (key agent:<id>) and
// jump straight into the thread.

function ActiveLoops({
  onSpawn,
}: {
  onSpawn: (kind: AppDef["kind"], label: string, explicitKey?: string) => void;
}) {
  const [running, setRunning] = useState<AgentConfig[]>([]);

  const load = useCallback(
    () =>
      listDiskAgents()
        .then((all) => {
          setRunning(all.filter((a) => isLoopThread(a.id) && a.status === "running"));
        })
        .catch(() => undefined),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useSharedInterval(15_000, () => void load()); // refresh while idle

  return (
    <section className={`aios-fade-in ${GLASS_CARD}`} style={{ animationDelay: "140ms" }}>
      <SectionHeader
        title="active loops"
        action={{ label: "open loops", onClick: () => onSpawn({ type: "loop" }, "loops") }}
      />
      {running.length === 0 ? (
        <div className="px-0.5 py-1 text-[11px] text-[var(--color-faint)]">
          no loops running right now — they fire on cadence + leave branches for you
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {running.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onSpawn({ type: "chat", cwd: a.cwd || undefined }, a.label || a.id, agentPaneKey(a.id))}
              className="group flex min-w-0 items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-2 text-left transition-colors hover:border-white/15 hover:bg-white/[0.06]"
              title={`open ${a.id}'s thread`}
            >
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-success)] opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-success)]" />
              </span>
              <Repeat size={13} className="shrink-0 text-[var(--color-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
                  {a.label || a.id}
                </span>
                <span className="block truncate text-[10px] text-[var(--color-faint)]">
                  {a.nextAction || a.role || a.mission || "working…"}
                </span>
              </span>
              {typeof a.lastUpdate === "number" && (
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">
                  {formatRelativeRunAge(a.lastUpdate)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ── loop outputs ─────────────────────────────────────────────────────────────

function loopResultColor(result: string): string {
  if (/\b(ready|done|ok|success|merged|pass|landed|green)\b/i.test(result))
    return "var(--color-success)";
  if (/\b(fail|failed|error|broke|broken)\b/i.test(result)) return "var(--color-danger)";
  if (/\b(block|blocked|skip|skipped|hold)\b/i.test(result)) return "#facc15";
  return "var(--color-muted)";
}

function LoopOutputs({ onSpawn }: { onSpawn: (kind: AppDef["kind"], label: string) => void }) {
  const [changes, setChanges] = useState<LoopChange[]>([]);

  useEffect(() => {
    let alive = true;
    listLoopChanges(6)
      .then((next) => {
        if (alive) setChanges(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const latest = changes.slice(0, 4);

  return (
    <section className={`aios-fade-in ${GLASS_CARD}`} style={{ animationDelay: "160ms" }}>
      <SectionHeader
        title="loop outputs"
        action={{ label: "open loops", onClick: () => onSpawn({ type: "loop" }, "loops") }}
      />
      {latest.length === 0 ? (
        <div className="px-0.5 py-1 text-[11px] text-[var(--color-faint)]">
          no loop activity yet
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {latest.map((c, i) => {
            const color = loopResultColor(c.result);
            return (
              <div
                key={`${c.ts}-${c.loop}-${i}`}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5"
              >
                <span
                  className="shrink-0 rounded-full border px-1.5 py-0.5 text-[8.5px] font-medium uppercase tracking-wide"
                  style={{ color, borderColor: color }}
                >
                  {c.result || "?"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] font-medium text-[var(--color-muted)]">
                    {c.loop}
                  </span>
                  <span className="block truncate text-[11px] leading-snug text-[var(--color-text-2)]">
                    {c.item}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[9px] text-[var(--color-faint)]">
                  {c.ts ? formatRelativeRunAge(c.ts * 1000) : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── channels ─────────────────────────────────────────────────────────────────

function channelDotColor(status: Channel["status"]): string {
  if (status === "connected") return "var(--color-success)";
  if (status === "disconnected") return "var(--color-danger)";
  return "var(--color-muted)";
}

function Channels({ onSpawn }: { onSpawn: (kind: AppDef["kind"], label: string) => void }) {
  const [channels, setChannels] = useState<Channel[]>([]);

  useEffect(() => {
    let alive = true;
    listBridges()
      .then((res) => {
        if (alive) setChannels(res.bridges ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className={`aios-fade-in ${GLASS_CARD}`} style={{ animationDelay: "200ms" }}>
      <SectionHeader title="channels" />
      <div className="flex flex-col gap-1.5">
        {channels.map((ch) => {
          const color = channelDotColor(ch.status);
          return (
            <div
              key={ch.id}
              className="flex min-w-0 items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
                title={ch.status}
              />
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-2)]">
                {ch.name}
              </span>
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">
                {ch.lastActivityAgo ?? ch.status}
              </span>
            </div>
          );
        })}

        <div className="mt-1 grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() =>
              onSpawn({ type: "browser", url: "https://chat.google.com" }, "google chat")
            }
            className="group flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.06]"
          >
            <AppSvgIcon
              name={iconKeyForPane({ type: "browser", url: "https://chat.google.com" }, "google chat")}
              size={16}
              className="shrink-0"
            />
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
              google chat
            </span>
          </button>
          <button
            type="button"
            onClick={() =>
              onSpawn(
                { type: "browser", url: "https://fathopesenergy-tech.atlassian.net" },
                "jira",
              )
            }
            className="group flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.06]"
          >
            <AppSvgIcon
              name={iconKeyForPane(
                { type: "browser", url: "https://fathopesenergy-tech.atlassian.net" },
                "jira",
              )}
              size={16}
              className="shrink-0"
            />
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">
              jira
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}

function QuickActions({
  onSpawn,
  onOpenPalette,
  onRevealSidebar,
}: {
  onSpawn: (kind: AppDef["kind"], label: string, explicitKey?: string) => void;
  onOpenPalette: () => void;
  onRevealSidebar: () => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {CORE_LAUNCHERS.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => onSpawn(action.kind, action.label.replace(/^new /, ""))}
          className="group flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/35 px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]/45 hover:bg-[var(--color-panel-2)]"
        >
          <AppSvgIcon name={action.icon} size={17} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">{action.label}</span>
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">{action.hint}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={onOpenPalette}
        className="group flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/35 px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]/45 hover:bg-[var(--color-panel-2)]"
      >
        <AppSvgIcon name="panes" size={17} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">palette</span>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">cmd k</span>
      </button>
      <button
        type="button"
        onClick={onRevealSidebar}
        className="group flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/35 px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]/45 hover:bg-[var(--color-panel-2)]"
      >
        <PanelLeft size={14} className="shrink-0 text-[var(--color-muted)] group-hover:text-[var(--color-accent)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">rail</span>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">spaces</span>
      </button>
    </div>
  );
}
