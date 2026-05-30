import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers over the Rust INBOX commands (see `src-tauri/src/inbox.rs`).
 *
 * The CRM pane is a customer messaging inbox, not a deal pipeline: a list of
 * everyone you can message (merged from the WhatsApp logs + manual contacts in
 * crm.json) and a chat thread per customer, sent over the WhatsApp bridge.
 *
 * Every command is defensive on the Rust side — these wrappers just normalise
 * the shape so the pane can render without re-checking for nulls.
 */

/** Which channel a customer is reachable on. WhatsApp is live; the rest are on
 *  the way (`send_message` returns "channel not connected yet" for them). */
export type InboxChannel =
  | "whatsapp"
  | "whatsapp-personal"
  | "instagram"
  | "telegram"
  | "email"
  | "phone"
  | "other";

/** The channels you can actually SEND on right now, for the composer switcher.
 *  `whatsapp` = the 0210 business number (Meta Cloud via push.js); `whatsapp-
 *  personal` = firaz's own number (paired wwebjs session via send-as-personal). */
export const SENDABLE_CHANNELS: { id: InboxChannel; label: string; short: string }[] = [
  { id: "whatsapp", label: "WhatsApp · 0210", short: "0210" },
  { id: "whatsapp-personal", label: "WhatsApp · personal", short: "personal" },
];

/** One person you can message — a merged view of a logged WhatsApp peer and/or
 *  a manual contact from the CRM store. */
export interface Customer {
  /** Stable id: a manual-contact id when known, else `wa:<handle>`. */
  id: string;
  /** Display name — a real contact/chat name when we have one, else the phone. */
  name: string;
  /** Channel this customer is messaged over (currently always "whatsapp"). */
  channel: InboxChannel;
  /** Bare-digit phone / handle used to send + thread. */
  handle: string;
  /** Local "YYYY-MM-DD HH:MM" of the last message, or null if never messaged. */
  lastAt: string | null;
  /** Humanised "4m" / "3h" / "2d" since the last message, or null. */
  lastAgo: string | null;
  /** Preview of the most-recent message (trimmed), or "" if none. */
  lastText: string;
  /** How many messages have flowed with this customer. */
  msgCount: number;
}

/** One message in a customer thread. */
export interface InboxMessage {
  /** Local "YYYY-MM-DD HH:MM". */
  ts: string;
  /** Humanised "4m" / "3h" / "2d", or null if unparseable / in the future. */
  tsAgo: string | null;
  /** "out" = we sent it, "in" = the customer sent it. */
  direction: "out" | "in";
  /** Message body (media-only messages show a `[type]` tag). */
  text: string;
}

/** Coerces an unknown value to a finite number, defaulting to 0. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Coerces an unknown value to a string or null. */
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The people you can message — merged from the WhatsApp logs + manual contacts,
 *  deduped by handle, newest conversation first. Never throws; returns [] on any
 *  unexpected payload. */
export async function listCustomers(): Promise<Customer[]> {
  const raw = await invoke<unknown>("list_customers");
  if (!Array.isArray(raw)) return [];
  return raw.map((r): Customer => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      id: typeof o.id === "string" ? o.id : "",
      name: typeof o.name === "string" && o.name ? o.name : "unknown",
      channel: (typeof o.channel === "string" ? o.channel : "whatsapp") as InboxChannel,
      handle: typeof o.handle === "string" ? o.handle : "",
      lastAt: strOrNull(o.lastAt),
      lastAgo: strOrNull(o.lastAgo),
      lastText: typeof o.lastText === "string" ? o.lastText : "",
      msgCount: num(o.msgCount),
    };
  });
}

/** The recent thread with one handle, chronological (oldest→newest). Pass the
 *  customer's `handle`. Never throws; returns [] on any unexpected payload. */
export async function customerThread(handle: string, limit = 200): Promise<InboxMessage[]> {
  const raw = await invoke<unknown>("customer_thread", { handle, limit });
  if (!Array.isArray(raw)) return [];
  return raw.map((r): InboxMessage => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      ts: typeof o.ts === "string" ? o.ts : "",
      tsAgo: strOrNull(o.tsAgo),
      direction: o.direction === "in" ? "in" : "out",
      text: typeof o.text === "string" ? o.text : "",
    };
  });
}

/** Sends a message over a channel. WhatsApp goes through the bridge's push.js;
 *  other channels reject with "channel not connected yet". Resolves to the
 *  backend's ok/sent string, or rejects with the error message. */
export async function sendMessage(
  channel: InboxChannel,
  to: string,
  text: string,
): Promise<string> {
  return invoke<string>("send_message", { channel, to, text });
}
