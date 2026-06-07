//! AIOS — desktop cockpit. Lean Tauri shell: multi-pane PTY terminals + the
//! oracle roster (attach to bridge-managed tmux sessions). No IDE cruft.

mod appcast;
mod bridges;
mod browser;
mod browser_store;
mod chat;
mod device;
mod diag;
mod files;
mod global_monitor;
mod mac_apps;
mod memory;
mod monitor;
mod oracles;
mod plugins;
mod pty;
mod stats;
mod telemetry;
mod usage;

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};

#[tauri::command]
fn read_telemetry() -> telemetry::Telemetry {
    telemetry::collect()
}

/// Builds the native macOS app menu and installs it.
///
/// WHY THIS EXISTS (R2a — the urgent fix): cockpit shortcuts (⌘F exit-fullscreen,
/// ⌘W close, ⌘1-9 jump, ⌘K/⌘B/⌘M, etc.) were registered ONLY via a React
/// `window.addEventListener("keydown")`. When focus sits inside a NATIVE child
/// webview — a browser pane (its own WKWebView) or a terminal (xterm grabs keys)
/// — those keystrokes never bubble up to the React webview, so every cockpit
/// shortcut DIED exactly when a pane was focused. firaz got stuck unable to exit
/// a fullscreen browser pane.
///
/// A real app-MENU accelerator fires whenever the app is frontmost REGARDLESS of
/// which webview holds focus — and, unlike `tauri-plugin-global-shortcut`, it does
/// NOT hijack the shortcut system-wide across other apps. So every menu item below
/// emits a `menu-action` event the React side listens for and routes into the
/// SAME handlers the in-React keydown fallback already calls.
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    // App submenu (the "AIOS" menu) — keep the standard about/quit so ⌘Q works.
    let app_menu = SubmenuBuilder::new(app, "AIOS")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // Edit submenu — without these the standard ⌘C/⌘V/⌘X/⌘A/⌘Z stop working once
    // we install a custom menu (a menu REPLACES the default, so the OS edit verbs
    // must be re-declared or copy/paste breaks inside every webview).
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    // Pane submenu — the cockpit shortcuts. Each id is matched in on_menu_event
    // and forwarded to the React handler via the `menu-action` event.
    //
    // NOTE on Escape: muda/macOS does NOT accept a bare "Escape" as a menu
    // accelerator (no modifier), so the URGENT exit-fullscreen path is bound to
    // ⌘F (toggle) AND given its own explicit "Exit Full Screen" item on ⌘. so
    // there are two reliable, webview-independent ways out of fullscreen.
    let exit_fs = MenuItemBuilder::with_id("pane:exit-fullscreen", "Exit Full Screen")
        .accelerator("CmdOrCtrl+.")
        .build(app)?;
    let toggle_fs = MenuItemBuilder::with_id("pane:toggle-fullscreen", "Toggle Pane Full Screen")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let new_term = MenuItemBuilder::with_id("pane:new", "New Terminal / Pane")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let close_pane = MenuItemBuilder::with_id("pane:close", "Close Pane")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let palette = MenuItemBuilder::with_id("pane:palette", "Command Palette")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    // ⌘P fuzzy file finder + ⌘⇧F global content search. Routed through the native
    // menu (not just window.keydown) so they fire even while focus is inside a
    // terminal/browser child webview — same reasoning as the rest of the Pane menu.
    let file_finder = MenuItemBuilder::with_id("pane:file-finder", "Find File…")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let global_search = MenuItemBuilder::with_id("pane:global-search", "Search in Files…")
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)?;
    // DevTools for the focused browser pane (R5 item 3). ⌥⌘I = the standard
    // "Web Inspector" accelerator; routed via the native menu so it fires even
    // when focus is inside the browser child webview.
    let devtools = MenuItemBuilder::with_id("pane:open-devtools", "Open DevTools")
        .accelerator("Alt+CmdOrCtrl+I")
        .build(app)?;
    let sidebar = MenuItemBuilder::with_id("pane:sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let minimize = MenuItemBuilder::with_id("pane:minimize", "Hide Pane")
        .accelerator("CmdOrCtrl+M")
        .build(app)?;
    // NOTE: muda's accelerator parser has no mapping for the backtick char, so
    // `CmdOrCtrl+\`` would silently parse to no-accelerator. The in-React keydown
    // handler keeps ⌘` working when the React webview is focused; the menu item
    // stays clickable (and works over a focused webview via click) but carries no
    // accelerator to avoid a misleading/dead shortcut label.
    let overview = MenuItemBuilder::with_id("pane:overview", "Pane Overview").build(app)?;

    let mut pane_builder = SubmenuBuilder::new(app, "Pane")
        .item(&exit_fs)
        .item(&toggle_fs)
        .separator()
        .item(&new_term)
        .item(&close_pane)
        .separator()
        .item(&palette)
        .item(&file_finder)
        .item(&global_search)
        .item(&devtools)
        .item(&sidebar)
        .item(&minimize)
        .item(&overview)
        .separator();

    // ⌘1 … ⌘9 — jump to the Nth open pane. Built in a loop so each carries its
    // own arg (the 1-based index) decoded from the id in on_menu_event.
    let mut jump_items = Vec::new();
    for n in 1..=9u8 {
        let item = MenuItemBuilder::with_id(format!("pane:jump:{n}"), format!("Go to Pane {n}"))
            .accelerator(format!("CmdOrCtrl+{n}"))
            .build(app)?;
        jump_items.push(item);
    }
    for item in &jump_items {
        pane_builder = pane_builder.item(item);
    }
    let pane_menu = pane_builder.build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&pane_menu)
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

/// Routes a native menu click into the React cockpit. The id encodes the action
/// (and, for `pane:jump:N`, the arg). The React side has a `listen("menu-action")`
/// that dispatches into the exact same handlers as the in-React keydown fallback.
fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
    if let Some(rest) = id.strip_prefix("pane:") {
        let (action, arg): (&str, Option<u8>) = if let Some(n) = rest.strip_prefix("jump:") {
            ("jump", n.parse().ok())
        } else {
            (rest, None)
        };
        let _ = app.emit(
            "menu-action",
            serde_json::json!({ "action": action, "arg": arg }),
        );
    }
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
    // Windows has no $HOME, but nearly every data source here keys off it (usage
    // stats, the memory vault, the file browser, JSONL telemetry). Alias it to
    // %USERPROFILE% once at startup so every `std::env::var("HOME")` across the
    // backend resolves correctly — this is what makes the homescreen show the
    // current user's real data on Windows.
    #[cfg(windows)]
    if std::env::var_os("HOME").is_none() {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            std::env::set_var("HOME", profile);
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::PtyState::new())
        // App-cast (ScreenCaptureKit "native app as a pane" spike) session map.
        .manage(appcast::AppCastState::default())
        .setup(|app| {
            // Boot the local-first diagnostics store (Phase 0+1): resolve the
            // per-bundle app-data dir (portable — a fork gets its own dir, no
            // dependency on firaz's ~/.aios), seed the anon install id, and
            // install the Rust panic hook so backend panics persist as
            // DiagEvents instead of dying silently. Soft-fail: if the dir can't
            // resolve we just skip diag (never block startup).
            if let Ok(dir) = app.path().app_data_dir() {
                let version = app.package_info().version.to_string();
                diag::init(dir.clone(), version);
                // Persistent browser history/bookmarks/downloads store (same
                // app-data dir, JSON files — see browser_store.rs for the
                // "why JSON not sqlite" rationale). Soft-fail if dir missing.
                browser_store::init(dir);
            }

            // Install the native macOS menu so cockpit accelerators (⌘F/⌘W/⌘1-9/…)
            // fire even when a child webview holds focus (R2a urgent fix).
            if let Err(e) = build_app_menu(app.handle()) {
                eprintln!("[aios menu] failed to install app menu: {e}");
            }
            global_monitor::start(app.handle().clone());
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu_event(app, event.id().0.as_str()))
        .invoke_handler(tauri::generate_handler![
            read_telemetry,
            diag::diag_report,
            diag::diag_recent,
            diag::diag_clear,
            diag::diag_info,
            startup_open_pane,
            pty::pty_spawn,
            pty::pty_spawn_oracle,
            pty::pty_spawn_tmux,
            // Registered on every platform: tmux-backed (persistent) on unix, a
            // plain PTY on Windows — see pty::pty_spawn_terminal.
            pty::pty_spawn_terminal,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_reap_terminals,
            oracles::list_oracles,
            oracles::list_tmux_sessions,
            oracles::list_roster,
            oracles::create_oracle,
            oracles::rename_oracle,
            oracles::delete_oracle,
            oracles::kill_tmux_session,
            oracles::appshot,
            oracles::appshot_capture,
            files::read_dir,
            files::read_dir_tree,
            files::git_status,
            files::git_snapshot,
            files::git_checkout,
            files::git_commit,
            files::git_pulse,
            files::shell_source_status,
            files::detect_project,
            files::list_projects,
            files::home_dir,
            files::read_file_preview,
            files::read_text_file,
            files::write_text_file,
            files::file_mtime,
            files::delete_path,
            files::convert_office_to_pdf,
            files::save_image_temp,
            files::find_files,
            files::resolve_in_cwd,
            files::search_in_files,
            plugins::list_plugins,
            browser::browser_zoom,
            browser::browser_clear_cookies,
            browser::browser_device_mode,
            browser::browser_screenshot,
            browser::browser_enter_annotate,
            browser::browser_exit_annotate,
            browser::browser_copy_selection,
            browser::browser_install_context_probe,
            browser::read_clipboard,
            usage::usage_stats,
            usage::codex_usage,
            usage::claude_usage,
            memory::memory_graph,
            memory::memory_file,
            memory::memory_search,
            memory::memory_save,
            memory::memory_save_raw,
            memory::memory_delete,
            memory::memory_delete_path,
            memory::memory_focus,
            stats::usage_extras,
            device::device_stats,
            bridges::list_bridges,
            bridges::bridge_activity,
            bridges::pair_personal_wa,
            mac_apps::mac_list_apps,
            mac_apps::mac_focus_app,
            mac_apps::mac_capture_app,
            monitor::monitor_start,
            monitor::monitor_stop,
            monitor::list_monitors,
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
            browser::browser_force_reload,
            browser::browser_nav_state,
            browser::browser_open_devtools,
            browser::browser_find,
            browser::browser_clear_cache,
            browser::browser_hide,
            browser::browser_close,
            browser_store::browser_history_record,
            browser_store::browser_history_query,
            browser_store::browser_history_clear,
            browser_store::browser_bookmark_add,
            browser_store::browser_bookmark_remove,
            browser_store::browser_bookmark_list,
            browser_store::browser_download_record,
            browser_store::browser_download_list,
            browser_store::browser_download_forget,
            browser_store::browser_download_clear,
            browser_store::browser_reveal_in_finder,
            // App-cast (ScreenCaptureKit native-app-as-a-pane spike, Phase A).
            appcast::appcast_list_windows,
            appcast::appcast_start,
            appcast::appcast_set_bounds,
            appcast::appcast_hide,
            appcast::appcast_show,
            appcast::appcast_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } if chat::has_busy_sessions() => {
                api.prevent_exit();
                show_main_window(app);
            }
            // Exit is actually proceeding here (no busy session blocked it above).
            // Reap every spawned chat child NOW — `detach_child_process` puts them
            // in their own process group so the OS won't signal them on our quit,
            // and they'd otherwise keep running forever (burning tokens/memory).
            // `RunEvent::Exit` is the final lifecycle event; kill there too as a
            // belt-and-braces catch for exit paths that skip ExitRequested.
            tauri::RunEvent::ExitRequested { .. } => {
                chat::kill_all_sessions();
            }
            tauri::RunEvent::Exit => {
                chat::kill_all_sessions();
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                show_main_window(app);
            }
            _ => {}
        });
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
