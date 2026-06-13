//! `aios-noded` — the headless AIOS node daemon.
//!
//! Runs chat sessions on a remote GUI box and exposes them over a tailnet-only
//! HTTP/WS API so a Mac cockpit pane can attach live (ring-buffer replay → live
//! stream, bidirectional). The session runtime is `aios-chat-core` — the exact
//! same `ChatSession` + replay buffer the laptop Tauri shell uses; only the
//! `OutputSink` differs (a broadcast sender here, a Tauri Channel there).
//!
//! SECURITY: this is RCE by design (it spawns claude/codex with whatever cwd a
//! caller asks for). Two hard rules, enforced below:
//!   1. Bind the tailscale IP ONLY — never `0.0.0.0`, never the public domain.
//!   2. Every request needs a valid bearer token (CSPRNG, `0600`, constant-time).

mod auth;
mod manager;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;

use manager::Manager;

struct AppState {
    manager: Manager,
    secret: String,
}

#[tokio::main]
async fn main() {
    let secret = match auth::load_or_create() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("aios-noded: cannot load node-secret: {e}");
            std::process::exit(1);
        }
    };

    // Bind the tailscale IP only. Default to the box's known tailnet address;
    // override with AIOS_NODE_BIND. Refuse 0.0.0.0 / :: — binding all interfaces
    // would expose an RCE daemon to every network the box is on.
    let bind = std::env::var("AIOS_NODE_BIND")
        .unwrap_or_else(|_| "100.113.3.98:8765".to_string());
    let addr: SocketAddr = match bind.parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("aios-noded: bad AIOS_NODE_BIND {bind:?}: {e}");
            std::process::exit(1);
        }
    };
    if addr.ip().is_unspecified() {
        eprintln!(
            "aios-noded: refusing to bind {addr} — 0.0.0.0/:: exposes an RCE daemon to every network. Bind the tailscale IP."
        );
        std::process::exit(1);
    }

    let state = Arc::new(AppState {
        manager: Manager::new(),
        secret,
    });

    let app = Router::new()
        .route("/registry", get(registry))
        .route("/chat/start", post(chat_start))
        .route("/chat/:id/attach", get(attach))
        .route("/chat/:id/stop", post(chat_stop))
        .route("/health", get(|| async { "ok" }))
        .with_state(state);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("aios-noded: cannot bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("aios-noded listening on {addr} (tailnet-only, bearer-auth)");
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("aios-noded: server error: {e}");
        std::process::exit(1);
    }
}

/// Checks the bearer token in constant time. Returns Err(401) on mismatch.
fn check_auth(headers: &HeaderMap, secret: &str) -> Result<(), StatusCode> {
    let raw = headers.get("authorization").and_then(|h| h.to_str().ok());
    match auth::bearer(raw) {
        Some(tok) if auth::ct_eq(tok, secret) => Ok(()),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

async fn registry(State(st): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(code) = check_auth(&headers, &st.secret) {
        return code.into_response();
    }
    Json(json!({ "sessions": st.manager.registry() })).into_response()
}

#[derive(Deserialize)]
struct StartReq {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    resume: Option<String>,
    /// Reserved: only "claude" is supported in v1; other engines 400 for now.
    #[serde(default)]
    engine: Option<String>,
}

async fn chat_start(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<StartReq>,
) -> Response {
    if let Err(code) = check_auth(&headers, &st.secret) {
        return code.into_response();
    }
    let engine = req.engine.as_deref().unwrap_or("claude");
    if engine != "claude" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("engine {engine:?} not supported on this node yet (v1: claude only)") })),
        )
            .into_response();
    }
    match st.manager.start_claude(req.cwd, req.model, req.resume) {
        Ok(id) => Json(json!({ "id": id })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

async fn chat_stop(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<u32>,
) -> Response {
    if let Err(code) = check_auth(&headers, &st.secret) {
        return code.into_response();
    }
    match st.manager.stop(id) {
        Ok(()) => Json(json!({ "stopped": id })).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))).into_response(),
    }
}

/// Client→server WS control frame.
#[derive(Deserialize)]
struct WsInput {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: String,
}

async fn attach(
    ws: WebSocketUpgrade,
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<u32>,
) -> Response {
    // Auth happens on the upgrade GET (it carries the same Authorization header).
    if let Err(code) = check_auth(&headers, &st.secret) {
        return code.into_response();
    }
    if st.manager.get(id).is_none() {
        return (StatusCode::NOT_FOUND, "no such session").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, st, id))
}

/// Replay the session's ring buffer to the new pane, then forward live broadcast
/// lines while pumping the pane's input back to the session. Snapshot-then-
/// subscribe ordering favors a (microsecond, self-healing) gap over duplicating a
/// whole event line — a seqno-based handoff is a future polish.
async fn handle_socket(socket: WebSocket, st: Arc<AppState>, id: u32) {
    let Some(node) = st.manager.get(id) else {
        return;
    };

    // Snapshot the replay buffer, THEN subscribe to live.
    let replay: Vec<String> = node.sess.buffer.lock().iter().cloned().collect();
    let mut rx = node.tx.subscribe();

    let (mut sink, mut stream) = socket.split();

    // outbound: replay buffer, then forward live lines until the socket dies.
    let out = tokio::spawn(async move {
        for line in replay {
            if sink.send(Message::Text(line)).await.is_err() {
                return;
            }
        }
        loop {
            match rx.recv().await {
                Ok(line) => {
                    if sink.send(Message::Text(line)).await.is_err() {
                        return;
                    }
                }
                // Lagged: a slow pane fell behind the broadcast cap. Skip the gap
                // and keep streaming rather than dropping the whole connection.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    });

    // inbound: pane → session (send / interrupt / steer).
    let mgr = &st.manager;
    while let Some(Ok(msg)) = stream.next().await {
        if let Message::Text(txt) = msg {
            if let Ok(input) = serde_json::from_str::<WsInput>(&txt) {
                let _ = match input.kind.as_str() {
                    "send" | "steer" => mgr.send(id, &input.text),
                    "interrupt" => mgr.interrupt(id),
                    _ => Ok(()),
                };
            }
        } else if let Message::Close(_) = msg {
            break;
        }
    }
    out.abort();
}
