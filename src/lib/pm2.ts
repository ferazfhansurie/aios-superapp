/**
 * PM2 fleet loader for the idle dashboard. Backed by the `pm2_list` Rust command
 * (pm2.rs), which runs `pm2 jlist` via the resolved node binary. On the laptop
 * pm2 is absent → the command returns an empty array and this getter returns
 * `[]`, so the Pm2Monitor tile renders nothing. On the bisnesgpt box it returns
 * the live fleet (bisnesgpt, bisnesgpt-api ×2, bisnesgpt-wwebjs, etc).
 *
 * Defensive: any throw (no tauri runtime, command failure) yields `[]`, never a
 * throw that blanks the idle page. Field names mirror the Rust `Pm2Proc` (camelCase).
 */
import { invoke } from "./tauri";

export interface Pm2Process {
  name: string;
  status: string;
  cpu: number;
  memoryMb: number;
  restarts: number;
  uptimeMs: number;
  pid: number;
  pmId: number;
}

/** Live pm2 fleet. Empty array on the laptop (no pm2) or any failure. */
export async function pm2List(): Promise<Pm2Process[]> {
  try {
    return await invoke<Pm2Process[]>("pm2_list");
  } catch {
    return [];
  }
}
