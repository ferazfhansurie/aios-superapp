//! AIOS — desktop cockpit. Lean Tauri shell: multi-pane PTY terminals + the
//! oracle roster (attach to bridge-managed tmux sessions). No IDE cruft.

mod oracles;
mod pty;
mod telemetry;

#[tauri::command]
fn read_telemetry() -> telemetry::Telemetry {
    telemetry::collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::new())
        .invoke_handler(tauri::generate_handler![
            read_telemetry,
            pty::pty_spawn,
            pty::pty_spawn_oracle,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            oracles::list_oracles,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
