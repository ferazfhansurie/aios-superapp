//! AIOS — desktop cockpit. Lean Tauri shell: multi-pane PTY terminals + the
//! oracle roster (attach to bridge-managed tmux sessions). No IDE cruft.

mod automations;
mod bridges;
mod browser;
mod chat;
mod crm;
mod db;
mod device;
mod files;
mod inbox;
mod memory;
mod monitor;
mod motion;
mod oracles;
mod plugins;
mod pty;
mod stats;
mod telemetry;
mod usage;
mod voice;

#[tauri::command]
fn read_telemetry() -> telemetry::Telemetry {
    telemetry::collect()
}

#[tauri::command]
fn startup_open_pane() -> Option<String> {
    std::env::var("AIOS_OPEN_PANE")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // INVARIANT: this app must NEVER tear down the `-L adletic` tmux socket /
    // server on exit. Persistent terminal panes (`aios-term-*`) and oracle panes
    // (`aios-*`) live on that daemon and are meant to outlive the cockpit — there
    // is deliberately no window-close / ExitRequested handler that kills tmux.
    // If you ever add an exit hook, do NOT `kill-server` the adletic socket.
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::PtyState::new())
        .invoke_handler(tauri::generate_handler![
            read_telemetry,
            startup_open_pane,
            pty::pty_spawn,
            // pty_spawn_terminal is Unix-only (tmux); on Windows it's compiled
            // out and the frontend falls back to pty_spawn (no persistence).
            #[cfg(unix)]
            pty::pty_spawn_terminal,
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
            oracles::kill_tmux_session,
            oracles::appshot,
            files::read_dir,
            files::read_dir_tree,
            files::git_status,
            files::git_pulse,
            files::detect_project,
            files::list_projects,
            files::home_dir,
            files::read_file_preview,
            files::read_text_file,
            files::write_text_file,
            files::delete_path,
            files::convert_office_to_pdf,
            files::save_image_temp,
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
            usage::codex_usage,
            memory::memory_graph,
            memory::memory_file,
            memory::memory_search,
            memory::memory_save,
            memory::memory_delete,
            db::db_list_connections,
            db::db_add_connection,
            db::db_remove_connection,
            db::db_test_connection,
            db::db_list_tables,
            db::db_table_rows,
            db::db_query,
            db::db_table_columns,
            db::db_update_row,
            db::db_insert_row,
            db::db_delete_row,
            stats::usage_extras,
            device::device_stats,
            automations::list_automations,
            automations::automation_detail,
            automations::run_automation,
            automations::set_automation_enabled,
            bridges::list_bridges,
            bridges::bridge_activity,
            bridges::pair_personal_wa,
            crm::crm_load,
            crm::crm_save_contact,
            crm::crm_delete_contact,
            inbox::list_customers,
            inbox::customer_thread,
            inbox::send_message,
            motion::motion_models,
            motion::motion_boards,
            motion::motion_board_save,
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
            chat::chat_steer,
            chat::chat_interrupt,
            chat::chat_send_raw,
            chat::chat_stop,
            chat::chat_detach,
            chat::chat_reattach,
            chat::chat_set_title,
            chat::list_chat_live,
            chat::list_chat_sessions,
            chat::record_chat_session,
            chat::read_chat_transcript,
            browser::browser_show,
            browser::browser_set_bounds,
            browser::browser_current_url,
            browser::browser_fullscreen_state,
            browser::set_window_fullscreen,
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
