//! Device monitor — a glanceable snapshot of the host machine for the idle
//! homescreen: CPU load, memory, root-disk usage, battery, and uptime.
//!
//! Uses `sysinfo` for CPU/mem/disk/uptime/load and parses `pmset -g batt` for
//! battery (sysinfo doesn't expose battery on macOS). Every field degrades to
//! null/0 on failure so the tile never blanks the page.

use serde_json::{json, Value};

/// One-shot host stats. CPU% needs two samples ~180ms apart to be meaningful,
/// so this call sleeps briefly — fine for the idle tile's few-second poll.
#[tauri::command]
pub fn device_stats() -> Value {
    use sysinfo::{Disks, System};

    let mut sys = System::new();
    sys.refresh_memory();
    // two CPU samples for an accurate instantaneous percentage.
    sys.refresh_cpu_usage();
    std::thread::sleep(std::time::Duration::from_millis(180));
    sys.refresh_cpu_usage();
    let cpu_pct = sys.global_cpu_usage();

    let mem_total = sys.total_memory();
    let mem_used = sys.used_memory();

    // root volume ("/") usage.
    let disks = Disks::new_with_refreshed_list();
    let (mut disk_total, mut disk_avail) = (0u64, 0u64);
    for d in disks.list() {
        if d.mount_point() == std::path::Path::new("/") {
            disk_total = d.total_space();
            disk_avail = d.available_space();
            break;
        }
    }

    let load = System::load_average();
    let uptime = System::uptime();
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    let (battery_pct, battery_charging) = battery();

    json!({
        "cpuPct": cpu_pct,
        "cores": cores,
        "memUsed": mem_used,
        "memTotal": mem_total,
        "diskUsed": disk_total.saturating_sub(disk_avail),
        "diskTotal": disk_total,
        "load1": load.one,
        "uptimeSecs": uptime,
        "batteryPct": battery_pct,
        "batteryCharging": battery_charging,
    })
}

/// Parses `pmset -g batt` → (percent, charging?). Returns (None, None) off mac
/// or if the command/format is unavailable.
fn battery() -> (Option<f64>, Option<bool>) {
    let out = match std::process::Command::new("pmset").args(["-g", "batt"]).output() {
        Ok(o) if o.status.success() => o,
        _ => return (None, None),
    };
    let text = String::from_utf8_lossy(&out.stdout);

    // percent: first "NN%" token.
    let pct = text
        .split('%')
        .next()
        .and_then(|head| head.rsplit(|c: char| !c.is_ascii_digit()).next())
        .and_then(|d| d.parse::<f64>().ok());

    // charging state: pmset reports "charging" / "charged" / "discharging" / "AC Power".
    let lower = text.to_lowercase();
    let charging = if lower.contains("discharging") {
        Some(false)
    } else if lower.contains("charging") || lower.contains("charged") || lower.contains("ac power") {
        Some(true)
    } else {
        None
    };

    (pct, charging)
}
