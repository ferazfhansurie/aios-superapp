# PLAN — voice control center pane ("the orb")

> spec from firaz + chatpane session 2026-06-11. hand to the building session as-is.
> status: approved direction, not started. free-tier feature (not paywalled, not stream-only).

## what it is

a new pane type: a full-duplex voice copilot you talk to like a phone call.
it talks when you stop talking, stops when you start (barge-in). it can drive
the cockpit — open panes, focus sessions, pull up content — via a tool surface.
primary use cases: (1) daily hands-free control of the shell, (2) stream cohost
that makes vibe-coding streams watchable. streaming is a *use case*, not the
product — do not couple it to OBS or stream state.

design north star: chatgpt advanced voice mode UI — minimal dark canvas,
amplitude-reactive orb, live transcript line ghosting by, mic state, close button.
nothing else on screen.

## non-negotiables (the feel)

- **perceived-instant response.** target: first SOUND within ~300ms of user
  stopping, meaningful words within ~700ms. this is the success metric for v1.
  if the loop feels like a walkie-talkie, the feature is dead regardless of smarts.
- **barge-in.** user speech while TTS is playing → TTS cancels mid-word
  (fade ~100ms, not hard cut), partial reply is dropped, listening resumes.
- **fully local audio + brain-on-existing-subs.** no per-minute metered API in
  the hot path. zero marginal cost per hour. (decision made: NOT openai realtime
  api — codex sub does not cover it, it's separate metered billing.)

## architecture — reflex + cortex

two brains, deliberately:

1. **reflex** — small fast model in the voice loop. only jobs: banter, acks,
   short answers, and routing ("answer myself" vs "delegate"). candidates:
   local qwen-class via mlx/ollama (first token ~100-200ms) or claude haiku.
   start with whatever hits first-token fastest on this machine; make it swappable.
2. **cortex** — the real agent: a claude code session via the same plumbing the
   chatpane already uses (firaz's existing max sub — no new spend). heavy asks
   get delegated async; the orb says "on it — pulling that up" instantly and
   narrates results when the cortex returns. the orb is the agent's FACE, not
   the agent.

### latency engineering (all four, stacked)

- **streaming TTS on first clause** — fire TTS as soon as the first clause of
  the reply streams in, not at completion. perceived latency = time-to-first-word.
- **eager prefill** — STT streams DURING user speech; partial transcript is sent
  to the reflex model before end-of-speech so the brain is mid-thought when VAD
  fires. don't start cold at silence.
- **backchannel cheat** — at VAD end-of-speech, immediately play a pre-cached
  short ack ("mm", "yeah", a breath) while the real reply spins up. pre-generate
  a pool of ~10 of these at session start, rotate randomly. 0ms compute at fire time.
- **VAD turn-taking** — proper voice-activity detection (e.g. silero-vad class),
  not naive silence threshold. end-of-speech detection ~200-300ms hangover, tuned
  so it doesn't clip firaz's natural pauses (he thinks mid-sentence).

### audio stack (exists already — reuse, don't rebuild)

the voicemode plugin stack on this machine already does local STT/TTS via
mlx-audio (whisper-class STT, kokoro-class TTS, even voice cloning for a custom
cohost voice). evaluate reusing its services directly vs vendoring the same
libs into the shell. requirement either way: streaming STT partials + cancellable
streaming TTS. verify what voicemode's local services expose before deciding —
do NOT assume; read its service API first.

reminder for the builder: GUI-launched tauri app has no node on PATH —
any node-shebang helper must resolve via the existing node_bin() pattern in
monitor.rs (known gotcha, see memory/HANDOFF docs).

## tool surface (v1, small)

the reflex model gets shell-control verbs as tools. start with ~6, no more:

- `open_pane(type)` / `close_pane(id)`
- `focus_session(name)`
- `show_file(path)` (opens in whatever viewer pane exists)
- `run_in_session(session, prompt)` — the delegation verb → cortex
- `query_status()` — what's running, recent activity (read from existing state)

these map to commands the shell already has internally (the chatpane/control-plane
work — see PLAN-control-plane.md and PLAN-chatpane-daily-driver.md). expose,
don't reinvent.

## UI (the orb pane)

- dark minimal canvas, centered orb. orb states: idle (slow breathe), listening
  (amplitude-reactive to USER voice), thinking (tight shimmer), speaking
  (amplitude-reactive to TTS output). canvas/webgl blob, ~60fps, cheap.
- live transcript: last user line + last assistant line, low-opacity, fades.
- mic mute toggle + end-call button. that's it. no settings in v1 — config via file.
- pane integrates like any other pane in the layout system (it's "a different
  version of chatpane" per firaz — same pane chrome, different body).

## v2 — eyes (explicitly OUT of v1)

glance vision: sample a frame of screen/stream every few seconds → small vision
model → rolling "what's on screen" note that the reflex brain reads. lets the
cohost comment on what firaz is doing. SPIKE-screencapturekit.md already explores
capture on macOS. webcam-on-firaz is lower value than screen — skip it.
do not build any of this until the voice loop ships and feels right.

## build order

1. **spike the loop, no UI**: mic → streaming STT → reflex model → streaming TTS,
   measure end-of-speech → first-sound. gate: ≤700ms to meaningful words
   (≤300ms with backchannel). if the local stack can't hit this after tuning,
   STOP and report — transport decision gets revisited, don't grind.
2. barge-in + VAD tuning + backchannel pool.
3. orb pane UI + transcript.
4. tool surface (the 6 verbs) + cortex delegation via existing chatpane plumbing.
5. polish: voice-cloned cohost voice via mlx-audio, personality prompt
   (cofounder voice, lowercase energy, no assistant-isms — mirror CLAUDE.md persona).

each step is shippable/testable alone. spike (1) is the whole bet — do it first,
report the measured latency numbers before building UI.

## context for the builder

- pricing/strategy context (why this is free tier): the orb is the wow feature +
  stream-cohost content engine that feeds the funnel (landing page → RM20-99
  group → RM699 hosted → operator quotes). it sells everything else; it is not
  itself the product being sold.
- related plans in this repo: PLAN-control-plane.md, PLAN-chat-engines.md,
  PLAN-chatpane-daily-driver.md, SPIKE-screencapturekit.md.
- firaz's bar: "i want instant." treat the latency gate in step 1 as a hard gate.
