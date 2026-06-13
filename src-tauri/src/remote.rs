//! Mac-side remote-attach: drive a chat session that actually runs on the box
//! (`aios-noded`) as if it were local. The frontend `ChatPane` is unchanged — it
//! still gets claude stream-json lines on a `Channel<String>`; they just arrive
//! over a tailnet WebSocket instead of from a local child's stdout. Input
//! (`chat_send`/`chat_steer`/`chat_interrupt`) reverse-pipes over the same socket.
//!
//! A remote session occupies the SAME id space as local ones (chat.rs allocates
//! the id from its `NEXT_ID` and hands it here), so the frontend treats local and
//! box sessions identically — chat.rs's command handlers just consult the remote
//! table first.
//!
//! No HTTP client crate is pulled (the app deliberately avoids reqwest); the one
//! `POST /chat/start` is hand-rolled over a tokio TcpStream, mirroring cdp.rs's
//! hand-rolled discovery GET. WS uses the in-tree `tokio-tungstenite`.

use std::collections::HashMap;
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use futures_util::{SinkExt, StreamExt};

/// A live remote session: which box session it maps to, and the input channel
/// whose drain task writes frames onto the WS. Dropping `input_tx` ends the
/// writer task, which closes the socket.
struct RemoteHandle {
    box_id: u32,
    input_tx: mpsc::UnboundedSender<String>,
}

fn remote_table() -> &'static Mutex<HashMap<u32, RemoteHandle>> {
    static T: OnceLock<Mutex<HashMap<u32, RemoteHandle>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `(host:port, bearer secret)` for the box node. Both env-overridable; the
/// secret defaults to the shared `~/.aios/state/node-secret` the daemon writes.
fn node_target() -> Result<(String, String), String> {
    let addr = std::env::var("AIOS_NODE_ADDR")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "100.113.3.98:8765".to_string());
    // Secret precedence: AIOS_NODE_SECRET env → dedicated `box-node-secret`
    // (the BOX's token, paired once — distinct from this Mac's own control-plane
    // `node-secret`, a different trust domain) → fall back to `node-secret` for
    // the single-machine case. The dedicated file is what makes Mac↔box auth work
    // without overloading the local control-plane token.
    let home = std::env::var("HOME").ok();
    let read = |name: &str| -> Option<String> {
        let h = home.as_ref()?;
        std::fs::read_to_string(format!("{h}/.aios/state/{name}"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let secret = std::env::var("AIOS_NODE_SECRET")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| read("box-node-secret"))
        .or_else(|| read("node-secret"))
        .ok_or("no node-secret (set AIOS_NODE_SECRET or ~/.aios/state/box-node-secret)")?;
    Ok((addr, secret))
}

/// Minimal `POST <path>` with a JSON body + bearer auth over a raw TcpStream.
/// Reads to EOF (`Connection: close`) and returns the parsed JSON body. Avoids a
/// whole HTTP-client dependency for the daemon's tiny control endpoints.
async fn http_post_json(
    addr: &str,
    path: &str,
    secret: &str,
    body: Value,
) -> Result<Value, String> {
    let mut stream = TcpStream::connect(addr)
        .await
        .map_err(|e| format!("connect {addr}: {e}"))?;
    let body = body.to_string();
    let host = addr.split(':').next().unwrap_or(addr);
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {secret}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .await
        .map_err(|e| format!("read: {e}"))?;
    let text = String::from_utf8_lossy(&raw);
    let (head, json_body) = text
        .split_once("\r\n\r\n")
        .ok_or("malformed HTTP response from node")?;
    let status_ok = head.lines().next().map(|l| l.contains(" 200 ")).unwrap_or(false);
    let parsed: Value =
        serde_json::from_str(json_body.trim()).map_err(|e| format!("bad node JSON: {e}"))?;
    if !status_ok {
        let err = parsed
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("node returned non-200");
        return Err(err.to_string());
    }
    Ok(parsed)
}

/// Minimal authed `GET <path>` over a raw TcpStream (read to EOF). Mirrors
/// `http_post_json` for the daemon's read endpoints (`/registry`, `/health`).
async fn http_get_json(addr: &str, path: &str, secret: &str) -> Result<Value, String> {
    let mut stream = TcpStream::connect(addr)
        .await
        .map_err(|e| format!("connect {addr}: {e}"))?;
    let host = addr.split(':').next().unwrap_or(addr);
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {secret}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .await
        .map_err(|e| format!("read: {e}"))?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or("malformed HTTP response from node")?;
    if !head.lines().next().map(|l| l.contains(" 200 ")).unwrap_or(false) {
        return Err("node returned non-200".to_string());
    }
    serde_json::from_str(body.trim()).map_err(|e| format!("bad node JSON: {e}"))
}

/// Tauri command: fetch the box node's live session registry for the Mac roster.
/// Returns `{ "sessions": [...] }` (or an error string the UI can show as offline).
#[tauri::command]
pub fn node_registry() -> Result<Value, String> {
    let (addr, secret) = node_target()?;
    tauri::async_runtime::block_on(http_get_json(&addr, "/registry", &secret))
}

/// Starts a session on the box and attaches it to `on_event` under `local_id`.
/// Returns immediately after the start RPC; the WS attach + line pump run on the
/// Tauri async runtime. `local_id` is allocated by chat.rs so it shares the local
/// id space (no collisions, frontend treats it like any session).
pub fn start(
    local_id: u32,
    on_event: Channel<String>,
    cwd: Option<String>,
    model: Option<String>,
    resume: Option<String>,
) -> Result<(), String> {
    let (addr, secret) = node_target()?;
    // Block on the start RPC so we can surface a real error to the caller (and so
    // the box session exists before we report success). The WS pump is detached.
    let start_body = json!({
        "engine": "claude",
        "cwd": cwd,
        "model": model,
        "resume": resume,
    });
    let addr_for_rpc = addr.clone();
    let secret_for_rpc = secret.clone();
    let box_id = tauri::async_runtime::block_on(async move {
        let resp = http_post_json(&addr_for_rpc, "/chat/start", &secret_for_rpc, start_body).await?;
        resp.get("id")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .ok_or_else(|| "node /chat/start returned no id".to_string())
    })?;

    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<String>();
    remote_table()
        .lock()
        .insert(local_id, RemoteHandle { box_id, input_tx });

    // Attach WS: forward box lines → frontend channel; drain input_rx → box.
    tauri::async_runtime::spawn(async move {
        let url = format!("ws://{addr}/chat/{box_id}/attach");
        let mut req = match url.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                let _ = on_event.send(synthetic_error(&format!("bad ws url: {e}")));
                cleanup(local_id);
                return;
            }
        };
        if let Ok(val) = format!("Bearer {secret}").parse() {
            req.headers_mut().insert("authorization", val);
        }
        let ws = match tokio_tungstenite::connect_async(req).await {
            Ok((ws, _)) => ws,
            Err(e) => {
                let _ = on_event.send(synthetic_error(&format!("node ws connect failed: {e}")));
                cleanup(local_id);
                return;
            }
        };
        let (mut sink, mut stream) = ws.split();

        // writer: frontend input → box.
        let writer = tauri::async_runtime::spawn(async move {
            while let Some(frame) = input_rx.recv().await {
                if sink.send(Message::Text(frame)).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        // reader: box lines → frontend channel (verbatim stream-json).
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(Message::Text(line)) => {
                    if on_event.send(line).is_err() {
                        break; // pane closed
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        writer.abort();
        cleanup(local_id);
    });

    Ok(())
}

/// True if `local_id` is a remote (box-backed) session.
pub fn is_remote(local_id: u32) -> bool {
    remote_table().lock().contains_key(&local_id)
}

/// Sends a user turn to the box session.
pub fn send(local_id: u32, text: &str) -> Result<(), String> {
    push_frame(local_id, json!({ "type": "send", "text": text }))
}

/// Steers the in-flight box turn (claude: another injected user line).
pub fn steer(local_id: u32, text: &str) -> Result<(), String> {
    push_frame(local_id, json!({ "type": "steer", "text": text }))
}

/// Interrupts the in-flight box turn.
pub fn interrupt(local_id: u32) -> Result<(), String> {
    push_frame(local_id, json!({ "type": "interrupt" }))
}

/// Stops the box session and drops the local handle.
pub fn stop(local_id: u32) -> Result<(), String> {
    let box_id = {
        let t = remote_table().lock();
        t.get(&local_id).map(|h| h.box_id)
    };
    let Some(box_id) = box_id else {
        return Ok(()); // already gone
    };
    if let Ok((addr, secret)) = node_target() {
        let _ = tauri::async_runtime::block_on(http_post_json(
            &addr,
            &format!("/chat/{box_id}/stop"),
            &secret,
            json!({}),
        ));
    }
    cleanup(local_id); // drops input_tx → writer ends → WS closes
    Ok(())
}

fn push_frame(local_id: u32, frame: Value) -> Result<(), String> {
    let t = remote_table().lock();
    let h = t.get(&local_id).ok_or("no such remote session")?;
    h.input_tx
        .send(frame.to_string())
        .map_err(|_| "remote session input channel closed".to_string())
}

fn cleanup(local_id: u32) {
    remote_table().lock().remove(&local_id);
}

fn synthetic_error(msg: &str) -> String {
    json!({
        "type": "result",
        "subtype": "error_during_execution",
        "is_error": true,
        "text": msg,
        "session_id": "",
        "total_cost_usd": 0
    })
    .to_string()
}
