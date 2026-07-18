# voice-loop spike — step 1 of PLAN-voice-pane.md

goal: mic → streaming STT → reflex model → streaming TTS, no UI.
measure: end-of-speech (VAD fire) → first SOUND out of the speaker.

## hard gate
- ≤700ms to meaningful words
- ≤300ms to first sound with backchannel cheat
- if the local stack can't hit this after tuning → STOP, report, revisit transport. don't grind.

## measurement protocol
timestamps (monotonic clock, single process):
- `t_eos` — VAD declares end-of-speech (after hangover)
- `t_stt_final` — final transcript ready (eager prefill: partials stream BEFORE eos)
- `t_llm_first_token` — reflex model first streamed token
- `t_tts_first_audio` — first audio buffer handed to output device
- `t_backchannel` — pre-cached ack playback start (should be ~0ms compute)

report per-trial: eos→first-audio, eos→first-meaningful-word. 5 trials min, drop warmup.

## status
- recon in flight: voicemode service API, reflex model bench, VAD/capture stack
- harness not written yet — blocked on recon (plan says verify voicemode API first, don't assume)
