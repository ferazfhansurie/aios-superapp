import {
  invoke as tauriInvoke,
  type InvokeArgs,
  type InvokeOptions,
} from "@tauri-apps/api/core";

type TauriWindow = typeof window & {
  __TAURI_INTERNALS__?: unknown;
};

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean((window as TauriWindow).__TAURI_INTERNALS__);
}

export function invoke<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  if (!isTauriRuntime()) {
    return Promise.reject(new Error(`tauri runtime unavailable for ${command}`));
  }
  return tauriInvoke<T>(command, args, options);
}
