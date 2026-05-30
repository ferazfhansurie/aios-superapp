/** Run/F5 support — detects the runnable project containing a path and yields
 *  the candidate run commands (flutter/node/rust/go/python/make). The App wires
 *  F5 to spawn a terminal pane running `commands[0]` in `root`, which streams
 *  logs exactly like VS Code's run terminal (and flutter's own `r` hot-reload
 *  works right in it). */
import { invoke } from "@tauri-apps/api/core";

export interface RunCommand {
  label: string;
  cmd: string;
}

export type ProjectKind =
  | "flutter"
  | "node"
  | "rust"
  | "go"
  | "python"
  | "make"
  | "unknown";

export interface ProjectRun {
  kind: ProjectKind;
  root: string | null;
  commands: RunCommand[];
}

/** Detect the runnable project that contains `path` (walks up to a marker). */
export async function detectProject(path: string): Promise<ProjectRun> {
  return invoke<ProjectRun>("detect_project", { path });
}

/** A short ▶ label for the run button, e.g. "▶ flutter run". */
export function runLabel(p: ProjectRun): string {
  return p.commands.length ? `▶ ${p.commands[0].label}` : "▶ run";
}
