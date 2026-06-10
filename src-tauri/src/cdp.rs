//! CDP "real Chrome as a pane" spike — drive a REAL supervised Chrome (full
//! codecs/DRM/extensions, real fingerprint) and mirror one tab into an AIOS
//! pane over the DevTools Protocol.
//!
//! Pipeline:
//!   1. discover a Chromium-family binary (Chrome → Chromium → Edge → Brave,
//!      /Applications + ~/Applications),
//!   2. launch it with `--remote-debugging-port=0` + a dedicated profile dir
//!      (`~/.aios/chrome-profile`) — port 0 means CHROME picks a free port and
//!      writes it to `<profile>/DevToolsActivePort`, so we never collide with
//!      anything. If a previous supervised Chrome is still alive on that file's
//!      port we REATTACH instead of relaunching (launching a second instance
//!      against a live profile would just forward to it and exit anyway),
//!   3. hand-rolled `GET /json/version` over a raw `tokio::net::TcpStream`
//!      (localhost-only; no reqwest for one request) → browser WS url,
//!   4. tokio-tungstenite WS client with id-correlated request/replies + event
//!      dispatch; flat session protocol (`Target.attachToTarget {flatten:true}`,
//!      session commands carry a top-level `sessionId`),
//!   5. `Page.startScreencast` (jpeg q70, max dims = pane rect × dpr) — frames
//!      stream to the frontend as base64 over a per-pane
//!      `tauri::ipc::Channel<serde_json::Value>` (same per-session channel
//!      pattern as `pty.rs` / `chat.rs`). `Page.screencastFrameAck` is sent
//!      IMMEDIATELY in Rust on receipt — before the frontend paints — because
//!      Chrome stops producing frames until the previous one is acked; acking
//!      from JS would serialize the stream behind the paint loop.
//!   6. Input.* forwarding (`cdp_mouse` / `cdp_key` / `cdp_scroll` /
//!      `cdp_insert_text`) — the canvas pane maps DOM events to these.
//!
//! Spike scope: ONE session (one Chrome, one attached tab) — module statics,
//! no per-pane registry. `cdp_close_pane` detaches but leaves Chrome running
//! (next open reattaches instantly); the supervised child is killed in
//! `RunEvent::Exit` via `kill_supervised_chrome()`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

/// Per-command reply timeout. Generous — `Page.navigate` on a cold page can
/// take a few seconds; anything past this means the socket is wedged.
const CMD_TIMEOUT: Duration = Duration::from_secs(15);
/// How long we poll for `DevToolsActivePort` after launching Chrome.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);

// ── module state (spike: single session) ─────────────────────────────────────

/// The supervised Chrome child, if WE launched it this app run. Killed in
/// `RunEvent::Exit`. A reattached Chrome (launched by a previous app run) is
/// NOT in here — we only own what we spawned. parking_lot Mutex: const-fn new,
/// never held across await.
static CHROME_CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// The single live CDP session (None when no pane is open).
static SESSION: Mutex<Option<Arc<CdpSession>>> = Mutex::new(None);

/// Monotonic CDP command id shared across the whole connection (browser- and
/// session-scoped commands share one id space per the protocol).
struct CdpSession {
    /// Raw outgoing JSON text → the WS writer task. Unbounded so the reader
    /// loop can enqueue the screencast ACK without awaiting (immediate ack).
    cmd_tx: mpsc::UnboundedSender<String>,
    /// id → reply waiter.
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    /// Flat-session id of the attached page target (set right after attach).
    page_session: Mutex<Option<String>>,
    /// Last viewport pushed (w, h, scale) — replayed by screencast restarts.
    viewport: Mutex<(u32, u32, f64)>,
    /// Frontend event channel for this pane.
    channel: Channel<Value>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── chrome discovery ─────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct ChromeInfo {
    pub name: String,
    pub path: String,
}

/// Relative (inside an app dir) candidates, preference order: real Chrome
/// first, then the Chromium-family fallbacks (all speak the same protocol).
const CHROME_CANDIDATES: &[(&str, &str)] = &[
    (
        "Google Chrome",
        "Google Chrome.app/Contents/MacOS/Google Chrome",
    ),
    ("Chromium", "Chromium.app/Contents/MacOS/Chromium"),
    (
        "Microsoft Edge",
        "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ),
    (
        "Brave Browser",
        "Brave Browser.app/Contents/MacOS/Brave Browser",
    ),
];

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Finds the first installed Chromium-family browser. Checks each candidate in
/// /Applications first, then ~/Applications (per-user installs).
fn detect_chrome() -> Option<ChromeInfo> {
    let mut roots: Vec<PathBuf> = vec![PathBuf::from("/Applications")];
    if let Some(home) = home_dir() {
        roots.push(home.join("Applications"));
    }
    for (name, rel) in CHROME_CANDIDATES {
        for root in &roots {
            let p = root.join(rel);
            if p.is_file() {
                return Some(ChromeInfo {
                    name: (*name).to_string(),
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    }
    None
}

/// Dedicated profile dir — isolates the pane's Chrome from the user's daily
/// profile AND is where `--remote-debugging-port=0` drops `DevToolsActivePort`.
fn profile_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("no $HOME")?;
    let dir = home.join(".aios").join("chrome-profile");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create profile dir: {e}"))?;
    Ok(dir)
}

/// Reads `<profile>/DevToolsActivePort`: line 1 = port, line 2 = browser WS
/// path (`/devtools/browser/<uuid>`). May be stale — caller must verify with a
/// live `/json/version` before trusting it.
fn read_devtools_port(profile: &PathBuf) -> Option<u16> {
    let text = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    text.lines().next()?.trim().parse::<u16>().ok()
}

// ── hand-rolled localhost HTTP GET (no reqwest) ──────────────────────────────

/// Minimal HTTP/1.1 GET against 127.0.0.1:`port`. `Connection: close` so the
/// body is simply "read to EOF"; handles chunked transfer-encoding too since
/// some Chromium builds chunk /json responses. 3s overall timeout.
async fn http_get(port: u16, path: &str) -> Result<String, String> {
    let fut = async move {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(|e| format!("connect 127.0.0.1:{port}: {e}"))?;
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        );
        stream
            .write_all(req.as_bytes())
            .await
            .map_err(|e| format!("http write: {e}"))?;
        let mut buf = Vec::with_capacity(8 * 1024);
        stream
            .read_to_end(&mut buf)
            .await
            .map_err(|e| format!("http read: {e}"))?;
        let text = String::from_utf8_lossy(&buf).into_owned();
        let split = text
            .find("\r\n\r\n")
            .ok_or_else(|| "http: no header/body split".to_string())?;
        let (head, body) = text.split_at(split);
        let body = &body[4..];
        let status_ok = head
            .lines()
            .next()
            .map(|l| l.contains(" 200 "))
            .unwrap_or(false);
        if !status_ok {
            return Err(format!(
                "http {} → {}",
                path,
                head.lines().next().unwrap_or("?")
            ));
        }
        let chunked = head
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked");
        Ok(if chunked {
            decode_chunked(body)
        } else {
            body.to_string()
        })
    };
    tokio::time::timeout(Duration::from_secs(3), fut)
        .await
        .map_err(|_| format!("http timeout: {path}"))?
}

/// Decodes an HTTP/1.1 chunked body (hex size line + payload, until size 0).
fn decode_chunked(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let Some(line_end) = rest.find("\r\n") else {
            break;
        };
        let size_line = rest[..line_end].split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_line, 16) else {
            break;
        };
        if size == 0 {
            break;
        }
        let start = line_end + 2;
        if rest.len() < start + size {
            // truncated read — take what's there
            out.push_str(&rest[start..]);
            break;
        }
        out.push_str(&rest[start..start + size]);
        rest = rest[start + size..].trim_start_matches("\r\n");
    }
    out
}

/// `/json/version` if a debuggable Chrome is alive on `port`.
async fn json_version(port: u16) -> Option<Value> {
    let body = http_get(port, "/json/version").await.ok()?;
    serde_json::from_str(&body).ok()
}

// ── launch / reattach ────────────────────────────────────────────────────────

/// Ensures a debuggable Chrome is running against our profile and returns
/// `(port, browser_ws_url)`. Reattach-first: if `DevToolsActivePort` names a
/// port that answers `/json/version`, use it (a relaunch against a live
/// profile would no-op into that instance anyway). Otherwise launch fresh.
async fn ensure_chrome(info: &ChromeInfo, initial_url: Option<&str>) -> Result<(u16, String), String> {
    let profile = profile_dir()?;

    // 1) reattach path.
    if let Some(port) = read_devtools_port(&profile) {
        if let Some(v) = json_version(port).await {
            if let Some(ws) = v.get("webSocketDebuggerUrl").and_then(|u| u.as_str()) {
                return Ok((port, ws.to_string()));
            }
        }
    }

    // 2) fresh launch. Remove the stale port file FIRST so polling can't read
    // a dead instance's port.
    let port_file = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&port_file);

    let mut cmd = Command::new(&info.path);
    cmd.arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.to_string_lossy()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Opening straight onto the requested URL avoids a flash of the new-tab
    // page before our post-attach navigate lands.
    if let Some(u) = initial_url {
        cmd.arg(u);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("launch {}: {e}", info.name))?;
    {
        // replace (and reap) any previous dead child handle
        let mut guard = CHROME_CHILD.lock();
        if let Some(mut old) = guard.take() {
            let _ = old.try_wait();
        }
        *guard = Some(child);
    }

    // 3) poll for the port file + a live /json/version.
    let deadline = tokio::time::Instant::now() + LAUNCH_TIMEOUT;
    loop {
        if let Some(port) = read_devtools_port(&profile) {
            if let Some(v) = json_version(port).await {
                if let Some(ws) = v.get("webSocketDebuggerUrl").and_then(|u| u.as_str()) {
                    return Ok((port, ws.to_string()));
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "{} did not expose a DevTools port within {LAUNCH_TIMEOUT:?}",
                info.name
            ));
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

/// Kills the supervised Chrome child (RunEvent::Exit). A reattached Chrome we
/// didn't spawn this run is left alone.
pub fn kill_supervised_chrome() {
    if let Some(mut child) = CHROME_CHILD.lock().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ── command plumbing ─────────────────────────────────────────────────────────

impl CdpSession {
    /// Sends a CDP command and awaits its id-correlated reply. `session` =
    /// flat-session id for page-scoped commands, None for browser-scoped.
    async fn send(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        session: Option<String>,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        if self.cmd_tx.send(msg.to_string()).is_err() {
            self.pending.lock().remove(&id);
            return Err("cdp socket closed".into());
        }
        match tokio::time::timeout(CMD_TIMEOUT, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("cdp connection dropped".into()),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err(format!("cdp timeout awaiting {method}"))
            }
        }
    }

    /// Page-scoped command on the attached tab.
    async fn page(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, String> {
        let sid = self
            .page_session
            .lock()
            .clone()
            .ok_or("no attached page")?;
        self.send(method, params, Some(sid)).await
    }

    /// Starts (or restarts) the screencast at the stored viewport. Max dims =
    /// CSS size × scale so frames are crisp on retina; quality 70 jpeg per the
    /// design (good fps/size tradeoff for video-ish content).
    async fn start_screencast(self: &Arc<Self>) -> Result<(), String> {
        let (w, h, scale) = *self.viewport.lock();
        let max_w = ((w as f64) * scale).ceil() as u32;
        let max_h = ((h as f64) * scale).ceil() as u32;
        self.page(
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": 70,
                "maxWidth": max_w.max(32),
                "maxHeight": max_h.max(32),
                "everyNthFrame": 1
            }),
        )
        .await
        .map(|_| ())
    }
}

/// Routes one incoming WS message: id-replies → pending waiters; events →
/// frontend channel. The screencast frame ack is enqueued HERE, synchronously,
/// before the frame is handed to the frontend — Chrome won't send the next
/// frame until the previous one is acked, so acking must never wait on JS.
fn handle_ws_message(sess: &Arc<CdpSession>, v: Value) {
    if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
        if let Some(tx) = sess.pending.lock().remove(&id) {
            let reply = if let Some(err) = v.get("error") {
                Err(format!("cdp: {err}"))
            } else {
                Ok(v.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = tx.send(reply);
        }
        return;
    }
    let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "Page.screencastFrame" => {
            // ACK IMMEDIATELY (before the frontend ever sees the frame).
            if let (Some(frame_sid), Some(page_sid)) = (
                params.get("sessionId").cloned(),
                sess.page_session.lock().clone(),
            ) {
                let id = sess.next_id.fetch_add(1, Ordering::SeqCst);
                let ack = json!({
                    "id": id,
                    "sessionId": page_sid,
                    "method": "Page.screencastFrameAck",
                    "params": { "sessionId": frame_sid }
                });
                let _ = sess.cmd_tx.send(ack.to_string());
            }
            let _ = sess.channel.send(json!({
                "type": "frame",
                "data": params.get("data").cloned().unwrap_or(Value::Null),
                "metadata": params.get("metadata").cloned().unwrap_or(Value::Null),
                "rustTs": now_ms(),
            }));
        }
        // Top-frame navigations → keep the pane's address bar honest.
        "Page.frameNavigated" => {
            let frame = params.get("frame");
            let is_top = frame
                .map(|f| f.get("parentId").is_none())
                .unwrap_or(false);
            if is_top {
                if let Some(url) = frame.and_then(|f| f.get("url")).and_then(|u| u.as_str()) {
                    let _ = sess.channel.send(json!({ "type": "url", "url": url }));
                }
            }
        }
        "Page.navigatedWithinDocument" => {
            if let Some(url) = params.get("url").and_then(|u| u.as_str()) {
                let _ = sess.channel.send(json!({ "type": "url", "url": url }));
            }
        }
        // Tab died / closed out from under us → tell the pane.
        "Target.detachedFromTarget" | "Inspector.detached" | "Target.targetCrashed" => {
            let _ = sess
                .channel
                .send(json!({ "type": "detached", "reason": method }));
        }
        _ => {}
    }
}

/// Drops the live session (closes the WS by ending the writer task). Chrome
/// itself stays up for instant reattach; only app-exit kills it.
fn drop_session() -> Option<Arc<CdpSession>> {
    SESSION.lock().take()
}

fn current_session() -> Result<Arc<CdpSession>, String> {
    SESSION
        .lock()
        .clone()
        .ok_or_else(|| "no live cdp session — open the pane first".to_string())
}

/// Prefixes a scheme when the user typed a bare host ("netflix.com").
fn normalize_url(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return "about:blank".into();
    }
    if t.contains("://") || t.starts_with("about:") || t.starts_with("chrome:") {
        t.to_string()
    } else {
        format!("https://{t}")
    }
}

// ── tauri commands ───────────────────────────────────────────────────────────

/// Which Chromium-family browser the pane would drive (None → empty state).
#[tauri::command]
pub fn cdp_detect_chrome() -> Option<ChromeInfo> {
    detect_chrome()
}

/// Launch-or-reattach Chrome, attach the first page target (flat session),
/// size the viewport, start the screencast, and stream events/frames over
/// `on_event`. Returns the attached tab's current URL.
#[tauri::command]
pub async fn cdp_open(
    on_event: Channel<Value>,
    url: Option<String>,
    width: u32,
    height: u32,
    scale: Option<f64>,
) -> Result<String, String> {
    // Replace any previous session (its tasks die when cmd_tx drops).
    drop_session();

    let info = detect_chrome().ok_or("no chromium-family browser installed")?;
    let want_url = url.as_deref().map(normalize_url);
    let (port, ws_url) = ensure_chrome(&info, want_url.as_deref()).await?;
    let _ = port; // (kept for debuggability in error strings if needed later)

    let (ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| format!("ws connect {ws_url}: {e}"))?;
    let (mut sink, mut stream) = ws.split();
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<String>();

    let sess = Arc::new(CdpSession {
        cmd_tx,
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        page_session: Mutex::new(None),
        viewport: Mutex::new((width.max(32), height.max(32), scale.unwrap_or(1.0).max(0.5))),
        channel: on_event,
    });

    // Writer: serialize every outgoing command/ack onto the socket.
    tauri::async_runtime::spawn(async move {
        while let Some(txt) = cmd_rx.recv().await {
            if sink.send(Message::Text(txt)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // Reader: replies → waiters, events → frontend (acks frames inline).
    {
        let sess = Arc::clone(&sess);
        tauri::async_runtime::spawn(async move {
            while let Some(msg) = stream.next().await {
                let Ok(msg) = msg else { break };
                let Message::Text(txt) = msg else { continue };
                let Ok(v) = serde_json::from_str::<Value>(&txt) else {
                    continue;
                };
                handle_ws_message(&sess, v);
            }
            // Socket gone (chrome quit / network) → fail any in-flight waiters
            // and tell the pane.
            sess.pending.lock().clear();
            let _ = sess.channel.send(json!({ "type": "closed" }));
        });
    }

    // Pick the first real page target (skip devtools:// + extension pages).
    let targets = sess.send("Target.getTargets", json!({}), None).await?;
    let mut target: Option<(String, String)> = None; // (targetId, url)
    if let Some(infos) = targets.get("targetInfos").and_then(|t| t.as_array()) {
        for t in infos {
            let ty = t.get("type").and_then(|x| x.as_str()).unwrap_or("");
            let turl = t.get("url").and_then(|x| x.as_str()).unwrap_or("");
            if ty == "page" && !turl.starts_with("devtools://") && !turl.starts_with("chrome-extension://") {
                if let Some(id) = t.get("targetId").and_then(|x| x.as_str()) {
                    target = Some((id.to_string(), turl.to_string()));
                    break;
                }
            }
        }
    }
    let (target_id, mut tab_url) = match target {
        Some(t) => t,
        None => {
            let created = sess
                .send(
                    "Target.createTarget",
                    json!({ "url": want_url.clone().unwrap_or_else(|| "about:blank".into()) }),
                    None,
                )
                .await?;
            let id = created
                .get("targetId")
                .and_then(|x| x.as_str())
                .ok_or("createTarget returned no targetId")?
                .to_string();
            (id, want_url.clone().unwrap_or_else(|| "about:blank".into()))
        }
    };

    // Flat-session attach: session commands carry sessionId at the top level.
    let attached = sess
        .send(
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
            None,
        )
        .await?;
    let session_id = attached
        .get("sessionId")
        .and_then(|x| x.as_str())
        .ok_or("attachToTarget returned no sessionId")?
        .to_string();
    *sess.page_session.lock() = Some(session_id);

    sess.page("Page.enable", json!({})).await?;
    // Size the page's layout viewport to the pane rect so the screencast maps
    // 1:1 (CSS px) onto the canvas — no letterboxing math in the frontend.
    {
        let (w, h, dpr) = *sess.viewport.lock();
        sess.page(
            "Emulation.setDeviceMetricsOverride",
            json!({ "width": w, "height": h, "deviceScaleFactor": dpr, "mobile": false }),
        )
        .await?;
    }
    // Navigate if the caller asked for a URL and the reused tab isn't on it.
    if let Some(u) = want_url {
        if u != tab_url {
            sess.page("Page.navigate", json!({ "url": u })).await?;
            tab_url = u;
        }
    }
    sess.start_screencast().await?;

    let _ = sess
        .channel
        .send(json!({ "type": "url", "url": tab_url }));
    *SESSION.lock() = Some(sess);
    Ok(tab_url)
}

/// Detach the pane: stop the screencast and drop the WS. Chrome stays alive
/// (reattach is instant); app exit reaps the supervised child.
#[tauri::command]
pub async fn cdp_close_pane() -> Result<(), String> {
    let Some(sess) = drop_session() else {
        return Ok(());
    };
    // Best-effort — if the socket is already dead this just times out fast on
    // the closed-channel send, which is fine.
    let _ = sess.page("Page.stopScreencast", json!({})).await;
    Ok(())
}

#[tauri::command]
pub async fn cdp_navigate(url: String) -> Result<(), String> {
    let sess = current_session()?;
    sess.page("Page.navigate", json!({ "url": normalize_url(&url) }))
        .await
        .map(|_| ())
}

/// History step shared by back/forward. Returns whether a step happened.
async fn history_step(delta: i64) -> Result<bool, String> {
    let sess = current_session()?;
    let hist = sess
        .page("Page.getNavigationHistory", json!({}))
        .await?;
    let cur = hist
        .get("currentIndex")
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let entries = hist
        .get("entries")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let want = cur + delta;
    if want < 0 || want as usize >= entries.len() {
        return Ok(false);
    }
    let Some(entry_id) = entries[want as usize].get("id").and_then(|x| x.as_i64()) else {
        return Ok(false);
    };
    sess.page(
        "Page.navigateToHistoryEntry",
        json!({ "entryId": entry_id }),
    )
    .await?;
    Ok(true)
}

#[tauri::command]
pub async fn cdp_back() -> Result<bool, String> {
    history_step(-1).await
}

#[tauri::command]
pub async fn cdp_forward() -> Result<bool, String> {
    history_step(1).await
}

#[tauri::command]
pub async fn cdp_reload() -> Result<(), String> {
    let sess = current_session()?;
    sess.page("Page.reload", json!({})).await.map(|_| ())
}

/// Forward a mouse event. `kind` ∈ mousePressed | mouseReleased | mouseMoved.
/// Coordinates are page CSS px (the pane already mapped canvas px → viewport
/// via the frame metadata). `modifiers` bitmask: alt=1 ctrl=2 meta=4 shift=8.
#[tauri::command]
pub async fn cdp_mouse(
    kind: String,
    x: f64,
    y: f64,
    button: Option<String>,
    click_count: Option<u32>,
    modifiers: Option<u32>,
) -> Result<(), String> {
    let sess = current_session()?;
    let button = button.unwrap_or_else(|| "none".into());
    sess.page(
        "Input.dispatchMouseEvent",
        json!({
            "type": kind,
            "x": x,
            "y": y,
            "button": button,
            "buttons": match button.as_str() { "left" => 1, "right" => 2, "middle" => 4, _ => 0 },
            "clickCount": click_count.unwrap_or(0),
            "modifiers": modifiers.unwrap_or(0),
        }),
    )
    .await
    .map(|_| ())
}

/// Forward a wheel event. Deltas use CDP's wheel convention (the frontend
/// negates DOM `deltaY` — see cdp.ts).
#[tauri::command]
pub async fn cdp_scroll(
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
    modifiers: Option<u32>,
) -> Result<(), String> {
    let sess = current_session()?;
    sess.page(
        "Input.dispatchMouseEvent",
        json!({
            "type": "mouseWheel",
            "x": x,
            "y": y,
            "deltaX": delta_x,
            "deltaY": delta_y,
            "modifiers": modifiers.unwrap_or(0),
        }),
    )
    .await
    .map(|_| ())
}

/// Forward a key event. `kind` ∈ keyDown | keyUp | rawKeyDown | char. The
/// frontend mapper (cdp.ts) picks keyDown+text for printables and rawKeyDown
/// for non-printing keys, per the DevTools screencast frontend's own scheme.
#[tauri::command]
pub async fn cdp_key(
    kind: String,
    key: String,
    code: String,
    windows_virtual_key_code: Option<u32>,
    text: Option<String>,
    modifiers: Option<u32>,
) -> Result<(), String> {
    let sess = current_session()?;
    let mut params = json!({
        "type": kind,
        "key": key,
        "code": code,
        "modifiers": modifiers.unwrap_or(0),
        "windowsVirtualKeyCode": windows_virtual_key_code.unwrap_or(0),
        "nativeVirtualKeyCode": windows_virtual_key_code.unwrap_or(0),
    });
    if let Some(t) = text {
        params["text"] = json!(t);
        params["unmodifiedText"] = json!(t);
    }
    sess.page("Input.dispatchKeyEvent", params).await.map(|_| ())
}

/// IME-grade text insertion (paste, emoji, composed input) — skips key events.
#[tauri::command]
pub async fn cdp_insert_text(text: String) -> Result<(), String> {
    let sess = current_session()?;
    sess.page("Input.insertText", json!({ "text": text }))
        .await
        .map(|_| ())
}

/// Pane resized → re-emulate the viewport and restart the screencast at the
/// new max dims (screencast max size is fixed at start time, so a restart is
/// the only way to keep frames matched to the pane rect).
#[tauri::command]
pub async fn cdp_set_viewport(
    width: u32,
    height: u32,
    scale: Option<f64>,
) -> Result<(), String> {
    let sess = current_session()?;
    let (w, h) = (width.max(32), height.max(32));
    let dpr = {
        let mut vp = sess.viewport.lock();
        let dpr = scale.unwrap_or(vp.2).max(0.5);
        *vp = (w, h, dpr);
        dpr
    };
    sess.page(
        "Emulation.setDeviceMetricsOverride",
        json!({ "width": w, "height": h, "deviceScaleFactor": dpr, "mobile": false }),
    )
    .await?;
    let _ = sess.page("Page.stopScreencast", json!({})).await;
    sess.start_screencast().await
}
