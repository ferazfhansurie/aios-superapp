import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("chat transport carries a renderer run id through send, steer, interrupt, and lifecycle frames", () => {
  const api = read("./chat.ts");
  const pane = read("../components/ChatPane.tsx");
  const backend = read("../../src-tauri/src/chat.rs");
  const remote = read("../../src-tauri/src/remote.rs");

  assert.match(api, /export async function chatSend\([\s\S]*runId: string/);
  assert.match(api, /export async function chatSteer\([\s\S]*runId: string/);
  assert.match(api, /export async function chatInterrupt\([\s\S]*runId: string/);
  assert.match(api, /invoke\("chat_steer",\s*\{[\s\S]*runId,/);
  assert.match(backend, /"type":"aios_run"/);
  assert.match(backend, /"state":"starting"/);
  assert.match(backend, /"state":"interrupting"/);
  assert.match(backend, /pub fn chat_steer\([\s\S]*run_id: String/);
  assert.match(backend, /active_run_matches\(session_id, &run_id\)/);
  assert.match(backend, /crate::remote::send\(session_id, &text, &run_id\)/);
  assert.match(backend, /crate::remote::interrupt\(session_id, &run_id\)/);
  assert.match(backend, /crate::remote::steer\(session_id, &text, &run_id\)/);
  // The box protocol stays compatible (`send`/`steer`/`interrupt` are not
  // expanded with renderer-private ids). The Mac relay owns that mapping and
  // emits the tagged lifecycle frames from its RemoteRun state.
  assert.match(remote, /struct RemoteRun\s*\{[\s\S]*id: String,[\s\S]*interrupting: bool,/);
  assert.match(remote, /pub fn send\(local_id: u32, text: &str, run_id: &str\)[\s\S]{0,900}json!\(\{ "type": "send", "text": text \}\)/);
  assert.match(
    remote,
    /emit_run\(handle, "starting", run_id\);[\s\S]{0,900}input_tx[\s\S]{0,300}send\(json!\(\{ "type": "send", "text": text \}\)\.to_string\(\)\)[\s\S]{0,500}emit_run\(handle, "running", run_id\);/,
  );
  assert.match(remote, /fn emit_run\(handle: &RemoteHandle, state: &str, run_id: &str\)[\s\S]{0,300}json!\(\{ "type": "aios_run", "state": state, "runId": run_id \}\)/);
  assert.match(remote, /remote_result_terminal\(&line\)[\s\S]{0,300}finish_run\(local_id, state\)/);
  assert.match(remote, /stale or missing remote chat run/);
  assert.match(api, /run_id: string \| null/);
  assert.match(api, /run_state: string \| null/);
  assert.match(pane, /info\.run_id/);
  assert.match(pane, /const \[runLifecycle, setRunLifecycle\] = useState<ChatRunLifecycle>/);
  assert.match(pane, /canStartNormalSend/);
  assert.match(pane, /canSteer/);
  assert.match(pane, /chatInterrupt\(id, runId\)/);
});

test("result rendering does not settle a turn before its tagged lifecycle terminal frame", () => {
  const pane = read("../components/ChatPane.tsx");
  const resultCase = pane.slice(pane.indexOf('case "result":'), pane.indexOf('case "aios_resume_pruned":'));

  assert.ok(resultCase.length > 0, "expected the stream result handler");
  assert.doesNotMatch(resultCase, /setStreaming\(false\)/);
  assert.doesNotMatch(resultCase, /setBackendBusy\(false\)/);
  // Terminal settlement is intentionally centralized in transitionRunLifecycle,
  // keyed by the reducer's next phase rather than duplicated in the `result`
  // branch. A result paints transcript content; only a tagged lifecycle frame
  // unlocks the composer.
  assert.match(pane, /next\.phase === "completed"[\s\S]{0,900}setStreaming\(false\)/);
});

test("a routed Claude hard-limit refusal overrides stale router telemetry", () => {
  const pane = read("../components/ChatPane.tsx");
  const failover = pane.slice(
    pane.indexOf("const limitRerouteRef"),
    pane.indexOf("// ── /resume:"),
  );

  assert.match(pane, /observeClaudeHardLimit/);
  assert.match(failover, /runtimeHarness === "claude"[\s\S]{0,300}observeClaudeHardLimit\(\)/);
  assert.match(failover, /observeClaudeHardLimit\(\)[\s\S]{0,500}switchToAios\(\)/);
});

test("chatpane switches the AIOS Codex model harness at the Claude cap boundary", () => {
  const pane = read("../components/ChatPane.tsx");
  const composer = read("../components/Composer.tsx");
  const chat = read("./chat.ts");
  const backend = read("../../src-tauri/src/chat.rs");
  assert.match(pane, /const runtimeEngine = model\.engine \?\? "claude"/);
  assert.match(pane, /const runtimeHarness:[\s\S]{0,240}aiosRouted != null[\s\S]{0,240}aiosHarness/);
  assert.match(pane, /harness: runtimeHarness/);
  assert.doesNotMatch(pane, /setHarness/);
  assert.doesNotMatch(composer, /codex native/);
  assert.doesNotMatch(composer, /switchHarness/);
  assert.doesNotMatch(composer, /"harness"/);
  assert.doesNotMatch(read("../components/Settings.tsx"), /default harness|chatHarness/);
  assert.doesNotMatch(read("./settings.ts"), /chatHarness/);
  assert.match(chat, /export type ChatHarness = "claude"/);
  assert.match(chat, /harness: opts\.harness \?\? null/);
  assert.match(backend, /AIOS_CODEX_ADAPTER_SECRET_FILE/);
});

test("claude chat sessions expose a non-recursive worker agent", () => {
  const backend = read("../../src-tauri/src/chat.rs");
  assert.match(backend, /\.arg\("--agents"\)/);
  assert.match(backend, /aios-worker/);
  assert.match(backend, /"disallowedTools":\["Agent"\]/);
});

test("native Claude sessions cannot inherit the Codex adapter route", () => {
  const backend = read("../../src-tauri/src/chat.rs");
  assert.match(
    backend,
    /claude_adapter_harness\s*=\s*harness\.as_deref\(\)\s*==\s*Some\("claude"\)\s*&&\s*matches!\(requested_engine,\s*Engine::Codex\)/,
  );
  assert.match(
    backend,
    /if claude_adapter_harness \{[\s\S]*?ANTHROPIC_BASE_URL[\s\S]*?\} else \{[\s\S]*?env_remove\("ANTHROPIC_BASE_URL"\)[\s\S]*?env_remove\("ANTHROPIC_CUSTOM_HEADERS"\)/,
  );
});

test("the selected model engine owns runtime image and steering semantics", () => {
  const pane = read("../components/ChatPane.tsx");
  assert.match(pane, /const runtimeEngine = model\.engine \?\? "claude"/);
  assert.match(pane, /const engine = runtimeEngine;[\s\S]*?engine === "claude" \|\| \(engine === "codex" && imgPaths\.length === 0\)/);
  assert.match(pane, /stopStrategy\(runtimeEngine\)/);
});

test("ChatPane mounts the normalized run cockpit instead of the legacy fleet footer", () => {
  const pane = read("../components/ChatPane.tsx");

  assert.match(pane, /import \{ TaskRail \} from "\.\/chat\/TaskRail"/);
  assert.match(pane, /<TaskRail[\s\S]{0,700}events=\{runEventState\.events\}/);
  assert.doesNotMatch(pane, /<TaskActivity/);
});

test("the task router summary describes Claude-harness GPT and native Codex failover", () => {
  const summary = read("../components/chat/TaskSummary.tsx");

  assert.match(summary, /gpt via claude code below 100%/);
  assert.match(summary, /native codex at claude 100%/);
  assert.doesNotMatch(summary, /ahead of pace|draining claude via bulk|pace \+/);
});
