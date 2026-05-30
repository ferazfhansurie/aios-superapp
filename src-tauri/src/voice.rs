//! Push-to-talk voice dictation for the cockpit.
//!
//! Records the microphone to a temp WAV via `ffmpeg` (avfoundation), then POSTs
//! the clip to the local whisper.cpp server's `/inference` endpoint via `curl`
//! and returns the transcript. Three commands drive the lifecycle:
//!
//! - `dictate_start` — spawn the recorder (errors if one is already running)
//! - `dictate_stop`  — stop the recorder, transcribe, return the text
//! - `dictate_cancel`— stop the recorder and throw the clip away
//!
//! macOS gates microphone access behind TCC: the first record will block on a
//! one-time system permission prompt, and a denied/unprompted mic surfaces as an
//! empty/zero-byte WAV. We treat those as clear, non-panicking errors so the UI
//! can tell the user to grant Microphone access.
//!
//! No new crates: HTTP is a plain `curl` subprocess, mirroring how `oracles.rs`
//! shells out to `tmux`. Process handles live in a module-level `OnceLock`.

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// Where the active recording is written. One dictation at a time, so a single
/// fixed path is fine (and lets a stale process be cleaned up on next start).
const WAV_PATH: &str = "/tmp/cockpit-dictate.wav";

/// Local whisper.cpp server transcription endpoint. Multipart `file` field.
const WHISPER_URL: &str = "http://localhost:9000/inference";

/// The in-flight recorder child, if any. `None` = idle.
static REC: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn rec() -> &'static Mutex<Option<Child>> {
    REC.get_or_init(|| Mutex::new(None))
}

/// Resolves a binary by trying known absolute locations first (GUI apps inherit
/// a minimal PATH), then falling back to the bare name so PATH still applies.
fn resolve_bin(candidates: &[&str], fallback: &str) -> String {
    for c in candidates {
        if Path::new(c).exists() {
            return (*c).to_string();
        }
    }
    fallback.to_string()
}

fn ffmpeg_bin() -> String {
    resolve_bin(
        &["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"],
        "ffmpeg",
    )
}

fn curl_bin() -> String {
    resolve_bin(&["/usr/bin/curl", "/opt/homebrew/bin/curl"], "curl")
}

/// Pick a usable avfoundation audio input. macOS frequently makes a Continuity
/// "iPhone Microphone" the DEFAULT input — and when the phone isn't connected,
/// ffmpeg's `:default` throws an I/O error and records nothing (silent failure).
/// So we enumerate the real devices and choose the first that ISN'T an
/// iPhone/iPad/Continuity device (i.e. the built-in mic), falling back to
/// `:default` only if enumeration yields nothing.
#[cfg(unix)]
fn pick_audio_device() -> String {
    let out = Command::new(ffmpeg_bin())
        .args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();
    if let Ok(o) = out {
        let txt = String::from_utf8_lossy(&o.stderr);
        let mut in_audio = false;
        for line in txt.lines() {
            if line.contains("AVFoundation audio devices") {
                in_audio = true;
                continue;
            }
            if line.contains("AVFoundation video devices") {
                in_audio = false;
                continue;
            }
            if !in_audio {
                continue;
            }
            // Line looks like: "[AVFoundation indev @ 0x..] [1] MacBook Air Microphone".
            // The LAST '[' is the device index; the name follows its ']'.
            if let Some(b) = line.rfind('[') {
                if let Some(rel) = line[b..].find(']') {
                    let idx = &line[b + 1..b + rel];
                    let name = line[b + rel + 1..].trim().to_lowercase();
                    if !idx.is_empty()
                        && idx.chars().all(|c| c.is_ascii_digit())
                        && !name.contains("iphone")
                        && !name.contains("ipad")
                        && !name.contains("continuity")
                    {
                        return format!(":{idx}");
                    }
                }
            }
        }
    }
    ":default".into()
}

/// Starts recording the built-in mic to `WAV_PATH`. Errors if already recording.
///
/// Picks a real (non-Continuity) avfoundation device — see `pick_audio_device`.
/// The recorder runs untimed — `dictate_stop`/`dictate_cancel` ends it — and we
/// keep its stdin piped so we can send `q` for a graceful flush of the WAV trailer.
#[tauri::command]
pub fn dictate_start() -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut guard = rec().lock();
        if guard.is_some() {
            return Err("already recording".into());
        }

        // Best-effort: clear any stale clip from a crashed prior session.
        let _ = std::fs::remove_file(WAV_PATH);

        let device = pick_audio_device();
        let child = Command::new(ffmpeg_bin())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "avfoundation",
                "-i",
                device.as_str(),
                "-ar",
                "16000",
                "-ac",
                "1",
                "-y",
                WAV_PATH,
            ])
            // Piped stdin lets us send 'q' for a clean stop.
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            // Keep ffmpeg's stderr in a log so a failed capture is never silent again.
            .stderr(
                std::fs::File::create("/tmp/aios-dictate-ffmpeg.log")
                    .map(Stdio::from)
                    .unwrap_or_else(|_| Stdio::null()),
            )
            .spawn()
            .map_err(|e| format!("failed to start ffmpeg: {e}"))?;

        *guard = Some(child);
        Ok(())
    }

    #[cfg(not(unix))]
    {
        Err("dictation is only supported on macOS".into())
    }
}

/// Stops the recorder, transcribes the clip, and returns the trimmed transcript.
///
/// Flow: send `q` to ffmpeg (then kill as a fallback), wait briefly for the WAV
/// to flush, sanity-check the file is non-trivial (a denied mic yields an empty
/// file), POST it to whisper, parse the `text` field, and clean up the temp file
/// regardless of outcome.
#[tauri::command]
pub fn dictate_stop() -> Result<String, String> {
    #[cfg(unix)]
    {
        let child = rec().lock().take();
        let Some(mut child) = child else {
            return Err("not recording".into());
        };

        stop_child(&mut child);

        // Give ffmpeg a moment to write the WAV header/trailer after exit.
        wait_for_wav(Duration::from_millis(1500));

        // Read + transcribe, then always remove the temp file.
        let result = transcribe(WAV_PATH);
        let _ = std::fs::remove_file(WAV_PATH);
        result
    }

    #[cfg(not(unix))]
    {
        Err("dictation is only supported on macOS".into())
    }
}

/// Kills the recorder and discards the clip. Safe to call when idle.
#[tauri::command]
pub fn dictate_cancel() -> Result<(), String> {
    #[cfg(unix)]
    {
        if let Some(mut child) = rec().lock().take() {
            stop_child(&mut child);
        }
        let _ = std::fs::remove_file(WAV_PATH);
        Ok(())
    }

    #[cfg(not(unix))]
    {
        Ok(())
    }
}

// ── internals ───────────────────────────────────────────────────────────────

/// Gracefully stops ffmpeg: write `q` to its stdin (clean WAV finalize), then
/// kill + reap as a fallback. Never panics.
#[cfg(unix)]
fn stop_child(child: &mut Child) {
    use std::io::Write;
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
    }
    // Drop stdin so ffmpeg sees EOF even if the 'q' didn't take.
    drop(child.stdin.take());

    // Briefly poll for a clean exit before forcing it.
    let deadline = Instant::now() + Duration::from_millis(800);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Polls until the WAV exists with a non-trivial size, or the timeout elapses.
/// A WAV header is 44 bytes; anything at/under that means no audio captured.
#[cfg(unix)]
fn wait_for_wav(timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(meta) = std::fs::metadata(WAV_PATH) {
            if meta.len() > 1024 {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// POSTs the WAV to whisper.cpp `/inference` via curl and extracts the text.
/// Returns a clear error on a missing/empty clip (mic permission denied) or a
/// non-200 / unparseable response.
#[cfg(unix)]
fn transcribe(path: &str) -> Result<String, String> {
    let meta = std::fs::metadata(path)
        .map_err(|_| "no audio captured — check microphone permission".to_string())?;
    if meta.len() <= 1024 {
        return Err("no audio captured — check microphone permission".into());
    }

    let out = Command::new(curl_bin())
        .args([
            "-s",
            "-S",
            "--max-time",
            "60",
            WHISPER_URL,
            "-H",
            "Content-Type: multipart/form-data",
            "-F",
            &format!("file=@{path}"),
            "-F",
            "temperature=0.0",
            "-F",
            "response_format=json",
        ])
        .output()
        .map_err(|e| format!("failed to run curl: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "transcription request failed".into()
        } else {
            format!("transcription request failed: {err}")
        });
    }

    let body = String::from_utf8_lossy(&out.stdout);
    parse_transcript(&body)
}

/// Pulls the transcript out of the whisper/OpenAI JSON `{"text": "..."}`.
#[cfg(unix)]
fn parse_transcript(body: &str) -> Result<String, String> {
    let json: serde_json::Value = serde_json::from_str(body.trim())
        .map_err(|_| format!("could not parse transcription response: {}", body.trim()))?;
    let text = json
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "transcription response had no text".to_string())?
        .trim()
        .to_string();
    Ok(text)
}
