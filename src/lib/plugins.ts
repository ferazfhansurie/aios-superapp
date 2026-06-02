import { invoke } from "./tauri";

export interface Skill {
  name: string;
  description: string;
  group: string;
}
export interface Plugins {
  skills: Skill[];
  mcps: string[];
}

export async function listPlugins(): Promise<Plugins> {
  return invoke<Plugins>("list_plugins");
}
