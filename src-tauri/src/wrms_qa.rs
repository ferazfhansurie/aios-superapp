use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_WRMS_QA_ROOT: &str = "wrms-qa";
const DEFAULT_COLLECTOR_APP: &str = "";
const DEFAULT_VENDOR_APP: &str = "";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrmsQaShot {
    path: Option<String>,
    run_id: Option<String>,
    shot_dir: Option<String>,
    report_md: Option<String>,
    report_json: Option<String>,
    result: Option<String>,
    findings: Option<u64>,
    mtime_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrmsQaRunResult {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    latest: Option<WrmsQaShot>,
    report_md: Option<String>,
    report_json: Option<String>,
    shot_dir: Option<String>,
}

fn system_time_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn run_meta(
    root: &Path,
    dir_name: &str,
) -> (Option<String>, Option<String>, Option<String>, Option<u64>) {
    let report_md = root.join("reports").join(format!("{dir_name}.md"));
    let report_json = root.join("reports").join(format!("{dir_name}.json"));
    let md = report_md
        .exists()
        .then(|| report_md.to_string_lossy().to_string());
    let json = report_json
        .exists()
        .then(|| report_json.to_string_lossy().to_string());

    let parsed = report_json
        .exists()
        .then(|| fs::read_to_string(&report_json).ok())
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let result = parsed.as_ref().map(|v| {
        if v.get("stopped").and_then(Value::as_bool).unwrap_or(false) {
            "STOPPED".to_string()
        } else if v.get("pass").and_then(Value::as_bool).unwrap_or(false) {
            "PASS".to_string()
        } else {
            "FAIL".to_string()
        }
    });
    let findings = parsed
        .as_ref()
        .and_then(|v| v.get("findings"))
        .and_then(Value::as_u64);

    (md, json, result, findings)
}

fn normalize_app(app: Option<String>) -> String {
    match app
        .as_deref()
        .unwrap_or("collector")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "vendor" => "vendor".to_string(),
        _ => "collector".to_string(),
    }
}

fn default_app_path(app: &str, is_real: bool) -> Option<String> {
    if is_real {
        return None;
    }
    let (env_key, fallback) = match app {
        "vendor" => ("AIOS_WRMS_VENDOR_APP", DEFAULT_VENDOR_APP),
        _ => ("AIOS_WRMS_COLLECTOR_APP", DEFAULT_COLLECTOR_APP),
    };
    let configured = std::env::var(env_key).unwrap_or_else(|_| fallback.to_string());
    let path = configured.trim();
    Path::new(path).exists().then(|| path.to_string())
}

fn wrms_qa_root() -> PathBuf {
    std::env::var("AIOS_WRMS_QA_ROOT")
        .ok()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_WRMS_QA_ROOT))
}

fn latest_app_shot(app: Option<String>) -> Option<WrmsQaShot> {
    let app = normalize_app(app);
    let prefix = format!("{app}-");
    let root = wrms_qa_root();
    let shots_root = root.join("shots");
    let dirs = fs::read_dir(&shots_root).ok()?;
    let mut best: Option<(PathBuf, String, u64)> = None;

    for entry in dirs.flatten() {
        let dir_path = entry.path();
        if !dir_path.is_dir() {
            continue;
        }
        let dir_name = match dir_path.file_name().and_then(|n| n.to_str()) {
            Some(name) if name.starts_with(&prefix) => name.to_string(),
            _ => continue,
        };
        let Ok(files) = fs::read_dir(&dir_path) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("png") {
                continue;
            }
            let mtime = file
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(system_time_ms)
                .unwrap_or(0);
            if best.as_ref().map(|(_, _, t)| mtime > *t).unwrap_or(true) {
                best = Some((path, dir_name.clone(), mtime));
            }
        }
    }

    let (path, dir_name, mtime_ms) = best?;
    let (report_md, report_json, result, findings) = run_meta(&root, &dir_name);
    Some(WrmsQaShot {
        path: Some(path.to_string_lossy().to_string()),
        run_id: Some(dir_name.clone()),
        shot_dir: Some(shots_root.join(&dir_name).to_string_lossy().to_string()),
        report_md,
        report_json,
        result,
        findings,
        mtime_ms,
    })
}

fn node_bin() -> &'static str {
    for candidate in [
        "/opt/homebrew/bin/node",
        "/opt/homebrew/Cellar/node@22/22.22.0/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        if Path::new(candidate).exists() {
            return candidate;
        }
    }
    "node"
}

fn line_value(output: &str, prefix: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.trim().strip_prefix(prefix).map(str::trim))
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

#[tauri::command]
pub fn wrms_qa_latest_collector_shot() -> Result<Option<WrmsQaShot>, String> {
    Ok(latest_app_shot(Some("collector".to_string())))
}

#[tauri::command]
pub fn wrms_qa_latest_shot(app: Option<String>) -> Result<Option<WrmsQaShot>, String> {
    Ok(latest_app_shot(app))
}

#[tauri::command]
pub fn wrms_qa_run(
    app_kind: Option<String>,
    flows: Option<String>,
    app: Option<String>,
    real: Option<bool>,
    udid: Option<String>,
) -> Result<WrmsQaRunResult, String> {
    let root = wrms_qa_root();
    let script = root.join("flutter").join("vision-driver.mjs");
    if !script.exists() {
        return Err(format!(
            "missing wrms qa driver: {}",
            script.to_string_lossy()
        ));
    }

    let is_real = real.unwrap_or(false);
    let app_kind = normalize_app(app_kind);
    let flows = flows
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if app_kind == "vendor" {
                "smoke".to_string()
            } else {
                "login".to_string()
            }
        });
    let mut cmd = Command::new(node_bin());
    cmd.current_dir(&root)
        .env("PATH", crate::chat::enriched_path())
        .arg(script)
        .arg(format!("--profile={app_kind}"))
        .arg(format!("--flows={flows}"));

    if is_real {
        cmd.arg("--real");
    }
    if let Some(udid) = udid.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        cmd.env("SIM_UDID", udid);
    }

    let app_path = app
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| default_app_path(&app_kind, is_real));
    if let Some(app_path) = app_path {
        cmd.arg(format!("--app={app_path}"));
    }

    let output = cmd
        .output()
        .map_err(|e| format!("couldn't launch wrms qa driver: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let latest = latest_app_shot(Some(app_kind.clone()));

    Ok(WrmsQaRunResult {
        ok: output.status.success(),
        code: output.status.code(),
        report_md: line_value(&stdout, "report:"),
        report_json: line_value(&stdout, "json:"),
        shot_dir: line_value(&stdout, "shots:"),
        stdout,
        stderr,
        latest,
    })
}

#[tauri::command]
pub fn wrms_qa_run_collector_login(
    app: Option<String>,
    real: Option<bool>,
    udid: Option<String>,
) -> Result<WrmsQaRunResult, String> {
    wrms_qa_run(
        Some("collector".to_string()),
        Some("login".to_string()),
        app,
        real,
        udid,
    )
}
