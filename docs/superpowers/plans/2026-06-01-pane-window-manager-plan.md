# pane window manager implementation plan

## goal

make panes act like controllable windows inside the aios shell: resizable, reorderable, splittable, stackable, persistent, and ai-controllable.

## files

- create `src/lib/paneLayout.ts`
- create `src/components/PaneChrome.tsx`
- modify `src/App.tsx`
- modify `src/components/ResizableGrid.tsx`
- modify `src/lib/paneBus.ts`

## data model

```ts
interface PaneLayoutNode {
  id: string;
  type: "leaf" | "split" | "stack";
  direction?: "horizontal" | "vertical";
  size?: number;
  paneKey?: string;
  children?: PaneLayoutNode[];
  activePaneKey?: string;
}
```

## phases

1. extract pane chrome actions: focus, close, hide, maximize, duplicate.
2. persist current pane order and sizes per project.
3. add drag reorder.
4. add split left/right/top/bottom.
5. add stack groups for tabbed panes.
6. add command ids for every pane action.
7. emit pane run events.

## acceptance

- user can resize every pane.
- user can reorder panes.
- user can stack panes as tabs.
- layout survives relaunch.
- ai can list and control panes through commands.
