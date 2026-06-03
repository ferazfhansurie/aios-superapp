import type { ReactNode } from "react";

import type { Command as PaletteCommand } from "../components/CommandPalette";

export type CommandScope = "global" | "pane" | "chat" | "browser" | "file" | "run";
export type CommandDanger = "none" | "low" | "destructive" | "external";

export interface CommandContext {
  source: "palette" | "button" | "slash" | "hotkey" | "ai" | "test";
  activePaneKey?: string | null;
}

export interface CommandResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface AiosCommand {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  scope: CommandScope;
  danger: CommandDanger;
  hotkeys: string[];
  keywords: string[];
  enabled: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext, input?: unknown) => CommandResult | Promise<CommandResult>;
}

export interface CommandInput {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  scope: CommandScope;
  danger?: CommandDanger;
  hotkeys?: string[];
  keywords?: string[];
  enabled?: (ctx: CommandContext) => boolean;
  run: (
    ctx: CommandContext,
    input?: unknown,
  ) => CommandResult | Promise<CommandResult> | void | Promise<void> | string;
}

export function createCommand(input: CommandInput): AiosCommand {
  return {
    ...input,
    danger: input.danger ?? "none",
    hotkeys: input.hotkeys ?? [],
    keywords: input.keywords ?? [],
    enabled: input.enabled ?? (() => true),
    run: async (ctx, value) => {
      const result = await input.run(ctx, value);
      if (typeof result === "string") return { ok: true, message: result };
      return result ?? { ok: true };
    },
  };
}

export async function runCommand(
  command: AiosCommand,
  context: CommandContext,
  input?: unknown,
): Promise<CommandResult> {
  if (!command.enabled(context)) {
    return { ok: false, error: "command disabled" };
  }
  return command.run(context, input);
}

export function commandToPaletteCommand(
  command: AiosCommand,
  options: {
    context: CommandContext;
    group?: string;
    actionLabel?: string;
    subtitle?: string;
  },
): PaletteCommand {
  return {
    id: command.id,
    title: command.label,
    subtitle: options.subtitle ?? command.description,
    group: options.group ?? command.scope,
    icon: command.icon,
    keywords: command.keywords.join(" "),
    actionLabel: options.actionLabel,
    run: () => {
      void runCommand(command, options.context);
    },
  };
}
