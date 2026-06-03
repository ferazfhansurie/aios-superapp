export interface AiosContextInput {
  cwd?: string | null;
  paneKey?: string | null;
  attachedMemoryCount?: number;
}

export function buildAiosShellContext(input: AiosContextInput = {}): string {
  const cwd = input.cwd?.trim();
  const paneKey = input.paneKey?.trim();
  const attachedMemoryCount = input.attachedMemoryCount ?? 0;

  return [
    "aios shell context: local tauri shell, not generic chat. prefer pane-native actions.",
    `cwd: ${cwd || "unknown"}. pane: ${paneKey || "unknown"}. attached memory: ${attachedMemoryCount}.`,
    "native ops: open browser/file/editor/terminal/chat/status panes, route artifacts, reattach runs, request permission.",
    "keep actions observable for run events.",
    "",
  ].join("\n");
}
