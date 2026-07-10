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
