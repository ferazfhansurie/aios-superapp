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
/// macOS: `pbpaste`. The frontend polls this and filters for the `AIOS_ANNOT:`
/// sentinel, so unrelated clipboard contents are ignored.
///
/// Windows fallback (not compiled here — macOS-only build): run
/// `powershell -NoProfile -Command Get-Clipboard` and read its stdout instead.
/// Linux fallback: `xclip -selection clipboard -o` (or `wl-paste`).
#[tauri::command]
pub fn read_clipboard() -> Result<String, String> {
    let out = std::process::Command::new("/usr/bin/pbpaste")
        .output()
        .map_err(|e| format!("pbpaste failed to launch: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "pbpaste exited with {}",
            out.status.code().unwrap_or(-1)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
