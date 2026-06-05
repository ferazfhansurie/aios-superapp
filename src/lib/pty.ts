/**
 * Thin wrappers over the Rust PTY commands. Output streams per-session over a
 * Tauri `Channel<string>` (passed into the spawn call), not the global event bus.
 */
import { Channel } from "@tauri-apps/api/core";
import { invoke } from "./tauri";

/** An AIOS oracle session discovered by the backend (tmux + instances.json). */
export interface OracleInfo {
  identity: string;
  session: string;
  socket: string;
  display_name: string;
  attached: boolean;
  is_master: boolean;
  running: boolean;
}

/** Any live tmux session across the known sockets (all-tmux attach surface). */
export interface TmuxSession {
  socket: string;
  name: string;
  attached: boolean;
  windows: number;
  is_oracle: boolean;
}

/** Lists oracle sessions; master is always present + pinned first. */
export async function listOracles(): Promise<OracleInfo[]> {
  return invoke<OracleInfo[]>("list_oracles");
}

/** Lists every live tmux session across all known sockets. */
export async function listTmuxSessions(): Promise<TmuxSession[]> {
  return invoke<TmuxSession[]>("list_tmux_sessions");
}

/** Creates a new oracle session `aios-<identity>`; optional startup command. */
export async function createOracle(identity: string, command?: string): Promise<string> {
  return invoke<string>("create_oracle", { identity, command: command ?? null });
}

/** Renames an oracle. Master can't be renamed (backend rejects). */
export async function renameOracle(from: string, to: string): Promise<string> {
  return invoke<string>("rename_oracle", { from, to });
}

/**
 * Deletes (kills) an oracle session. Master can't be deleted (backend rejects).
 * firaz's primary oracle (`aios-firaz`) is load-bearing and backend-blocked
 * unless `force` is passed — the UI only sets it after an explicit warned confirm.
 */
export async function deleteOracle(identity: string, force = false): Promise<void> {
  return invoke("delete_oracle", { identity, force });
}

/** Kills any tmux session on a socket (all-tmux attach surface). Master rejected. */
export async function killTmuxSession(socket: string, session: string): Promise<void> {
  return invoke("kill_tmux_session", { socket, session });
}

/** ⌘⌘ appshot: screenshot → routed into an oracle (defaults to master). */
export async function appshot(identity?: string): Promise<string> {
  return invoke<string>("appshot", { identity: identity ?? null });
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

/**
 * Spawns a pane attached to a PERSISTENT terminal tmux session `aios-term-<name>`
 * (created on first use). Closing the pane / quitting the app only detaches the
 * tmux client — the session (and `cmd`, e.g. `claude`) keeps running and is
 * reattachable. Unix-only: on Windows the backend command is absent, so callers
 * must fall back to `spawnShell` (the raw, non-persistent PTY).
 */
export async function spawnTerminal(
  onData: Channel<string>,
  name: string,
  cmd: string | null,
  cwd: string | null,
  cols: number,
  rows: number,
): Promise<number> {
  return invoke<number>("pty_spawn_terminal", { onData, name, cmd: cmd ?? null, cwd: cwd ?? null, cols, rows });
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

/** Attaches a pane to any tmux session on a given socket (all-tmux attach). */
export async function spawnTmux(
  onData: Channel<string>,
  socket: string,
  session: string,
  cols: number,
  rows: number,
): Promise<number> {
  return invoke<number>("pty_spawn_tmux", { onData, socket, session, cols, rows });
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

/**
 * Startup GC (B2): kills orphaned `aios-term-*` tmux sessions that have NO live
 * restored pane. `keep` is the list of `termSessionName` suffixes for the panes
 * currently in the layout; the backend reaps only sessions outside that set.
 * Returns the full session names that were reaped.
 */
export async function reapTerminals(keep: string[]): Promise<string[]> {
  return invoke<string[]>("pty_reap_terminals", { keep });
}
