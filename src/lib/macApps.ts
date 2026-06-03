import { invoke } from "./tauri";

export interface MacAppInfo {
  name: string;
  bundle_id: string | null;
  windows: string[];
  window_error: string | null;
}

export async function listMacApps(): Promise<MacAppInfo[]> {
  return invoke<MacAppInfo[]>("mac_list_apps");
}

export async function focusMacApp(app: MacAppInfo): Promise<void> {
  return invoke<void>("mac_focus_app", {
    name: app.name,
    bundleId: app.bundle_id ?? null,
  });
}

export async function captureMacApp(app: MacAppInfo): Promise<string> {
  return invoke<string>("mac_capture_app", {
    name: app.name,
    bundleId: app.bundle_id ?? null,
  });
}
