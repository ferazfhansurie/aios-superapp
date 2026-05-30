/** Customer messaging INBOX — the superapp's customer-comms surface. Not a deal
 *  pipeline: this is where you talk to customers over the channels AIOS already
 *  speaks (WhatsApp today, more later) and see everyone you can message.
 *
 *  Two panes, WhatsApp/iMessage style:
 *    - LEFT — a searchable, segment-filterable list of customers (merged from the
 *      WhatsApp logs + manual contacts in crm.json). Each row: colour-keyed
 *      avatar w/ live dot, name, channel chip, media-aware last-msg preview, and
 *      "Xm ago". Arrow keys move the selection; "/" focuses search.
 *    - RIGHT — the conversation: day separators, sender-grouped bubbles (out =
 *      accent-tinted right, in = panel-2 left w/ avatar), clickable links,
 *      media chips, delivery ticks, a jump-to-latest button, and a composer that
 *      sends over the bridge (optimistic append). Thread polls every ~10s.
 *
 *  Data comes from `lib/inbox.ts` (Rust `list_customers` / `customer_thread` /
 *  `send_message`). Adding a manual contact reuses `lib/crm.ts` →
 *  `crm_save_contact`. Brand --color-* tokens only (light+dark safe). */
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";

import {
  ArrowDown,
  Check,
  ChevronLeft,
  Clock,
  FileText,
  Image as ImageIcon,
  Inbox,
  MapPin,
  MessageCircle,
  Mic,
  Paperclip,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sticker,
  Video,
  X,
} from "lucide-react";

import {
  customerThread,
  listCustomers,
  sendMessage,
  SENDABLE_CHANNELS,
  type Customer,
  type InboxChannel,
  type InboxMessage,
} from "../lib/inbox";
import { crmSaveContact, type Channel } from "../lib/crm";

/** How often the open thread re-fetches from the logs (ms). */
const THREAD_POLL_MS = 10_000;
/** How often the customer list re-fetches (ms) — slower; it's the index. */
const LIST_POLL_MS = 30_000;
/** Gap after which consecutive same-sender messages stop being one visual group. */
const GROUP_GAP_MS = 5 * 60_000;

type Segment = "all" | "active";

/** Catches any render throw inside the pane so a single bad row can't white-screen
 *  the whole app — shows the error + stack inline + a retry instead. */
class PaneErrorBoundary extends Component<
  { children: ReactNode },
  { err: Error | null; stack: string }
> {
  state = { err: null as Error | null, stack: "" };
  static getDerivedStateFromError(err: Error) {
    return { err, stack: "" };
  }
  componentDidCatch(err: Error, info: ErrorInfo) {
    this.setState({ err, stack: info.componentStack ?? "" });
    // surface in the tauri dev console too
    console.error("[CrmPane] render crash:", err, info.componentStack);
  }
  render() {
    if (this.state.err) {
      return (
        <div className="flex h-full flex-col gap-2 overflow-auto bg-[var(--color-pane)] p-4 text-[12px]">
          <span className="font-medium text-[var(--color-danger)]">inbox hit a render error</span>
          <pre className="whitespace-pre-wrap text-[11px] text-[var(--color-text-2)]">
            {String(this.state.err?.message || this.state.err)}
          </pre>
          {this.state.stack && (
            <pre className="whitespace-pre-wrap text-[10px] text-[var(--color-faint)]">
              {this.state.stack.trim()}
            </pre>
          )}
          <button
            onClick={() => this.setState({ err: null, stack: "" })}
            className="mt-1 w-fit rounded-md bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)]"
          >
            retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function CrmPane() {
  return (
    <PaneErrorBoundary>
      <CrmPaneInner />
    </PaneErrorBoundary>
  );
}

function CrmPaneInner() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState<Segment>("all");
  const [selectedHandle, setSelectedHandle] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadCustomers = useCallback(async () => {
    setError(null);
    try {
      const list = await listCustomers();
      setCustomers(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCustomers();
    const t = setInterval(loadCustomers, LIST_POLL_MS);
    return () => clearInterval(t);
  }, [loadCustomers]);

  // search + segment filter. "active" = a conversation that moved in the last day
  // (lastAgo measured in seconds / minutes / hours, not days+).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return customers.filter((c) => {
      if (segment === "active" && !isRecent(c.lastAgo)) return false;
      if (!q) return true;
      return [c.name, c.handle, c.lastText, c.channel]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(q));
    });
  }, [customers, query, segment]);

  const activeCount = useMemo(
    () => customers.filter((c) => isRecent(c.lastAgo)).length,
    [customers],
  );

  const selected = useMemo(
    () => (selectedHandle ? customers.find((c) => c.handle === selectedHandle) ?? null : null),
    [customers, selectedHandle],
  );

  // keep the keyboard-selected row in view as it moves.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedHandle]);

  // ↑/↓ walk the visible list.
  const onListKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (filtered.length === 0) return;
      e.preventDefault();
      const i = filtered.findIndex((c) => c.handle === selectedHandle);
      let n = e.key === "ArrowDown" ? i + 1 : i - 1;
      if (i === -1) n = e.key === "ArrowDown" ? 0 : filtered.length - 1;
      n = Math.max(0, Math.min(filtered.length - 1, n));
      setSelectedHandle(filtered[n].handle);
    },
    [filtered, selectedHandle],
  );

  // Adding a manual contact: persist via the existing crm command, then refresh
  // the list (the new contact surfaces through list_customers' merge) and select
  // it so you can start a thread immediately.
  const addContact = useCallback(
    async (name: string, phone: string) => {
      const handle = phone.replace(/\D/g, "");
      await crmSaveContact({
        id: "",
        name: name.trim() || handle,
        phone: phone.trim(),
        channel: "whatsapp" as Channel,
        createdAt: Date.now(),
      });
      setAddOpen(false);
      await loadCustomers();
      if (handle) setSelectedHandle(handle);
    },
    [loadCustomers],
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-[var(--color-pane)] text-[13px]"
      onKeyDown={(e) => {
        // "/" focuses search from anywhere in the pane (unless already typing).
        const tag = (e.target as HTMLElement)?.tagName;
        if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault();
          searchRef.current?.focus();
        }
      }}
    >
      {/* header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <MessageCircle size={14} className="text-[var(--color-accent)]" />
        <span className="text-[13px] font-medium text-[var(--color-text)]">contacts</span>
        <span className="text-[11px] text-[var(--color-muted)]">
          {customers.length} {customers.length === 1 ? "contact" : "contacts"}
        </span>

        <button
          onClick={() => setAddOpen(true)}
          className="ml-auto flex items-center gap-1 rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-2)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
          title="add a contact"
        >
          <Plus size={12} /> contact
        </button>
        <button
          onClick={loadCustomers}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <p className="shrink-0 px-3 py-1.5 text-[12px] text-[var(--color-danger)]">{error}</p>
      )}

      <div className="flex min-h-0 flex-1">
        {/* LEFT — searchable customer list (hidden on narrow widths once a chat is open) */}
        <div
          className={`${
            selected ? "hidden md:flex" : "flex"
          } w-full flex-col border-r border-[var(--color-border)] md:w-[300px] md:min-w-[300px]`}
        >
          {/* search */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-2.5 py-1.5">
            <Search size={12} className="text-[var(--color-faint)]" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (setQuery(""), e.currentTarget.blur())}
              placeholder="search contacts…  ( / )"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="rounded p-0.5 text-[var(--color-faint)] hover:text-[var(--color-text)]"
                title="clear"
              >
                <X size={11} />
              </button>
            )}
          </div>

          {/* segment chips */}
          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2.5 py-1.5">
            <SegChip label="all" count={customers.length} on={segment === "all"} onClick={() => setSegment("all")} />
            <SegChip label="active" count={activeCount} on={segment === "active"} onClick={() => setSegment("active")} />
          </div>

          {/* rows */}
          <div
            ref={listRef}
            tabIndex={0}
            onKeyDown={onListKey}
            className="min-h-0 flex-1 overflow-y-auto py-1 outline-none"
          >
            {loading && customers.length === 0 ? (
              Array.from({ length: 7 }).map((_, i) => <RowSkeleton key={i} />)
            ) : filtered.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12px] text-[var(--color-muted)]/60">
                {query
                  ? "no matches"
                  : segment === "active"
                    ? "no recent conversations"
                    : "no contacts yet — message someone or add one"}
              </div>
            ) : (
              filtered.map((c) => (
                <CustomerRow
                  key={c.handle || c.id}
                  customer={c}
                  active={c.handle === selectedHandle}
                  onClick={() => setSelectedHandle(c.handle)}
                />
              ))
            )}
          </div>
        </div>

        {/* RIGHT — conversation */}
        <div className={`${selected ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
          {selected ? (
            <Conversation
              key={selected.handle}
              customer={selected}
              onSent={loadCustomers}
              onBack={() => setSelectedHandle(null)}
            />
          ) : (
            <div className="grid h-full place-items-center px-6 text-center">
              <div className="flex flex-col items-center gap-2 text-[var(--color-faint)]">
                <Inbox size={28} className="opacity-50" />
                <span className="text-[12px]">select a customer to open the chat</span>
                <span className="text-[10px] opacity-70">↑ ↓ to move · / to search</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {addOpen && <AddContactModal onClose={() => setAddOpen(false)} onAdd={addContact} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Left list
// ════════════════════════════════════════════════════════════════════════

/** A segment-filter chip (all / active). */
function SegChip({
  label,
  count,
  on,
  onClick,
}: {
  label: string;
  count: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
        on
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
          : "text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
      }`}
    >
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

/** One row in the customer list — colour-keyed avatar (w/ live dot when the
 *  conversation moved recently), name, channel chip, media-aware preview, and
 *  time-ago. */
function CustomerRow({
  customer,
  active,
  onClick,
}: {
  customer: Customer;
  active: boolean;
  onClick: () => void;
}) {
  const media = mediaTag(customer.lastText);
  return (
    <button
      data-active={active}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
        active ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel-2)]"
      }`}
    >
      <Avatar name={customer.name} live={isVeryRecent(customer.lastAgo)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-text)]">
            {customer.name}
          </span>
          <ChannelChip channel={customer.channel} />
          {customer.lastAgo && (
            <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-faint)]">
              {customer.lastAgo} ago
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-[11px] text-[var(--color-muted)]">
            {media ? (
              <>
                <media.Icon size={11} className="shrink-0 text-[var(--color-faint)]" />
                <span className="truncate">{media.label}</span>
              </>
            ) : customer.lastText ? (
              <span className="truncate">{customer.lastText}</span>
            ) : (
              <span className="italic text-[var(--color-faint)]">no messages yet</span>
            )}
          </span>
          {customer.msgCount > 0 && (
            <span className="shrink-0 rounded-full bg-[var(--color-bg)] px-1.5 text-[9px] tabular-nums text-[var(--color-faint)]">
              {customer.msgCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

/** Shimmer placeholder while the list first loads. */
function RowSkeleton() {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <span className="h-7 w-7 shrink-0 animate-pulse rounded-md bg-[var(--color-panel-2)]" />
      <div className="min-w-0 flex-1">
        <span className="block h-2.5 w-1/2 animate-pulse rounded bg-[var(--color-panel-2)]" />
        <span className="mt-1.5 block h-2 w-4/5 animate-pulse rounded bg-[var(--color-panel-2)]" />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Right conversation
// ════════════════════════════════════════════════════════════════════════

/** A locally-appended optimistic message — same shape as InboxMessage plus a
 *  transient flag so we can render it slightly dimmed until the next poll. */
type ThreadMsg = InboxMessage & { pending?: boolean };

/** A bubble with its computed grouping/day-separator context. */
type Row = {
  msg: ThreadMsg;
  idx: number;
  daySep: string | null;
  groupStart: boolean;
  groupEnd: boolean;
};

/** The conversation with one customer: thread + composer. Polls the thread on a
 *  timer while mounted; sends optimistically. */
function Conversation({
  customer,
  onSent,
  onBack,
}: {
  customer: Customer;
  onSent: () => void;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ThreadMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  // Which channel to SEND on — the 0210 business number or firaz's personal
  // wwebjs WhatsApp. Defaults to the contact's own channel; switchable per thread.
  const [sendChannel, setSendChannel] = useState<InboxChannel>(
    (customer.channel as InboxChannel) || "whatsapp",
  );
  const [atBottom, setAtBottom] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);
  // Optimistic bubbles keyed by their text+ts so a refresh doesn't double them
  // forever — once the real log line shows up we drop the matching pending one.
  const pendingRef = useRef<ThreadMsg[]>([]);

  const loadThread = useCallback(async () => {
    try {
      const real = await customerThread(customer.handle, 300);
      // Keep any pending sends not yet reflected in the log.
      const realTexts = new Set(real.map((m) => `${m.direction}|${m.text}`));
      pendingRef.current = pendingRef.current.filter(
        (p) => !realTexts.has(`${p.direction}|${p.text}`),
      );
      setMessages([...real, ...pendingRef.current]);
    } catch (e) {
      setSendErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [customer.handle]);

  // Initial load + poll loop. Re-keys on handle (parent passes key=handle), so a
  // new customer remounts this cleanly.
  useEffect(() => {
    pendingRef.current = [];
    setMessages([]);
    setLoading(true);
    atBottomRef.current = true;
    setAtBottom(true);
    loadThread();
    const t = setInterval(loadThread, THREAD_POLL_MS);
    return () => clearInterval(t);
  }, [loadThread]);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Auto-scroll on new messages, but only if the reader was already at the
  // bottom — don't yank them away while they're reading history.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [messages.length, scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near;
    setAtBottom(near);
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSendErr(null);
    setSending(true);

    // Optimistic bubble.
    const optimistic: ThreadMsg = {
      ts: nowLocal(),
      tsAgo: null,
      direction: "out",
      text,
      pending: true,
    };
    pendingRef.current = [...pendingRef.current, optimistic];
    setMessages((prev) => [...prev, optimistic]);
    setDraft("");
    atBottomRef.current = true;
    requestAnimationFrame(() => scrollToBottom(true));

    try {
      await sendMessage(sendChannel, customer.handle, text);
      // Mark delivered; the next poll will reconcile against the real log line.
      setMessages((prev) =>
        prev.map((m) => (m === optimistic ? { ...m, pending: false } : m)),
      );
      pendingRef.current = pendingRef.current.map((m) =>
        m === optimistic ? { ...m, pending: false } : m,
      );
      onSent();
      // Pull the authoritative thread shortly after (gives the log a beat to flush).
      setTimeout(loadThread, 1200);
    } catch (e) {
      // Roll the optimistic bubble back + surface why.
      pendingRef.current = pendingRef.current.filter((m) => m !== optimistic);
      setMessages((prev) => prev.filter((m) => m !== optimistic));
      setDraft(text);
      setSendErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [draft, sending, sendChannel, customer.handle, loadThread, onSent, scrollToBottom]);

  // Precompute day separators + sender grouping once per message change.
  const rows = useMemo<Row[]>(() => {
    return messages.map((m, i) => {
      const prev = messages[i - 1];
      const next = messages[i + 1];
      const dk = dayKey(m.ts);
      const daySep = !prev || dayKey(prev.ts) !== dk ? daySeparatorLabel(dk) : null;
      const t = parseTs(m.ts);
      const gapFrom = (o?: ThreadMsg) => {
        if (!o) return true;
        const ot = parseTs(o.ts);
        return !Number.isFinite(t) || !Number.isFinite(ot)
          ? false
          : Math.abs(t - ot) > GROUP_GAP_MS;
      };
      const groupStart =
        !prev || prev.direction !== m.direction || !!daySep || gapFrom(prev);
      const nextNewDay = next && dayKey(next.ts) !== dk;
      const groupEnd =
        !next || next.direction !== m.direction || !!nextNewDay || gapFrom(next);
      return { msg: m, idx: i, daySep, groupStart, groupEnd };
    });
  }, [messages]);

  const presence = presenceLabel(customer.lastAgo);

  return (
    <>
      {/* conversation header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <button
          onClick={onBack}
          className="-ml-1 rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] md:hidden"
          title="back"
        >
          <ChevronLeft size={16} />
        </button>
        <Avatar name={customer.name} live={isVeryRecent(customer.lastAgo)} />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium leading-tight text-[var(--color-text)]">
            {customer.name}
          </div>
          <div className="flex items-center gap-1 text-[10px] leading-tight text-[var(--color-muted)]">
            {presence ? (
              <span className={isVeryRecent(customer.lastAgo) ? "text-[var(--color-success)]" : ""}>
                {presence}
              </span>
            ) : (
              <>
                <Phone size={9} className="shrink-0" />
                <span className="truncate tabular-nums">{customer.handle}</span>
              </>
            )}
          </div>
        </div>
        <SendChannelSwitch value={sendChannel} onChange={setSendChannel} className="ml-auto" />
        <RefreshCw
          size={11}
          className={`text-[var(--color-faint)] ${loading ? "animate-spin" : "opacity-0"}`}
        />
      </div>

      {/* thread */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-3">
          {loading && messages.length === 0 ? (
            <div className="grid h-full place-items-center text-[12px] text-[var(--color-faint)]">
              loading…
            </div>
          ) : messages.length === 0 ? (
            <div className="grid h-full place-items-center text-[12px] text-[var(--color-faint)]">
              no messages yet — say hi below
            </div>
          ) : (
            <div className="flex flex-col">
              {rows.map((row) => (
                <BubbleRow key={`${row.msg.ts}-${row.idx}`} row={row} name={customer.name} />
              ))}
            </div>
          )}
        </div>

        {/* jump-to-latest */}
        {!atBottom && messages.length > 0 && (
          <button
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-panel)] text-[var(--color-text-2)] shadow-lg transition-colors hover:text-[var(--color-text)]"
            title="jump to latest"
          >
            <ArrowDown size={15} />
          </button>
        )}
      </div>

      {/* composer */}
      <div className="shrink-0 border-t border-[var(--color-border)] px-3 py-2">
        {sendErr && <p className="mb-1.5 text-[11px] text-[var(--color-danger)]">{sendErr}</p>}
        <div className="flex items-end gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1.5 focus-within:border-[var(--color-accent)]/50">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter newlines.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={`message ${customer.name}…`}
            className="max-h-28 min-h-[20px] min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-snug text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
          />
          <button
            onClick={send}
            disabled={!draft.trim() || sending}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent)] text-white transition-opacity hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
            title="send (Enter)"
          >
            <Send size={13} className={sending ? "animate-pulse" : ""} />
          </button>
        </div>
      </div>
    </>
  );
}

/** One message row: optional day separator above, inbound avatar gutter, the
 *  bubble (corners merged within a sender group), and a timestamp/tick under the
 *  last bubble of each group. */
function BubbleRow({ row, name }: { row: Row; name: string }) {
  const { msg, daySep, groupStart, groupEnd, idx } = row;
  const out = msg.direction === "out";
  const media = mediaTag(msg.text);

  // Merge the inner corners of stacked same-sender bubbles.
  const corners = out
    ? `${groupStart ? "rounded-tr-2xl" : "rounded-tr-md"} ${groupEnd ? "rounded-br-sm" : "rounded-br-md"} rounded-l-2xl`
    : `${groupStart ? "rounded-tl-2xl" : "rounded-tl-md"} ${groupEnd ? "rounded-bl-sm" : "rounded-bl-md"} rounded-r-2xl`;

  return (
    <>
      {daySep && (
        <div className="my-2 flex items-center justify-center">
          <span className="rounded-full bg-[var(--color-panel-2)] px-2.5 py-0.5 text-[10px] font-medium text-[var(--color-muted)]">
            {daySep}
          </span>
        </div>
      )}
      <div
        className={`flex items-end gap-2 ${out ? "flex-row-reverse" : "flex-row"} ${
          groupStart && idx > 0 ? "mt-2" : "mt-0.5"
        }`}
      >
        {/* inbound avatar gutter — only at the bottom of a group */}
        {!out && (
          <div className="w-6 shrink-0">{groupEnd && <Avatar name={name} size={24} />}</div>
        )}
        <div className={`flex max-w-[78%] flex-col ${out ? "items-end" : "items-start"}`}>
          <div
            className={`whitespace-pre-wrap break-words px-3 py-1.5 text-[13px] leading-snug ${corners} ${
              out
                ? `bg-[var(--color-accent-soft)] text-[var(--color-text)] ${msg.pending ? "opacity-60" : ""}`
                : "bg-[var(--color-panel-2)] text-[var(--color-text)]"
            }`}
          >
            {media ? (
              <span className="flex items-center gap-1.5 text-[var(--color-text-2)]">
                <media.Icon size={14} className="shrink-0 opacity-80" />
                {media.label}
              </span>
            ) : msg.text ? (
              <Linkified text={msg.text} />
            ) : (
              <span className="italic text-[var(--color-faint)]">(empty)</span>
            )}
          </div>
          {groupEnd && (
            <span className="mt-0.5 flex items-center gap-0.5 px-1 text-[10px] tabular-nums text-[var(--color-faint)]">
              {msg.pending ? (
                <>
                  <Clock size={9} /> sending…
                </>
              ) : (
                <>
                  {hhmm(msg.ts)}
                  {out && <Check size={11} className="text-[var(--color-faint)]" />}
                </>
              )}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Add-contact modal
// ════════════════════════════════════════════════════════════════════════

/** Minimal "+ contact" form — name + phone, persisted via crm_save_contact. */
function AddContactModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (name: string, phone: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const save = async () => {
    const digits = phone.replace(/\D/g, "");
    if (!digits) {
      setErr("a phone number is required to message over whatsapp");
      return;
    }
    setErr(null);
    setSaving(true);
    try {
      await onAdd(name, phone);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Modal title="add contact" onClose={onClose}>
      <div
        className="flex flex-col gap-2.5"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
        }}
      >
        <Field label="name">
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. acme — sarah"
            className={inputCls}
          />
        </Field>
        <Field label="phone / whatsapp">
          <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1 focus-within:border-[var(--color-accent)]/50">
            <Phone size={12} className="shrink-0 text-[var(--color-faint)]" />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              inputMode="tel"
              placeholder="60123456789"
              className="min-w-0 flex-1 bg-transparent text-[12px] tabular-nums text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
            />
          </div>
        </Field>

        {err && <p className="text-[11px] text-[var(--color-danger)]">{err}</p>}

        <div className="mt-1 flex items-center gap-2">
          <button
            onClick={onClose}
            className="ml-auto rounded-md px-3 py-1 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {saving ? "adding…" : "add contact"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════
// shared bits
// ════════════════════════════════════════════════════════════════════════

const inputCls =
  "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1 text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)] focus:border-[var(--color-accent)]/50";

/** Local "YYYY-MM-DD HH:MM" for an optimistic bubble (matches backend format). */
function nowLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

// ── time + grouping helpers ──────────────────────────────────────────────

/** "YYYY-MM-DD HH:MM" → epoch ms (local), or NaN. */
function parseTs(ts: string): number {
  return Date.parse(ts.replace(" ", "T"));
}

/** "YYYY-MM-DD HH:MM" → "HH:MM". */
function hhmm(ts: string): string {
  return ts.split(" ")[1] ?? ts;
}

/** "YYYY-MM-DD HH:MM" → "YYYY-MM-DD". */
function dayKey(ts: string): string {
  return ts.split(" ")[0] ?? ts;
}

/** Friendly date label for a day separator: today / yesterday / "Mar 3" / "Mar 3, 2025". */
function daySeparatorLabel(dk: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = new Date();
  const yday = new Date(today);
  yday.setDate(today.getDate() - 1);
  if (dk === key(today)) return "today";
  if (dk === key(yday)) return "yesterday";
  const d = new Date(`${dk}T00:00`);
  if (Number.isNaN(d.getTime())) return dk;
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
}

/** Recent = the conversation moved within ~a day (seconds / minutes / hours). */
function isRecent(lastAgo: string | null): boolean {
  if (!lastAgo) return false;
  return /^\d+(s|m|h)$/.test(lastAgo.trim());
}

/** Very recent = seconds or single/low minutes — drives the live dot. */
function isVeryRecent(lastAgo: string | null): boolean {
  if (!lastAgo) return false;
  const m = lastAgo.trim().match(/^(\d+)(s|m)$/);
  if (!m) return false;
  return m[2] === "s" || Number(m[1]) <= 10;
}

/** Header presence line: "active 4m ago" when recent, else null (falls back to phone). */
function presenceLabel(lastAgo: string | null): string | null {
  if (!isRecent(lastAgo)) return null;
  return isVeryRecent(lastAgo) ? "online" : `active ${lastAgo} ago`;
}

/** If a message body is a bare media tag (`[image]` etc.), map it to an icon + label. */
function mediaTag(text: string): { Icon: typeof ImageIcon; label: string } | null {
  const m = text.trim().match(/^\[([\w-]+)\]$/);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  switch (kind) {
    case "image":
    case "photo":
    case "sticker":
      return { Icon: kind === "sticker" ? Sticker : ImageIcon, label: kind === "sticker" ? "sticker" : "photo" };
    case "video":
      return { Icon: Video, label: "video" };
    case "audio":
    case "ptt":
    case "voice":
      return { Icon: Mic, label: "voice message" };
    case "document":
    case "file":
      return { Icon: FileText, label: "document" };
    case "location":
      return { Icon: MapPin, label: "location" };
    default:
      return { Icon: Paperclip, label: kind };
  }
}

/** Renders message text with bare URLs turned into accent links. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            target="_blank"
            rel="noreferrer"
            className="break-all text-[var(--color-accent)] underline decoration-[var(--color-accent)]/40 underline-offset-2 hover:decoration-[var(--color-accent)]"
          >
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** A labelled form field. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
        {label}
      </span>
      {children}
    </label>
  );
}

/** Deterministic hue [0,360) from a string — keeps each contact a stable colour. */
function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Initials avatar — a deterministic colour keyed to the name, with an optional
 *  live dot. Reads correctly in both themes (tinted fg on a soft wash). */
function Avatar({ name, size = 28, live = false }: { name: string; size?: number; live?: boolean }) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?";
  const hue = hueFor(name);
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      <span
        className="flex h-full w-full items-center justify-center rounded-md font-semibold"
        style={{
          fontSize: Math.round(size * 0.36),
          color: `oklch(0.66 0.15 ${hue})`,
          backgroundColor: `oklch(0.66 0.15 ${hue} / 18%)`,
        }}
      >
        {initials}
      </span>
      {live && (
        <span
          className="status-dot status-dot--active absolute -bottom-0.5 -right-0.5 !h-2 !w-2 ring-2"
          style={{ ["--tw-ring-color" as string]: "var(--color-pane)" }}
        />
      )}
    </span>
  );
}

/** Segmented switcher for which channel to SEND on — the 0210 business number
 *  vs firaz's personal wwebjs WhatsApp. Drives sendMessage's channel arg. */
function SendChannelSwitch({
  value,
  onChange,
  className = "",
}: {
  value: InboxChannel;
  onChange: (c: InboxChannel) => void;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex shrink-0 overflow-hidden rounded-full border border-[var(--color-border)] ${className}`}
      title="send via which WhatsApp account"
    >
      {SENDABLE_CHANNELS.map((c) => {
        const active = value === c.id;
        return (
          <button
            key={c.id}
            onClick={() => onChange(c.id)}
            className={`flex items-center gap-1 px-2 py-0.5 text-[9px] transition-colors ${
              active
                ? "bg-[var(--color-accent-soft)] text-[var(--color-text)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            <span className={`status-dot ${active ? "status-dot--active" : "status-dot--cold"} !h-1.5 !w-1.5`} />
            {c.short}
          </button>
        );
      })}
    </div>
  );
}

/** Small channel chip — WhatsApp green, others muted. Includes a status dot. */
function ChannelChip({ channel, className = "" }: { channel: InboxChannel; className?: string }) {
  const isWa = channel === "whatsapp";
  const color = isWa
    ? "text-[var(--color-success)]"
    : channel === "instagram"
      ? "text-[var(--color-accent)]"
      : "text-[var(--color-muted)]";
  return (
    <span
      className={`flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[9px] ${color} ${className}`}
    >
      <span className={`status-dot ${isWa ? "status-dot--active" : "status-dot--cold"} !h-1.5 !w-1.5`} />
      {channel}
    </span>
  );
}

/** A small centered modal with a scrim. Esc closes. */
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[340px] flex-col rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel)] shadow-2xl"
      >
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
          <span className="text-[12px] font-medium text-[var(--color-text)]">{title}</span>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-3">{children}</div>
      </div>
    </div>
  );
}
