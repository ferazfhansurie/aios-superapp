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
- **Phase 1 step 2a ✅ DONE + build-verified green + 12 chat tests pass (0 warnings). Commit `51bb84c`.**
  - **Sink seam bound on the laptop.** New `ChannelSink(Channel<String>)` in chat.rs implements `OutputSink` — the ONE place the seam touches Tauri on the laptop. `ChatSession.sink` is now `Mutex<Option<Box<dyn OutputSink>>>` (was `Channel<String>`), so **the struct is fully Tauri-free.** All 4 sink-set sites wrap in `ChannelSink`; the 3 read sites call `ch.send(line)` (the `&str` trait method).
  - **`ChatSession` + ring buffer moved into the crate** → new `crates/aios-chat-core/src/session.rs` (added `parking_lot` dep). Holds: `REPLAY_CAP`/`REPLAY_BYTE_CAP`, the `ChatSession` struct (all fields now `pub`), and `buffer_push`/`fan_out`/`fan_out_split`. Re-exported from lib.rs. chat.rs imports via `use aios_chat_core::session::{buffer_push, fan_out, fan_out_split, ChatSession};` (~line 58). Test module imports `REPLAY_BYTE_CAP` from the crate directly.
  - **Gotcha logged:** plain `cargo check` does NOT compile the `#[cfg(test)]` module — it missed a `super::REPLAY_BYTE_CAP` regression. **Always `cargo check --tests` (or `cargo test -p aios-shell --lib chat`) before declaring a step green.**

## DECISIONS locked
- Box is a **GUI-capable PC** (has the TV as display), not headless. So it can run the superapp itself via a Tauri **Linux** build (Phase 0.5) — it's a true second GUI node, not just a backend. But the sync architecture is identical either way.
- Architecture = **GUI node(s) + shared runtime via `aios-noded` daemon on the box**, over tailscale. Reuse chat.rs's existing detach/reattach + ring buffer as the remote-attach model. "Open in both" = multi-sink fan-out (`sink: Channel` → `Vec`/`Box<dyn OutputSink>`).
- firaz chose **go full product** (~2–2.5 wks), not the 1-day ssh+tmux MVP.
- Phase 1 is sequential surgery (one file) → driven directly, NOT fanned out. Phases 2–4 fan out to parallel agents.

## PENDING — exact next steps
1. **Phase 1 step 2b — engine adapters → crate (the remaining heavy middle, ~600 lines). NEXT UP.** Struct + ring buffer already moved (step 2a). Move into a new `crates/aios-chat-core/src/codex.rs` (or `adapt.rs`):
   - **Pure slice first (low risk):** `adapt_codex_line` (~line 1638), `adapt_opencode_line` (~1711), and the 11+ pure value helpers they call — `codex_item_id`, `codex_agent_message_method`, `codex_delta_item_id`, `codex_delta_phase`, `codex_delta_is_answer`, `codex_item_type`, `codex_is_action_item`, `codex_tool_name`, `codex_tool_input`, `codex_tool_result_text`, `codex_item_is_error`, `codex_input_items`, `codex_effort`, `codex_usage_to_claude`. All pure (read `&Arc<ChatSession>`/`&Value` → return `Vec<String>`/`Value`/`String`), call only wire fns + each other. No statics, no I/O. Move + re-export + `use` in chat.rs. Verify `cargo check --tests`.
   - **Entangled slice second (more care):** `adapt_codex_appserver_frame` (~1181) calls `codex_rpc_write`/`codex_fire_turn` (write `sess.stdin` — std only, movable) AND the module static `NEXT_REQ` (line 88, also used by `chat_send_raw` ~line 2201). To move the frame adapter you must relocate `NEXT_REQ` into the crate as a `pub static` (chat.rs then references `aios_chat_core::session::NEXT_REQ`) and move `codex_rpc_write`/`codex_next_rpc`/`codex_fire_turn`. The codex test cases (`mod tests`) call `adapt_codex_appserver_frame` — keep them green. `codex_usage_event` (~1865) is pure too — move with the cluster.
   - **Leave in chat.rs (spawn/lifecycle, Tauri/Command-coupled):** `codex_bin`/`codex_native_bin`/`codex_appserver_bin`/`codex_chat_home`/`codex_config_without_mcp_servers`/`opencode_bin` (bin+config), `start_*`/`run_per_turn`/`chat_send`/`chat_steer` (lifecycle), `ingest_line` (orchestrator — calls `notify_done` + usage, AppHandle-coupled), `notify_done`, reader threads (the 2 `AppHandle.emit("chat-exit")` sites).
2. **Phase 1 step 2c — `SessionEvents` swap:** route the 3 `AppHandle.emit` sites (`chat-exit` in the 2 reader threads, `notify_done`'s `aios-notify`) through a `Box<dyn SessionEvents>` so `ingest_line`'s notify path + exit can move behind the seam too. After this, the only Tauri left in the session runtime is the spawn/lifecycle shell.
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
Open a fresh session in `~/Repo/firaz/aios/shell`, read this doc + the plan doc, `git checkout feat/cross-machine-sync`, and start **Phase 1 step 2b** (move the pure codex/opencode adapters into the crate first, then the entangled `adapt_codex_appserver_frame` + `NEXT_REQ`). `cargo` is at `$HOME/.cargo/bin/cargo`; verify with `cargo check --tests`, not bare `cargo check`.
