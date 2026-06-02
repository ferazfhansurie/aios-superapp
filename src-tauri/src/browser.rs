//! Embedded browser panes backed by NATIVE child webviews (real WebKit, not
//! iframes) so X-Frame-Options / frame-ancestors sites (vercel, google, …)
//! render. Each browser PANE owns its own webview, keyed by a per-pane label,
//! so the user can spawn as many as they like. The frontend reports each pane's
//! on-screen rect; we create/position/resize/hide/close the matching webview.
//!
//! Requires the tauri `unstable` feature (child webviews via `Window::add_child`).

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

/// Present as desktop **Safari**, NOT Chrome. We're a WKWebView — Safari's own
/// engine — so a Safari UA is the honest, consistent fingerprint and Google
/// fully supports Safari sign-in. A Chrome UA gets flagged on Google's OAuth
/// pages ("this browser or app may not be secure"): real Chrome sends `Sec-CH-UA`
/// client-hint headers that a WKWebView can't, so "claims Chrome + no client
/// hints" reads as a fake/embedded browser. The `Version/… Safari/…` suffix is
/// also what separates real Safari from a bare embedded webview (whose default
/// UA omits it). Cookies persist on-disk per profile, so logins stick.
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

fn parse(url: &str) -> Result<Url, String> {
    Url::parse(url).map_err(|e| format!("bad url: {e}"))
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct BrowserNewPane {
    url: String,
    profile: Option<String>,
}

fn browser_new_pane(url: &Url, profile: &Option<String>) -> BrowserNewPane {
    BrowserNewPane {
        url: url.to_string(),
        profile: profile.clone(),
    }
}

/// Derive a stable 16-byte WKWebsiteDataStore identifier from a profile name.
/// Each distinct profile gets its OWN persistent cookie jar — so two Google
/// accounts can be logged in simultaneously (each is a *fresh first login* in
/// its own partition, sidestepping Google's stricter "add account" webview
/// check that throws "this browser or app may not be secure"). Deterministic
/// (FNV-1a, two salted passes) so a profile's login persists across restarts.
fn profile_store_id(profile: &str) -> [u8; 16] {
    fn fnv1a(bytes: &[u8], mut hash: u64) -> u64 {
        for &b in bytes {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
        }
        hash
    }
    let lo = fnv1a(profile.as_bytes(), 0xcbf2_9ce4_8422_2325);
    let hi = fnv1a(profile.as_bytes(), 0x9e37_79b9_7f4a_7c15);
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&lo.to_le_bytes());
    id[8..].copy_from_slice(&hi.to_le_bytes());
    id
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
    profile: Option<String>,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)));
        return Ok(());
    }
    let parsed = parse(&url)?;
    let window = app.get_window("main").ok_or("no main window")?;
    let popup_app = app.clone();
    let popup_profile = profile.clone();
    let mut builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .user_agent(UA)
        .on_new_window(move |url, _features| {
            let _ = popup_app.emit("browser-new-pane", browser_new_pane(&url, &popup_profile));
            tauri::webview::NewWindowResponse::Deny
        });
    // A named profile gets its own persistent cookie partition on macOS. Other
    // platforms keep the default store for now: Windows WebView2 profile
    // partitioning needs a separate implementation, so don't make pulls fail.
    #[cfg(target_os = "macos")]
    if let Some(name) = profile.as_deref().filter(|p| !p.is_empty() && *p != "default") {
        builder = builder.data_store_identifier(profile_store_id(name));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = &profile;
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    // WKWebView ships with element (HTML) fullscreen DISABLED, so YouTube etc.
    // show "your browser doesn't support full screen". Flip the preference on the
    // freshly-created native webview. macOS-only; best-effort.
    #[cfg(target_os = "macos")]
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.with_webview(|pw| {
            // PlatformWebview::inner() is the raw WKWebView pointer — cast to the
            // objc2-web-kit type (same crate version tauri uses) and flip the pref.
            let ptr = pw.inner() as *mut objc2_web_kit::WKWebView;
            unsafe {
                if let Some(wk) = ptr.as_ref() {
                    wk.configuration()
                        .preferences()
                        .setElementFullscreenEnabled(true);
                }
            }
        });
    }
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

/// Returns the webview's CURRENT url (reflects in-page navigation the address
/// bar never saw). The frontend polls this to (a) keep the address bar live and
/// (b) remember a pinned site's last location so reopening returns there.
#[tauri::command]
pub fn browser_current_url(app: AppHandle, label: String) -> Option<String> {
    app.get_webview(&label)
        .and_then(|wv| wv.url().ok().map(|u| u.to_string()))
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let parsed = parse(&url)?;
    let wv = app.get_webview(&label).ok_or("browser not open")?;
    wv.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

/// Reads the WKWebView element-fullscreen state (0 = not, 1 = entering, 2 = in,
/// 3 = exiting). A child webview's HTML fullscreen only fills the webview's own
/// rect, so the frontend polls this to drive TRUE fullscreen: when a video goes
/// fullscreen we maximize the pane (webview → full window) + put the OS window
/// in fullscreen (window → full screen). macOS-only; 0 elsewhere.
#[tauri::command]
pub async fn browser_fullscreen_state(app: AppHandle, label: String) -> i64 {
    // `with_webview` needs a Send + 'static closure (dispatched to the main
    // thread), so we ship the read back over a channel. async → this runs off
    // the main thread, so the brief blocking recv can't deadlock the dispatch.
    #[cfg(target_os = "macos")]
    if let Some(wv) = app.get_webview(&label) {
        let (tx, rx) = std::sync::mpsc::channel::<i64>();
        let _ = wv.with_webview(move |pw| {
            let ptr = pw.inner() as *mut objc2_web_kit::WKWebView;
            let s = unsafe {
                ptr.as_ref()
                    .map(|wk| wk.fullscreenState().0 as i64)
                    .unwrap_or(0)
            };
            let _ = tx.send(s);
        });
        return rx
            .recv_timeout(std::time::Duration::from_millis(300))
            .unwrap_or(0);
    }
    let _ = (&app, &label);
    0
}

/// Puts the main OS window into (or out of) screen-fill mode — the second half
/// of true video fullscreen (the pane-maximize covers the window, this covers the
/// screen). On macOS we use simple fullscreen instead of native fullscreen so
/// YouTube/WebKit element fullscreen does not race the OS space transition.
#[tauri::command]
pub fn set_window_fullscreen(app: AppHandle, on: bool) -> Result<(), String> {
    if let Some(win) = app.get_window("main") {
        #[cfg(target_os = "macos")]
        win.set_simple_fullscreen(on)
            .or_else(|_| win.set_fullscreen(on))
            .map_err(|e| e.to_string())?;
        #[cfg(not(target_os = "macos"))]
        win.set_fullscreen(on).map_err(|e| e.to_string())?;
    }
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
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label, x, y, width, height);
        return Err("browser screenshots are macos-only right now".into());
    }

    #[cfg(target_os = "macos")]
    {
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
}

// ─── Annotate mode (Codex-style "select-on-page → send to chat") ──────────────
//
// CLIPBOARD-BRIDGE design (read this before touching it):
//
// A native child webview cannot call our Tauri IPC, and `wv.eval()` is
// fire-and-forget — it returns no value to Rust. So neither process can read
// the other's DOM directly. The robust channel that works TODAY with zero new
// deps is the **system clipboard**:
//
//   1. We `eval()` a small annotator into the page. It highlights the hovered
//      element, captures `{selector, tagName, text, rect, url}` on click, shows
//      an inline note box, and on submit writes
//      `"AIOS_ANNOT:" + JSON.stringify(payload)` to the clipboard via
//      `navigator.clipboard.writeText(...)`.
//   2. The FRONTEND (main webview) polls `read_clipboard()` (below), which runs
//      `pbpaste` on macOS. When it sees the `AIOS_ANNOT:` sentinel prefix it
//      parses the JSON, formats a line, fires `onAnnotate`, and exits annotate
//      mode. The sentinel prefix means we never grab unrelated clipboard text.
//
// The same path powers "send selection to chat" (selection → clipboard → read).

/// Injects the annotator overlay + listeners into the page. Idempotent: tears
/// down any prior instance first, so re-entering is safe. On submit the
/// annotation JSON is copied to the clipboard with the `AIOS_ANNOT:` sentinel
/// (the frontend polls `read_clipboard` to pick it up).
#[tauri::command]
pub fn browser_enter_annotate(app: AppHandle, label: String) -> Result<(), String> {
    let wv = app.get_webview(&label).ok_or("browser not open")?;
    // Wrapped in an IIFE; all state hangs off `window.__aiosAnnot` so
    // `browser_exit_annotate` can clean up listeners + DOM precisely.
    let _ = wv.eval(
        r#"(function(){
  try{
    if(window.__aiosAnnot&&window.__aiosAnnot.teardown){window.__aiosAnnot.teardown();}
    var SENT='AIOS_ANNOT:';
    var hl=document.createElement('div');
    hl.style.cssText='position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #6ea8fe;background:rgba(110,168,254,.12);border-radius:3px;transition:all .03s linear;display:none;';
    document.documentElement.appendChild(hl);
    var box=null,cur=null;
    function cssPath(el){
      if(!(el instanceof Element))return'';
      if(el.id)return'#'+CSS.escape(el.id);
      var parts=[];
      while(el&&el.nodeType===1&&parts.length<6){
        var sel=el.nodeName.toLowerCase();
        if(el.classList&&el.classList.length){sel+='.'+Array.from(el.classList).slice(0,2).map(function(c){return CSS.escape(c);}).join('.');}
        var p=el.parentNode;
        if(p){
          var sibs=Array.prototype.filter.call(p.children,function(c){return c.nodeName===el.nodeName;});
          if(sibs.length>1){sel+=':nth-of-type('+(Array.prototype.indexOf.call(sibs,el)+1)+')';}
        }
        parts.unshift(sel);
        if(el.id){parts[0]='#'+CSS.escape(el.id);break;}
        el=el.parentElement;
      }
      return parts.join(' > ');
    }
    function move(e){
      if(box)return;
      var el=document.elementFromPoint(e.clientX,e.clientY);
      if(!el||el===hl){hl.style.display='none';cur=null;return;}
      cur=el;
      var r=el.getBoundingClientRect();
      hl.style.display='block';hl.style.left=r.left+'px';hl.style.top=r.top+'px';hl.style.width=r.width+'px';hl.style.height=r.height+'px';
    }
    function buildBox(el){
      var r=el.getBoundingClientRect();
      box=document.createElement('div');
      box.style.cssText='position:fixed;z-index:2147483647;left:'+Math.max(8,Math.min(r.left,window.innerWidth-300))+'px;top:'+Math.min(r.bottom+8,window.innerHeight-130)+'px;width:280px;background:#1b1d22;color:#e6e6e6;border:1px solid #3a3d44;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.45);font:13px/1.4 -apple-system,system-ui,sans-serif;padding:10px;';
      var ta=document.createElement('textarea');
      ta.placeholder='describe these changes…';
      ta.style.cssText='width:100%;box-sizing:border-box;height:60px;resize:none;background:#101216;color:#e6e6e6;border:1px solid #3a3d44;border-radius:5px;padding:6px 8px;font:13px/1.4 inherit;outline:none;';
      var row=document.createElement('div');
      row.style.cssText='display:flex;gap:6px;justify-content:flex-end;margin-top:8px;';
      var cancel=document.createElement('button');
      cancel.textContent='cancel';
      cancel.style.cssText='background:transparent;color:#9aa0a6;border:1px solid #3a3d44;border-radius:5px;padding:4px 10px;cursor:pointer;font:12px inherit;';
      var send=document.createElement('button');
      send.textContent='send to chat';
      send.style.cssText='background:#6ea8fe;color:#0b0c0f;border:none;border-radius:5px;padding:4px 10px;cursor:pointer;font:12px inherit;font-weight:600;';
      row.appendChild(cancel);row.appendChild(send);
      box.appendChild(ta);box.appendChild(row);
      document.documentElement.appendChild(box);
      setTimeout(function(){ta.focus();},0);
      cancel.onclick=function(ev){ev.preventDefault();ev.stopPropagation();closeBox();};
      send.onclick=function(ev){
        ev.preventDefault();ev.stopPropagation();
        var rect=el.getBoundingClientRect();
        var payload={
          selector:cssPath(el),
          tagName:el.tagName?el.tagName.toLowerCase():'',
          text:(el.innerText||el.textContent||'').trim().slice(0,200),
          note:ta.value.trim(),
          rect:{x:Math.round(rect.left),y:Math.round(rect.top),width:Math.round(rect.width),height:Math.round(rect.height)},
          url:location.href
        };
        try{navigator.clipboard.writeText(SENT+JSON.stringify(payload));}catch(_){
          try{window.__aiosAnnotation=payload;}catch(__){}
        }
        window.__aiosAnnotation=payload;
        closeBox();
      };
    }
    function closeBox(){if(box){box.remove();box=null;}hl.style.display='none';}
    function click(e){
      if(box){return;}
      if(!cur)return;
      e.preventDefault();e.stopPropagation();
      buildBox(cur);
    }
    function key(e){if(e.key==='Escape'){closeBox();}}
    document.addEventListener('mousemove',move,true);
    document.addEventListener('click',click,true);
    document.addEventListener('keydown',key,true);
    window.__aiosAnnot={
      teardown:function(){
        try{document.removeEventListener('mousemove',move,true);}catch(_){}
        try{document.removeEventListener('click',click,true);}catch(_){}
        try{document.removeEventListener('keydown',key,true);}catch(_){}
        try{closeBox();}catch(_){}
        try{hl.remove();}catch(_){}
        try{delete window.__aiosAnnot;}catch(_){window.__aiosAnnot=null;}
      }
    };
  }catch(e){}
})()"#,
    );
    Ok(())
}

/// Removes the annotator overlay + listeners injected by
/// `browser_enter_annotate`. Safe to call even if annotate mode isn't active.
#[tauri::command]
pub fn browser_exit_annotate(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval(
            "(function(){try{if(window.__aiosAnnot&&window.__aiosAnnot.teardown){window.__aiosAnnot.teardown();}}catch(e){}})()",
        );
    }
    Ok(())
}

/// Evals a copy of the current text selection into the clipboard with the
/// `AIOS_ANNOT:` sentinel so the frontend's existing poll picks it up. Used by
/// the "send selection to chat" button. The payload shape mirrors the annotator
/// (note carries the selection, text is empty) so one parser handles both.
#[tauri::command]
pub fn browser_copy_selection(app: AppHandle, label: String) -> Result<(), String> {
    let wv = app.get_webview(&label).ok_or("browser not open")?;
    let _ = wv.eval(
        r#"(function(){
  try{
    var SENT='AIOS_ANNOT:';
    var sel=(window.getSelection?window.getSelection().toString():'').trim();
    if(!sel)return;
    var payload={selector:'',tagName:'selection',text:'',note:sel,rect:null,url:location.href};
    try{navigator.clipboard.writeText(SENT+JSON.stringify(payload));}catch(_){window.__aiosAnnotation=payload;}
    window.__aiosAnnotation=payload;
  }catch(e){}
})()"#,
    );
    Ok(())
}

/// Reads the system clipboard as text — the receive end of the clipboard-bridge.
/// The frontend polls this and filters for the `AIOS_ANNOT:` sentinel, so
/// unrelated clipboard contents are ignored.
#[tauri::command]
pub fn read_clipboard() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("/usr/bin/pbpaste");
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("powershell.exe");
        c.args(["-NoProfile", "-Command", "Get-Clipboard"]);
        c
    };
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    let mut cmd = {
        let mut c = std::process::Command::new("sh");
        c.args([
            "-c",
            "command -v wl-paste >/dev/null 2>&1 && wl-paste || xclip -selection clipboard -o",
        ]);
        c
    };
    let out = cmd
        .output()
        .map_err(|e| format!("clipboard read failed to launch: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "clipboard read exited with {}",
            out.status.code().unwrap_or(-1)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_browser_pane_keeps_the_source_profile() {
        let url = Url::parse("https://example.com/path").unwrap();
        assert_eq!(
            browser_new_pane(&url, &Some("work".into())),
            BrowserNewPane {
                url: "https://example.com/path".into(),
                profile: Some("work".into()),
            }
        );
    }
}
