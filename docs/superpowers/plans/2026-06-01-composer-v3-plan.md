# composer v3 implementation plan

## goal

make the chat composer the best control surface in the app: explicit, dense, powerful, and readable.

## files

- modify `src/components/ChatPane.tsx`
- modify `src/lib/chatPaneState.ts`
- create `src/components/ComposerContextBar.tsx`
- create `src/components/WorkspaceAttachPicker.tsx`

## controls

- `send`
- `queue`
- `steer`
- `interrupt+send`
- `attach`
- `@file`
- `@folder`
- `@pane`
- `@session`
- `@artifact`
- model chip
- effort chip
- permission chip
- cwd/project chip
- branch/worktree chip
- selected panes chip
- context budget meter

## phases

1. extract composer into smaller components.
2. add command-backed buttons.
3. add context preview before send.
4. add workspace attach picker.
5. add queue stack with drag reorder.
6. add pane/session/artifact mentions.
7. add prompt budget and hidden context meter.

## acceptance

- user always knows what send will do.
- running state supports steer/queue/interrupt+send.
- attached context is visible before send.
- no text overlaps on narrow panes.
