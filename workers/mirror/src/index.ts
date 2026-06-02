import { DurableObject } from "cloudflare:workers";

type MirrorRole = "desktop" | "viewer" | "unknown";

interface Env {
  AIOS_MIRROR: DurableObjectNamespace<MirrorRoom>;
}

interface PeerMeta {
  id: string;
  role: MirrorRole;
}

interface MirrorMessage {
  type: string;
  role?: MirrorRole;
  token?: string;
  snapshot?: unknown;
  action?: unknown;
  requestId?: string;
  result?: unknown;
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

function roomFromRequest(request: Request): string {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "default";
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseMessage(message: string | ArrayBuffer): MirrorMessage | null {
  try {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    try {
      ws.close(1011, "send failed");
    } catch {
      /* already gone */
    }
  }
}

export class MirrorRoom extends DurableObject<Env> {
  private latest: unknown = null;
  private tokenHash: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.latest = (await ctx.storage.get("latest")) ?? null;
      this.tokenHash = (await ctx.storage.get<string>("tokenHash")) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({
        ok: true,
        schema: "aios.mirror.room.v1",
        hasSnapshot: this.latest != null,
        peers: this.peers().length,
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.serializeAttachment({ id: crypto.randomUUID(), role: "unknown" } satisfies PeerMeta);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const parsed = parseMessage(message);
    if (!parsed) {
      send(ws, { type: "error", error: "invalid json" });
      return;
    }

    if (parsed.type === "hello") {
      await this.handleHello(ws, parsed);
      return;
    }

    const meta = ws.deserializeAttachment() as PeerMeta | undefined;
    if (!meta || meta.role === "unknown") {
      send(ws, { type: "error", error: "not paired" });
      ws.close(1008, "not paired");
      return;
    }

    if (meta.role === "desktop" && parsed.type === "snapshot") {
      this.latest = parsed.snapshot ?? null;
      await this.ctx.storage.put("latest", this.latest);
      this.broadcast({ type: "snapshot", snapshot: this.latest }, "viewer");
      this.broadcastPresence();
      return;
    }

    if (meta.role === "viewer" && parsed.type === "control") {
      const requestId = parsed.requestId ?? crypto.randomUUID();
      const desktops = this.peers("desktop");
      if (desktops.length === 0) {
        send(ws, { type: "control_result", requestId, result: { ok: false, error: "desktop offline" } });
        return;
      }
      for (const peer of desktops) send(peer, { type: "control", requestId, action: parsed.action });
      return;
    }

    if (meta.role === "desktop" && parsed.type === "control_result") {
      this.broadcast({ type: "control_result", requestId: parsed.requestId, result: parsed.result }, "viewer");
    }
  }

  async webSocketClose(): Promise<void> {
    this.broadcastPresence();
  }

  async webSocketError(): Promise<void> {
    this.broadcastPresence();
  }

  private async handleHello(ws: WebSocket, message: MirrorMessage): Promise<void> {
    const role = message.role === "desktop" || message.role === "viewer" ? message.role : null;
    const token = typeof message.token === "string" ? message.token : "";
    if (!role || token.length < 24) {
      send(ws, { type: "error", error: "invalid pairing" });
      ws.close(1008, "invalid pairing");
      return;
    }

    const hash = await sha256(token);
    if (!this.tokenHash) {
      if (role !== "desktop") {
        send(ws, { type: "error", error: "desktop must claim room first" });
        ws.close(1008, "unclaimed room");
        return;
      }
      this.tokenHash = hash;
      await this.ctx.storage.put("tokenHash", hash);
    }

    if (hash !== this.tokenHash) {
      send(ws, { type: "error", error: "pairing rejected" });
      ws.close(1008, "pairing rejected");
      return;
    }

    const previous = ws.deserializeAttachment() as PeerMeta | undefined;
    ws.serializeAttachment({ id: previous?.id ?? crypto.randomUUID(), role } satisfies PeerMeta);
    send(ws, {
      type: "hello",
      role,
      snapshot: this.latest,
      presence: this.presence(),
    });
    this.broadcastPresence();
  }

  private peers(role?: MirrorRole): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const meta = ws.deserializeAttachment() as PeerMeta | undefined;
      return meta && meta.role !== "unknown" && (!role || meta.role === role);
    });
  }

  private presence() {
    return {
      desktops: this.peers("desktop").length,
      viewers: this.peers("viewer").length,
      hasSnapshot: this.latest != null,
    };
  }

  private broadcast(payload: unknown, role?: MirrorRole): void {
    for (const ws of this.peers(role)) send(ws, payload);
  }

  private broadcastPresence(): void {
    this.broadcast({ type: "presence", presence: this.presence() });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const room = roomFromRequest(request);
    const id = env.AIOS_MIRROR.idFromName(room);
    return env.AIOS_MIRROR.get(id).fetch(request);
  },
};
