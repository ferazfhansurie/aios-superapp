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

/// Sets the page zoom via CSS `body.style.zoom`. The frontend tracks the
/// percentage and passes the factor (e.g. 1.25 for 125%).
#[tauri::command]
pub fn browser_zoom(app: AppHandle, label: String, factor: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval(&format!("document.body.style.zoom={factor}"));
    }
    Ok(())
}

/// Best-effort cookie/storage clear. NOTE: true cookie-store wiping isn't
/// available via `eval` (HttpOnly cookies + the WKWebView cookie store can't be
/// reached from page JS), so we do the JS-accessible clears — `document.cookie`
/// wipe for each non-HttpOnly cookie + localStorage/sessionStorage clear — then
/// reload so the page re-runs with cleared client state.
#[tauri::command]
pub fn browser_clear_cookies(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval(
            "(function(){\
                try{document.cookie.split(';').forEach(function(c){\
                    var n=c.split('=')[0].trim();\
                    if(n){\
                        document.cookie=n+'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';\
                        document.cookie=n+'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain='+location.hostname;\
                    }\
                });}catch(e){}\
                try{localStorage.clear();}catch(e){}\
                try{sessionStorage.clear();}catch(e){}\
                location.reload();\
            })()",
        );
    }
    Ok(())
}

/// Toggles a mobile-viewport approximation. NOTE: real device emulation needs
/// CDP (touch events, DPR, real UA override) which we don't have, so this is a
/// CSS-based approximation — inject a `meta[name=viewport]` + constrain the
/// document width to a phone-ish 420px centered; turning it off resets those.
#[tauri::command]
pub fn browser_device_mode(app: AppHandle, label: String, mobile: bool) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        if mobile {
            let _ = wv.eval(
                "(function(){\
                    var m=document.querySelector('meta[name=viewport][data-cockpit]');\
                    if(!m){m=document.createElement('meta');m.name='viewport';m.setAttribute('data-cockpit','1');document.head.appendChild(m);}\
                    m.content='width=420, initial-scale=1';\
                    document.documentElement.style.maxWidth='420px';\
                    document.documentElement.style.margin='0 auto';\
                })()",
            );
        } else {
            let _ = wv.eval(
                "(function(){\
                    var m=document.querySelector('meta[name=viewport][data-cockpit]');\
                    if(m){m.remove();}\
                    document.documentElement.style.maxWidth='';\
                    document.documentElement.style.margin='';\
                })()",
            );
        }
    }
    Ok(())
}

/// Captures the browser's on-screen region to a PNG via `screencapture` and
/// returns the saved path. The frontend passes the webview slot's screen rect
/// (its `getBoundingClientRect`). Requires Screen Recording permission — a
/// non-zero exit (denied / failed) surfaces as an error.
#[tauri::command]
pub fn browser_screenshot(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    // Touch `app`/`label` so the call shape matches the other commands and the
    // capture is clearly scoped to a live pane.
    let _ = app.get_webview(&label).ok_or("browser not open")?;
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let path = format!("/tmp/cockpit-shot-{epoch}.png");
    let region = format!(
        "{},{},{},{}",
        x.round() as i64,
        y.round() as i64,
        width.round().max(1.0) as i64,
        height.round().max(1.0) as i64,
    );
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg(format!("-R{region}"))
        .arg(&path)
        .status()
        .map_err(|e| format!("screencapture failed to launch: {e}"))?;
    if !status.success() {
        return Err(format!(
            "screencapture exited with {} (check Screen Recording permission)",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(path)
}
