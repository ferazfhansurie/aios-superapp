/**
 * TicketPane — firaz's loops-space board.
 *
 * This pane is intentionally agent-native: tickets are not just rows, they are
 * units moving through writer → reviewer → coder gates, with the owning agent's
 * live state visible beside the work.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Copy,
  GitBranch,
  Inbox,
  KanbanSquare,
  LayoutList,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Ticket,
  Trash2,
  UserRound,
  XCircle,
  Zap,
} from "lucide-react";

import {
  addTicket,
  commentTicket,
  deleteTicket,
  listDiskAgents,
  listLoopChanges,
  listTickets,
  readTicket,
  setTicketPriority,
  setTicketStatus,
  type AgentConfig,
  type LoopChange,
  type TicketInfo,
} from "../lib/agents";

type TicketSpace = "aios" | "wrms";
type BoardView = "board" | "list";
type TicketPriority = "urgent" | "high" | "normal";

interface TicketComment {
  author: string;
  stamp: string;
  text: string;
}

interface TicketDetail {
  fields: Record<string, string>;
  body: string;
  comments: TicketComment[];
}

const GLASS_CARD = "rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]/70 backdrop-blur-md";
const INNER_ROW = "rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/55";
const INPUT =
  "rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)]/70 px-3 py-2 text-[12px] text-[var(--color-text)] outline-none backdrop-blur-md transition-colors placeholder:text-[var(--color-faint)] focus:border-[var(--color-accent)]/60";
const ICON_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-panel-2)]/75 text-[var(--color-text-2)] backdrop-blur-md transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40";
const PILL_BUTTON =
  "inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-panel-2)]/75 px-3 text-[11px] font-medium text-[var(--color-text-2)] backdrop-blur-md transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40";

const SPACES: Array<{ id: TicketSpace; label: string; hint: string }> = [
  { id: "aios", label: "aios", hint: "shell loops" },
  { id: "wrms", label: "wrms", hint: "delivery loops" },
];

const BOARD_COLUMNS = [
  { id: "backlog", label: "backlog", hint: "writer output", statuses: ["open"], icon: Inbox },
  { id: "todo", label: "to do", hint: "reviewer approved", statuses: ["approved", "ready-for-go"], icon: ShieldCheck },
  { id: "progress", label: "in progress", hint: "claimed by coder", statuses: ["in-progress"], icon: Activity },
  { id: "review", label: "in review", hint: "waiting verdict", statuses: ["in-review"], icon: MessageSquare },
  { id: "done", label: "done", hint: "landed or closed", statuses: ["done"], icon: Check },
];

const STATUS_OPTIONS = [
  "open",
  "approved",
  "in-progress",
  "in-review",
  "done",
  "ignored",
  "rejected",
] as const;

/** Splits a ticket's raw markdown into frontmatter, primary body, and comments. */
function parseTicket(raw: string): TicketDetail {
  const fields: Record<string, string> = {};
  const lines = raw.split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    for (; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        i++;
        break;
      }
      const idx = lines[i].indexOf(":");
      if (idx > 0) fields[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
    }
  }

  const bodyLines: string[] = [];
  const comments: TicketComment[] = [];
  let current: TicketComment | null = null;
  for (const line of lines.slice(i)) {
    const match = /^## comment\s+[—-]\s*(.+?)\s*\((.*?)\)\s*$/i.exec(line.trim());
    if (match) {
      if (current) comments.push({ ...current, text: current.text.trim() });
      current = { author: match[1].trim(), stamp: match[2].trim(), text: "" };
      continue;
    }
    if (current) {
      current.text += `${line}\n`;
    } else {
      bodyLines.push(line);
    }
  }
  if (current) comments.push({ ...current, text: current.text.trim() });

  return { fields, body: bodyLines.join("\n").trim(), comments };
}

function relAge(created: string, now = Date.now()): string {
  if (!created) return "";
  const ts = Date.parse(created.replace(" ", "T"));
  if (Number.isNaN(ts)) return "";
  const min = Math.max(1, Math.floor(Math.max(0, now - ts) / 60_000));
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function absDate(created: string): string {
  if (!created) return "";
  const ts = Date.parse(created.replace(" ", "T"));
  if (Number.isNaN(ts)) return created;
  return new Date(ts)
    .toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    .toLowerCase();
}

function sourceColor(source: string): string {
  if (source === "firaz") return "var(--color-accent)";
  if (source === "loop") return "var(--color-info)";
  return "var(--color-muted)";
}

function statusMeta(status: string): { label: string; color: string } {
  switch (status) {
    case "open":
      return { label: "open", color: "var(--color-warning)" };
    case "approved":
    case "ready-for-go":
      return { label: "approved", color: "var(--color-info)" };
    case "in-progress":
      return { label: "in progress", color: "var(--color-accent)" };
    case "in-review":
      return { label: "in review", color: "#a78bfa" };
    case "done":
      return { label: "done", color: "var(--color-success)" };
    case "ignored":
      return { label: "ignored", color: "var(--color-faint)" };
    case "rejected":
      return { label: "rejected", color: "var(--color-danger)" };
    default:
      return { label: status || "unknown", color: "var(--color-faint)" };
  }
}

function priorityColor(priority: string): string {
  if (priority === "urgent") return "var(--color-danger)";
  if (priority === "high") return "var(--color-warning)";
  return "var(--color-muted)";
}

function mergeStatusColor(status?: string): string {
  switch (status) {
    case "merged":
      return "var(--color-success)";
    case "not-merged":
      return "var(--color-warning)";
    case "unknown":
      return "var(--color-muted)";
    default:
      return "var(--color-faint)";
  }
}

function ticketTitle(t: TicketInfo): string {
  return (t.title || t.name).replace(/^\[wrms\]\s*/i, "");
}

function ticketSpace(t: TicketInfo): TicketSpace {
  const haystack = `${t.name} ${t.title} ${t.repo || ""} ${t.branch || ""} ${t.owner || ""}`.toLowerCase();
  if (
    haystack.includes("[wrms]") ||
    haystack.includes("wrms") ||
    haystack.includes("fathopes") ||
    haystack.includes("fat hopes") ||
    haystack.includes("fhe")
  ) {
    return "wrms";
  }
  return "aios";
}

function changeSpace(change: LoopChange): TicketSpace {
  const haystack = `${change.loop} ${change.branch || ""} ${change.item || ""} ${change.summary || ""}`.toLowerCase();
  return haystack.includes("wrms") || haystack.includes("fhe") ? "wrms" : "aios";
}

function normalizedStatus(t: TicketInfo): string {
  const status = (t.status || "").trim();
  if (status) return status;
  return t.queue === "done" ? "done" : "open";
}

function belongsToColumn(t: TicketInfo, column: (typeof BOARD_COLUMNS)[number]): boolean {
  const status = normalizedStatus(t);
  if (status === "ignored" || status === "rejected") return false;
  if (column.statuses.includes(status)) return true;
  return column.id === "backlog" && !BOARD_COLUMNS.some((c) => c.statuses.includes(status));
}

function agentForOwner(owner: string | undefined, agents: AgentConfig[]): AgentConfig | null {
  const key = (owner || "").trim().toLowerCase();
  if (!key) return null;
  return (
    agents.find((a) => {
      const ids = [a.id, a.label, a.role].filter(Boolean).map((v) => String(v).toLowerCase());
      return ids.includes(key);
    }) || null
  );
}

function agentLiveMeta(owner: string | undefined, agent: AgentConfig | null): { label: string; color: string; pulse: boolean } {
  if (!owner) return { label: "unowned", color: "var(--color-faint)", pulse: false };
  if (!agent) return { label: "idle", color: "var(--color-muted)", pulse: false };
  if (agent.status === "blocked") return { label: "blocked", color: "var(--color-danger)", pulse: false };
  if (agent.status === "running") return { label: "working", color: "var(--color-success)", pulse: true };
  if (agent.status === "done") return { label: "done", color: "var(--color-success)", pulse: false };
  return { label: "idle", color: "var(--color-muted)", pulse: false };
}

function latestReviewerComment(comments: TicketComment[]): TicketComment | null {
  const reviewerComments = comments.filter((c) => /reviewer/i.test(c.author));
  return reviewerComments[reviewerComments.length - 1] || null;
}

function cherryPickCommand(branch: string): string {
  return `git cherry-pick ${branch}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function TicketPane() {
  const [tickets, setTickets] = useState<TicketInfo[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [changes, setChanges] = useState<LoopChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [filing, setFiling] = useState(false);
  const [space, setSpace] = useState<TicketSpace>("aios");
  const [view, setView] = useState<BoardView>("board");
  const [showRejected, setShowRejected] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [nextTickets, nextAgents, nextChanges] = await Promise.all([
        listTickets(),
        listDiskAgents(),
        listLoopChanges(20),
      ]);
      setTickets(nextTickets);
      setAgents(nextAgents);
      setChanges(nextChanges);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const spaceTickets = useMemo(() => tickets.filter((t) => ticketSpace(t) === space), [tickets, space]);
  const activeTickets = useMemo(
    () => spaceTickets.filter((t) => !["ignored", "rejected"].includes(normalizedStatus(t))),
    [spaceTickets],
  );
  const rejectedTickets = useMemo(
    () => spaceTickets.filter((t) => ["ignored", "rejected"].includes(normalizedStatus(t))),
    [spaceTickets],
  );
  const activityGroups = useMemo(() => {
    const grouped = new Map<string, LoopChange[]>();
    for (const change of changes.filter((c) => changeSpace(c) === space).slice(0, 20)) {
      const key = change.loop || "loop";
      grouped.set(key, [...(grouped.get(key) || []), change]);
    }
    return Array.from(grouped.entries()).map(([loop, rows]) => ({ loop, rows }));
  }, [changes, space]);

  const counts = useMemo(
    () =>
      SPACES.reduce(
        (acc, s) => {
          acc[s.id] = tickets.filter((t) => ticketSpace(t) === s.id).length;
          return acc;
        },
        {} as Record<TicketSpace, number>,
      ),
    [tickets],
  );

  const file = async () => {
    const text = draft.trim();
    if (!text || filing) return;
    setFiling(true);
    try {
      const scopedText = space === "wrms" && !/^\[wrms\]/i.test(text) ? `[wrms] ${text}` : text;
      await addTicket(scopedText, urgent);
      setDraft("");
      setUrgent(false);
      await refresh();
    } catch {
      /* invoke rejected (web build / cli missing) — leave the draft intact */
    } finally {
      setFiling(false);
    }
  };

  const doneCount = activeTickets.filter((t) => normalizedStatus(t) === "done").length;
  const workingCount = activeTickets.filter((t) => normalizedStatus(t) === "in-progress").length;
  const reviewCount = activeTickets.filter((t) => normalizedStatus(t) === "in-review").length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg)]/82 px-4 py-3 backdrop-blur-md">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.05] text-[var(--color-accent)] shadow-xl shadow-black/20">
              <Ticket size={15} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[13px] font-semibold text-[var(--color-text)]">loops space</h1>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--color-faint)]">
                  reviewer gate
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-[var(--color-faint)]">
                <span>{activeTickets.length} active</span>
                <span>{workingCount} working</span>
                <span>{reviewCount} review</span>
                <span>{doneCount} done</span>
              </div>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="flex rounded-full border border-white/10 bg-white/[0.04] p-0.5 shadow-xl shadow-black/15 backdrop-blur-md">
              {SPACES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSpace(s.id)}
                  title={s.hint}
                  className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-colors ${
                    space === s.id
                      ? "bg-white/[0.1] text-[var(--color-text)] shadow-lg shadow-black/20"
                      : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  <span>{s.label}</span>
                  <span className="font-mono text-[9px] text-[var(--color-faint)]">{counts[s.id] || 0}</span>
                </button>
              ))}
            </div>

            <div className="flex rounded-full border border-white/10 bg-white/[0.04] p-0.5 backdrop-blur-md">
              <button
                type="button"
                onClick={() => setView("board")}
                title="board view"
                className={`grid h-7 w-7 place-items-center rounded-full transition-colors ${
                  view === "board" ? "bg-white/[0.1] text-[var(--color-text)]" : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <KanbanSquare size={13} />
              </button>
              <button
                type="button"
                onClick={() => setView("list")}
                title="list view"
                className={`grid h-7 w-7 place-items-center rounded-full transition-colors ${
                  view === "list" ? "bg-white/[0.1] text-[var(--color-text)]" : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <LayoutList size={13} />
              </button>
            </div>

            <button type="button" onClick={() => void refresh()} disabled={loading} className={ICON_BUTTON} title="reload board">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <form
          className={`${GLASS_CARD} flex shrink-0 items-center gap-2 px-3 py-2 shadow-2xl shadow-black/15`}
          onSubmit={(e) => {
            e.preventDefault();
            void file();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={space === "wrms" ? "file a wrms ticket" : "file an aios ticket"}
            className={`${INPUT} min-w-0 flex-1`}
          />
          <button
            type="button"
            onClick={() => setUrgent((v) => !v)}
            className={ICON_BUTTON}
            style={{
              borderColor: urgent ? "color-mix(in srgb, var(--color-danger) 45%, transparent)" : undefined,
              color: urgent ? "var(--color-danger)" : undefined,
              background: urgent ? "color-mix(in srgb, var(--color-danger) 12%, transparent)" : undefined,
            }}
            title={urgent ? "urgent" : "mark urgent"}
          >
            <Zap size={13} />
          </button>
          <button
            type="submit"
            disabled={!draft.trim() || filing}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-[var(--color-accent)]/50 bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] text-[var(--color-accent)] shadow-xl shadow-black/20 transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_32%,transparent)] disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-[var(--color-faint)]"
            title="file ticket"
          >
            <Check size={14} />
          </button>
        </form>

        <div className="grid min-h-0 flex-1 gap-3 2xl:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-h-0 overflow-hidden">
            {view === "board" ? (
              <BoardView tickets={activeTickets} agents={agents} onChanged={refresh} />
            ) : (
              <ListView tickets={activeTickets} agents={agents} onChanged={refresh} />
            )}

            {rejectedTickets.length > 0 && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setShowRejected((v) => !v)}
                  className={`${PILL_BUTTON} w-full justify-between`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Archive size={12} />
                    rejected / ignored
                  </span>
                  <span className="font-mono text-[10px] text-[var(--color-faint)]">{rejectedTickets.length}</span>
                </button>
                {showRejected && (
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    {rejectedTickets.map((t) => (
                      <TicketCard key={`${t.queue}:${t.name}`} t={t} agents={agents} onChanged={refresh} compact />
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <ActivityFeed groups={activityGroups} />
        </div>
      </main>
    </div>
  );
}

function BoardView({
  tickets,
  agents,
  onChanged,
}: {
  tickets: TicketInfo[];
  agents: AgentConfig[];
  onChanged: () => void | Promise<void>;
}) {
  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto pb-1">
      {BOARD_COLUMNS.map((column) => {
        const Icon = column.icon;
        const columnTickets = tickets.filter((t) => belongsToColumn(t, column));
        return (
          <section
            key={column.id}
            className={`${GLASS_CARD} flex min-h-[420px] w-[224px] shrink-0 flex-col overflow-hidden shadow-2xl shadow-black/10 2xl:w-[236px]`}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
              <Icon size={13} className="text-[var(--color-accent)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-2)]">
                  {column.label}
                </div>
                <div className="truncate text-[9.5px] text-[var(--color-faint)]">{column.hint}</div>
              </div>
              <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] text-[var(--color-faint)]">
                {columnTickets.length}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
              {columnTickets.length === 0 ? (
                <div className="grid min-h-24 place-items-center rounded-lg border border-dashed border-white/[0.08] px-4 text-center text-[11px] leading-relaxed text-[var(--color-faint)]">
                  empty
                </div>
              ) : (
                columnTickets.map((t) => (
                  <TicketCard key={`${t.queue}:${t.name}`} t={t} agents={agents} onChanged={onChanged} />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ListView({
  tickets,
  agents,
  onChanged,
}: {
  tickets: TicketInfo[];
  agents: AgentConfig[];
  onChanged: () => void | Promise<void>;
}) {
  if (tickets.length === 0) {
    return (
      <div className={`${GLASS_CARD} grid min-h-[280px] place-items-center p-6 text-[12px] text-[var(--color-faint)]`}>
        no tickets in this space
      </div>
    );
  }
  return (
    <div className={`${GLASS_CARD} flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-3 shadow-2xl shadow-black/10`}>
      {tickets.map((t) => (
        <TicketCard key={`${t.queue}:${t.name}`} t={t} agents={agents} onChanged={onChanged} wide />
      ))}
    </div>
  );
}

function TicketCard({
  t,
  agents,
  compact,
  wide,
  onChanged,
}: {
  t: TicketInfo;
  agents: AgentConfig[];
  compact?: boolean;
  wide?: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  const title = ticketTitle(t);
  const status = normalizedStatus(t);
  const statusInfo = statusMeta(status);
  const owner = detail?.fields.owner || t.owner || "";
  const agent = agentForOwner(owner, agents);
  const live = agentLiveMeta(owner, agent);
  const age = relAge(t.created);
  const when = absDate(t.created);
  const reviewer = detail ? latestReviewerComment(detail.comments) : null;
  const branch = detail?.fields.branch || t.branch || "";
  const priority = (t.priority || detail?.fields.priority || "normal") as TicketPriority;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && detail === null) {
      setLoading(true);
      try {
        setDetail(parseTicket(await readTicket(t.name, t.queue)));
      } finally {
        setLoading(false);
      }
    }
  };

  const reloadDetail = async () => {
    setDetail(parseTicket(await readTicket(t.name, t.queue)));
  };

  const refreshAfterMutation = async () => {
    if (open) await reloadDetail();
    await onChanged();
  };

  const addComment = async () => {
    const text = comment.trim();
    if (!text || busy) return;
    setBusy("comment");
    try {
      await commentTicket(t.name, t.queue, text);
      setComment("");
      await refreshAfterMutation();
    } finally {
      setBusy(null);
    }
  };

  const changeStatus = async (nextStatus: string) => {
    if (busy) return;
    setBusy(nextStatus);
    try {
      await setTicketStatus(t.name, t.queue, nextStatus);
      await refreshAfterMutation();
    } finally {
      setBusy(null);
    }
  };

  const changePriority = async (nextPriority: TicketPriority) => {
    if (busy) return;
    setBusy(nextPriority);
    try {
      await setTicketPriority(t.name, t.queue, nextPriority);
      await refreshAfterMutation();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy("delete");
    try {
      await deleteTicket(t.name, t.queue);
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  const copyBranch = async () => {
    if (!branch) return;
    const ok = await copyText(cherryPickCommand(branch));
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <article
      className={`${INNER_ROW} group overflow-hidden shadow-xl shadow-black/10 transition-colors hover:border-white/15 hover:bg-white/[0.05] ${
        wide ? "w-full" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => void toggle()}
        className={`flex w-full min-w-0 flex-col gap-2 px-3 py-2.5 text-left ${compact ? "py-2" : ""}`}
      >
        <div className="flex items-start gap-2">
          {open ? (
            <ChevronDown size={12} className="mt-0.5 shrink-0 text-[var(--color-faint)]" />
          ) : (
            <ChevronRight size={12} className="mt-0.5 shrink-0 text-[var(--color-faint)]" />
          )}
          <span className="relative mt-1 flex h-2 w-2 shrink-0">
            <span className="h-2 w-2 rounded-full" style={{ background: statusInfo.color }} title={statusInfo.label} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[12px] font-medium leading-snug text-[var(--color-text)]">{title}</div>
            {!compact && (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                <TicketChip label={t.source || "unknown"} color={sourceColor(t.source)} />
                <TicketChip label={statusInfo.label} color={statusInfo.color} />
                {priority !== "normal" && <TicketChip label={priority} color={priorityColor(priority)} />}
                {owner ? (
                  <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-px text-[8.5px] font-medium uppercase tracking-wide text-[var(--color-text-2)]">
                    <UserRound size={9} className="shrink-0 text-[var(--color-muted)]" />
                    <span className="truncate">{owner}</span>
                    <LiveDot color={live.color} pulse={live.pulse} />
                    <span className="text-[var(--color-faint)]">{live.label}</span>
                  </span>
                ) : null}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {when && (
              <span className="font-mono text-[9px] text-[var(--color-faint)]" title={t.created}>
                {when}
              </span>
            )}
            {age && <span className="font-mono text-[9px] text-[var(--color-faint)]">{age}</span>}
          </div>
        </div>

        {branch && (
          <div className="flex min-w-0 items-center gap-1 pl-6">
            <span
              className="inline-flex min-w-0 items-center gap-1 rounded-full border px-1.5 py-px text-[8.5px] font-medium uppercase tracking-wide"
              style={{
                color: mergeStatusColor(t.mergeStatus),
                borderColor: `color-mix(in srgb, ${mergeStatusColor(t.mergeStatus)} 45%, transparent)`,
              }}
              title={branch}
            >
              <GitBranch size={9} className="shrink-0" />
              <span className="truncate">{branch}</span>
            </span>
          </div>
        )}
      </button>

      {open && (
        <div className="border-t border-white/[0.06] px-3 pb-3 pt-2.5">
          {loading ? (
            <div className="text-[11px] text-[var(--color-faint)]">loading</div>
          ) : detail ? (
            <div className="flex flex-col gap-3">
              {reviewer && (
                <div className="rounded-xl border border-[#a78bfa]/30 bg-white/[0.05] p-3 shadow-xl shadow-black/10">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[#c4b5fd]">
                    <ShieldCheck size={11} />
                    reviewer verdict
                  </div>
                  <div className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--color-text)]">{reviewer.text}</div>
                </div>
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="repo" value={detail.fields.repo || t.repo} />
                <Field label="owner" value={owner} />
                <Field label="result" value={detail.fields.result || t.result} />
                <Field label="blocker" value={detail.fields.blocker || t.blocker} danger />
              </div>

              {branch && (
                <button type="button" onClick={() => void copyBranch()} className={`${PILL_BUTTON} justify-between`} title={cherryPickCommand(branch)}>
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <GitBranch size={12} className="shrink-0 text-[var(--color-accent)]" />
                    <span className="truncate">{branch}</span>
                  </span>
                  <span className="inline-flex items-center gap-1 font-mono text-[9px] text-[var(--color-faint)]">
                    <Copy size={10} />
                    {copied ? "copied" : "cherry-pick"}
                  </span>
                </button>
              )}

              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-black/10 px-3 py-2.5 font-sans text-[11.5px] leading-relaxed text-[var(--color-text-2)]">
                {detail.body || "(no body)"}
              </pre>

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex min-w-0 flex-col gap-1 text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--color-faint)]">
                  priority
                  <select
                    value={priority}
                    disabled={busy !== null}
                    onChange={(e) => void changePriority(e.target.value as TicketPriority)}
                    className={`${INPUT} py-1.5 text-[11px] normal-case tracking-normal`}
                  >
                    <option value="normal">normal</option>
                    <option value="high">high</option>
                    <option value="urgent">urgent</option>
                  </select>
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--color-faint)]">
                  status
                  <select
                    value={status === "ready-for-go" ? "approved" : status}
                    disabled={busy !== null}
                    onChange={(e) => void changeStatus(e.target.value)}
                    className={`${INPUT} py-1.5 text-[11px] normal-case tracking-normal`}
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {statusMeta(option).label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void changeStatus("approved")}
                  disabled={busy !== null}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--color-info)]/40 bg-[color-mix(in_srgb,var(--color-info)_13%,transparent)] px-3 text-[11px] font-medium text-[var(--color-info)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-info)_22%,transparent)] disabled:opacity-40"
                >
                  <ShieldCheck size={12} />
                  approve
                </button>
                <button
                  type="button"
                  onClick={() => void changeStatus("rejected")}
                  disabled={busy !== null}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--color-danger)]/35 bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-3 text-[11px] font-medium text-[var(--color-danger)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)] disabled:opacity-40"
                >
                  <XCircle size={12} />
                  reject
                </button>
                {status === "ignored" || status === "rejected" ? (
                  <button type="button" onClick={() => void changeStatus("open")} disabled={busy !== null} className={PILL_BUTTON}>
                    <RotateCcw size={12} />
                    reopen
                  </button>
                ) : (
                  <button type="button" onClick={() => void changeStatus("ignored")} disabled={busy !== null} className={PILL_BUTTON}>
                    <Archive size={12} />
                    ignore
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={busy !== null}
                  className={`ml-auto inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                    confirmDelete
                      ? "border-[var(--color-danger)]/60 bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] text-[var(--color-danger)]"
                      : "border-white/10 bg-white/[0.04] text-[var(--color-faint)] hover:text-[var(--color-danger)]"
                  }`}
                >
                  <Trash2 size={12} />
                  {confirmDelete ? "confirm" : "delete"}
                </button>
                {busy && <span className="font-mono text-[9px] text-[var(--color-faint)]">{busy}</span>}
              </div>

              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-2.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--color-faint)]">
                    <MessageSquare size={11} />
                    steering thread
                  </div>
                  <span className="font-mono text-[9px] text-[var(--color-faint)]">{detail.comments.length}</span>
                </div>
                <div className="mb-2 flex max-h-44 flex-col gap-2 overflow-y-auto">
                  {detail.comments.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-white/[0.08] px-3 py-4 text-center text-[11px] text-[var(--color-faint)]">
                      no comments
                    </div>
                  ) : (
                    detail.comments.map((c, idx) => <CommentBubble key={`${c.author}:${c.stamp}:${idx}`} comment={c} />)
                  )}
                </div>
                <div className="flex items-end gap-2">
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="add steering"
                    className={`${INPUT} min-h-20 min-w-0 flex-1 resize-y leading-relaxed`}
                  />
                  <button
                    type="button"
                    onClick={() => void addComment()}
                    disabled={!comment.trim() || busy !== null}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-[var(--color-accent)]/45 bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-[var(--color-accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_28%,transparent)] disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-[var(--color-faint)]"
                    title="post comment"
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>

              <div className="font-mono text-[8.5px] text-[var(--color-faint)]">
                {t.name}.md · {t.queue}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-[var(--color-faint)]">could not read ticket</div>
          )}
        </div>
      )}
    </article>
  );
}

function TicketChip({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full border bg-white/[0.03] px-1.5 py-px text-[8.5px] font-medium uppercase tracking-wide"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}
    >
      {label}
    </span>
  );
}

function LiveDot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
      {pulse && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: color }} />}
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: color }} />
    </span>
  );
}

function Field({ label, value, danger }: { label: string; value?: string; danger?: boolean }) {
  if (!value) return null;
  return (
    <div className="min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-2">
      <div className="mb-1 text-[8.5px] font-medium uppercase tracking-[0.12em] text-[var(--color-faint)]">{label}</div>
      <div className={`break-words font-mono text-[10.5px] ${danger ? "text-[var(--color-danger)]" : "text-[var(--color-text-2)]"}`}>
        {value}
      </div>
    </div>
  );
}

function CommentBubble({ comment }: { comment: TicketComment }) {
  const reviewer = /reviewer/i.test(comment.author);
  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${
        reviewer
          ? "border-[#a78bfa]/30 bg-white/[0.055]"
          : "border-white/[0.06] bg-black/10"
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-[0.12em]">
        <Circle size={7} className={reviewer ? "fill-[#a78bfa] text-[#a78bfa]" : "fill-[var(--color-muted)] text-[var(--color-muted)]"} />
        <span className={reviewer ? "text-[#c4b5fd]" : "text-[var(--color-muted)]"}>{comment.author}</span>
        <span className="ml-auto font-mono text-[8.5px] normal-case tracking-normal text-[var(--color-faint)]">{comment.stamp}</span>
      </div>
      <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--color-text-2)]">{comment.text}</div>
    </div>
  );
}

function ActivityFeed({ groups }: { groups: Array<{ loop: string; rows: LoopChange[] }> }) {
  return (
    <aside className={`${GLASS_CARD} hidden min-h-0 flex-col overflow-hidden shadow-2xl shadow-black/10 2xl:flex`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
        <Activity size={13} className="text-[var(--color-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-2)]">agent activity</div>
          <div className="truncate text-[9.5px] text-[var(--color-faint)]">latest loop changes</div>
        </div>
        <SlidersHorizontal size={12} className="text-[var(--color-faint)]" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {groups.length === 0 ? (
          <div className="grid min-h-24 place-items-center rounded-lg border border-dashed border-white/[0.08] px-4 text-center text-[11px] leading-relaxed text-[var(--color-faint)]">
            no activity yet
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.loop} className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-2.5">
              <div className="mb-2 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
                <span className="truncate text-[10px] font-semibold text-[var(--color-text-2)]">{group.loop}</span>
                <span className="ml-auto font-mono text-[9px] text-[var(--color-faint)]">{group.rows.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {group.rows.slice(0, 3).map((row, idx) => (
                  <div key={`${group.loop}:${row.ts}:${idx}`} className="border-l border-white/10 pl-2">
                    <div className="line-clamp-2 text-[10.5px] leading-snug text-[var(--color-text-2)]">
                      {row.summary || row.item}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 font-mono text-[8.5px] text-[var(--color-faint)]">
                      <Clock3 size={9} />
                      <span>{row.result || "logged"}</span>
                      {row.branch && <span className="truncate">· {row.branch}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
