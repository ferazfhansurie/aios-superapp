/** CRM pane — a fast, agency-grade contacts + deal-pipeline tool for closing
 *  client deals. Two views toggled in the header:
 *    1. Pipeline — a Kanban board (lead → contacted → proposal → won/lost) with
 *       HTML5 drag-drop between columns; moving a card persists its new stage.
 *    2. Contacts — a searchable list with a side detail panel for inline edits,
 *       notes, and the contact's linked deals.
 *
 *  Distilled essence, not enterprise bloat:
 *    - Attio/Folk: minimal chrome, dense rows, channel + tag chips, a clean
 *      record detail panel that edits in place.
 *    - Pipedrive: the deal Kanban with per-column count + total value, drag to
 *      advance a stage.
 *    - HubSpot: lead → won/lost lifecycle as the spine.
 *    - Notion CRM: everything is one flexible local store; no setup.
 *
 *  All persistence goes through `lib/crm.ts` → the Rust `crm_*` commands
 *  (JSON at ~/.aios/state/crm.json). Brand --color-* tokens only (light+dark). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Building2,
  GripVertical,
  KanbanSquare,
  Mail,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  Trophy,
  Users,
  X,
} from "lucide-react";

import {
  crmDeleteContact,
  crmDeleteDeal,
  crmLoad,
  crmSaveContact,
  crmSaveDeal,
  formatValue,
  STAGE_LABELS,
  STAGES,
  type Channel,
  type Contact,
  type Currency,
  type Deal,
  type Stage,
} from "../lib/crm";

// ── stage → brand styling ───────────────────────────────────────────────────
// lead=muted, contacted=info(blue), proposal=warning(amber), won=success(green),
// lost=danger. `dot` reuses the App.css status-dot classes; `text`/`bar` are
// --color-* arbitrary values so they track light+dark automatically.
const STAGE_STYLE: Record<Stage, { dot: string; text: string; bar: string }> = {
  lead: { dot: "status-dot--cold", text: "text-[var(--color-muted)]", bar: "bg-[var(--color-muted)]" },
  contacted: { dot: "status-dot--dormant", text: "text-[var(--color-info)]", bar: "bg-[var(--color-info)]" },
  proposal: { dot: "status-dot--idle", text: "text-[var(--color-warning)]", bar: "bg-[var(--color-warning)]" },
  won: { dot: "status-dot--active", text: "text-[var(--color-success)]", bar: "bg-[var(--color-success)]" },
  lost: { dot: "", text: "text-[var(--color-danger)]", bar: "bg-[var(--color-danger)]" },
};

const CHANNELS: Channel[] = ["whatsapp", "instagram", "telegram", "email", "phone", "referral", "other"];

type View = "pipeline" | "contacts";

export function CrmPane() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("pipeline");

  const load = useCallback(async () => {
    setError(null);
    try {
      const store = await crmLoad();
      setContacts(store.contacts);
      setDeals(store.deals);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Fast name lookup for rendering a deal's linked contact.
  const contactById = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of contacts) m.set(c.id, c);
    return m;
  }, [contacts]);

  // ── deal mutations (optimistic, then persist) ─────────────────────────────
  const persistDeal = useCallback(async (deal: Deal) => {
    setDeals((prev) => {
      const i = prev.findIndex((d) => d.id === deal.id);
      if (i === -1) return [...prev, deal];
      const next = [...prev];
      next[i] = deal;
      return next;
    });
    try {
      const id = await crmSaveDeal(deal);
      // Reconcile a freshly-minted id from the backend.
      if (id && id !== deal.id) {
        setDeals((prev) => prev.map((d) => (d === deal || d.id === deal.id ? { ...deal, id } : d)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load(); // resync on failure
    }
  }, [load]);

  const moveDeal = useCallback((id: string, stage: Stage) => {
    const deal = deals.find((d) => d.id === id);
    if (!deal || deal.stage === stage) return;
    persistDeal({ ...deal, stage, updatedAt: Date.now() });
  }, [deals, persistDeal]);

  const removeDeal = useCallback(async (id: string) => {
    setDeals((prev) => prev.filter((d) => d.id !== id));
    try {
      await crmDeleteDeal(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  }, [load]);

  // ── contact mutations ─────────────────────────────────────────────────────
  const persistContact = useCallback(async (contact: Contact): Promise<string> => {
    setContacts((prev) => {
      const i = prev.findIndex((c) => c.id === contact.id);
      if (i === -1) return [...prev, contact];
      const next = [...prev];
      next[i] = contact;
      return next;
    });
    try {
      const id = await crmSaveContact(contact);
      if (id && id !== contact.id) {
        setContacts((prev) => prev.map((c) => (c.id === contact.id ? { ...contact, id } : c)));
      }
      return id || contact.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
      return contact.id;
    }
  }, [load]);

  const removeContact = useCallback(async (id: string) => {
    setContacts((prev) => prev.filter((c) => c.id !== id));
    try {
      await crmDeleteContact(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  }, [load]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--color-pane)] text-[13px]">
      {/* header: icon + title + counts + view toggle + refresh */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Users size={14} className="text-[var(--color-accent)]" />
        <span className="text-[13px] font-medium text-[var(--color-text)]">crm</span>
        <span className="text-[11px] text-[var(--color-muted)]">
          {contacts.length} {contacts.length === 1 ? "contact" : "contacts"} · {deals.length}{" "}
          {deals.length === 1 ? "deal" : "deals"}
        </span>

        {/* segmented control */}
        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 p-0.5">
          <SegBtn active={view === "pipeline"} onClick={() => setView("pipeline")} icon={<KanbanSquare size={12} />} label="pipeline" />
          <SegBtn active={view === "contacts"} onClick={() => setView("contacts")} icon={<Users size={12} />} label="contacts" />
        </div>

        <button
          onClick={load}
          className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && <p className="shrink-0 px-3 py-1.5 text-[12px] text-[var(--color-danger)]">{error}</p>}

      {view === "pipeline" ? (
        <PipelineView
          deals={deals}
          contacts={contacts}
          contactById={contactById}
          onMove={moveDeal}
          onSave={persistDeal}
          onDelete={removeDeal}
        />
      ) : (
        <ContactsView
          contacts={contacts}
          deals={deals}
          onSave={persistContact}
          onDelete={removeContact}
        />
      )}
    </div>
  );
}

/** One button in the header's pipeline|contacts segmented control. */
function SegBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? "bg-[var(--color-accent-soft)] text-[var(--color-text)]"
          : "text-[var(--color-muted)] hover:text-[var(--color-text-2)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Pipeline (Kanban)
// ════════════════════════════════════════════════════════════════════════

function PipelineView({
  deals,
  contacts,
  contactById,
  onMove,
  onSave,
  onDelete,
}: {
  deals: Deal[];
  contacts: Contact[];
  contactById: Map<string, Contact>;
  onMove: (id: string, stage: Stage) => void;
  onSave: (deal: Deal) => void;
  onDelete: (id: string) => void;
}) {
  // Which column is hovered during a drag (for the drop highlight).
  const [dragOver, setDragOver] = useState<Stage | null>(null);
  // The deal being edited (existing) — or a stage-seeded blank for "+ deal".
  const [editing, setEditing] = useState<{ deal: Partial<Deal>; isNew: boolean } | null>(null);

  const byStage = useMemo(() => {
    const m: Record<Stage, Deal[]> = { lead: [], contacted: [], proposal: [], won: [], lost: [] };
    for (const d of deals) (m[d.stage] ?? m.lead).push(d);
    // Newest-updated first within a column.
    for (const s of STAGES) m[s].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return m;
  }, [deals]);

  const openNew = (stage: Stage) =>
    setEditing({
      isNew: true,
      deal: { title: "", stage, currency: "RM", contactId: contacts[0]?.id },
    });

  return (
    <>
      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-2">
        {STAGES.map((stage) => {
          const cards = byStage[stage];
          const total = cards.reduce((sum, d) => sum + (d.value ?? 0), 0);
          const style = STAGE_STYLE[stage];
          const isWonLost = stage === "won" || stage === "lost";
          return (
            <div
              key={stage}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOver !== stage) setDragOver(stage);
              }}
              onDragLeave={(e) => {
                // Only clear when truly leaving the column (not entering a child).
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver((s) => (s === stage ? null : s));
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const id = e.dataTransfer.getData("application/x-aios-deal");
                if (id) onMove(id, stage);
              }}
              className={`flex w-[210px] min-w-[210px] flex-col rounded-lg border transition-colors ${
                dragOver === stage
                  ? "border-[var(--color-accent)]/60 bg-[var(--color-accent-soft)]"
                  : "border-[var(--color-border)] bg-[var(--color-panel-2)]/20"
              }`}
            >
              {/* column header: dot + label + count + total value */}
              <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-2.5 py-1.5">
                {style.dot ? (
                  <span className={`status-dot shrink-0 ${style.dot}`} />
                ) : (
                  <span className={`h-2 w-2 shrink-0 rounded-full ${style.bar}`} />
                )}
                <span className={`text-[12px] font-medium ${style.text}`}>
                  {isWonLost && stage === "won" ? (
                    <span className="inline-flex items-center gap-1">
                      <Trophy size={11} /> {STAGE_LABELS[stage]}
                    </span>
                  ) : (
                    STAGE_LABELS[stage]
                  )}
                </span>
                <span className="ml-auto rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--color-muted)]">
                  {cards.length}
                </span>
                <button
                  onClick={() => openNew(stage)}
                  className="rounded p-0.5 text-[var(--color-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                  title={`add deal in ${stage}`}
                >
                  <Plus size={13} />
                </button>
              </div>
              {total > 0 && (
                <div className="border-b border-[var(--color-border)]/60 px-2.5 py-1 text-[10px] font-mono text-[var(--color-faint)]">
                  {formatValue(total)}
                </div>
              )}

              {/* cards */}
              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
                {cards.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    contactName={deal.contactId ? contactById.get(deal.contactId)?.name : undefined}
                    onClick={() => setEditing({ deal, isNew: false })}
                  />
                ))}
                {cards.length === 0 && (
                  <button
                    onClick={() => openNew(stage)}
                    className="mt-1 rounded-md border border-dashed border-[var(--color-border)] px-2 py-3 text-[11px] text-[var(--color-faint)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-muted)]"
                  >
                    {stage === "lead" ? "no deals yet — add your first" : "drop a deal here"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <DealModal
          initial={editing.deal}
          isNew={editing.isNew}
          contacts={contacts}
          onClose={() => setEditing(null)}
          onSave={(d) => {
            onSave(d);
            setEditing(null);
          }}
          onDelete={
            editing.isNew || !editing.deal.id
              ? undefined
              : () => {
                  onDelete(editing.deal.id!);
                  setEditing(null);
                }
          }
        />
      )}
    </>
  );
}

/** A draggable deal card: title, linked contact, formatted value. */
function DealCard({
  deal,
  contactName,
  onClick,
}: {
  deal: Deal;
  contactName?: string;
  onClick: () => void;
}) {
  const value = formatValue(deal.value, deal.currency ?? "RM");
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-aios-deal", deal.id);
        e.dataTransfer.setData("text/plain", deal.title);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onClick}
      className="group flex cursor-grab flex-col gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 transition-colors hover:border-[var(--color-border-strong)] active:cursor-grabbing"
      title="drag to another column to change stage · click to edit"
    >
      <div className="flex items-start gap-1">
        <GripVertical
          size={12}
          className="mt-0.5 shrink-0 text-[var(--color-faint)] opacity-0 transition-opacity group-hover:opacity-100"
        />
        <span className="min-w-0 flex-1 break-words text-[12px] font-medium leading-snug text-[var(--color-text)]">
          {deal.title || "untitled deal"}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 pl-[18px]">
        {contactName ? (
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--color-muted)]">
            <Users size={10} className="shrink-0" />
            <span className="truncate">{contactName}</span>
          </span>
        ) : (
          <span className="text-[11px] text-[var(--color-faint)]">no contact</span>
        )}
        {value && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-2)]">{value}</span>
        )}
      </div>
    </div>
  );
}

/** Create/edit-deal modal. Compact, keyboard-friendly (Esc closes, ⌘/Ctrl+Enter
 *  saves, Enter in the title saves). */
function DealModal({
  initial,
  isNew,
  contacts,
  onClose,
  onSave,
  onDelete,
}: {
  initial: Partial<Deal>;
  isNew: boolean;
  contacts: Contact[];
  onClose: () => void;
  onSave: (deal: Deal) => void;
  onDelete?: () => void;
}) {
  const [title, setTitle] = useState(initial.title ?? "");
  const [contactId, setContactId] = useState(initial.contactId ?? "");
  const [valueStr, setValueStr] = useState(initial.value != null ? String(initial.value) : "");
  const [currency, setCurrency] = useState<Currency>(initial.currency ?? "RM");
  const [stage, setStage] = useState<Stage>(initial.stage ?? "lead");
  const [notes, setNotes] = useState(initial.notes ?? "");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const save = () => {
    const t = title.trim();
    if (!t) {
      titleRef.current?.focus();
      return;
    }
    const now = Date.now();
    const value = valueStr.trim() === "" ? undefined : Number(valueStr.replace(/[, ]/g, ""));
    onSave({
      id: initial.id ?? "",
      title: t,
      contactId: contactId || undefined,
      value: value != null && !Number.isNaN(value) ? value : undefined,
      currency,
      stage,
      notes: notes.trim() || undefined,
      createdAt: initial.createdAt ?? now,
      updatedAt: now,
    });
  };

  return (
    <Modal title={isNew ? "new deal" : "edit deal"} onClose={onClose}>
      <div
        className="flex flex-col gap-2.5"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
        }}
      >
        <Field label="title">
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && save()}
            placeholder="e.g. acme — social media retainer"
            className={inputCls}
          />
        </Field>

        <div className="grid grid-cols-2 gap-2.5">
          <Field label="contact">
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} className={inputCls}>
              <option value="">— none —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.company ? ` · ${c.company}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="stage">
            <select value={stage} onChange={(e) => setStage(e.target.value as Stage)} className={inputCls}>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="value">
          <div className="flex gap-1.5">
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
              className={`${inputCls} w-20 shrink-0`}
            >
              <option value="RM">RM</option>
              <option value="USD">USD</option>
            </select>
            <input
              value={valueStr}
              onChange={(e) => setValueStr(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              inputMode="numeric"
              placeholder="5000"
              className={`${inputCls} flex-1`}
            />
          </div>
        </Field>

        <Field label="notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="context, next step…"
            className={`${inputCls} resize-none`}
          />
        </Field>

        <div className="mt-1 flex items-center gap-2">
          {onDelete && (
            <button
              onClick={onDelete}
              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-danger)] hover:border-[var(--color-danger)]/50"
              title="delete deal"
            >
              <Trash2 size={12} /> delete
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded-md px-3 py-1 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            cancel
          </button>
          <button
            onClick={save}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)]"
          >
            {isNew ? "create deal" : "save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Contacts
// ════════════════════════════════════════════════════════════════════════

function ContactsView({
  contacts,
  deals,
  onSave,
  onDelete,
}: {
  contacts: Contact[];
  deals: Deal[];
  onSave: (contact: Contact) => Promise<string>;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = [...contacts].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return list;
    return list.filter((c) =>
      [c.name, c.company, c.email, c.phone, c.channel, ...(c.tags ?? [])]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(q)),
    );
  }, [contacts, query]);

  const selected = selectedId ? contacts.find((c) => c.id === selectedId) ?? null : null;

  const addContact = async () => {
    const now = Date.now();
    const id = await onSave({ id: "", name: "new contact", channel: "whatsapp", createdAt: now });
    setSelectedId(id);
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* left: search + list */}
      <div className="flex w-[44%] min-w-[260px] flex-col border-r border-[var(--color-border)]">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-2.5 py-1.5">
          <Search size={12} className="text-[var(--color-faint)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search contacts…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
          />
          <button
            onClick={addContact}
            className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-2)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
            title="add contact"
          >
            <Plus size={12} /> contact
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {filtered.map((c) => {
            const dealCount = deals.filter((d) => d.contactId === c.id).length;
            return (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                  selectedId === c.id ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-panel-2)]"
                }`}
              >
                <Avatar name={c.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-[var(--color-text)]">{c.name}</span>
                    {c.channel && <ChannelChip channel={c.channel} />}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
                    {c.company && (
                      <span className="flex min-w-0 items-center gap-1">
                        <Building2 size={10} className="shrink-0" />
                        <span className="truncate">{c.company}</span>
                      </span>
                    )}
                    {dealCount > 0 && <span className="shrink-0 text-[var(--color-faint)]">· {dealCount} deal{dealCount === 1 ? "" : "s"}</span>}
                  </div>
                  {c.tags && c.tags.length > 0 && (
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {c.tags.slice(0, 4).map((t) => (
                        <TagChip key={t} tag={t} />
                      ))}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--color-muted)]/60">
              {query ? "no matches" : "no contacts yet — add your first"}
            </div>
          )}
        </div>
      </div>

      {/* right: detail */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <ContactDetail
            key={selected.id}
            contact={selected}
            deals={deals.filter((d) => d.contactId === selected.id)}
            onSave={onSave}
            onDelete={() => {
              onDelete(selected.id);
              setSelectedId(null);
            }}
          />
        ) : (
          <div className="grid h-full place-items-center px-6 text-center text-[12px] text-[var(--color-faint)]">
            select a contact to view + edit
          </div>
        )}
      </div>
    </div>
  );
}

/** The side detail panel — edits fields inline (debounced auto-save on blur),
 *  shows the contact's deals. */
function ContactDetail({
  contact,
  deals,
  onSave,
  onDelete,
}: {
  contact: Contact;
  deals: Deal[];
  onSave: (contact: Contact) => Promise<string>;
  onDelete: () => void;
}) {
  // Local draft; commit to the store on blur / channel change.
  const [draft, setDraft] = useState<Contact>(contact);
  const [tagInput, setTagInput] = useState("");

  // Re-seed when a different contact is selected (key already remounts, but be safe).
  useEffect(() => setDraft(contact), [contact]);

  const commit = (patch: Partial<Contact>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onSave(next);
  };

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    const tags = Array.from(new Set([...(draft.tags ?? []), t]));
    commit({ tags });
    setTagInput("");
  };
  const removeTag = (t: string) => commit({ tags: (draft.tags ?? []).filter((x) => x !== t) });

  return (
    <>
      {/* detail header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Avatar name={draft.name} />
        <span className="truncate text-[13px] font-medium text-[var(--color-text)]">{draft.name || "unnamed"}</span>
        <button
          onClick={onDelete}
          className="ml-auto flex items-center gap-1 rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-danger)]"
          title="delete contact"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-2.5">
          <Field label="name">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onBlur={() => onSave(draft)}
              className={inputCls}
            />
          </Field>
          <Field label="company">
            <DetailInput
              icon={<Building2 size={12} />}
              value={draft.company ?? ""}
              placeholder="company"
              onChange={(v) => setDraft({ ...draft, company: v })}
              onCommit={() => onSave(draft)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="email">
              <DetailInput
                icon={<Mail size={12} />}
                value={draft.email ?? ""}
                placeholder="email"
                onChange={(v) => setDraft({ ...draft, email: v })}
                onCommit={() => onSave(draft)}
              />
            </Field>
            <Field label="phone">
              <DetailInput
                icon={<Phone size={12} />}
                value={draft.phone ?? ""}
                placeholder="phone"
                onChange={(v) => setDraft({ ...draft, phone: v })}
                onCommit={() => onSave(draft)}
              />
            </Field>
          </div>
          <Field label="channel">
            <select
              value={draft.channel ?? "other"}
              onChange={(e) => commit({ channel: e.target.value as Channel })}
              className={inputCls}
            >
              {CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {ch}
                </option>
              ))}
            </select>
          </Field>

          {/* tags */}
          <Field label="tags">
            <div className="flex flex-wrap items-center gap-1.5">
              {(draft.tags ?? []).map((t) => (
                <span
                  key={t}
                  className="flex items-center gap-1 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--color-text-2)]"
                >
                  <Tag size={9} />
                  {t}
                  <button onClick={() => removeTag(t)} className="hover:text-[var(--color-danger)]">
                    <X size={10} />
                  </button>
                </span>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTag();
                  if (e.key === "Backspace" && !tagInput && (draft.tags ?? []).length) {
                    removeTag((draft.tags ?? [])[draft.tags!.length - 1]);
                  }
                }}
                onBlur={addTag}
                placeholder="+ tag"
                className="min-w-[60px] flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
              />
            </div>
          </Field>

          <Field label="notes">
            <textarea
              value={draft.notes ?? ""}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              onBlur={() => onSave(draft)}
              rows={4}
              placeholder="anything worth remembering…"
              className={`${inputCls} resize-none`}
            />
          </Field>

          {/* linked deals */}
          <div className="mt-1">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-muted)]">
              <KanbanSquare size={11} /> deals
              <span className="text-[var(--color-faint)]">({deals.length})</span>
            </div>
            {deals.length === 0 ? (
              <p className="text-[11px] text-[var(--color-faint)]">no deals linked — create one in the pipeline.</p>
            ) : (
              <div className="flex flex-col gap-1">
                {deals
                  .slice()
                  .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                  .map((d) => {
                    const style = STAGE_STYLE[d.stage];
                    return (
                      <div
                        key={d.id}
                        className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/30 px-2 py-1.5"
                      >
                        <span className={`h-2 w-2 shrink-0 rounded-full ${style.bar}`} />
                        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-2)]">{d.title}</span>
                        <span className={`shrink-0 text-[10px] ${style.text}`}>{STAGE_LABELS[d.stage]}</span>
                        {d.value != null && (
                          <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-muted)]">
                            {formatValue(d.value, d.currency ?? "RM")}
                          </span>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          <p className="mt-1 text-[10px] text-[var(--color-faint)]">
            added {new Date(draft.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>
    </>
  );
}

// ── small shared bits ───────────────────────────────────────────────────────

const inputCls =
  "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1 text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)] focus:border-[var(--color-accent)]/50";

/** A labelled form field. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-faint)]">{label}</span>
      {children}
    </label>
  );
}

/** A leading-icon text input that commits its value on blur — used for the
 *  contact detail fields so edits feel inline. */
function DetailInput({
  icon,
  value,
  placeholder,
  onChange,
  onCommit,
}: {
  icon: React.ReactNode;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onCommit: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1 focus-within:border-[var(--color-accent)]/50">
      <span className="shrink-0 text-[var(--color-faint)]">{icon}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
      />
    </div>
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
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-soft)] text-[10px] font-semibold text-[var(--color-accent)]">
      {initials}
    </span>
  );
}

/** Small channel chip with a brand colour for WhatsApp/IG. */
function ChannelChip({ channel }: { channel: Channel }) {
  const color =
    channel === "whatsapp"
      ? "text-[var(--color-success)]"
      : channel === "instagram"
        ? "text-[var(--color-accent)]"
        : "text-[var(--color-muted)]";
  return (
    <span className={`shrink-0 rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[9px] ${color}`}>{channel}</span>
  );
}

/** A tag chip. */
function TagChip({ tag }: { tag: string }) {
  return (
    <span className="flex items-center gap-0.5 rounded-full bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]">
      <Tag size={8} />
      {tag}
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
    <div
      className="absolute inset-0 z-20 grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[380px] flex-col rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel)] shadow-2xl"
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
