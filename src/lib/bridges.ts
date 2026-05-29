import { invoke } from "@tauri-apps/api/core";

/**
 * One bridge — a long-running process connecting AIOS to an external channel
 * (WhatsApp today). Health + recent activity, all best-effort: any field may be
 * null when its source is unavailable.
 */
export interface Bridge {
  /** Stable slug, e.g. "whatsapp". */
  id: string;
  /** Human label, e.g. "WhatsApp bridge". */
  name: string;
  /** Channel type chip, e.g. "whatsapp". */
  kind: string;
  /** True when a live process exists, or launchd reports it running. */
  alive: boolean;
  /** PID of the matched bridge process, if found. */
  pid: number | null;
  /** Humanized process uptime, e.g. "3h 12m". */
  uptime: string | null;
  /** launchd job label, e.g. "com.firaz.aios-bridge-bsg". */
  launchd: string | null;
  /** Whether a matching launchd job is loaded. */
  loaded: boolean;
  /** Total log lines (≈ messages sent). */
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

/** The bridges roster, shaped so future bridges slot straight in. */
export interface Bridges {
  bridges: Bridge[];
}

export async function listBridges(): Promise<Bridges> {
  return invoke<Bridges>("list_bridges");
}

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
