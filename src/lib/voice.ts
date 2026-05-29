/** Push-to-talk mic dictation — browser-native capture.
 *
 *  Capture runs IN THE WEBVIEW via `getUserMedia` (which reliably triggers the
 *  app's own macOS microphone permission prompt — unlike the old ffmpeg
 *  subprocess, which couldn't inherit the TCC grant and silently produced "no
 *  audio captured"). We record with MediaRecorder (typically webm/opus), then
 *  on stop we decode the blob via an AudioContext, downmix + resample to 16 kHz
 *  mono, encode a 16-bit PCM WAV in-JS, and POST it as multipart `file` to the
 *  local whisper.cpp server at /inference. One dictation at a time.
 *
 *  Public API is intentionally identical to the previous Rust-backed module so
 *  callers (VoiceButton, and via the pane-writer bridge, ChatPane's composer)
 *  keep working unchanged: dictateStart / dictateStop / dictateCancel. */

/** Local whisper.cpp server transcription endpoint. Multipart `file` field,
 *  same contract the old Rust path used (temperature + response_format). */
const WHISPER_URL = "http://localhost:9000/inference";

/** Target format whisper.cpp wants: 16 kHz mono PCM16. */
const TARGET_SAMPLE_RATE = 16000;

/** Hard ceiling so a wedged decode/fetch can never hang the UI forever. */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** Below this many WAV bytes there's effectively no speech — treat as a denied
 *  / empty mic rather than shipping silence to whisper. (44-byte header only.) */
const MIN_WAV_BYTES = 1024;

interface Session {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  /** Resolves once the recorder has flushed its final data + fully stopped. */
  stopped: Promise<void>;
}

/** Module-level singleton — exactly one dictation may be live at a time. */
let session: Session | null = null;

/** Pick a recorder mime type that this webview can both *record* and later
 *  *decode* via AudioContext.decodeAudioData. We prefer webm/opus, then ogg,
 *  then mp4/aac; finally fall back to the browser default ("" lets the UA
 *  choose). decodeAudioData on WebKit handles these container/codec combos. */
function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
    "audio/mpeg",
  ];
  const supported = (
    typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.isTypeSupported === "function"
  );
  if (supported) {
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
  }
  return ""; // let the UA decide
}

/** Stop all tracks on a stream so the OS mic indicator clears immediately. */
function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* best-effort */
    }
  }
}

/** Begins recording the default microphone.
 *
 *  Calls `getUserMedia({ audio: true })`, which prompts for the app's mic
 *  permission on first use (and resolves silently thereafter). Rejects with a
 *  clear message if a dictation is already in flight, if the API is missing, or
 *  if the mic is denied/unavailable. */
export async function dictateStart(): Promise<void> {
  if (session) {
    throw new Error("already recording");
  }
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    throw new Error("microphone capture unavailable in this environment");
  }
  if (typeof MediaRecorder === "undefined") {
    throw new Error("audio recording (MediaRecorder) unavailable");
  }

  let stream: MediaStream;
  try {
    // This is the call that fires the macOS mic permission prompt.
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new Error("microphone permission denied — allow mic access for AIOS");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new Error("no microphone found");
    }
    throw new Error(`could not access microphone: ${String((e as Error)?.message ?? e)}`);
  }

  let recorder: MediaRecorder;
  try {
    const mimeType = pickMimeType();
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (e) {
    releaseStream(stream);
    throw new Error(`could not start recorder: ${String((e as Error)?.message ?? e)}`);
  }

  const chunks: Blob[] = [];
  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  // Resolves when the recorder has fully stopped and flushed its last chunk.
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => resolve();
  });

  session = { stream, recorder, chunks, stopped };

  try {
    recorder.start(); // single blob on stop; we don't need timeslices
  } catch (e) {
    const s = session;
    session = null;
    if (s) releaseStream(s.stream);
    throw new Error(`could not start recording: ${String((e as Error)?.message ?? e)}`);
  }
}

/** Stops recording, encodes the captured audio to a 16 kHz mono WAV in-JS,
 *  POSTs it to the local whisper server, and resolves with the trimmed
 *  transcript. Rejects with a clear message on an empty clip (mic likely
 *  denied) or a failed/garbled request. Always releases the mic. */
export async function dictateStop(): Promise<string> {
  const active = session;
  if (!active) {
    throw new Error("not recording");
  }
  // Claim the session immediately so a stray double-stop can't double-process.
  session = null;

  try {
    // Stop the recorder and wait for its final chunk to flush.
    try {
      if (active.recorder.state !== "inactive") active.recorder.stop();
    } catch {
      /* recorder may already be inactive */
    }
    await active.stopped;

    const type = active.recorder.mimeType || active.chunks[0]?.type || "audio/webm";
    const recordedBlob = new Blob(active.chunks, { type });
    if (recordedBlob.size === 0) {
      throw new Error("no audio captured — check microphone permission");
    }

    const wavBlob = await encodeBlobToWav(recordedBlob);
    if (wavBlob.size <= MIN_WAV_BYTES) {
      throw new Error("no audio captured — check microphone permission");
    }

    return await postToWhisper(wavBlob);
  } finally {
    releaseStream(active.stream);
  }
}

/** Stops recording and discards the clip, releasing the mic. Safe to call when
 *  idle (no-op). Never throws. */
export async function dictateCancel(): Promise<void> {
  const active = session;
  if (!active) return;
  session = null;
  try {
    if (active.recorder.state !== "inactive") active.recorder.stop();
  } catch {
    /* best-effort */
  }
  // Don't block on flush — we're discarding. Just release the mic now.
  releaseStream(active.stream);
}

// ── WAV encoding ────────────────────────────────────────────────────────────

/** Resolve a usable AudioContext constructor across WebKit/standard. */
function getAudioContextCtor(): typeof AudioContext {
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio (AudioContext) unavailable");
  return Ctor;
}

/** Decode a recorded audio Blob (webm/opus, ogg, mp4, …) → resample/downmix to
 *  16 kHz mono → encode a 16-bit PCM WAV Blob. */
async function encodeBlobToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();

  const Ctor = getAudioContextCtor();
  // A plain AudioContext is fine for one-shot decode; sampleRate hint isn't
  // honored for decodeAudioData (it decodes at the file's native rate), so we
  // resample manually below.
  const decodeCtx = new Ctor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch (e) {
    void decodeCtx.close?.();
    throw new Error(
      `could not decode recorded audio: ${String((e as Error)?.message ?? e)}`,
    );
  }
  // Done with the decode context.
  try {
    await decodeCtx.close?.();
  } catch {
    /* best-effort */
  }

  const mono = downmixToMono(decoded);
  const resampled =
    decoded.sampleRate === TARGET_SAMPLE_RATE
      ? mono
      : resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);

  return encodeWav(resampled, TARGET_SAMPLE_RATE);
}

/** Average all channels of an AudioBuffer into a single Float32 mono track. */
function downmixToMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  if (channels === 1) {
    // Copy out so we own the memory independent of the AudioBuffer.
    return Float32Array.from(buffer.getChannelData(0));
  }
  const out = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) out[i] += data[i];
  }
  for (let i = 0; i < length; i++) out[i] /= channels;
  return out;
}

/** Linear-interpolation resampler (Float32 in, Float32 out). Good enough for
 *  speech → 16 kHz; whisper is robust to mild resampling artifacts. */
function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** Encode Float32 [-1,1] mono samples into a 16-bit PCM WAV Blob. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bytesPerSample = 2; // PCM16
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  // RIFF header
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true); // file size minus first 8 bytes
  writeStr(8, "WAVE");

  // fmt chunk
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample

  // data chunk
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples (clamp + scale to int16)
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// ── whisper transport ────────────────────────────────────────────────────────

/** POST the WAV blob to whisper.cpp /inference and return the trimmed text.
 *  Guarded with a timeout so a hung server can't freeze dictation forever. */
async function postToWhisper(wav: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", wav, "audio.wav");
  form.append("temperature", "0");
  form.append("response_format", "json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await window.fetch(WHISPER_URL, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") {
      throw new Error("transcription timed out");
    }
    throw new Error(
      `transcription request failed — is the whisper server running on :9000? (${String(
        (e as Error)?.message ?? e,
      )})`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`transcription request failed: HTTP ${res.status}`);
  }

  const raw = await res.text();
  return parseTranscript(raw);
}

/** Pull the transcript out of whisper/OpenAI-shaped JSON `{ "text": "..." }`.
 *  Mirrors the old Rust parser's behavior and error messages. */
function parseTranscript(body: string): string {
  const trimmed = body.trim();
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new Error(`could not parse transcription response: ${trimmed}`);
  }
  const text = (json as { text?: unknown })?.text;
  if (typeof text !== "string") {
    throw new Error("transcription response had no text");
  }
  return text.trim();
}
