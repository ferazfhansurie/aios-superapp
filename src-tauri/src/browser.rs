//! Embedded browser pane backed by a NATIVE child webview (real WebKit, not an
//! iframe) so X-Frame-Options / frame-ancestors sites (vercel.com, google, …)
//! render instead of going blank. The frontend reports the pane's on-screen
//! rect; we create/position/resize/hide one child webview to match it.
//!
//! Requires the tauri `unstable` feature (child webviews via `Window::add_child`).

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

/// Single shared browser webview label (one embedded browser at a time).
const LABEL: &str = "aios-browser";

fn parse(url: &str) -> Result<Url, String> {
    Url::parse(url).map_err(|e| format!("bad url: {e}"))
}

/// Shows the browser at the given rect, creating it on first call (loading
/// `url`) or just repositioning an existing one.
#[tauri::command]
pub fn browser_show(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)));
        return Ok(());
    }
    let parsed = parse(&url)?;
    let window = app.get_window("main").ok_or("no main window")?;
    let builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(parsed));
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Repositions/resizes the browser to track the pane's rect.
#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)));
    }
    Ok(())
}

/// Navigates the browser to a new URL.
#[tauri::command]
pub fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = parse(&url)?;
    let wv = app.get_webview(LABEL).ok_or("browser not open")?;
    wv.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

/// History back / forward / reload via in-page JS (no native history API on a
/// child webview, but eval is enough).
#[tauri::command]
pub fn browser_back(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        let _ = wv.eval("history.back()");
    }
    Ok(())
}

#[tauri::command]
pub fn browser_forward(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        let _ = wv.eval("history.forward()");
    }
    Ok(())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        let _ = wv.eval("location.reload()");
    }
    Ok(())
}

/// Hides the browser without destroying it (shrinks to 0×0, preserves page).
#[tauri::command]
pub fn browser_hide(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        let _ = wv.set_size(LogicalSize::new(0.0, 0.0));
    }
    Ok(())
}

/// Destroys the browser webview entirely (pane closed).
#[tauri::command]
pub fn browser_close(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        let _ = wv.close();
    }
    Ok(())
}
