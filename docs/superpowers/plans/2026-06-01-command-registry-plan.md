# command registry implementation plan

## goal

make every action in aios addressable by one command id. buttons, hotkeys, slash commands, command palette, pane chrome, browser controls, run actions, and ai tool calls must use the same registry.

## files

- create `src/lib/commands.tsx`
- modify `src/components/CommandPalette.tsx`
- modify `src/App.tsx`
- modify `src/components/ChatPane.tsx`
- modify `src/lib/paneBus.ts`

## command shape

```ts
interface AiosCommand {
  id: string;
  label: string;
  description?: string;
  icon?: React.ComponentType;
  scope: "global" | "pane" | "chat" | "browser" | "file" | "run";
  danger?: "none" | "low" | "destructive" | "external";
  hotkeys?: string[];
  enabled(ctx: CommandContext): boolean;
  run(ctx: CommandContext, input?: unknown): Promise<CommandResult> | CommandResult;
}
```

## phases

1. create registry and context types.
2. migrate existing command palette actions.
3. migrate pane lifecycle actions.
4. migrate chat composer/run actions.
5. migrate browser/file actions.
6. expose command lookup to ai tool contract.

## acceptance

- no new button action is added without a command id.
- command palette and pane buttons call the same command.
- command executions can emit run events.
- dangerous commands expose risk level.
