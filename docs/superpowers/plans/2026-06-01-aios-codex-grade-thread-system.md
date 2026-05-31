# aios codex-grade thread system implementation plan

> **for agentic workers:** required sub-skill: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. steps use checkbox (`- [ ]`) syntax for tracking.

**goal:** build the ten-part codex-grade thread system inside the real tauri superapp while keeping aios's multi-pane operating-system advantage.

**architecture:** start with a durable `runevent` model, then make composer/run cockpit/changes/right rail consume that model instead of parsing transcript text. each feature lands behind focused pure helpers and tests before renderer wiring.

**tech stack:** tauri v2, rust backend commands, react 19, typescript, existing chat pane stream adapter, node test runner for pure ui state, cargo tests for backend event adapters.

---

## intelligence requirement

chatpane ai must be at least as smart as codex desktop and more native to aios. that means:

- keep codex terminal-grade config: model defaults, reasoning, plugins, hooks, and auth, while avoiding mcp auth stalls.
- inject an aios-native system contract so the model knows it is inside the tauri superapp, not a generic terminal.
- expose app actions as structured tools/events: spawn pane, open file pane, open editor pane, open browser pane, write to pane, submit to pane, attach file/folder context, inspect current panes, hand off to oracle, request permission.
- every app action must become a `runevent`, so the run cockpit and right rail show what the ai did.
- do not rely on hidden magic. the composer must show the context and permissions before send.
- product philosophy: more, better, more, better. if adding more power makes a surface worse, create a stronger primitive instead of hiding capability.

### task 1: composer control contract v1

**files:**
- modify: `src/lib/chatPaneState.ts`
- modify: `src/lib/chatPaneState.test.ts`
- modify: `src/components/ChatPane.tsx`

- [x] add tested pure helpers for send mode, context chips, queue edit, and queue reorder.
- [x] render context chips above composer: cwd, engine, model, effort, permission, attachments, queue, plan, goal.
- [x] make primary action explicit: send, steer, queue, stop.
- [x] add editable/reorderable queued messages.
- [x] verify with `pnpm test:chatpane` and `pnpm build`.

### task 2: runevent model

**files:**
- create: `src/lib/runEvents.ts`
- create: `src/lib/runEvents.test.ts`
- modify: `src/components/ChatPane.tsx`
- modify: `src-tauri/src/chat.rs`

- [x] define first `RunEvent` core: reasoning, message.delta, action.started, action.completed, permission.requested, run.completed, run.failed, run.interrupted.
- [x] write reducer tests for stream deltas, tool lifecycle, permission request, and completion metadata.
- [x] wire chatpane to maintain `RunEventState` in parallel with the existing transcript.
- [ ] extend `RunEvent` for artifact.created, file.changed, diff.ready, pane.opened, pane.written, pane.submitted, oracle.handoff.
- [ ] adapt current `Turn` construction to derive from `RunEvent[]`.
- [ ] keep rendered transcript behavior unchanged while events become source of truth.

### task 2b: aios-native tool contract

**files:**
- create: `src/lib/aiosTools.ts`
- create: `src/lib/aiosTools.test.ts`
- modify: `src/components/ChatPane.tsx`
- modify: `src/App.tsx`
- modify: `src/lib/paneBus.ts`
- modify: `src-tauri/src/chat.rs`

- [ ] define model-visible aios tool schema: `aios.open_pane`, `aios.open_file`, `aios.open_editor`, `aios.open_browser`, `aios.spawn_terminal`, `aios.write_pane`, `aios.submit_pane`, `aios.list_panes`, `aios.attach_context`, `aios.handoff_oracle`.
- [ ] inject compact aios capability prompt into chat starts for codex and claude paths.
- [ ] add pane bus request/response bridge for app actions.
- [ ] require permission events for destructive or broad actions.
- [ ] map every tool request/result into `RunEvent`.

### task 3: run cockpit v2

**files:**
- create: `src/components/RunCockpit.tsx`
- modify: `src/components/ChatPane.tsx`

- [ ] derive live phase from run events: thinking, reading, editing, running, waiting, failed, verified.
- [ ] show compact strip above the active assistant turn.
- [ ] add expandable inspector with raw events, active tool, duration, model, cwd, session id.
- [ ] auto-collapse after completion.

### task 4: changes/review tab

**files:**
- create: `src/lib/gitDiff.ts`
- create: `src/components/ChangesPanel.tsx`
- modify: `src-tauri/src/files.rs`
- modify: `src-tauri/src/lib.rs`

- [ ] add bounded tauri command for `git diff --stat` and unified diff by cwd.
- [ ] parse changed files into added/modified/deleted/renamed groups.
- [ ] show risk labels: tests, migrations, config, secrets/env, destructive deletes.
- [ ] add "review this run" action wired to the chat composer.

### task 5: workspace add-to-chat

**files:**
- create: `src/lib/attachments.ts`
- create: `src/components/WorkspaceAttachPicker.tsx`
- modify: `src/components/ChatPane.tsx`
- modify: `src-tauri/src/files.rs`

- [ ] replace current lightweight `@` mention with fuzzy workspace picker.
- [ ] rank recent files and changed files above full tree.
- [ ] support file/folder attachments with preview and size warning.
- [ ] serialize attachments into model-visible prompt context.

### task 6: thread right rail

**files:**
- create: `src/components/ThreadRightRail.tsx`
- create: `src/lib/threadState.ts`
- modify: `src/components/ChatPane.tsx`

- [ ] add per-chat rail tabs: activity, files, changes, browser, memory.
- [ ] persist rail tab and width per conversation.
- [ ] add pop-out actions that open normal aios panes.
- [ ] ensure composer reserves space and does not overlap the rail.

### task 7: artifact system

**files:**
- create: `src/lib/artifacts.ts`
- create: `src/components/ArtifactCard.tsx`
- modify: `src/components/FileViewerPane.tsx`
- modify: `src/components/ChatPane.tsx`

- [ ] infer artifacts from file.changed events and generated output paths.
- [ ] preview markdown, image, pdf, html, csv first.
- [ ] add open/source/attach-next actions.
- [ ] leave whatsapp/gchat send as command-registry actions after task 10.

### task 8: permission queue

**files:**
- create: `src/lib/permissions.ts`
- create: `src/components/PermissionDock.tsx`
- modify: `src/components/ChatPane.tsx`
- modify: `src-tauri/src/chat.rs`

- [ ] normalize claude control requests and codex permission requests into run events.
- [ ] render dock above composer.
- [ ] support approve once, approve session, deny, edit command.
- [ ] attach every decision to the run inspector audit log.

### task 9: worktree environments

**files:**
- create: `src/lib/worktrees.ts`
- create: `src/components/EnvironmentPill.tsx`
- modify: `src-tauri/src/files.rs`
- modify: `src/components/ChatPane.tsx`

- [ ] detect repo root, branch, dirty state, and existing worktrees.
- [ ] expose current tree vs isolated worktree in composer context.
- [ ] create worktree setup/cleanup commands with confirmations.
- [ ] link worktrees to conversations.

### task 10: command registry

**files:**
- create: `src/lib/commands.tsx`
- modify: `src/components/CommandPalette.tsx`
- modify: `src/App.tsx`
- modify: `src/components/ChatPane.tsx`

- [ ] centralize command ids, labels, icons, hotkeys, scope, danger, enabled state, and handlers.
- [ ] migrate global pane commands first.
- [ ] migrate chat/run/file/review actions second.
- [ ] use the registry for slash commands and future voice/whatsapp command routing.

### task 11: pane window manager

**files:**
- modify: `src/App.tsx`
- modify: `src/lib/paneBus.ts`
- create: `src/lib/paneLayout.ts`
- create: `src/components/PaneChrome.tsx`

- [ ] make every pane resizable with stable min/max constraints.
- [ ] support drag reorder, split, stack, pop-out, pin, close, focus, and duplicate.
- [ ] persist layouts per project/conversation.
- [ ] expose pane dimensions and focus state to chat context.
- [ ] wire ai-controllable pane commands through the command registry: `pane.resize`, `pane.move`, `pane.focus`, `pane.split`, `pane.stack`, `pane.popout`.
- [ ] emit `pane.opened`, `pane.focused`, `pane.resized`, `pane.moved`, `pane.closed` run events.

### task 12: browser panes as native aios tabs

**files:**
- modify: `src/components/BrowserPane.tsx`
- modify: `src/lib/paneRouting.ts`
- modify: `src/lib/paneBus.ts`
- modify: `src/App.tsx`

- [ ] treat browser instances as panes, not external tabs.
- [ ] support multiple browser panes grouped like chrome tabs inside aios.
- [ ] add browser pane commands: open url, duplicate, back, forward, reload, inspect, screenshot, attach page to chat.
- [ ] route http links to existing browser group or a new side-by-side browser pane based on modifier/context.
- [ ] let ai open multiple browser panes for comparison/research and attach the visible page context.
- [ ] persist browser groups per conversation/project.

## sequencing rule

do not build right rail, artifacts, permissions, or worktrees before `runevent` exists. otherwise every panel will parse transcript text differently and the app will rot.
