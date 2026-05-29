//! Embedded browser panes backed by NATIVE child webviews (real WebKit, not
//! iframes) so X-Frame-Options / frame-ancestors sites (vercel, google, …)
//! render. Each browser PANE owns its own webview, keyed by a per-pane label,
//! so the user can spawn as many as they like. The frontend reports each pane's
//! on-screen rect; we create/position/resize/hide/close the matching webview.
//!
//! Requires the tauri `unstable` feature (child webviews via `Window::add_child`).

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

/// Present as desktop Chrome so sites don't flag the WKWebView UA as a bot
/// (cuts captcha walls). Cookies persist on-disk per app, so a one-time login
/// sticks across restarts.
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn parse(url: &str) -> Result<Url, String> {
    Url::parse(url).map_err(|e| format!("bad url: {e}"))
}

/// Shows the browser `label` at the given rect, creating it (loading `url`) on
/// first call or just repositioning an existing one.
#[tauri::command]
pub fn browser_show(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)));
        return Ok(());
    }
    let parsed = parse(&url)?;
    let window = app.get_window("main").ok_or("no main window")?;
    let builder =
        tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed)).user_agent(UA);
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)));
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let parsed = parse(&url)?;
    let wv = app.get_webview(&label).ok_or("browser not open")?;
    wv.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn browser_back(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval("history.back()");
    }
    Ok(())
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval("history.forward()");
    }
    Ok(())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval("location.reload()");
    }
    Ok(())
}

/// Hides without destroying (shrinks to 0×0, preserves the page).
#[tauri::command]
pub fn browser_hide(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.set_size(LogicalSize::new(0.0, 0.0));
    }
    Ok(())
}

/// Destroys the webview entirely (pane closed).
#[tauri::command]
pub fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.close();
    }
    Ok(())
}
