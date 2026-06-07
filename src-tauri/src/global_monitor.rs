//! App-wide/global input watcher for bare-modifier gestures.
//!
//! macOS menu accelerators cannot express "press both command keys", and React
//! keydown only works while the shell webview has focus. This tiny polling
//! monitor catches the Codex-style appshot gesture while a browser/native child
//! webview, terminal, or another foreground app owns focus.

#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
const HID_SYSTEM_STATE: u32 = 1;
#[cfg(target_os = "macos")]
const RIGHT_COMMAND: u16 = 54;
#[cfg(target_os = "macos")]
const LEFT_COMMAND: u16 = 55;

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceKeyState(state_id: u32, key: u16) -> std::os::raw::c_uchar;
}

#[cfg(target_os = "macos")]
fn key_down(key: u16) -> bool {
    unsafe { CGEventSourceKeyState(HID_SYSTEM_STATE, key) != 0 }
}

#[cfg(target_os = "macos")]
pub fn start(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("aios-global-monitor".into())
        .spawn(move || {
            let mut was_both_down = false;
            let mut last_fire = Instant::now() - Duration::from_secs(10);

            // Idle-CPU fix: this used to wake every 24ms (~41Hz) forever, even
            // when no key was touched — a constant background drain. A proper
            // CGEventTap would be fully event-driven, but it needs a CFRunLoop on
            // this thread + Accessibility permission (which this gesture does not
            // otherwise require) + tap-callback FFI — too much new risk on a
            // build firaz is live-using. Instead: back off the poll.
            //
            //   * IDLE (no command key down): 100ms — the common case. ~10Hz vs
            //     ~41Hz = ~4x fewer wakeups. Worst-case added latency to NOTICE
            //     the gesture is ~76ms, imperceptible for a deliberate chord.
            //   * ARMED (≥1 command key down): 24ms — once a modifier is held we
            //     tighten back up so the "both keys within the window" edge is
            //     caught crisply. This window is rare + short (you're mid-press).
            const IDLE_SLEEP: Duration = Duration::from_millis(100);
            const ARMED_SLEEP: Duration = Duration::from_millis(24);

            loop {
                let left = key_down(LEFT_COMMAND);
                let right = key_down(RIGHT_COMMAND);
                let both_down = left && right;
                if both_down && !was_both_down && last_fire.elapsed() > Duration::from_millis(900) {
                    last_fire = Instant::now();
                    let _ = app.emit(
                        "global-appshot",
                        serde_json::json!({ "source": "double-command" }),
                    );
                }
                was_both_down = both_down;
                // Tight loop only while a command key is actually held.
                thread::sleep(if left || right { ARMED_SLEEP } else { IDLE_SLEEP });
            }
        });
}

#[cfg(not(target_os = "macos"))]
pub fn start(_: tauri::AppHandle) {}
