import { invoke } from "./tauri";

/**
 * Typed wrappers over the Rust CRM contacts store (see `src-tauri/src/crm.rs`).
 *
 * The CRM pane is a customer messaging INBOX now (see `lib/inbox.ts` for the
 * threads/send side). This file is the thin contacts layer the inbox reuses:
 * the backend keeps a flexible `{ contacts, deals }` JSON blob at
 * `~/.aios/state/crm.json` and upserts by `id`. We only touch `contacts` here —
 * a manual contact is just someone you've added so they appear in the inbox and
 * can be messaged over their channel. (The legacy `deals` array stays untouched
 * on disk; we simply don't surface it.)
 *
 * An absent `id` on save means "create me" and the backend mints one (returned
 * from the save call).
 */

/** Which channel a contact is reachable on — drives the channel chip + send. */
export type Channel =
  | "whatsapp"
  | "instagram"
  | "telegram"
  | "email"
  | "phone"
  | "referral"
  | "other";

/** A person you can message. `phone` is the WhatsApp handle the inbox sends to. */
export interface Contact {
  /** Stable id (minted by the backend on first save). */
  id: string;
  name: string;
  company?: string;
  email?: string;
  /** Phone / WhatsApp handle — what the inbox uses to thread + send. */
  phone?: string;
  /** Primary channel, e.g. "whatsapp". */
  channel?: Channel;
  tags?: string[];
  notes?: string;
  /** Epoch millis when the contact was created. */
  createdAt: number;
}

/** The whole store as returned by `crm_load`. We only read `contacts`. */
export interface CrmStore {
  contacts: Contact[];
}

/** Loads the contacts store. Never throws on missing/corrupt data — the backend
 *  returns an empty store in those cases. */
export async function crmLoad(): Promise<CrmStore> {
  const raw = await invoke<{ contacts?: Contact[] }>("crm_load");
  return {
    contacts: Array.isArray(raw?.contacts) ? raw.contacts : [],
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
