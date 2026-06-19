/**
 * TicketPane — firaz's dogfood ticket intake + queue surface (a first-class pane,
 * registered in CORE_PANE_TYPES + the SPAWN catalog like `mission`).
 *
 * Top: a quick-file input — type an issue, hit enter, it files a firaz- ticket
 * (via the aios-ticket CLI, wrapped by the ticket_add Rust cmd). Below: the live
 * queue read from ~/.aios/state/dogfood/tickets/{open,done}/ (ticket_list cmd),
 * ordered the way the dogfood loop actually picks: open first, firaz-authored
 * first, oldest-first. This is where firaz sees what the loop will pick next and
 * files new work with the least friction.
 */
import { useEffect, useState } from "react";
import { Check, Inbox, RefreshCw, Ticket, Zap } from "lucide-react";

import { addTicket, listTickets, type TicketInfo } from "../lib/agents";

function relAge(created: string, now = Date.now()): string {
  // created is "YYYY-MM-DD HH:MM:SS" (local). Best-effort parse; blank if unknown.
  if (!created) return "";
  const ts = Date.parse(created.replace(" ", "T"));
  if (Number.isNaN(ts)) return "";
  const min = Math.max(1, Math.floor(Math.max(0, now - ts) / 60_000));
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function statusColor(status: string): string {
  switch (status) {
    case "open":
      return "var(--color-warning, var(--color-muted))";
    case "ready-for-go":
      return "var(--color-info)";
    case "in-progress":
      return "var(--color-accent)";
    case "done":
      return "var(--color-success)";
    default:
      return "var(--color-faint)";
  }
}

export function TicketPane() {
  const [tickets, setTickets] = useState<TicketInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [filing, setFiling] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setTickets(await listTickets());
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const file = async () => {
    const text = draft.trim();
    if (!text || filing) return;
    setFiling(true);
    try {
      await addTicket(text, urgent);
      setDraft("");
      setUrgent(false);
      await refresh();
    } catch {
      /* invoke rejected (web build / CLI missing) — leave the draft intact */
    } finally {
      setFiling(false);
    }
  };

  const open = tickets.filter((t) => t.queue === "open");
  const done = tickets.filter((t) => t.queue === "done");

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)] p-3">
      <div className="mb-2 flex items-center gap-2">
        <Ticket size={14} className="shrink-0 text-[var(--color-accent)]" />
        <span className="text-[12px] font-medium text-[var(--color-text)]">tickets</span>
        <span className="text-[10px] text-[var(--color-faint)]">{open.length} open · {done.length} done</span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
          title="reload the queue"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* quick-file intake */}
      <form
        className="mb-3 flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void file();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="file a ticket — what's broken / what to improve"
          className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="button"
          onClick={() => setUrgent((v) => !v)}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md border transition-colors"
          style={{
            borderColor: urgent ? "var(--color-danger)" : "var(--color-border)",
            color: urgent ? "var(--color-danger)" : "var(--color-muted)",
            background: urgent ? "color-mix(in srgb, var(--color-danger) 14%, transparent)" : "transparent",
          }}
          title={urgent ? "urgent — jumps the loop queue" : "mark urgent"}
        >
          <Zap size={13} />
        </button>
        <button
          type="submit"
          disabled={!draft.trim() || filing}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--color-accent)] text-[var(--color-bg)] transition-transform hover:scale-[1.05] disabled:opacity-40"
          title="file ticket (enter)"
        >
          <Check size={14} />
        </button>
      </form>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <TicketGroup label="open · pickup order" tickets={open} emptyHint="no open tickets — all clear" />
        {done.length > 0 && <TicketGroup label="done" tickets={done} dim />}
      </div>
    </div>
  );
}

function TicketGroup({
  label,
  tickets,
  emptyHint,
  dim,
}: {
  label: string;
  tickets: TicketInfo[];
  emptyHint?: string;
  dim?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
        <Inbox size={10} />
        {label}
      </div>
      {tickets.length === 0 ? (
        emptyHint ? <div className="px-1 text-[11px] text-[var(--color-faint)]">{emptyHint}</div> : null
      ) : (
        <div className="flex flex-col gap-1">
          {tickets.map((t) => {
            const age = relAge(t.created);
            const isFiraz = t.source === "firaz";
            const isUrgent = t.priority === "urgent";
            return (
              <div
                key={`${t.queue}:${t.name}`}
                className={`flex min-w-0 items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-3 py-1.5 ${dim ? "opacity-60" : ""}`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: statusColor(t.status) }}
                  title={t.status}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] text-[var(--color-text-2)]">{t.title}</div>
                  <div className="flex items-center gap-1.5 font-mono text-[9px] text-[var(--color-faint)]">
                    {isFiraz && <span className="text-[var(--color-accent)]">firaz</span>}
                    {isUrgent && <span className="text-[var(--color-danger)]">urgent</span>}
                    <span>{t.status}</span>
                    {age && <span>· {age}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
