import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers over the Rust CRM commands (see `src-tauri/src/crm.rs`).
 *
 * The backend stores a flexible `{ contacts, deals }` JSON blob and upserts by
 * `id`; the frontend owns the record shape — these types ARE that contract.
 * Optional fields are genuinely optional on disk; an absent `id` on save means
 * "create me" and the backend mints one (returned from the save call).
 */

/** Where a lead first reached us — drives the channel chip on a contact. */
export type Channel =
  | "whatsapp"
  | "instagram"
  | "telegram"
  | "email"
  | "phone"
  | "referral"
  | "other";

/** A person / account in the book. */
export interface Contact {
  /** Stable id (minted by the backend on first save). */
  id: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  /** Acquisition / primary channel, e.g. "whatsapp". */
  channel?: Channel;
  tags?: string[];
  notes?: string;
  /** Epoch millis when the contact was created. */
  createdAt: number;
}

/** The pipeline stages, lead → won/lost. Order is the board's column order. */
export type Stage = "lead" | "contacted" | "proposal" | "won" | "lost";

/** Ordered stages — the single source of truth for column layout + iteration. */
export const STAGES: Stage[] = ["lead", "contacted", "proposal", "won", "lost"];

/** Human labels for each stage (column headers, selects). */
export const STAGE_LABELS: Record<Stage, string> = {
  lead: "lead",
  contacted: "contacted",
  proposal: "proposal",
  won: "won",
  lost: "lost",
};

/** Currencies a deal value can be denominated in. */
export type Currency = "RM" | "USD";

/** One deal moving through the pipeline. */
export interface Deal {
  /** Stable id (minted by the backend on first save). */
  id: string;
  title: string;
  /** Links to a {@link Contact.id}; optional so a deal can exist standalone. */
  contactId?: string;
  /** Monetary value in `currency`. */
  value?: number;
  currency?: Currency;
  stage: Stage;
  notes?: string;
  /** Epoch millis when created. */
  createdAt: number;
  /** Epoch millis of the last edit (incl. a stage move via drag-drop). */
  updatedAt: number;
}

/** The whole store as returned by `crm_load`. */
export interface CrmStore {
  contacts: Contact[];
  deals: Deal[];
}

/** Loads the entire store. Never throws on missing/corrupt data — the backend
 *  returns an empty store in those cases. */
export async function crmLoad(): Promise<CrmStore> {
  const raw = await invoke<Partial<CrmStore>>("crm_load");
  return {
    contacts: Array.isArray(raw?.contacts) ? raw.contacts : [],
    deals: Array.isArray(raw?.deals) ? raw.deals : [],
  };
}

/** Upserts a contact by `id`. Pass without an `id` to create — the resolved id
 *  (minted or existing) is returned. */
export async function crmSaveContact(contact: Partial<Contact>): Promise<string> {
  return invoke<string>("crm_save_contact", { contact });
}

/** Deletes a contact by id (no-op if absent). */
export async function crmDeleteContact(id: string): Promise<void> {
  return invoke<void>("crm_delete_contact", { id });
}

/** Upserts a deal by `id`. Pass without an `id` to create — returns the id. */
export async function crmSaveDeal(deal: Partial<Deal>): Promise<string> {
  return invoke<string>("crm_save_deal", { deal });
}

/** Deletes a deal by id (no-op if absent). */
export async function crmDeleteDeal(id: string): Promise<void> {
  return invoke<void>("crm_delete_deal", { id });
}

// ── small shared formatting helpers (kept here so the pane stays lean) ──────

/** Formats a deal value like "RM 5,000" / "USD 12,500". Falsy value → "". */
export function formatValue(value?: number, currency: Currency = "RM"): string {
  if (value == null || Number.isNaN(value)) return "";
  return `${currency} ${Math.round(value).toLocaleString("en-US")}`;
}
