#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MODEL = process.env.AIOS_CODEX_ADAPTER_MODEL || "gpt-5.6-sol";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function anthropicError(type, message) {
  return { type: "error", error: { type, message } };
}

function isAuthorized(req, secret) {
  const adapterSecret = req.headers["x-aios-adapter-secret"];
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const apiKey = req.headers["x-api-key"];
  const supplied = typeof adapterSecret === "string"
    ? adapterSecret
    : typeof apiKey === "string" ? apiKey : bearer;
  if (!supplied || supplied.length !== secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(secret));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

function responseSchema(tools = []) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "text", "id", "name", "tool_input_json"],
    properties: {
      kind: { type: "string", enum: tools.length ? ["final", "tool_use"] : ["final"] },
      text: { type: "string" },
      id: { type: "string" },
      name: { type: "string", description: `Empty for final; otherwise one of: ${tools.map((tool) => tool.name).join(", ")}` },
      tool_input_json: { type: "string", description: "JSON object encoded as a string; use {} for final" },
    },
  };
}

function buildPrompt(body) {
  return [
    "You are the language model behind an Anthropic Messages-compatible local adapter.",
    "Do not use your native shell, file, web, or MCP tools. Do not inspect the workspace.",
    "Return only the requested structured result. If a supplied client tool is needed, return one tool_use; otherwise return final text.",
    "For final set id/name empty and tool_input_json to {}. For tool_use set text empty and encode the tool input object in tool_input_json.",
    JSON.stringify({ system: body.system ?? null, messages: body.messages, tools: body.tools ?? [], tool_choice: body.tool_choice ?? null }),
  ].join("\n\n");
}

function imageExtension(mediaType) {
  switch (mediaType) {
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    default: return ".png";
  }
}

export async function prepareCodexInput(body, dir) {
  const imagePaths = [];

  async function sanitize(value) {
    if (Array.isArray(value)) return Promise.all(value.map(sanitize));
    if (!value || typeof value !== "object") return value;
    if (
      value.type === "image" &&
      value.source?.type === "base64" &&
      typeof value.source.data === "string"
    ) {
      const bytes = Buffer.from(value.source.data, "base64");
      if (!bytes.length) throw Object.assign(new Error("empty base64 image"), { status: 400 });
      const imageNumber = imagePaths.length + 1;
      const imagePath = path.join(
        dir,
        `image-${imageNumber}${imageExtension(value.source.media_type)}`,
      );
      await fs.writeFile(imagePath, bytes, { mode: 0o600 });
      imagePaths.push(imagePath);
      return { type: "text", text: `[attached image ${imageNumber}]` };
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, child]) => [key, await sanitize(child)]),
      ),
    );
  }

  const messages = await sanitize(body.messages);
  return {
    imagePaths,
    prompt: buildPrompt({ ...body, messages }),
  };
}

export function resolveCodexModel(requested, fallback = DEFAULT_MODEL) {
  if (!requested || requested === "claude" || requested.startsWith("claude-")) return fallback;
  return requested;
}

export async function runCodex(body, { signal } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aios-codex-adapter-"));
  const schemaPath = path.join(dir, "response.schema.json");
  const outputPath = path.join(dir, "response.json");
  await fs.writeFile(schemaPath, JSON.stringify(responseSchema(body.tools)), { mode: 0o600 });
  const model = resolveCodexModel(body.model);
  const prepared = await prepareCodexInput(body, dir);
  const args = [
    "exec", "-", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
    "--sandbox", "read-only", "--color", "never", "--output-schema", schemaPath,
    "--output-last-message", outputPath, "--model", model,
  ];
  for (const imagePath of prepared.imagePaths) args.push("--image", imagePath);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.env.AIOS_CODEX_BIN || "codex", args, {
        cwd: process.env.AIOS_CODEX_ADAPTER_CWD || os.homedir(),
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-16 * 1024);
      });
      const abort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", reject);
      child.on("exit", (code) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) return reject(Object.assign(new Error("request cancelled"), { status: 499 }));
        if (code === 0) resolve();
        else {
          const detail = stderr.trim().split("\n").slice(-8).join("\n");
          reject(new Error(`codex exited ${code}${detail ? `: ${detail}` : ""}`));
        }
      });
      child.stdin.end(prepared.prompt);
    });
    const output = JSON.parse(await fs.readFile(outputPath, "utf8"));
    return { output, usage: {} };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export function toAnthropicMessage(output, model = DEFAULT_MODEL, usage = {}) {
  const tool = output?.kind === "tool_use";
  let toolInput = output?.input;
  if (tool && toolInput == null && typeof output.tool_input_json === "string") {
    try { toolInput = JSON.parse(output.tool_input_json); } catch { toolInput = {}; }
  }
  return {
    id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model,
    content: tool
      ? [{ type: "tool_use", id: output.id, name: output.name, input: toolInput ?? {} }]
      : [{ type: "text", text: String(output?.text ?? "") }],
    stop_reason: tool ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 },
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamMessage(res, message) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
  });
  sse(res, "message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 } } });
  const block = message.content[0];
  sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
  const delta = block.type === "tool_use"
    ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
    : { type: "text_delta", text: block.text };
  sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta });
  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

export function createAdapterServer({ secret, runner = runCodex } = {}) {
  if (!secret) throw new Error("AIOS_CODEX_ADAPTER_SECRET is required");
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/healthz" && req.method === "GET") return json(res, 200, { ok: true });
    if (!isAuthorized(req, secret)) return json(res, 401, anthropicError("authentication_error", "invalid local adapter credential"));
    if (pathname === "/v1/messages/count_tokens" && req.method === "POST") {
      try {
        const body = await readJson(req);
        return json(res, 200, { input_tokens: Math.ceil(JSON.stringify(body).length / 4) });
      } catch (error) {
        return json(res, error.status ?? 400, anthropicError("invalid_request_error", error.message));
      }
    }
    if (pathname !== "/v1/messages" || req.method !== "POST") return json(res, 404, anthropicError("not_found_error", "not found"));
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    try {
      const body = await readJson(req);
      if (!Array.isArray(body.messages) || !body.messages.length || !Number.isFinite(body.max_tokens)) {
        return json(res, 400, anthropicError("invalid_request_error", "messages and max_tokens are required"));
      }
      const result = await runner(body, { signal: controller.signal });
      const message = toAnthropicMessage(result.output, body.model || DEFAULT_MODEL, result.usage);
      return body.stream ? streamMessage(res, message) : json(res, 200, message);
    } catch (error) {
      process.stderr.write(`[adapter] ${pathname}: ${String(error?.message || error).replace(/Bearer\s+\S+/gi, "Bearer [redacted]")}\n`);
      if (res.headersSent) return res.end();
      return json(res, error.status ?? 502, anthropicError("api_error", error.message || "codex adapter failed"));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const secret = process.env.AIOS_CODEX_ADAPTER_SECRET ||
    (process.env.AIOS_CODEX_ADAPTER_SECRET_FILE
      ? (await fs.readFile(process.env.AIOS_CODEX_ADAPTER_SECRET_FILE, "utf8")).trim()
      : null);
  const port = Number(process.env.AIOS_CODEX_ADAPTER_PORT || 8791);
  const server = createAdapterServer({ secret });
  server.listen(port, "127.0.0.1", () => process.stdout.write(`codex anthropic adapter listening on http://127.0.0.1:${port}\n`));
}
