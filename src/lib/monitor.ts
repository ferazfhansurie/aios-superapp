import { invoke } from "./tauri";

/**
 * Pane monitor — watch a tmux session (an oracle's work surface) and push
 * WhatsApp updates to firaz when it finishes a task or hits notable output.
 *
 * One cockpit click starts a background watcher thread for that session; the
 * watcher polls `tmux capture-pane` every ~15s and sends a WhatsApp message
 * (via the bridge push.js, prefixed "[cockpit monitor]") on a detected event:
 *   - "done / idle" when output stops changing for ~30s after having moved
 *   - "error" when fresh output contains error/panic/failed/Traceback
 *
 * Master awareness: the watcher mirrors live state to
 * `~/.aios/state/cockpit-monitors.json` and logs every notification to
 * `~/.aios/state/cockpit-monitor-events.jsonl`.
 */

/**
 * Start watching a tmux session. No-op if that session already has a live
 * watcher. Sends one "now watching <session>" WhatsApp on start.
 *
 * @param socket  tmux socket the session lives on (e.g. "adletic", "aios").
 * @param session full tmux session name (e.g. "aios-firaz").
 */
export async function monitorStart(socket: string, session: string): Promise<void> {
  return invoke<void>("monitor_start", { socket, session });
}

/**
 * Stop watching a session. Idempotent — no-op if it wasn't being monitored.
 * Sends a closing "stopped watching <session>" WhatsApp.
 */
export async function monitorStop(session: string): Promise<void> {
  return invoke<void>("monitor_stop", { session });
}

/**
 * The session names currently being monitored, so the UI can reflect which
 * panes have a live watcher.
 */
export async function listMonitors(): Promise<string[]> {
  return invoke<string[]>("list_monitors");
}
