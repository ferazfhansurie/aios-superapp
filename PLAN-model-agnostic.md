# PLAN — model-agnostic AIOS chat (CLI swap + API fallback)

_decided 2026-05-30 · firaz chose "both" (full opencode-grade)._
_internal build plan. not for the public repo._

## Why
The chat pane is hardwired to spawn the local `claude` CLI and speak claude's `stream-json`
protocol end-to-end (`src-tauri/src/chat.rs`). A stranger with no claude sub clicks chat →
`failed to spawn claude` (chat.rs:247). This is the **#1 OSS-launch blocker** AND the proven
launch wedge — opencode hit 160k stars on exactly "not coupled to any provider." Goal: anyone,
any model, works; power users keep the full agentic loop.

## Target architecture (3 tiers)
```
tier 1 — local AGENTIC CLI (full power: tool-use, approvals, resume, effort)
   provider = which binary:  claude | codex | gemini-cli | opencode
   each is a real coding agent → keep the whole loop. devs pick their CLI.
tier 2 — BYO-key native API (works for everyone, no CLI installed)
   openai | openrouter | ollama (local) — paste key / endpoint.
   plain chat-completion + a tool-runner so it's still agentic where the model supports tools.
tier 3 — free fallback model (badged "you're on free models — connect your account")
   so download→first-click does SOMETHING instead of erroring.
```

## What's claude-specific (must abstract or degrade per provider)
- binary name + `stream-json` in/out protocol (chat.rs:205-211)
- tool-use approval control protocol `can_use_tool` / `control_response` (chat.rs:487+, chat.ts:291)
- `--permission-mode`, `--effort`, `--resume` flags (claude-only)
- transcript path `~/.claude/projects/<id>.jsonl`
Reusable as-is: turn model, token streaming to UI, tool cards, per-session buffer, transcript replay.

## Deps — already present (no new Cargo deps)
`reqwest = { "0.12", features=["json","stream"] }` + `tokio = { "1", features=["full"] }`.
So tier-2 async HTTP/SSE is buildable today.

## Existing seams to reuse
- settings: `src/lib/settings.ts` — plain localStorage `AppSettings`, `loadSettings/saveSettings/subscribe`. Extend it.
- model picker: `CHAT_MODELS` in `src/lib/chat.ts:183` + the model pill in ChatPane. Make provider-aware.
- bin resolver: `claude_bin()` chat.rs:95-124 (env `AIOS_CLAUDE_BIN` → fallbacks). Generalize to `agent_bin(provider)`.

---

## PHASES (ship incrementally — each is independently valuable)

### Phase 0 — onboarding/unblock (smallest, ships the "not embarrassing" win first)
- rust: a `detect_providers()` command — which agent CLIs exist on PATH (claude/codex/gemini/opencode) + which API keys are set in env.
- ts: if no provider available, ChatPane shows a clean "connect your AI" panel (not the raw spawn error).
- DOES collide with ChatPane → wait for doc-links agent to land first.

### Phase 1 — the seam + settings + provider registry (foundation)
- `src/lib/providers.ts` (NEW) — `Provider` type, registry: id, kind ('cli'|'api'), label, models, capabilities {toolUse, effort, resume}, bin/endpoint. NO collision.
- `src/lib/settings.ts` — extend `AppSettings`: `chatProvider`, `apiKeys: Record<provider,string>`, `apiEndpoints`, `defaultModel`. Default = claude-cli (back-comat). NO collision.
- `src-tauri/src/chat.rs` — add `ChatProvider` enum + thread it through `chat_start`; CLI path = today's code refactored under `match`. NO collision (rust).
- keep `chat_start` Tauri signature back-compat (provider defaults to claude).

### Phase 2 — agentic CLI swap (tier 1)
- generalize `claude_bin()` → `agent_bin(provider)` + per-CLI arg builders (codex/gemini/opencode have their own flags + event shapes).
- normalizer layer in rust: map each CLI's stream → the generic `ChatEvent` the frontend already parses.
- ChatPane: provider picker (binary) + model list per provider. Capabilities gate which pills show (hide effort/approval where unsupported).
- Settings.tsx: chat section — provider picker + detected-CLI status.

### Phase 3 — BYO-key native API (tier 2)
- rust `chat_providers/` submodule: openai (HTTP+SSE), openrouter (same shape), ollama (local stream). reqwest streaming → normalize SSE deltas → `ChatEvent`.
- a tool-runner so API providers that support function-calling stay agentic (collect tool_calls → run via existing tool infra → feed results back). Where unsupported → plain chat, degrade gracefully.
- Settings: masked API-key inputs + endpoint override (ollama url). Store in settings (plaintext now; keychain = Phase 5).
- session resume fallback: API has no `--resume` → replay transcript from our own store.

### Phase 4 — free fallback (tier 3)
- a free model (openrouter free tier or bundled) behind a badge so first-click works with zero setup. cap it.

### Phase 5 — polish
- keychain/secure storage for API keys (currently localStorage plaintext).
- per-model capability matrix + graceful pill hiding everywhere.
- first-run wizard.

---

## Collision note (today)
A background agent is editing ChatPane.tsx / App.tsx / MemoryPane / FileViewerPane (doc-links→browser-pane feature). Do NOT touch those until it commits. Start with rust (chat.rs) + new lib/providers.ts + settings.ts — all collision-free. Wire ChatPane/Settings UI after.

## First slice to build tonight (collision-free)
1. `src/lib/providers.ts` — registry + types.
2. `src/lib/settings.ts` — provider fields.
3. `src-tauri/src/chat.rs` — `ChatProvider` enum + `match`-dispatch seam, CLI path = refactor of current code, claude default.
Then (after doc agent lands): Phase 0 onboarding + Phase 2 picker.
