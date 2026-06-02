import {
  agentActionPolicy,
  auditAgentAction,
  parseAgentAction,
  type AgentAction,
  type AgentAuditEntry,
  type AgentPolicyLevel,
  type AgentSource,
} from "./agentActions.ts";

export interface AgentPaneSnapshot {
  key: string;
  label: string;
  type: string;
  hidden: boolean;
  active: boolean;
}

export interface AgentDispatchInput {
  source: AgentSource;
  action: unknown;
  confirmed?: boolean;
}

export interface AgentDispatchResult {
  ok: boolean;
  message?: string;
  error?: string;
  level?: AgentPolicyLevel;
  data?: unknown;
}

export interface AgentControllerDeps {
  getPanes: () => AgentPaneSnapshot[];
  focusPane: (key: string) => void;
  hidePane: (key: string) => void;
  maximizePane: (key: string) => void;
  closePane: (key: string) => void;
  setSidebarOpen: (open: boolean) => void;
  setOverviewOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  stopChat: (key: string) => void;
  detachChat: (key: string) => void;
  audit?: (entry: AgentAuditEntry) => void;
}

export interface AgentController {
  dispatch: (input: AgentDispatchInput) => Promise<AgentDispatchResult>;
}

function resultFor(action: AgentAction, deps: AgentControllerDeps): AgentDispatchResult {
  switch (action.type) {
    case "pane.list":
      return { ok: true, data: deps.getPanes() };
    case "pane.focus":
      deps.focusPane(action.paneKey);
      return { ok: true, message: "focused" };
    case "pane.hide":
      deps.hidePane(action.paneKey);
      return { ok: true, message: "hidden" };
    case "pane.maximize":
      deps.maximizePane(action.paneKey);
      return { ok: true, message: "maximized" };
    case "pane.close":
      deps.closePane(action.paneKey);
      return { ok: true, message: "closed" };
    case "view.show_overview":
      deps.setOverviewOpen(true);
      return { ok: true, message: "overview opened" };
    case "view.open_settings":
      deps.setSettingsOpen(true);
      return { ok: true, message: "settings opened" };
    case "view.set_sidebar":
      deps.setSidebarOpen(action.open);
      return { ok: true, message: action.open ? "sidebar opened" : "sidebar closed" };
    case "chat.stop":
      deps.stopChat(action.paneKey);
      return { ok: true, message: "chat stopped" };
    case "chat.detach":
      deps.detachChat(action.paneKey);
      return { ok: true, message: "chat detached" };
    case "browser.back":
    case "browser.forward":
    case "browser.reload":
    case "browser.screenshot":
    case "browser.copy_selection":
    case "browser.navigate":
      return { ok: false, error: "browser agent control is not wired yet" };
    default:
      return { ok: false, error: "unsupported action" };
  }
}

export function createAgentController(deps: AgentControllerDeps): AgentController {
  return {
    async dispatch(input) {
      const parsed = parseAgentAction(input.action);
      if (!parsed.ok) return { ok: false, error: parsed.error };

      const policy = agentActionPolicy(parsed.action);
      if (!policy.allowed && !input.confirmed) {
        const blocked: AgentDispatchResult = {
          ok: false,
          error: policy.reason ?? "blocked",
          level: policy.level,
        };
        deps.audit?.(auditAgentAction({ source: input.source, action: parsed.action, result: blocked }));
        return blocked;
      }

      const result = resultFor(parsed.action, deps);
      deps.audit?.(auditAgentAction({ source: input.source, action: parsed.action, result }));
      return result;
    },
  };
}
