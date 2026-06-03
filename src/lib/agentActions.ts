export type AgentSource = "chatpane" | "codex" | "oracle" | "mirror" | "test";
export type AgentPolicyLevel = "readonly" | "ui" | "external" | "destructive";

export type AgentAction =
  | { type: "pane.list" }
  | { type: "pane.focus"; paneKey: string }
  | { type: "pane.hide"; paneKey: string }
  | { type: "pane.maximize"; paneKey: string }
  | { type: "pane.close"; paneKey: string }
  | { type: "view.show_overview" }
  | { type: "view.open_settings" }
  | { type: "view.set_sidebar"; open: boolean }
  | { type: "browser.navigate"; paneKey: string; url: string }
  | { type: "browser.back"; paneKey: string }
  | { type: "browser.forward"; paneKey: string }
  | { type: "browser.reload"; paneKey: string }
  | { type: "browser.screenshot"; paneKey: string }
  | { type: "browser.copy_selection"; paneKey: string }
  | { type: "chat.stop"; paneKey: string }
  | { type: "chat.detach"; paneKey: string };

export type AgentActionParseResult =
  | { ok: true; action: AgentAction }
  | { ok: false; error: string };

export interface AgentPolicyDecision {
  allowed: boolean;
  level: AgentPolicyLevel;
  reason?: string;
}

export interface AgentActionResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface AgentAuditInput {
  source: AgentSource;
  action: AgentAction;
  result: AgentActionResult;
  now?: number;
}

export interface AgentAuditEntry {
  ts: number;
  source: AgentSource;
  actionType: AgentAction["type"];
  target?: string;
  ok: boolean;
  message?: string;
  error?: string;
}

const paneActionTypes = new Set([
  "pane.focus",
  "pane.hide",
  "pane.maximize",
  "pane.close",
  "browser.back",
  "browser.forward",
  "browser.reload",
  "browser.screenshot",
  "browser.copy_selection",
  "chat.stop",
  "chat.detach",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function validHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseAgentAction(input: unknown): AgentActionParseResult {
  if (!isRecord(input)) return { ok: false, error: "agent action must be an object" };
  const type = input.type;
  if (typeof type !== "string") return { ok: false, error: "agent action requires type" };

  if (type === "pane.list" || type === "view.show_overview" || type === "view.open_settings") {
    return { ok: true, action: { type } as AgentAction };
  }

  if (type === "view.set_sidebar") {
    if (typeof input.open !== "boolean") return { ok: false, error: "view.set_sidebar requires open" };
    return { ok: true, action: { type, open: input.open } };
  }

  if (type === "browser.navigate") {
    const paneKey = stringField(input, "paneKey");
    if (!paneKey) return { ok: false, error: "browser.navigate requires paneKey" };
    const url = stringField(input, "url");
    if (!url || !validHttpUrl(url)) return { ok: false, error: "browser.navigate requires http url" };
    return { ok: true, action: { type, paneKey, url } };
  }

  if (paneActionTypes.has(type)) {
    const paneKey = stringField(input, "paneKey");
    if (!paneKey) return { ok: false, error: `${type} requires paneKey` };
    return { ok: true, action: { type, paneKey } as AgentAction };
  }

  return { ok: false, error: "unsupported agent action" };
}

export function agentActionLevel(action: AgentAction): AgentPolicyLevel {
  if (action.type === "pane.list") return "readonly";
  if (action.type === "browser.navigate") return "external";
  if (action.type === "pane.close") return "destructive";
  return "ui";
}

export function agentActionPolicy(action: AgentAction): AgentPolicyDecision {
  const level = agentActionLevel(action);
  if (level === "readonly" || level === "ui") return { allowed: true, level };
  return { allowed: false, level, reason: "requires confirmation" };
}

export function agentActionTarget(action: AgentAction): string | undefined {
  if ("paneKey" in action) return action.paneKey;
  return undefined;
}

export function auditAgentAction(input: AgentAuditInput): AgentAuditEntry {
  const entry: AgentAuditEntry = {
    ts: input.now ?? Date.now(),
    source: input.source,
    actionType: input.action.type,
    target: agentActionTarget(input.action),
    ok: input.result.ok,
  };
  if (input.result.message) entry.message = input.result.message;
  if (input.result.error) entry.error = input.result.error;
  return entry;
}
