import { invoke } from "./tauri";

export type WrmsQaApp = "collector" | "vendor";
export type WrmsQaFlow = "login" | "smoke" | "start-trip" | "sync";

export interface WrmsQaShot {
  path: string | null;
  runId: string | null;
  shotDir: string | null;
  reportMd: string | null;
  reportJson: string | null;
  result: string | null;
  findings: number | null;
  mtimeMs: number;
}

export interface WrmsQaRunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  latest: WrmsQaShot | null;
  reportMd: string | null;
  reportJson: string | null;
  shotDir: string | null;
}

export async function latestWrmsCollectorShot(): Promise<WrmsQaShot | null> {
  return invoke<WrmsQaShot | null>("wrms_qa_latest_collector_shot");
}

export async function latestWrmsShot(app: WrmsQaApp): Promise<WrmsQaShot | null> {
  return invoke<WrmsQaShot | null>("wrms_qa_latest_shot", { app });
}

export async function runWrmsQa(opts: {
  appKind: WrmsQaApp;
  flows?: WrmsQaFlow[] | string | null;
  app?: string | null;
  real?: boolean | null;
  udid?: string | null;
}): Promise<WrmsQaRunResult> {
  const flows = Array.isArray(opts.flows) ? opts.flows.join(",") : opts.flows;
  return invoke<WrmsQaRunResult>("wrms_qa_run", {
    appKind: opts.appKind,
    flows: flows ?? null,
    app: opts.app ?? null,
    real: opts.real ?? null,
    udid: opts.udid ?? null,
  });
}

export async function runWrmsCollectorLogin(opts: {
  app?: string | null;
  real?: boolean | null;
  udid?: string | null;
} = {}): Promise<WrmsQaRunResult> {
  return invoke<WrmsQaRunResult>("wrms_qa_run_collector_login", {
    app: opts.app ?? null,
    real: opts.real ?? null,
    udid: opts.udid ?? null,
  });
}
