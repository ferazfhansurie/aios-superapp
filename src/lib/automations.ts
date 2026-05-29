import { invoke } from "@tauri-apps/api/core";

/** One launchd job (com.firaz.aios-* / com.aios.*). */
export interface Job {
  label: string;
  command: string;
  schedule: string;
  running: boolean;
  last_exit: number;
}

/** One timed intervention from the proactive nightly plan. */
export interface PlannedItem {
  time: string;
  title: string;
}

/** One live background agent (aios-* tmux session). */
export interface Agent {
  name: string;
  attached: boolean;
}

/** Everything AIOS runs in the background, aggregated. */
export interface Automations {
  jobs: Job[];
  planned: PlannedItem[];
  agents: Agent[];
}

export async function listAutomations(): Promise<Automations> {
  return invoke<Automations>("list_automations");
}

/** Full per-job detail: command, schedule, flags, live state, log tail. */
export interface JobDetail {
  label: string;
  command: string;
  plistPath: string;
  schedule: string;
  runAtLoad: boolean;
  keepAlive: boolean;
  loaded: boolean;
  pid: number | null;
  lastExit: number | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  recentLog: string[];
}

/** Parse a job's plist + live launchctl state into a detailed view. */
export async function automationDetail(label: string): Promise<JobDetail> {
  return invoke<JobDetail>("automation_detail", { label });
}

/** Kick a run right now (`launchctl start <label>`). */
export async function runAutomation(label: string): Promise<void> {
  return invoke<void>("run_automation", { label });
}

/** Enable (bootstrap/load) or disable (bootout/unload) a real launchd job. */
export async function setAutomationEnabled(label: string, enabled: boolean): Promise<void> {
  return invoke<void>("set_automation_enabled", { label, enabled });
}
