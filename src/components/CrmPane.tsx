/** Customer messaging INBOX — the superapp's customer-comms surface. Not a deal
 *  pipeline: this is where you talk to customers over the channels AIOS already
 *  speaks (WhatsApp today, more later) and see everyone you can message.
 *
 *  Two panes, WhatsApp/iMessage style:
 *    - LEFT — a searchable list of customers (merged from the WhatsApp logs +
 *      manual contacts in crm.json), each with avatar, channel chip, last-msg
 *      preview, and "Xm ago". Click to select.
 *    - RIGHT — the conversation with the selected customer: chat bubbles (out =
 *      accent-tinted right, in = panel-2 left), scrollable with newest at the
 *      bottom, and a composer that sends over the bridge (optimistic append).
 *      The thread polls every ~10s while open.
 *
 *  Data comes from `lib/inbox.ts` (Rust `list_customers` / `customer_thread` /
 *  `send_message`). Adding a manual contact reuses `lib/crm.ts` →
 *  `crm_save_contact`. Brand --color-* tokens only (light+dark safe). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Inbox,
  MessageCircle,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Send,
  X,
} from "lucide-react";

import {
  customerThread,
  listCustomers,
  sendMessage,
  type Customer,
  type InboxChannel,
  type InboxMessage,
} from "../lib/inbox";
import { crmSaveContact, type Channel } from "../lib/crm";

/** How often the open thread re-fetches from the logs (ms). */
const THREAD_POLL_MS = 10_000;
/** How often the customer list re-fetches (ms) — slower; it's the index. */
const LIST_POLL_MS = 30_000;

export function CrmPane() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedHandle, setSelectedHandle] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      [c.name, c.handle, c.lastText, c.channel]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(q)),
    );
  }, [customers, query]);

  const selected = useMemo(
    () => (selectedHandle ? customers.find((c) => c.handle === selectedHandle) ?? null : null),
    [customers, selectedHandle],
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
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--color-pane)] text-[13px]">
      {/* header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <MessageCircle size={14} className="text-[var(--color-accent)]" />
        <span className="text-[13px] font-medium text-[var(--color-text)]">inbox</span>
        <span className="text-[11px] text-[var(--color-muted)]">
          {customers.length} {customers.length === 1 ? "customer" : "customers"}
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
        {/* LEFT — searchable customer list */}
        <div className="flex w-[300px] min-w-[300px] flex-col border-r border-[var(--color-border)]">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-2.5 py-1.5">
            <Search size={12} className="text-[var(--color-faint)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search customers…"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {filtered.map((c) => (
              <CustomerRow
                key={c.handle || c.id}
                customer={c}
                active={c.handle === selectedHandle}
                onClick={() => setSelectedHandle(c.handle)}
              />
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-8 text-center text-[12px] text-[var(--color-muted)]/60">
                {query ? "no matches" : "no customers yet — message someone or add a contact"}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — conversation */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <Conversation key={selected.handle} customer={selected} onSent={loadCustomers} />
          ) : (
            <div className="grid h-full place-items-center px-6 text-center">
              <div className="flex flex-col items-center gap-2 text-[var(--color-faint)]">
                <Inbox size={28} className="opacity-50" />
                <span className="text-[12px]">select a customer to open the chat</span>
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

/** One row in the customer list — avatar, name, channel chip, last-msg preview,
 *  and time-ago. */
function CustomerRow({
  customer,
  active,
  onClick,
}: {
  customer: Customer;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
        active ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel-2)]"
      }`}
    >
      <Avatar name={customer.name} />
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
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-muted)]">
            {customer.lastText || (
              <span className="text-[var(--color-faint)] italic">no messages yet</span>
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

// ════════════════════════════════════════════════════════════════════════
// Right conversation
// ════════════════════════════════════════════════════════════════════════

/** A locally-appended optimistic message — same shape as InboxMessage plus a
 *  transient flag so we can render it slightly dimmed until the next poll. */
type ThreadMsg = InboxMessage & { pending?: boolean };

/** The conversation with one customer: thread + composer. Polls the thread on a
 *  timer while mounted; sends optimistically. */
function Conversation({ customer, onSent }: { customer: Customer; onSent: () => void }) {
  const [messages, setMessages] = useState<ThreadMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
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
    loadThread();
    const t = setInterval(loadThread, THREAD_POLL_MS);
    return () => clearInterval(t);
  }, [loadThread]);

  // Auto-scroll to newest whenever the message list grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

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

    try {
      await sendMessage(customer.channel as InboxChannel, customer.handle, text);
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
  }, [draft, sending, customer.channel, customer.handle, loadThread, onSent]);

  return (
    <>
      {/* conversation header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Avatar name={customer.name} />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium leading-tight text-[var(--color-text)]">
            {customer.name}
          </div>
          <div className="flex items-center gap-1 text-[10px] leading-tight text-[var(--color-muted)]">
            <Phone size={9} className="shrink-0" />
            <span className="truncate tabular-nums">{customer.handle}</span>
          </div>
        </div>
        <ChannelChip channel={customer.channel} className="ml-auto" />
        <RefreshCw
          size={11}
          className={`text-[var(--color-faint)] ${loading ? "animate-spin" : "opacity-0"}`}
        />
      </div>

      {/* thread */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading && messages.length === 0 ? (
          <div className="grid h-full place-items-center text-[12px] text-[var(--color-faint)]">
            loading…
          </div>
        ) : messages.length === 0 ? (
          <div className="grid h-full place-items-center text-[12px] text-[var(--color-faint)]">
            no messages yet — say hi below
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {messages.map((m, i) => (
              <Bubble key={`${m.ts}-${i}`} msg={m} />
            ))}
          </div>
        )}
      </div>

      {/* composer */}
      <div className="shrink-0 border-t border-[var(--color-border)] px-3 py-2">
        {sendErr && (
          <p className="mb-1.5 text-[11px] text-[var(--color-danger)]">{sendErr}</p>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1.5 focus-within:border-[var(--color-accent)]/50">
          <textarea
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

/** A single chat bubble. Outbound = accent-tinted, right-aligned; inbound =
 *  panel-2, left-aligned. Timestamp under each. */
function Bubble({ msg }: { msg: ThreadMsg }) {
  const out = msg.direction === "out";
  return (
    <div className={`flex flex-col ${out ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[13px] leading-snug ${
          out
            ? `rounded-br-sm bg-[var(--color-accent-soft)] text-[var(--color-text)] ${
                msg.pending ? "opacity-60" : ""
              }`
            : "rounded-bl-sm bg-[var(--color-panel-2)] text-[var(--color-text)]"
        }`}
      >
        {msg.text || <span className="text-[var(--color-faint)] italic">(empty)</span>}
      </div>
      <span className="mt-0.5 px-1 text-[10px] tabular-nums text-[var(--color-faint)]">
        {msg.pending ? "sending…" : msg.ts}
      </span>
    </div>
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

/** Initials avatar — deterministic accent-tinted square. */
function Avatar({ name }: { name: string }) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?";
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-soft)] text-[10px] font-semibold text-[var(--color-accent)]">
      {initials}
    </span>
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
