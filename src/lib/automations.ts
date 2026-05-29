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
