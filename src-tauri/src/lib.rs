//! AIOS — desktop cockpit. Lean Tauri shell: multi-pane PTY terminals + the
//! oracle roster (attach to bridge-managed tmux sessions). No IDE cruft.

mod automations;
mod bridges;
mod browser;
mod chat;
mod crm;
mod inbox;
mod files;
mod memory;
mod monitor;
mod motion;
mod plugins;
mod voice;
mod oracles;
mod pty;
mod stats;
mod telemetry;
mod usage;

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
            pty::pty_spawn_tmux,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            oracles::list_oracles,
            oracles::list_tmux_sessions,
            oracles::create_oracle,
            oracles::rename_oracle,
            oracles::delete_oracle,
            oracles::appshot,
            files::read_dir,
            files::home_dir,
            files::read_file_preview,
            plugins::list_plugins,
            browser::browser_zoom,
            browser::browser_clear_cookies,
            browser::browser_device_mode,
            browser::browser_screenshot,
            browser::browser_enter_annotate,
            browser::browser_exit_annotate,
            browser::browser_copy_selection,
            browser::read_clipboard,
            usage::usage_stats,
            memory::memory_graph,
            memory::memory_file,
            stats::usage_extras,
            automations::list_automations,
            automations::automation_detail,
            automations::run_automation,
            automations::set_automation_enabled,
            bridges::list_bridges,
            bridges::bridge_activity,
            crm::crm_load,
            crm::crm_save_contact,
            crm::crm_delete_contact,
            inbox::list_customers,
            inbox::customer_thread,
            inbox::send_message,
            motion::motion_models,
            motion::motion_generate,
            motion::motion_status,
            motion::motion_credits,
            monitor::monitor_start,
            monitor::monitor_stop,
            monitor::list_monitors,
            voice::dictate_start,
            voice::dictate_stop,
            voice::dictate_cancel,
            chat::chat_start,
            chat::chat_send,
            chat::chat_interrupt,
            chat::chat_send_raw,
            chat::chat_stop,
            browser::browser_show,
            browser::browser_set_bounds,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_hide,
            browser::browser_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
