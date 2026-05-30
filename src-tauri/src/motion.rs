//! MOTION — MotionBoards AI generation proxy. A thin, server-side HTTP bridge
//! to the MotionBoards REST API (the `flashstudio` Next.js app deployed at
//! `https://motionboards.vercel.app`) so the AIOS canvas pane can generate
//! images + videos without (a) tripping the webview's CORS, or (b) ever
//! exposing the Bearer key to the frontend. Mirrors the clean, commented style
//! of `bridges.rs` / `oracles.rs`.
//!
//! WHY curl, not an http crate: the shell's Cargo manifest carries only
//! serde/serde_json/chrono — no reqwest/ureq, and the task forbids adding one.
//! Every macOS install ships `curl`, so we shell out via `std::process::Command`
//! exactly like the other modules shell out to `ps` / `launchctl` / `tmux`.
//! Keys + the base URL stay in this process; the webview only ever sees parsed
//! JSON `Value`s.
//!
//! API CONTRACT (verified live 2026-05-30 against the deployed app AND the
//! canonical MCP client at ~/Repo/firaz/claude-motion/src/lib/client.ts):
//!
//!   Auth     `Authorization: Bearer <key>` where key starts with `mb_`
//!            (created in motionboards.vercel.app → Settings → API Keys). The
//!            route layer accepts EITHER this Bearer OR a session cookie
//!            (src/lib/auth.ts → requireUser); we always use the Bearer.
//!   Base     https://motionboards.vercel.app   (override: AIOS_MOTION_API)
//!   Key env  AIOS_MOTION_KEY  ▸ falls back to MOTIONBOARDS_API_KEY (the same
//!            name the MCP server reads, so a machine already running the
//!            `motion` MCP needs zero extra config).
//!
//!   GET  /api/models           → { models: [ { id, name, type, provider,
//!                                              creditCost, inputs:[{name,type,
//!                                              required,description}] } ] }
//!                                 (src/app/api/models/route.ts)
//!   GET  /api/auth/me          → { user: { id, name, email, credits, role },
//!                                  subscription: { active, expiresAt, … } }
//!                                 credits are in SEN (RM*100). This is the
//!                                 credits read — there is NO /api/credits GET
//!                                 (that route is admin-topup POST only).
//!                                 (src/app/api/auth/me/route.ts + claude-motion
//!                                  tools/credits.ts)
//!   POST /api/generate         → body { prompt, model, inputImage, inputImages,
//!                                  inputVideo, inputVideos, startFrame, endFrame,
//!                                  inputAudio, inputAudios, generationOptions }.
//!                                 SYNC models (Nano Banana, GPT Image, FLUX,
//!                                 Segmind, TTS) return
//!                                   { generationId, status:"completed",
//!                                     outputUrl }
//!                                 ASYNC models (Veo, Seedance, Kling, Wan, Sora,
//!                                 lipsync) return
//!                                   { generationId, requestId, modelId,
//!                                     status:"processing", <provider>Video:true }
//!                                 (src/app/api/generate/route.ts)
//!   GET  /api/generate/status  → ?requestId&modelId&generationId (+ optional
//!                                  durationSec&resolution) →
//!                                   { status:"processing"|"completed"|"failed",
//!                                     outputUrl?, log?, error?, cost? }.
//!                                 The route AUTO-DETECTS the provider from
//!                                 modelId when no <provider>Video flag is given
//!                                 (it names "claude-motion MCP, AIOS bridge
//!                                  poller" as the intended non-browser callers),
//!                                 so the pane never has to know the provider
//!                                 taxonomy. (src/app/api/generate/status/route.ts)
//!
//! Every command is DEFENSIVE: a missing key, an unreachable host, a non-2xx,
//! or unparseable JSON resolves to a structured `{ ok:false, error, … }` Value
//! (or a `Result::Err(String)` for `motion_generate`) — never a panic. The pane
//! reads `configured`/`ok` to degrade into a clear "configure MotionBoards API"
//! state instead of failing blind.

use serde_json::{json, Value};

// ════════════════════════════════════════════════════════════════════════
// config — base URL + Bearer key, both env-overridable
// ════════════════════════════════════════════════════════════════════════

/// Default deployment, confirmed across the app (sitemap/robots/layout) and the
/// MCP client's `DEFAULT_BASE_URL`.
const DEFAULT_BASE_URL: &str = "https://motionboards.vercel.app";

/// Resolved base URL — `AIOS_MOTION_API` wins (lets the owner point the pane at
/// a local `next dev` on :3000 or a preview deploy), else the prod default.
/// Trailing slashes are trimmed so `format!("{base}/api/…")` is always clean.
fn base_url() -> String {
    let raw = std::env::var("AIOS_MOTION_API")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    raw.trim_end_matches('/').to_string()
}

/// Resolved Bearer key. Prefers `AIOS_MOTION_KEY` (the AIOS-namespaced var), then
/// `MOTIONBOARDS_API_KEY` (the name the `motion` MCP server already uses — so a
/// box that runs the MCP is configured for free). `None` when neither is set or
/// the value is blank.
fn api_key() -> Option<String> {
    for var in ["AIOS_MOTION_KEY", "MOTIONBOARDS_API_KEY"] {
        if let Ok(v) = std::env::var(var) {
            let t = v.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    // Fallback: a key file at ~/.aios/state/motion.key (kept out of source so
    // the GUI app — which doesn't inherit the shell env — can still authenticate).
    if let Ok(home) = std::env::var("HOME") {
        if let Ok(v) = std::fs::read_to_string(format!("{home}/.aios/state/motion.key")) {
            let t = v.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

// ════════════════════════════════════════════════════════════════════════
// HTTP via curl
// ════════════════════════════════════════════════════════════════════════

/// Outcome of one curl invocation: the parsed JSON body (when the response was
/// JSON), the raw text otherwise, and the HTTP status. Network/spawn failures
/// surface as `Err(String)`.
struct HttpOut {
    status: u16,
    /// Parsed JSON when the body was valid JSON, else `Value::Null`.
    json: Value,
    /// Raw body text (always populated) — used for error messages when the
    /// body wasn't JSON (Vercel's HTML 413/5xx pages, gateway errors, …).
    text: String,
}

/// Runs `curl` against `path` (e.g. `/api/models`) on the configured base URL,
/// attaching the Bearer key. `method` is "GET" or "POST"; a POST sends
/// `json_body` as the request body with `Content-Type: application/json`.
///
/// Flags: `-s` silent, `-S` still show hard errors, `--max-time` hard timeout,
/// and `-w "\n<<<%{http_code}"` to append the status code on its own trailer
/// line so we can split body from status without extra round-trips. We do NOT
/// pass `-f` — we want the body of non-2xx responses (the API returns a JSON
/// `{ error }` on 4xx that we forward verbatim).
///
/// Best-effort: returns `Err` only when curl itself can't run or the host is
/// unreachable; an HTTP error (4xx/5xx) is a successful `Ok(HttpOut)` carrying
/// the status + body for the caller to interpret.
fn curl(
    method: &str,
    path: &str,
    key: &str,
    json_body: Option<&str>,
    timeout_secs: u64,
) -> Result<HttpOut, String> {
    let url = format!("{}{}", base_url(), path);
    // Unique sentinel so a status trailer can't collide with body content.
    const SENTINEL: &str = "\n<<<AIOS_HTTP_CODE:";

    let mut cmd = std::process::Command::new("curl");
    cmd.arg("-sS")
        .arg("--max-time")
        .arg(timeout_secs.to_string())
        .arg("-X")
        .arg(method)
        .arg("-H")
        .arg(format!("Authorization: Bearer {key}"))
        .arg("-H")
        .arg("Accept: application/json")
        .arg("-w")
        .arg(format!("{SENTINEL}%{{http_code}}"));

    if let Some(body) = json_body {
        cmd.arg("-H")
            .arg("Content-Type: application/json")
            .arg("--data-binary")
            .arg(body);
    }

    cmd.arg(url);

    let out = cmd
        .output()
        .map_err(|e| format!("couldn't run curl: {e} (is curl on PATH?)"))?;

    let raw = String::from_utf8_lossy(&out.stdout).to_string();

    // Curl failed to even reach the server (DNS, refused, timeout). stderr
    // carries the reason; surface a trimmed version.
    if !out.status.success() && raw.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = err.trim();
        return Err(if msg.is_empty() {
            "curl failed (no output) — host unreachable or request timed out".to_string()
        } else {
            msg.chars().take(300).collect()
        });
    }

    // Split the body from the appended "<<<AIOS_HTTP_CODE:NNN" trailer.
    let (body, status) = match raw.rfind(SENTINEL) {
        Some(idx) => {
            let code_str = raw[idx + SENTINEL.len()..].trim();
            let code = code_str.parse::<u16>().unwrap_or(0);
            (raw[..idx].to_string(), code)
        }
        None => (raw.clone(), 0),
    };

    let json = serde_json::from_str::<Value>(body.trim()).unwrap_or(Value::Null);

    Ok(HttpOut {
        status,
        json,
        text: body.trim().chars().take(600).collect(),
    })
}

/// Pulls the API's own `{ error: "…" }` message out of a parsed body when
/// present, else falls back to the raw text, else a generic `HTTP <status>`.
fn error_message(out: &HttpOut) -> String {
    if let Some(e) = out.json.get("error").and_then(|v| v.as_str()) {
        return e.to_string();
    }
    if !out.text.is_empty() {
        return out.text.clone();
    }
    format!("HTTP {}", out.status)
}

/// Shared "not configured" payload so every command degrades identically. The
/// pane keys off `configured: false` to show the setup state.
fn not_configured() -> Value {
    json!({
        "ok": false,
        "configured": false,
        "error": "MotionBoards API key not set. Create one at motionboards.vercel.app → Settings → API Keys, then set AIOS_MOTION_KEY=mb_… (or MOTIONBOARDS_API_KEY). Optionally set AIOS_MOTION_API to point at a different base URL.",
        "baseUrl": base_url(),
    })
}

// ════════════════════════════════════════════════════════════════════════
// commands
// ════════════════════════════════════════════════════════════════════════

/// Available generation models. Returns the live catalog from `GET /api/models`
/// shaped as `{ ok, configured, baseUrl, models: [...] }`. The `models` array is
/// passed through verbatim — `{ id, name, type, provider, creditCost, inputs }`
/// per entry — so the pane can drive its dropdown + per-model option hints
/// directly. On any failure returns `{ ok:false, … , models:[] }` (never an
/// error throw) so the UI can still render its empty/needs-config state.
#[tauri::command]
pub fn motion_models() -> Value {
    let Some(key) = api_key() else {
        let mut v = not_configured();
        v["models"] = json!([]);
        return v;
    };

    match curl("GET", "/api/models", &key, None, 30) {
        Ok(out) if (200..300).contains(&out.status) => {
            let models = out
                .json
                .get("models")
                .cloned()
                .unwrap_or_else(|| json!([]));
            json!({
                "ok": true,
                "configured": true,
                "baseUrl": base_url(),
                "models": models,
            })
        }
        Ok(out) => json!({
            "ok": false,
            "configured": true,
            "baseUrl": base_url(),
            "status": out.status,
            "error": error_message(&out),
            "models": [],
        }),
        Err(e) => json!({
            "ok": false,
            "configured": true,
            "baseUrl": base_url(),
            "error": e,
            "models": [],
        }),
    }
}

/// Best-effort credits / account read. There is no public `/api/credits` GET, so
/// (matching the MCP's `credits` tool) this reads `GET /api/auth/me` and projects
/// the account + credit balance. Credits come back in SEN; we also surface
/// `creditsRm` (RM, 2dp) for convenient display.
///
/// Always returns a Value: `{ ok, configured, credits, creditsRm, name, email,
/// role, subscriptionActive }` on success, or `{ ok:false, credits:null, … }`
/// when unknown — the pane treats `credits:null` as "usage unknown" rather than
/// an error.
#[tauri::command]
pub fn motion_credits() -> Value {
    let Some(key) = api_key() else {
        let mut v = not_configured();
        v["credits"] = Value::Null;
        v["creditsRm"] = Value::Null;
        return v;
    };

    match curl("GET", "/api/auth/me", &key, None, 30) {
        Ok(out) if (200..300).contains(&out.status) => {
            let user = out.json.get("user").cloned().unwrap_or(Value::Null);
            let credits = user.get("credits").and_then(|v| v.as_i64());
            let credits_rm = credits.map(|c| format!("{:.2}", c as f64 / 100.0));
            let sub_active = out
                .json
                .get("subscription")
                .and_then(|s| s.get("active"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            json!({
                "ok": true,
                "configured": true,
                "baseUrl": base_url(),
                "credits": credits,
                "creditsRm": credits_rm,
                "name": user.get("name").and_then(|v| v.as_str()),
                "email": user.get("email").and_then(|v| v.as_str()),
                "role": user.get("role").and_then(|v| v.as_str()),
                "subscriptionActive": sub_active,
            })
        }
        // 401 here almost always means a bad / revoked key — say so plainly.
        Ok(out) => json!({
            "ok": false,
            "configured": true,
            "baseUrl": base_url(),
            "status": out.status,
            "error": if out.status == 401 {
                "MotionBoards rejected the API key (401). Check AIOS_MOTION_KEY / MOTIONBOARDS_API_KEY — it may be wrong or revoked.".to_string()
            } else {
                error_message(&out)
            },
            "credits": Value::Null,
            "creditsRm": Value::Null,
        }),
        Err(e) => json!({
            "ok": false,
            "configured": true,
            "baseUrl": base_url(),
            "error": e,
            "credits": Value::Null,
            "creditsRm": Value::Null,
        }),
    }
}

/// Kicks off a generation via `POST /api/generate`.
///
/// Params mirror the route's body. `kind` ("image" | "video") is advisory only —
/// the server derives the real pipeline from the model id — but the pane passes
/// it so callers can be explicit; it's echoed back on the result for the UI to
/// pick the right player. `opts` is the free-form `generationOptions` map
/// (aspect_ratio / duration / resolution / generate_audio / …) forwarded as-is.
///
/// Returns the raw API JSON augmented with a normalized `_kind` echo:
///   - SYNC  → `{ generationId, status:"completed", outputUrl, _kind }`
///   - ASYNC → `{ generationId, requestId, modelId, status:"processing",
///               <provider>Video:true, _kind }`
///
/// Errors (no key, network down, 4xx/5xx, no usable payload) return
/// `Result::Err(String)` carrying the API's own message where available, so the
/// pane can surface an exact toast (`Insufficient credits…`, `Blocked by content
/// policy…`, etc.). 5-minute timeout — sync models like Nano Banana 4K can run
/// 60-120s server-side and the route's own `maxDuration` is 300s.
#[tauri::command]
pub fn motion_generate(
    prompt: Option<String>,
    model: String,
    kind: Option<String>,
    opts: Option<Value>,
) -> Result<Value, String> {
    let key = api_key().ok_or_else(|| {
        "MotionBoards API key not set. Set AIOS_MOTION_KEY=mb_… (or MOTIONBOARDS_API_KEY).".to_string()
    })?;

    if model.trim().is_empty() {
        return Err("No model selected.".to_string());
    }

    let kind_echo = kind.unwrap_or_else(|| "image".to_string());

    // Build the request body. Only `prompt`, `model`, and `generationOptions`
    // are relevant for the prompt-driven canvas; the image/video/audio input
    // slots are left for a future ref-upload flow (the route accepts them all
    // as optional, so omitting them is correct for text-driven generation).
    let mut body = serde_json::Map::new();
    if let Some(p) = &prompt {
        body.insert("prompt".into(), json!(p));
    }
    body.insert("model".into(), json!(model));
    if let Some(o) = &opts {
        if !o.is_null() {
            body.insert("generationOptions".into(), o.clone());
        }
    }
    let body_str = Value::Object(body).to_string();

    let out = curl("POST", "/api/generate", &key, Some(&body_str), 5 * 60)
        .map_err(|e| e)?;

    if !(200..300).contains(&out.status) {
        return Err(error_message(&out));
    }
    if out.json.is_null() {
        return Err(if out.text.is_empty() {
            "MotionBoards returned an empty response.".to_string()
        } else {
            out.text.clone()
        });
    }

    // Augment with the kind echo without disturbing the API's own fields.
    let mut result = out.json.clone();
    if let Some(obj) = result.as_object_mut() {
        obj.insert("_kind".into(), json!(kind_echo));
    }

    // Sanity: a usable response is either a sync outputUrl or an async
    // requestId+modelId. Anything else is surfaced as an error with the raw
    // payload so the failure is visible, not silently swallowed.
    let has_sync = result.get("outputUrl").and_then(|v| v.as_str()).is_some();
    let has_async = result.get("requestId").is_some() && result.get("modelId").is_some();
    if !has_sync && !has_async {
        // Some routes (e.g. an explicit failure) come back 200 with
        // `{ status:"failed", error }` — honor that as an error.
        if let Some(e) = result.get("error").and_then(|v| v.as_str()) {
            return Err(e.to_string());
        }
        return Err(format!(
            "Generation accepted but no output/job in the response: {}",
            result.to_string().chars().take(300).collect::<String>()
        ));
    }

    Ok(result)
}

/// Polls an async job via `GET /api/generate/status`. Pass the `requestId`,
/// `modelId`, and `generationId` from `motion_generate`'s async response;
/// `duration_sec` + `resolution` are optional (forwarded so the server charges
/// the exact per-second rate, matching the web client). The status route
/// auto-detects the provider from `modelId`, so no provider flag is needed.
///
/// Returns the raw status JSON: `{ status, outputUrl?, log?, error?, cost? }`.
/// On a transport/non-2xx failure returns `{ status:"processing", _pollError }`
/// rather than `"failed"` — a flaky status check shouldn't permanently mark a
/// still-running job dead; the pane keeps polling and surfaces `_pollError` as a
/// soft hint.
#[tauri::command]
pub fn motion_status(
    request_id: String,
    model_id: String,
    generation_id: String,
    duration_sec: Option<i64>,
    resolution: Option<String>,
) -> Value {
    let Some(key) = api_key() else {
        return json!({ "status": "failed", "error": not_configured()["error"].clone() });
    };

    if request_id.is_empty() || model_id.is_empty() || generation_id.is_empty() {
        return json!({ "status": "failed", "error": "Missing requestId / modelId / generationId." });
    }

    // Build the query string with light percent-encoding for the values that
    // can carry reserved chars (model ids contain `/`, e.g. `…preview/i2v`).
    let mut path = format!(
        "/api/generate/status?requestId={}&modelId={}&generationId={}",
        encode(&request_id),
        encode(&model_id),
        encode(&generation_id),
    );
    if let Some(d) = duration_sec {
        path.push_str(&format!("&durationSec={d}"));
    }
    if let Some(r) = &resolution {
        if !r.is_empty() {
            path.push_str(&format!("&resolution={}", encode(r)));
        }
    }

    match curl("GET", &path, &key, None, 60) {
        Ok(out) if (200..300).contains(&out.status) && !out.json.is_null() => out.json,
        Ok(out) => json!({
            "status": "processing",
            "_pollError": error_message(&out),
        }),
        Err(e) => json!({
            "status": "processing",
            "_pollError": e,
        }),
    }
}

/// Reads the shared MotionBoards canvas state via `GET /api/boards` — the SAME
/// `mb_boards` record the web app and the `motion` MCP (`add_to_board:true`)
/// read/write. This is what makes the AIOS studio canvas interchangeable with
/// the MCP: assets Claude generates land here, and vice-versa. Returns
/// `{ ok, configured, baseUrl, data }` where `data` is the raw SavedState
/// `{ boards:[{ id, name, items:[…], panX, panY, zoom, connections }],
///    activeBoardId, selectedModelId, savedAt }`. Defensive: any miss → empty.
#[tauri::command]
pub fn motion_boards() -> Value {
    let Some(key) = api_key() else {
        let mut v = not_configured();
        v["data"] = Value::Null;
        return v;
    };
    match curl("GET", "/api/boards", &key, None, 30) {
        Ok(out) if (200..300).contains(&out.status) => json!({
            "ok": true,
            "configured": true,
            "baseUrl": base_url(),
            "data": out.json,
        }),
        Ok(out) => json!({
            "ok": false,
            "configured": true,
            "baseUrl": base_url(),
            "status": out.status,
            "error": error_message(&out),
            "data": Value::Null,
        }),
        Err(e) => json!({
            "ok": false,
            "configured": true,
            "baseUrl": base_url(),
            "error": e,
            "data": Value::Null,
        }),
    }
}

/// Writes the canvas state back via `POST /api/boards`. `state` is the full
/// SavedState (`{ boards, activeBoardId, selectedModelId, savedAt }`) — the route
/// replaces the user's `mb_boards` row, so callers should GET fresh, append, and
/// POST promptly to keep the race window with the MCP / web autosave small.
/// Errors surface the API's own message.
#[tauri::command]
pub fn motion_board_save(state: Value) -> Result<Value, String> {
    let key = api_key()
        .ok_or_else(|| "MotionBoards API key not set.".to_string())?;
    let body = state.to_string();
    let out = curl("POST", "/api/boards", &key, Some(&body), 30)?;
    if !(200..300).contains(&out.status) {
        return Err(error_message(&out));
    }
    Ok(if out.json.is_null() { json!({ "ok": true }) } else { out.json })
}

/// Minimal percent-encoder for query-param VALUES. Encodes everything outside
/// the RFC 3986 unreserved set (`A-Z a-z 0-9 - _ . ~`). Sufficient for model ids
/// (`/`), generation ids, and request ids without pulling in a url crate.
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
