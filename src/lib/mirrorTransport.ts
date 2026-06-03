import type { AgentAction } from "./agentActions";
import type { MirrorSnapshot } from "./mirror";

export type MirrorRole = "desktop" | "viewer";
export type MirrorConnectionStatus = "off" | "connecting" | "connected" | "error";

export interface MirrorPairing {
  room: string;
  token: string;
}

export interface MirrorPresence {
  desktops: number;
  viewers: number;
  hasSnapshot: boolean;
}

export type MirrorSocketMessage =
  | { type: "hello"; role: MirrorRole; snapshot?: MirrorSnapshot | null; presence?: MirrorPresence }
  | { type: "presence"; presence: MirrorPresence }
  | { type: "snapshot"; snapshot: MirrorSnapshot | null }
  | { type: "control"; requestId: string; action: AgentAction }
  | { type: "control_result"; requestId: string; result: unknown }
  | { type: "error"; error: string };

const ROOM_KEY = "aios.mirror.room";
const TOKEN_KEY = "aios.mirror.token";
const DEFAULT_HTTP_ENDPOINT = "https://aios-mirror-worker.firazfhansurie.workers.dev";

function randomToken(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function ensureMirrorPairing(): MirrorPairing {
  let room = safeStorageGet(ROOM_KEY);
  let token = safeStorageGet(TOKEN_KEY);
  if (!room) {
    room = `firaz-${randomToken(5)}`;
    safeStorageSet(ROOM_KEY, room);
  }
  if (!token || token.length < 24) {
    token = randomToken(24);
    safeStorageSet(TOKEN_KEY, token);
  }
  return { room, token };
}

export function mirrorPairingFromLocation(loc: Location = window.location): MirrorPairing | null {
  const hash = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  const params = new URLSearchParams(hash);
  const explicit = params.get("mirror");
  const raw = explicit ?? (hash.startsWith("mirror=") ? hash.slice("mirror=".length) : "");
  const [room, token] = raw.split(".");
  if (!room || !token || token.length < 24) return null;
  safeStorageSet(ROOM_KEY, room);
  safeStorageSet(TOKEN_KEY, token);
  return { room, token };
}

export function savedMirrorPairing(): MirrorPairing | null {
  const room = safeStorageGet(ROOM_KEY);
  const token = safeStorageGet(TOKEN_KEY);
  if (!room || !token || token.length < 24) return null;
  return { room, token };
}

export function mirrorShareUrl(pairing: MirrorPairing): string {
  return `https://aios-superapp.pages.dev/#mirror=${pairing.room}.${pairing.token}`;
}

export function mirrorWebSocketUrl(pairing: MirrorPairing): string {
  const base =
    import.meta.env.VITE_AIOS_MIRROR_URL ||
    DEFAULT_HTTP_ENDPOINT;
  const url = new URL(`${base.replace(/\/+$/, "")}/${encodeURIComponent(pairing.room)}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function parseMirrorSocketMessage(raw: MessageEvent["data"]): MirrorSocketMessage | null {
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && typeof parsed.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}
