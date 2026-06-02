interface Env {
  OPENAI_API_KEY?: string;
  AIOS_CHAT_MODEL?: string;
  AIOS_OPENAI_BASE_URL?: string;
}

interface WebChatTurn {
  role: "user" | "assistant";
  text: string;
}

interface WebChatRequest {
  text?: string;
  model?: string | null;
  messages?: WebChatTurn[];
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init.headers,
    },
  });

function outputText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  return output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as { content?: unknown }).content;
      return Array.isArray(content) ? content : [];
    })
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildInput(text: string, messages: WebChatTurn[]): string {
  const transcript = messages
    .filter((turn) => turn.text.trim())
    .slice(-12)
    .map((turn) => `${turn.role}: ${turn.text.trim()}`)
    .join("\n\n");
  return transcript ? `${transcript}\n\nuser: ${text}` : text;
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

export async function onRequestPost(context: { request: Request; env: Env }) {
  const { request, env } = context;
  if (!env.OPENAI_API_KEY || !env.AIOS_CHAT_MODEL) {
    return json(
      {
        error:
          "web chat is not configured. add OPENAI_API_KEY and AIOS_CHAT_MODEL to cloudflare pages secrets.",
      },
      { status: 503 },
    );
  }

  let body: WebChatRequest;
  try {
    body = await request.json() as WebChatRequest;
  } catch {
    return json({ error: "invalid json body" }, { status: 400 });
  }

  const text = (body.text ?? "").trim();
  if (!text) return json({ error: "message is empty" }, { status: 400 });

  const model = env.AIOS_CHAT_MODEL;
  const defaultEndpoint = "https://api.openai.com/v1/responses";
  const endpoint = env.AIOS_OPENAI_BASE_URL
    ? `${env.AIOS_OPENAI_BASE_URL}/responses`
    : defaultEndpoint;
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: buildInput(text, Array.isArray(body.messages) ? body.messages : []),
      instructions:
        "you are aios web shell. answer directly, keep responses concise, and be clear about browser-only limitations.",
      store: false,
    }),
  });

  const data = await upstream.json().catch(() => null) as Record<string, unknown> | null;
  if (!upstream.ok || !data) {
    const err =
      data && typeof data.error === "object" && data.error && "message" in data.error
        ? String((data.error as { message?: unknown }).message)
        : `openai request failed (${upstream.status})`;
    return json({ error: err }, { status: upstream.ok ? 502 : upstream.status });
  }

  const textOut = outputText(data);
  return json({
    text: textOut || "no response text returned.",
    model,
    usage: typeof data.usage === "object" && data.usage ? data.usage : undefined,
  });
}
