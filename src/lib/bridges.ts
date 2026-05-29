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
