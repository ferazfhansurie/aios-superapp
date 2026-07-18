import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAdapterServer,
  prepareCodexInput,
  resolveCodexModel,
  toAnthropicMessage,
} from "./codex-anthropic-adapter.mjs";

test("maps Claude model names onto the configured subscription model", () => {
  assert.equal(resolveCodexModel("claude-sonnet-4-6", "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(resolveCodexModel("gpt-5.5", "gpt-5.6-sol"), "gpt-5.5");
});

test("maps a structured Codex final into an Anthropic message", () => {
  const message = toAnthropicMessage({ kind: "final", text: "hello" }, "gpt-5.6-sol", {
    input_tokens: 10,
    output_tokens: 2,
  });
  assert.equal(message.type, "message");
  assert.deepEqual(message.content, [{ type: "text", text: "hello" }]);
  assert.equal(message.stop_reason, "end_turn");
});

test("maps a structured Codex tool handoff without changing its input", () => {
  const message = toAnthropicMessage(
    { kind: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/a" } },
    "gpt-5.6-sol",
  );
  assert.deepEqual(message.content, [
    { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/a" } },
  ]);
  assert.equal(message.stop_reason, "tool_use");
});

test("decodes strict-schema tool JSON into Anthropic tool input", () => {
  const message = toAnthropicMessage(
    { kind: "tool_use", id: "toolu_2", name: "Read", tool_input_json: '{"file_path":"/tmp/b"}', text: "" },
    "gpt-5.6-sol",
  );
  assert.deepEqual(message.content[0].input, { file_path: "/tmp/b" });
});

test("translates Anthropic base64 image blocks into native Codex image arguments", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aios-adapter-image-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const base64 = Buffer.from("fake png bytes").toString("base64");

  const prepared = await prepareCodexInput({
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
        { type: "text", text: "what is shown?" },
      ],
    }],
  }, dir);

  assert.equal(prepared.imagePaths.length, 1);
  assert.equal(path.extname(prepared.imagePaths[0]), ".png");
  assert.deepEqual(await fs.readFile(prepared.imagePaths[0]), Buffer.from("fake png bytes"));
  assert.match(prepared.prompt, /\[attached image 1\]/);
  assert.match(prepared.prompt, /what is shown\?/);
  assert.doesNotMatch(prepared.prompt, new RegExp(base64));
});

test("localhost service rejects missing auth and serves valid messages", async (t) => {
  const server = createAdapterServer({
    secret: "local-secret",
    runner: async () => ({ output: { kind: "final", text: "from codex" }, usage: {} }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/v1/messages?beta=true`;

  const rejected = await fetch(url, { method: "POST", body: "{}" });
  assert.equal(rejected.status, 401);

  const accepted = await fetch(url, {
    method: "POST",
    headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.deepEqual(body.content, [{ type: "text", text: "from codex" }]);
});

test("accepts the private adapter header while Claude keeps its login bearer", async (t) => {
  const server = createAdapterServer({
    secret: "local-secret",
    runner: async () => ({ output: { kind: "final", text: "connected" }, usage: {} }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer claude-login-token",
      "x-aios-adapter-secret": "local-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.content, [{ type: "text", text: "connected" }]);
});

test("streaming response follows Anthropic SSE event order", async (t) => {
  const server = createAdapterServer({
    secret: "s",
    runner: async () => ({ output: { kind: "final", text: "hi" }, usage: { output_tokens: 1 } }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer s", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await response.text();
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(events, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
});
