/**
 * Thin wrappers over the Rust PTY commands. Output streams per-session over a
 * Tauri `Channel<string>` (passed into the spawn call), not the global event bus.
 */
import { Channel, invoke } from "@tauri-apps/api/core";

/** An AIOS oracle session discovered by the backend (tmux + instances.json). */
export interface OracleInfo {
  identity: string;
  session: string;
  display_name: string;
  attached: boolean;
}

/** Lists bridge-managed oracle tmux sessions (Unix only; empty elsewhere). */
export async function listOracles(): Promise<OracleInfo[]> {
  return invoke<OracleInfo[]>("list_oracles");
}

/** Spawns the user's login shell in a new PTY. Returns the session id. */
export async function spawnShell(
  onData: Channel<string>,
  cwd: string | null,
  cols: number,
  rows: number,
): Promise<number> {
  return invoke<number>("pty_spawn", { onData, cwd, cols, rows });
}

/** Spawns a pane attached to the oracle tmux session `aios-<identity>`. */
export async function spawnOracle(
  onData: Channel<string>,
  identity: string,
  cols: number,
  rows: number,
): Promise<number> {
  return invoke<number>("pty_spawn_oracle", { onData, identity, cols, rows });
}

/** Writes input to a session's PTY stdin. */
export async function ptyWrite(id: number, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

/** Propagates a resize to a session's PTY. */
export async function ptyResize(id: number, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

/** Kills a session (for an oracle pane, only detaches the tmux client). */
export async function ptyKill(id: number): Promise<void> {
  return invoke("pty_kill", { id });
}
