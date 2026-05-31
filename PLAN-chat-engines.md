# PLAN — multi-engine chat pane (claude + codex + opencode/openrouter)

Goal (firaz): chat pane should be engine-agnostic and as capable as the terminal
pane. Use the **ChatGPT subscription** via Codex (no API key), and ALSO be able to
pick **any opencode / openrouter model** from Settings (opencode aggregates 75+
providers incl openrouter). "use codex as engine like claude; opencode as fallback
when chatgpt runs out; in Settings select all opencode + openrouter models."

## Architecture — three engines, one normalized event stream

`chat.rs` currently spawns ONE persistent `claude -p --output-format stream-json`
process per session and forwards its raw JSON lines verbatim (dumb pipe). The
frontend (`ChatPane.tsx`) parses claude's schema. We keep that schema as the
**canonical wire format** and make the backend normalize other engines INTO it,
so the rich frontend rendering "just works" for every engine.

- **claude** — native, persistent stdin process (unchanged).
- **codex** — ChatGPT sub. NOT persistent: **spawn-per-turn**.
  - turn 1: `codex exec --json -s read-only --skip-git-repo-check [-m <model>] "<msg>"`
  - turn N: `codex exec resume <thread_id> --json --skip-git-repo-check [-m <model>] "<msg>"`  (NOTE: `resume` rejects `-s`)
  - JSONL events: `thread.started{thread_id}` · `turn.started` · `item.completed{item:{type,text}}` (type `agent_message` | `reasoning` | command/file/mcp) · `turn.completed{usage}` · `turn.failed`/`error`.
  - stderr is NOISY (skill-YAML + MCP-auth errors) — read stdout only, drop stderr.
- **opencode** — everything else, incl **openrouter** + free models. spawn-per-turn:
  - turn 1: `opencode run --format json -m <provider/model> "<msg>"`
  - turn N: `opencode run --format json -s <sessionID> -m <provider/model> "<msg>"` (or `-c`)
  - JSONL events: `{type:"step_start",sessionID,part}` · `{type:"text",sessionID,part:{text}}` · (tool/step-finish) — `sessionID` (`ses_...`) is the resume key.

## Event normalization (engine JSONL → claude-shaped lines, in Rust)

Emit these synthetic claude-shaped lines so the frontend is untouched:
- on session start (codex/opencode): `{"type":"system","subtype":"init","session_id":""}` → flips `claudeReady`, enables composer.
- first `thread.started`/`sessionID`: capture as resume id + emit `{"type":"system","subtype":"init","session_id":"<id>"}` (updates `claudeSessionIdRef` → records into /resume list).
- agent text → `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}`
- reasoning → assistant content block `{"type":"thinking","thinking":"..."}`
- turn end → `{"type":"result","subtype":"success","session_id":"<id>","usage":{...},"total_cost_usd":0}` → clears busy, footer.
- failure → `{"type":"result","subtype":"error_during_execution",...}`
- (v1: tool/command items can be skipped or rendered as a compact note; read-only chat rarely emits them.)

No token-delta streaming from codex/opencode `--json` (whole messages) → assistant
bubble appears per-message, the "Working… m:ss" timer covers the gap. Acceptable v1.

## Backend changes (`src-tauri/src/chat.rs`)

- `enum Engine { Claude, Codex, Opencode }` parsed from a new `engine` arg.
- `ChatSession`: add `engine`, make `child`/`stdin` Optional (codex/opencode have no
  persistent process; `child` holds the CURRENT turn's child for interrupt),
  add `thread_id`, `model`, `cwd`, `effort` (stored for per-turn spawns).
- `chat_start(engine, ...)`: claude → existing; codex/opencode → register session,
  spawn NOTHING, emit synthetic init, return id.
- `chat_send`: claude → write stdin; codex/opencode → `run_subprocess_turn()` that
  spawns the per-turn command, reader thread adapts each line → `ingest_line`, on
  EOF emits synthetic `result` + clears busy. Store child for interrupt.
- `chat_interrupt`: claude → control_request; codex/opencode → kill current child.
- `codex_bin()` / `opencode_bin()` resolvers (PATH + nvm + ~/.opencode/bin).
- `adapt_codex_line()` / `adapt_opencode_line()` → `Vec<String>` of claude-shaped lines.

## Frontend changes

- `lib/chat.ts`: `ChatStartOpts.engine?: string`; `chatStart` passes it. `ChatModel`
  gains `engine?: "claude"|"codex"|"opencode"`. Add codex + a few opencode models to
  `CHAT_MODELS` (replace the disabled "openai june 1" placeholder).
- `ChatPane.tsx`: pass `engine: model.engine` to `chatStart` (line ~812). `model.id`
  already in the session effect deps → switching engine restarts cleanly.
- `Settings.tsx` (Phase 3): a **dynamic model browser** — read live `opencode models`
  (new Rust cmd `list_opencode_models`) + claude + codex, searchable, pick → persists
  `chatProvider`/`chatModel`. openrouter onboarding: a field to drop an OpenRouter key
  into opencode's auth so `openrouter/*` appears in the catalog.

## Phases (commit each)

1. **Codex engine** (primary — the sub). chat.rs spawn-per-turn + codex adapter +
   chat.ts engine plumbing + 2 codex models in picker. build/install/test.
2. **Opencode engine** + adapter + a few opencode models (incl free fallback).
3. **Settings dynamic model catalog** (opencode live list) + **openrouter** key onboarding.

## Verified facts (live, this machine, 2026-05-31)
- codex-cli 0.135.0, logged in via ChatGPT (Plus). models: gpt-5.5 (default), gpt-5.4,
  gpt-5.4-mini, gpt-5.3-codex, gpt-5.2. `~/.codex/auth.json` auth_mode=chatgpt, no API key.
- opencode 1.15.12 at `~/.opencode/bin/opencode`. `opencode models` lists dozens
  (`opencode/...` zen catalog incl `deepseek-v4-flash-free`, `mimo-v2.5-free`).
- `timeout` is NOT installed on this mac (use bg + file, not `timeout`).
- Rate limits: codex sub shares a 5h rolling + weekly window with other ChatGPT agent
  usage — heavy chat use burns it; that's literally why opencode-free is the fallback.
