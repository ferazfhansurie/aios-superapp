/** Host machine stats for the idle homescreen's device-monitor tile.
 *  Wraps the Rust `device_stats` command (sysinfo + pmset). All sizes are bytes;
 *  battery fields are null off-mac / when unavailable. */
import { invoke } from "./tauri";

export interface DeviceStats {
  cpuPct: number;
  cores: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  load1: number;
  uptimeSecs: number;
  batteryPct: number | null;
  batteryCharging: boolean | null;
}

export async function deviceStats(): Promise<DeviceStats | null> {
  return invoke<DeviceStats | null>("device_stats");
}
