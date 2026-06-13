# HANDOFF — cross-machine superapp sync · Phase 1 in progress

_2026-06-13 · branch `feat/cross-machine-sync` · the next session needs ONLY this doc + the plan doc + `git log`._

## North star
Make firaz's laptop superapp and the **bisnesgpt box** (a co-located Ubuntu 24.04 PC on his TV, NOT a remote headless server) feel like **one app with two windows**. A pane/agent running on either machine is visible + attachable from the other. End-goal demo: from the laptop chatpane, spin up a chat session ON the box that monitors the server, and open that pane on both machines. Works **off-wifi** (tailscale is the transport, mandatory not optional).

**Full plan doc (read this first):** `~/Repo/firaz/adletic/aios-firaz/outputs/2026-06-13-cross-machine-superapp-sync.md` — has the architecture, all phases, and the exact NEXT steps with file:line anchors.

## Working rules
- This is firaz's **daily-driver app**. Refactor must keep `cargo check` GREEN at every step. Never leave it broken.
- `cargo` is NOT on PATH in GUI-launched shells → use `$HOME/.cargo/bin/cargo`.
- Voice: lowercase, sharp, co-founder. No exclaim, no "happy to help".

## DONE this session
- **Phase 0 (network) ✅ DONE + verified.** Tailscale live on both machines, off-LAN ssh proven.
  - laptop `100.69.172.34`; box `firaz` (ubuntu 24.04) `100.113.3.98`, MagicDNS host `firaz`, ssh user `firaz` (sudo needs password). `ssh firaz@100.113.3.98` works over tailnet. Box has a broken ngrok apt repo — install pkgs via `apt-get install` (cached lists) not `apt update`. Recorded in memory `reference-tailnet-bisnesgpt`.
- **Phase 1 step 1 ✅ DONE + build-verified green (0 warnings).**
  - `src-tauri/crates/aios-chat-core/` created (Cargo.toml + src/lib.rs + src/wire.rs), compiles standalone AND as a dep of the shell.
  - **Trait seam defined** in `crates/aios-chat-core/src/lib.rs`: `OutputSink` (`fn send(&self, line: &str)` — Channel on laptop / WebSocket on box) + `SessionEvents` (`on_exit`, `on_notify` — the only `AppHandle.emit` couplings). **These two traits are the whole cross-machine split.**
  - **First extraction:** `Engine` enum + 11 pure wire-format fns moved into `wire.rs` (`json_escape`, `user_line`, `image_media_type`, `user_line_with_images`, `slim_user_image_line`, `text_delta_line`, `thinking_delta_line`, `assistant_text_line`, `assistant_thinking_line`, `assistant_tool_use_line`, `user_tool_result_line`). chat.rs re-imports via `use aios_chat_core::wire::{...}` + `use aios_chat_core::Engine;` (top of file, ~line 51). `src-tauri/Cargo.toml` has the path dep `aios-chat-core = { path = "crates/aios-chat-core" }`.

## DECISIONS locked
- Box is a **GUI-capable PC** (has the TV as display), not headless. So it can run the superapp itself via a Tauri **Linux** build (Phase 0.5) — it's a true second GUI node, not just a backend. But the sync architecture is identical either way.
- Architecture = **GUI node(s) + shared runtime via `aios-noded` daemon on the box**, over tailscale. Reuse chat.rs's existing detach/reattach + ring buffer as the remote-attach model. "Open in both" = multi-sink fan-out (`sink: Channel` → `Vec`/`Box<dyn OutputSink>`).
- firaz chose **go full product** (~2–2.5 wks), not the 1-day ssh+tmux MVP.
- Phase 1 is sequential surgery (one file) → driven directly, NOT fanned out. Phases 2–4 fan out to parallel agents.

## PENDING — exact next steps
1. **Phase 1 step 2 (the heavy middle, ~1500 lines):** move `ChatSession` (struct at chat.rs ~line 106 after the Engine removal) + the engine adapters (`adapt_codex_line`, `adapt_opencode_line`, `adapt_codex_appserver_frame`, the `codex_*` helpers) + ring buffer (`buffer_push`, `fan_out`, `fan_out_split`) into `aios-chat-core`. The adapters read `ChatSession` state → move the struct FIRST. Then swap `sink: Mutex<Option<Channel<String>>>` → `Box<dyn OutputSink>` and the 3 `AppHandle.emit` sites (`chat-exit` ~line 783/1360, `notify_done` ~2265, usage events) → `Box<dyn SessionEvents>`. `cargo check` green each step.
2. **Phase 1 step 3:** build `aios-noded` binary (new crate, also path-deps `aios-chat-core`) = axum HTTP/WS server exposing `/registry`, `POST /chat/start`, `WS /chat/:id/attach`, `POST /chat/:id/stop`. Token auth from `~/.aios/state/node-secret`. Deploy on box under pm2/systemd. TAILNET-ONLY (it's RCE by design — never on the public domain).
3. **Phase 2:** node registry/presence — `/registry` + GUI unified roster (merge into existing `OracleRoster` / `oracles.rs`, tag each entry by node).
4. **Phase 3:** `chatStart({node})` proxy in the Tauri backend → box `/attach` WS bridged to the local `Channel`; multi-sink fan-out for "open in both".
5. **Phase 4:** composer `@bisnesgpt` node picker + canned server-monitor agent prompt + state-sync allowlist (from the 2026-05-19 failover plan).
6. **Phase 0.5 (parallel):** Tauri Linux build target so the box renders its own panes on the TV.

## Live context / gotchas
- Branch `feat/cross-machine-sync` is off the `windows-port` line (cross-platform work already in flight there — relevant to Phase 0.5).
- chat.rs is 3,484 lines pre-extraction; ~95% pure logic, only `Channel` + `AppHandle.emit` (3 sites) are tauri-coupled.
- No background agents running. No external deps pending.

## Resume
Open a fresh session in `~/Repo/firaz/aios/shell`, read this doc + the plan doc, `git checkout feat/cross-machine-sync`, and start **Phase 1 step 2** (move `ChatSession` into the crate, struct first).
