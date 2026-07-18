/** JSON-RPC transport over the Rust LSP pipe (lsp.rs).
 *
 *  Rust frames bytes; THIS file is the protocol floor: it correlates request
 *  ids, dispatches server→client notifications, and answers server-initiated
 *  REQUESTS (rust-analyzer sends `workspace/configuration` and
 *  `client/registerCapability` during startup and hangs forever if nobody
 *  replies — handled here so the client layer never sees them).
 *
 *  One LspTransport per spawned server process. `vscode-languageserver-protocol`
 *  is imported as TYPES ONLY — the runtime stays hand-rolled because
 *  monaco-languageclient is incompatible with our plain monaco-editor + vite
 *  `?worker` setup (it requires the vscode-api shim world).
 */
import { Channel } from "@tauri-apps/api/core";

import { invoke } from "../tauri";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
}

export interface LspStartInfo {
  id: number;
  command: string;
}

export class LspTransport {
  private serverId = 0;
  /** The resolved spawn line (which node + which cli.mjs) — for the status pill. */
  command = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationHandlers = new Map<string, (params: unknown) => void>();
  private exitHandlers: (() => void)[] = [];
  private dead = false;

  /** Spawns the server process. Throws (with the rust-side reason, e.g.
   *  "typescript-language-server not found …") when resolution fails. */
  async start(root: string, lang: string): Promise<void> {
    const channel = new Channel<string>();
    channel.onmessage = (raw) => this.dispatch(raw);
    const info = await invoke<LspStartInfo>("lsp_start", { root, lang, onEvent: channel });
    this.serverId = info.id;
    this.command = info.command;
  }

  private dispatch(raw: string) {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(raw) as RpcMessage;
    } catch {
      return; // not JSON — framing already guaranteed message boundaries, drop
    }

    // pipe-level sentinel from lsp.rs: the server process exited.
    if (msg.method === "$/aios/serverExit") {
      this.markDead(new Error("language server exited"));
      return;
    }

    // response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id as number);
      if (!entry) return;
      this.pending.delete(msg.id as number);
      if (msg.error) {
        entry.reject(
          new Error(`${entry.method}: ${msg.error.message} (code ${msg.error.code})`),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // server-initiated REQUEST (has both id and method) — must be answered or
    // the server stalls. We satisfy the protocol minimally.
    if (msg.id !== undefined && msg.method !== undefined) {
      this.answerServerRequest(msg);
      return;
    }

    // notification
    if (msg.method !== undefined) {
      if (msg.method === "$/progress") return; // swallow (rust-analyzer spam)
      const handler = this.notificationHandlers.get(msg.method);
      if (handler) handler(msg.params);
    }
  }

  private answerServerRequest(msg: RpcMessage) {
    const reply = (result: unknown) =>
      void this.post({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "workspace/configuration": {
        // null per requested section — "no explicit config, use your defaults".
        const items = (msg.params as { items?: unknown[] })?.items ?? [];
        reply(items.map(() => null));
        return;
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        reply(null); // plain ack
        return;
      case "workspace/applyEdit":
        reply({ applied: false }); // we don't support server-pushed edits (yet)
        return;
      default:
        void this.post({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `method not handled: ${msg.method}` },
        });
    }
  }

  /** request → correlated promise. */
  request<T>(method: string, params: unknown): Promise<T> {
    if (this.dead) return Promise.reject(new Error("lsp transport is dead"));
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
    });
    this.post({ jsonrpc: "2.0", id, method, params }).catch((e) => {
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        entry.reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    return p;
  }

  notify(method: string, params: unknown): void {
    if (this.dead) return;
    void this.post({ jsonrpc: "2.0", method, params }).catch(() => {});
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Fires once, when the server process exits (crash or shutdown). */
  onExit(handler: () => void): void {
    this.exitHandlers.push(handler);
  }

  private post(msg: RpcMessage): Promise<void> {
    return invoke<void>("lsp_send", { serverId: this.serverId, payload: JSON.stringify(msg) });
  }

  private markDead(reason: Error) {
    if (this.dead) return;
    this.dead = true;
    for (const entry of this.pending.values()) entry.reject(reason);
    this.pending.clear();
    for (const h of this.exitHandlers) h();
  }

  get alive(): boolean {
    return !this.dead;
  }

  /** Stops the server (rust runs shutdown→exit→kill escalation). */
  async stop(): Promise<void> {
    const wasDead = this.dead;
    this.markDead(new Error("lsp transport stopped"));
    if (!wasDead) await invoke<void>("lsp_stop", { serverId: this.serverId }).catch(() => {});
  }
}

/** Nearest ancestor of `path` carrying a workspace marker, via the rust walker
 *  (stops at the .git boundary). null = no project root. */
export function findWorkspaceRoot(path: string, markers: string[]): Promise<string | null> {
  return invoke<string | null>("lsp_find_root", { path, markers });
}
