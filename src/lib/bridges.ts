import { invoke } from "./tauri";

/**
 * Headline state of a channel:
 *  - "connected"    — wired + reachable (a live process / running launchd / log).
 *  - "disconnected" — known connector, but nothing alive right now.
 *  - "soon"         — connector not built yet (the honest default).
 */
export type ChannelStatus = "connected" | "disconnected" | "soon";

/**
 * One channel AIOS speaks through. WhatsApp is the live, fully-detected proof;
 * the rest are connectors on the way. Health + recent activity are best-effort:
 * any field may be null when its source is unavailable (or the channel is
 * "soon" — connectors that don't exist yet carry null stats).
 */
export interface Channel {
  /** Stable slug, e.g. "whatsapp", "telegram". */
  id: string;
  /** Human label shown on the card, e.g. "whatsapp", "google chat". */
  name: string;
  /** Channel-type chip, e.g. "messaging", "dm", "social", "chat", "email". */
  kind: string;
  /** Headline state — drives the status dot + label + affordance. */
  status: ChannelStatus;
  /** True when a live process exists, or launchd reports it running. */
  alive: boolean;
  /** PID of the matched channel process, if found. */
  pid: number | null;
  /** Humanized process uptime, e.g. "3h 12m". */
  uptime: string | null;
  /** launchd job label, e.g. "com.firaz.aios-bridge-bsg". */
  launchd: string | null;
  /** Whether a matching launchd job is loaded. */
  loaded: boolean;
  /** Total log lines (≈ messages sent). Null for channels with no log. */
  messagesTotal: number | null;
  /** Local timestamp of the last activity, "YYYY-MM-DD HH:MM". */
  lastActivity: string | null;
  /** Time since last activity, e.g. "4m". */
  lastActivityAgo: string | null;
  /** Entries logged today. */
  today: number | null;
  /** Resolved activity-log path. */
  logPath: string | null;
}

/**
 * Back-compat alias — the live, fully-detected channels (WhatsApp today) are
 * still shaped like the old `Bridge`. `Channel` is the canonical name now.
 */
export type Bridge = Channel;

/**
 * The channels roster. The wire key stays `bridges` (the Rust command is still
 * `list_bridges`) so nothing downstream of the IPC boundary had to change.
 */
export interface Channels {
  bridges: Channel[];
}

/** Back-compat alias for the roster shape. */
export type Bridges = Channels;

/** Fetches every channel AIOS speaks through, with status + live health. */
export async function listBridges(): Promise<Channels> {
  return invoke<Channels>("list_bridges");
}

/** Alias under the channels naming — same IPC call. */
export const listChannels = listBridges;

/**
 * One message flowing through a bridge — a row in the recent-activity feed.
 * Sourced from the bridge's outbound log (and an inbound/conversation log when
 * one exists), best-effort and tolerant of malformed lines.
 */
export interface BridgeMessage {
  /** Local timestamp, "YYYY-MM-DD HH:MM". */
  ts: string;
  /** Time since the message, e.g. "4m" — null if unparseable. */
  tsAgo: string | null;
  /** "out" = sent by AIOS, "in" = received. */
  direction: "out" | "in";
  /** Counterparty — a name when known, else a phone/id. */
  peer: string;
  /** Message text, trimmed to ~280 chars (whitespace collapsed). */
  text: string;
}

/** Recent messages for a bridge, newest-first. */
export interface BridgeActivity {
  messages: BridgeMessage[];
}

/** Fetches the recent message feed for a bridge (newest-first, capped). */
export async function bridgeActivity(
  id: string,
  limit: number,
): Promise<BridgeActivity> {
  return invoke<BridgeActivity>("bridge_activity", { id, limit });
}

export interface PairResult {
  ok: boolean;
  /** 8-digit pairing code "ABCD-EFGH" on success. */
  code?: string;
  error?: string;
}

/** Pairs firaz's PERSONAL WhatsApp (the wwebjs session the "personal" channel
 *  sends through). Returns the 8-digit pairing code to enter in WhatsApp →
 *  Linked Devices → Link with phone number. Can take ~30-50s (wwebjs boot). */
export async function pairPersonalWa(): Promise<PairResult> {
  return invoke<PairResult>("pair_personal_wa");
}
