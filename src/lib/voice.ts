/** Wrapper over the `voice` Rust commands — push-to-talk mic dictation.
 *  Records the mic to a temp WAV (ffmpeg/avfoundation), then transcribes it via
 *  the local whisper.cpp server. One dictation at a time. */
import { invoke } from "@tauri-apps/api/core";

/** Begins recording the default microphone. Rejects if already recording or if
 *  the recorder fails to spawn. */
export async function dictateStart(): Promise<void> {
  return invoke<void>("dictate_start");
}

/** Stops recording, transcribes the clip, and resolves with the trimmed
 *  transcript. Rejects with a clear message on a denied mic / failed request. */
export async function dictateStop(): Promise<string> {
  return invoke<string>("dictate_stop");
}

/** Stops recording and discards the clip. Safe to call when idle. */
export async function dictateCancel(): Promise<void> {
  return invoke<void>("dictate_cancel");
}
