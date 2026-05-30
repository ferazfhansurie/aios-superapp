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

    // Primary volume usage: the disk that hosts the user's home dir — root "/" on
    // unix, the home drive (e.g. C:\) on Windows — falling back to the largest disk.
    let disks = Disks::new_with_refreshed_list();
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
        .to_lowercase();
    let (mut disk_total, mut disk_avail) = (0u64, 0u64);
    for d in disks.list() {
        let mp = d.mount_point().to_string_lossy().to_lowercase();
        let hosts_home = if cfg!(windows) {
            !mp.is_empty() && home.starts_with(&mp)
        } else {
            mp == "/"
        };
        if hosts_home {
            disk_total = d.total_space();
            disk_avail = d.available_space();
            break;
        }
    }
    // Fallback: the largest disk, if no mount point matched the home dir.
    if disk_total == 0 {
        for d in disks.list() {
            if d.total_space() > disk_total {
                disk_total = d.total_space();
                disk_avail = d.available_space();
            }
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
#[cfg(not(windows))]
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

/// Windows battery via `GetSystemPowerStatus` (kernel32) — no extra deps. Returns
/// (None, None) on desktops with no battery, or if the call fails.
#[cfg(windows)]
fn battery() -> (Option<f64>, Option<bool>) {
    #[repr(C)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
    }

    let mut s = SystemPowerStatus {
        ac_line_status: 255,
        battery_flag: 255,
        battery_life_percent: 255,
        system_status_flag: 0,
        battery_life_time: 0,
        battery_full_life_time: 0,
    };
    if unsafe { GetSystemPowerStatus(&mut s) } == 0 {
        return (None, None);
    }
    // battery_flag 128 = no system battery (desktop); 255 = unknown.
    if s.battery_flag == 128 || s.battery_flag == 255 {
        return (None, None);
    }
    let pct = (s.battery_life_percent <= 100).then_some(s.battery_life_percent as f64);
    // ac_line_status: 0 = on battery, 1 = plugged in.
    let charging = match s.ac_line_status {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    };
    (pct, charging)
}
