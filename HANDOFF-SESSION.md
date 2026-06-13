# HANDOFF — cross-machine superapp sync · Phase 1 in progress

_2026-06-13 · branch `feat/cross-machine-sync` · the next session needs ONLY this doc + the plan doc + `git log`._

---

## ⏩ SESSION 2026-06-14 (overnight) — firaz directive: "get ALL working" (full product A→F), compact + handoff at 1M ctx

**Approved plan:** `~/.claude/plans/wild-moseying-allen.md` (full A→F, "go" given). This handoff was written because session context hit ~1.5M tokens — resume in a FRESH session.

**Live state on the box (`firaz@100.113.3.98`, tailnet):**
- **A. Install .deb — IN FLIGHT.** Detached build running on the box: `/tmp/aios-build-install.sh` → log `/tmp/aios-install.log`. It does: `pnpm run build` (frontend ✅ already produced `dist/`) → `pnpm tauri build --bundles deb` (capped `CARGO_BUILD_JOBS=3` + `nice/ionice` — UNCAPPED `-j` REBOOTED the box once, do not remove the cap) → `sudo dpkg -i` the .deb → `/usr/bin/aios-shell` + gnome `.desktop`. **Check on resume:** `ssh firaz@100.113.3.98 'tail -20 /tmp/aios-install.log; which aios-shell'`. If it died/rebooted, relaunch: `ssh firaz@100.113.3.98 'setsid bash /tmp/aios-build-install.sh </dev/null >/dev/null 2>&1 &'`.
- Box display facts: physical monitor (what firaz sees) = `DISPLAY=:0` (gnome). chrome-remote-desktop = `:20` (xfce) — DIFFERENT screen, don't confuse them (wasted an hour on this). Screenshot a display: `ssh ... 'DISPLAY=:0 xfce4-screenshooter -f -s /tmp/s.png'` then scp. node20 on box: `~/.nvm/versions/node/v20.20.2/bin`. pnpm via corepack. cargo at `~/.cargo/bin`. webkit2gtk-4.1-dev IS installed now (old blocker gone). passwordless sudo works.
- **ssh gotcha:** `pkill -f "<pat>"` / `pgrep -f "<pat>"` where `<pat>` appears in your own ssh command string SELF-MATCHES and kills your shell (exit 255). Use bracket trick `[v]ite` or match by exact name `pkrill -x`.

**Remaining work (from approved plan, in order):**
- **B. "launch superapp on box from Mac"** — composer command/button → `ssh firaz@100.113.3.98 'DISPLAY=:0 setsid aios-shell </dev/null >/dev/null 2>&1 &'`. Small. Do after A installs.
- **C. BUG: :8787 port collision** — control plane (`src-tauri/src/control.rs:34`, scans 8787+) and headroom proxy default (`src-tauri/src/chat.rs:485`, `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`) collide; whoever binds first wins → headroom-on claude turns can hit the doorbell not Anthropic. Fix: give headroom proxy a distinct base (e.g. 8799) OR read `~/.aios/state/control-port` and avoid it. Quick standalone patch.
- **D. Finish crate surgery (Phase 1.2b-ii + 2c)** — see PENDING below. Sequential, ONE file, NOT fanned out. Gate EVERY step on `cargo check --tests` + `cargo test -p aios-shell --lib chat` (12 tests). `cargo` = `$HOME/.cargo/bin/cargo`.
- **E. Build `aios-noded`** — the core ask ("box session live in a Mac pane"). New bin crate, path-deps `aios-chat-core`, axum + `tokio-tungstenite` (in-tree via cdp.rs). `GET /registry`, `POST /chat/start`, `WS /chat/:id/attach` (ring-buffer replay → live), `POST /chat/:id/stop`. On box: session `OutputSink` = WS sender (vs `ChannelSink` on Mac). **Bind to tailscale IP `100.113.3.98` ONLY, never 0.0.0.0** (RCE by design). Upgrade `~/.aios/state/node-secret` → CSPRNG + 0600 + constant-time compare (this is where the auth-hardening bug fix lands). pm2/systemd, box no-sleep. Mac side: `chatStart({node:'bisnesgpt'})` opens WS instead of spawning local claude → pumps lines into the local `Channel<String>`; `chat_send`/`chat_steer` reverse the pipe. Make `ChatSession.sink` a `Vec<Box<dyn OutputSink>>` for "open in both" fan-out. Frontend ChatPane UNCHANGED (same stream-json wire).
- **F. Registry + composer `@bisnesgpt` picker** — `/registry` merged into roster (`oracles.rs`/`OracleRoster`) tagged by node; composer node picker + canned server-monitor agent prompt.

**Bug list (review-confirmed):** (1) :8787 collision [C above]; (2) weak control-plane auth — non-crypto token, world-readable `node-secret`, non-constant-time compare — fine for loopback, fix when E binds to tailscale.

---

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
1. ✅ **Phase 1 step 2b-i — PURE engine adapters → crate. DONE (commit `184c1e1`, cargo check --tests green, 12 chat tests pass).** 17 pure fns now in `crates/aios-chat-core/src/adapt.rs`: codex value helpers (`codex_item_id`/`codex_agent_message_method`/`codex_delta_*`/`codex_item_type`/`codex_is_action_item`/`codex_tool_name`/`codex_tool_input`/`codex_tool_result_text`/`codex_item_is_error`), `codex_input_items`, `codex_effort`, `adapt_codex_line`, `adapt_opencode_line`, `codex_usage_event`, `codex_usage_to_claude`. chat.rs imports the 13 it still calls via `use aios_chat_core::adapt::{...}`.
1b. **Phase 1 step 2b-ii — ENTANGLED codex app-server frame → crate. NEXT UP (riskiest remaining).** Move `adapt_codex_appserver_frame` (currently ~line 1181 in chat.rs) into a new crate module `codex_rpc.rs`. It drags along:
   - the module static **`NEXT_REQ`** (chat.rs line 88) — ALSO used by `chat_send_raw` (the approval-decision reply path). Relocate it to the crate as a `pub static` (e.g. `aios_chat_core::session::NEXT_REQ` or in `codex_rpc.rs`); chat.rs references it there.
   - the stdin-writers `codex_rpc_write`, `codex_next_rpc`, `codex_fire_turn` (write `sess.stdin`/`sess.child` — std only, no Tauri, movable). NOTE these are ALSO called by lifecycle ops that STAY in chat.rs (`codex_send_turn`, `codex_steer`, `codex_interrupt`, the handshake in `start_codex_appserver`) → after moving, chat.rs imports them back.
   - `codex_fire_turn` calls `codex_input_items`+`codex_effort` (already in adapt.rs → `use crate::adapt::...`).
   - The codex `mod tests` in chat.rs call `adapt_codex_appserver_frame` directly → import it from the crate so tests stay green. Verify with `cargo check --tests` AND `cargo test -p aios-shell --lib chat` (12 tests).
   - Verify the appserver_frame body (chat.rs ~1181–~1450) calls NOTHING else chat.rs-local besides the above + wire fns + the now-moved adapt.rs helpers before cutting.
   - **Leave in chat.rs (spawn/lifecycle, Tauri/Command-coupled):** `codex_bin`/`codex_native_bin`/`codex_appserver_bin`/`codex_chat_home`/`codex_config_without_mcp_servers`/`opencode_bin`, `start_*`/`run_per_turn`/`chat_send`/`chat_steer`/`codex_send_turn`/`codex_steer`/`codex_interrupt`, `adapt_line` dispatcher, `ingest_line` (orchestrator), `notify_done`, reader threads (the 2 `AppHandle.emit("chat-exit")` sites).
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
