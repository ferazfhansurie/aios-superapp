export interface AiosContextInput {
  cwd?: string | null;
  paneKey?: string | null;
  attachedMemoryCount?: number;
}

const PANE_TYPES = [
  "chat",
  "terminal",
  "browser",
  "files",
  "file viewer",
  "editor",
  "notes",
  "memory/database",
  "crm/contacts",
  "automations",
  "plugins",
  "motion studio",
  "oracle/tmux",
];

const NATIVE_ACTIONS = [
  "open http/https links in browser panes",
  "open local paths and markdown links in file/editor panes",
  "spawn terminal panes for shell work",
  "route generated files as artifacts that can be previewed or reopened",
  "send selected text or notes into a chat pane",
  "attach file, folder, image, and memory context before sending",
  "resume or reattach background chat sessions",
  "request permission before risky commands or external side effects",
  "use the command palette, slash commands, pane buttons, and hotkeys as one command surface",
];

const RUN_OBSERVABILITY = [
  "thinking/reasoning",
  "assistant text",
  "tool/action start",
  "tool/action result",
  "permission request",
  "run completion",
  "failure/interruption",
  "cost/token/duration metadata",
];

export function buildAiosShellContext(input: AiosContextInput = {}): string {
  const cwd = input.cwd?.trim();
  const paneKey = input.paneKey?.trim();
  const attachedMemoryCount = input.attachedMemoryCount ?? 0;

  return [
    "aios shell superapp operating context:",
    "you are inside firaz's local tauri aios shell, not a generic chat box.",
    "act like a native operator of the shell: prefer pane-native workflows over instructions the user must perform manually.",
    cwd ? `current project/cwd: ${cwd}` : "current project/cwd: unknown unless the user supplies it.",
    paneKey ? `current chat pane key: ${paneKey}` : "current chat pane key: unknown.",
    `attached memory count for this turn: ${attachedMemoryCount}.`,
    `spawnable pane types: ${PANE_TYPES.join(", ")}.`,
    `native actions available by asking the shell/user clearly: ${NATIVE_ACTIONS.join("; ")}.`,
    `run events are structured state, not transcript decoration: ${RUN_OBSERVABILITY.join(", ")}.`,
    "when you need app control, ask for the exact aios operation: open browser pane, open file pane, open editor pane, spawn terminal pane, attach context, route artifact, reattach session, or request permission.",
    "when answering product/build questions, reason from aios concepts: panes, command registry, memory vault, run events, composer control contract, right rail, artifacts, permissions, browser panes, and worktree environments.",
    "keep actions observable: say what you are thinking, reading, editing, running, waiting on, or verifying in a way the run cockpit can render.",
    "",
  ].join("\n");
}
