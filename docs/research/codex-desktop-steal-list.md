# codex desktop steal-list for aios

date: 2026-06-01
source inspected: `/Applications/Codex.app`
bundle version observed: `26.519.81530`
method: local `app.asar` asset inventory, selected asset extraction into `/tmp/codex-assets`, string/feature scan, and comparison against the real AIOS tauri superapp in `/Users/firazfhansurie/Repo/firaz/aios/shell`.

note: this is a product/interaction audit. do not copy codex source. copy the product patterns, then implement them in aios-native code and language.

## executive read

codex desktop is not just a chat app. it is a task cockpit with five strong loops:

- compose work with context, mode, branch, model, queueing, and permissions.
- observe work through reasoning, tool activity, terminals, files, browser/app side panels, and diff/review panels.
- steer work without destroying the active run.
- verify work through diffs, ci checks, review comments, and changed-file panels.
- resume work through threads, projects, worktrees, pins, archive, and keyboard-first navigation.

aios should not clone the whole surface. aios should steal the operating-system parts and make them more personal, more agentic, and more founder-workflow aware.

## already stolen in this pass

- pane-native link routing: chat markdown/http links open browser panes; file-ish links and inline paths open file/editor panes.
- markdown document pane: `.md` files now open in the file viewer with clickable pane-aware links instead of dumping raw text.
- startup pane handoff: `AIOS_OPEN_PANE=/path/or/url` lets the shell boot directly into a target pane.
- codex-style thinking shimmer: plain text `thinking` with a cadenced shimmer sweep while streaming, then a quiet collapsed thought disclosure after completion.
- tauri's existing sticky autoscroll and true `chat_interrupt` stop path are now confirmed as the correct app surface to improve, not the electron terminal.
- codex action visibility: codex app-server `item/started` and `item/completed` action items now adapt into chat-pane `tool_use` / `tool_result` blocks, so running commands and tool actions can render in the aios activity stream.

## second-pass read after testing the real tauri app

the first pass treated codex as the stronger shell. that was wrong. the real aios tauri superapp already has the better operating-system primitive:

- multi-pane layout with persistent app panes, browser panes, file viewer, editor, terminals, notes, memory, crm, and chat.
- pane-native open routing, cross-pane drag/drop, pane writers/submitters, background chat sessions, and mission-control style pane overview.
- true stop path through `chat_interrupt`, sticky autoscroll, queued composer state, model/effort controls, and image/file prompt context.
- now, codex action events are visible enough to feed an activity surface.

codex is still better at one critical layer: it normalizes the work itself. its ui is built around thread-scoped state machines: composer state, side-panel state, permission requests, artifacts, diffs, workspace files, worktrees, and command ids. aios currently has many of those ingredients, but they are still too component-local and transcript-derived.

so the steal is not "make aios look like codex". the steal is:

1. codex's run model.
2. codex's thread-scoped right panel.
3. codex's workspace/diff/review loop.
4. codex's permission and worktree contracts.

aios should keep its superapp pane model and add a codex-grade run cockpit inside it.

## codex patterns to mutate for aios

### 1. normalized run events

codex pattern: reasoning, tool calls, terminal work, file edits, permission requests, artifacts, diffs, and final output are separate event classes, not just chat transcript text.

aios mutation:
- introduce a `RunEvent` model behind the chat pane.
- every backend stream frame becomes one of: `reasoning`, `action.started`, `action.delta`, `action.completed`, `permission.requested`, `artifact.created`, `file.changed`, `diff.ready`, `message.delta`, `run.completed`, `run.failed`, `run.interrupted`.
- chat remains the narrative surface; the run inspector becomes the state surface.

why this is the highest-leverage steal: once actions, diffs, permissions, artifacts, and memory are first-class events, every pane can become smarter without parsing rendered chat.

### 2. thread-scoped right panel

codex pattern: a thread has contextual side panels: files, browser, review, activity. it is not just a global window manager.

aios mutation:
- keep the global aios panes.
- add an optional right rail inside each chat pane with tabs: `activity`, `files`, `changes`, `browser`, `memory`.
- each tab can pop out into a normal aios pane.
- panel state persists per conversation/session.

why this matters: free panes are powerful, but work needs locality. when a run edits files, opens links, or creates artifacts, those should orbit the current thread before becoming global panes.

### 3. action timeline with real lifecycle

codex pattern: the user sees what the agent is doing now, what finished, what failed, and what needs approval.

aios mutation:
- current assistant output gets a minimal run strip.
- expanded activity panel shows grouped actions: command, file read/write, search, web, mcp, agent dispatch.
- each group has status, duration, cwd/path, input summary, output summary, and error state.
- collapsed completed groups should read like "ran tests", "edited chat.rs", "opened docs", not raw sdk names.

current status: action events now arrive for codex. the next work is modeling them as durable run events instead of only inline activity blocks.

### 4. composer context contract

codex pattern: composer state includes prompt, attachments, model, permission mode, workspace root, branch/worktree, queue, and active-thread state.

aios mutation:
- formalize composer state as data, not scattered component state.
- show compact context chips above composer: project, branch, permission mode, model, effort, attachments, queued messages.
- make `stop`, `queue`, `steer`, and `interrupt+send` explicit states.
- file attachments should be inspectable and removable before send.

why this matters: firaz should always know what context the agent is about to use.

### 5. workspace file command bridge

codex pattern: file search is not just browsing. it is a command bridge: open, add to chat, copy path, reveal, attach.

aios mutation:
- composer `@file` opens fuzzy project file search.
- selected files/folders become prompt attachments.
- file cards expose `open pane`, `open editor`, `copy path`, `remove`.
- recent files and changed files are ranked above the full tree.

### 6. changes and review surface

codex pattern: code work has a review panel: diff tree, stats, inline diff, annotations, ci status, review comments.

aios mutation:
- every coding run gets a `changes` tab.
- start with `git diff --stat` + file list + unified diff preview.
- add "review this run" to spawn a second-pass reviewer.
- add risk labels: tests touched, migrations touched, config touched, destructive files touched.

this is the biggest quality unlock after run events.

### 7. permission queue

codex pattern: approvals are first-class pending items, not random chat cards.

aios mutation:
- pending permission dock above composer.
- approve once, approve session, deny, edit command.
- every approval/denial becomes a run event.
- later, tie permission modes to project/worktree trust.

### 8. worktree environments

codex pattern: branch/worktree/environment is visible in composer and thread chrome.

aios mutation:
- project pill becomes `repo / branch / dirty / mode`.
- coding runs can choose: current tree, new worktree, existing worktree.
- worktree runs get their own panes and cleanup state.

### 9. artifacts as products

codex pattern: generated files become artifacts with preview, source, status, navigation, and open actions.

aios mutation:
- when an agent creates files under known output/docs paths, create artifact events.
- artifact cards can preview markdown/images/pdf/html/csv and pop into panes.
- "send to whatsapp/gchat", "attach to next prompt", and "open folder" are aios-specific upgrades codex does not have.

### 10. command registry

codex pattern: hotkeys, command-k, slash commands, thread actions, and menus resolve to command ids.

aios mutation:
- central `CommandRegistry`.
- commands declare label, icon, scope, hotkey, danger, handler, and discoverability.
- use it for pane commands, chat commands, file actions, run actions, and app menu.

this prevents the superapp from becoming a pile of one-off buttons.

## priority backlog

### steal now

1. run cockpit v2

codex pattern: assistant output has a minimal live status row, not a giant debug panel. reasoning is immediate, tool state is grouped, and details unfold only when asked.

aios version:
- one compact "run strip" above each assistant answer.
- live phase: thinking, using tools, writing, waiting for permission, failed, verified.
- single active operation label: reading file, editing file, running command, checking web, launching agent.
- expandable run inspector with raw tool cards, thinking tail, changed files, duration, model, cwd, session id.
- after completion, collapse details automatically but preserve one-click reopen.

why it matters: firaz needs to trust what the agent is doing without reading a wall of tool logs.

2. composer control contract

codex pattern: active generation is not a binary blocked state. user can stop, queue, steer, retry queued messages, delete queued messages, and choose whether queueing is on.

aios version:
- stop: abort active run.
- queue: send after active run ends.
- steer: inject a follow-up into current run if sdk supports it, otherwise label clearly as "interrupt and send".
- retry failed queued item.
- edit queued item inline.
- show "another chat running" without blocking this chat.

why it matters: current composer must feel like a control surface, not a textbox waiting on a hidden process.

3. workspace file browser + add-to-chat

codex pattern: file tree search has "copy path", "add to chat", "open in...", and available-app opening.

aios version:
- workspace file picker from composer.
- fuzzy file search.
- add selected files/folders to prompt context.
- preview before attach for images/pdf/markdown/code.
- recent files per project.

why it matters: aios is supposed to know firaz's machine. attachment should not rely on drag/drop or manual path typing.

4. diff and review surface

codex pattern: rich diff assets include unified diff, file tree, stats, stage/unstage/revert, review mode, ci check badges, github comment navigation, and search inside diffs.

aios version:
- "changes" side panel for every coding run.
- file list grouped by added/modified/deleted/renamed.
- inline diff preview with additions/deletions counts.
- ai-generated change summary attached to run.
- "review this run" action that asks a second model/agent for bugs.
- "open in editor", "copy patch", and "revert file" gated behind confirmation.

why it matters: chat output is not enough for code. firaz needs to see the actual patch and risk profile.

5. permission request queue

codex pattern: permission requests are modeled as panel items with approve/deny, keyboard shortcuts, and visibility tied to active tools.

aios version:
- pending permission dock above composer.
- show command/path/tool requesting access.
- approve once, approve for session, deny, edit command.
- hotkeys for approve/deny.
- audit log in run inspector.

why it matters: current bypass-permissions posture is too blunt for an app that can operate across firaz's machine.

### steal next

6. side-panel architecture

codex pattern: thread chrome has named panels: files, side chat, browser, review, activity. panels are contextual to the current thread.

aios version:
- right panel with tabs: activity, files, changes, browser/app, memory.
- panels persist per conversation.
- composer reserves bottom overlay space so panels do not fight the input.

why it matters: aios should become a cockpit. chat alone is too narrow.

7. worktree/project environments

codex pattern: local/cloud/worktree modes are first-class. branch picker and worktree init flows are visible in composer/footer.

aios version:
- project focus becomes an explicit environment pill.
- "work in current tree" vs "create isolated worktree".
- show branch, dirty state, default branch, and local env.
- run setup command for new worktree if project defines one.
- per-project environment memory.

why it matters: agent coding without isolation eventually burns the repo.

8. command and shortcut registry

codex pattern: keyboard shortcuts are searchable, rebindable, and tied to command ids. slash commands have source-specific UI.

aios version:
- one command registry powering slash palette, command-k, menu shortcuts, and docs.
- command metadata: source, mode, scope, hotkey, danger level.
- user-rebindable shortcuts later.

why it matters: aios already has commands scattered across components. this will rot unless centralized.

9. artifact previews

codex pattern: artifacts can open in side panel, show source, download, open in folder/app, and preview rich file types.

aios version:
- generated files appear as artifacts in run output.
- preview markdown, images, pdf, notebooks, csv, html, simple office docs if available.
- "open folder", "download/export", "attach artifact to next message".

why it matters: many aios outputs are files, not text. treat them as first-class products.

10. thread actions and recents

codex pattern: pin, archive, rename, copy cwd, copy session id, copy deeplink, copy as markdown, open in new window.

aios version:
- pin important chats.
- archive completed chats without deleting.
- copy transcript as markdown.
- copy project/cwd/session ids.
- conversation deeplinks for handoff between terminal/web/electron.

why it matters: firaz lives across many long-running threads. retrieval and handoff matter.

### steal later

11. ambient suggestions

codex pattern: home suggestions, connected-app consent, "create a plan", plan mode, and personalized next actions.

aios version:
- proactive suggestions based on current repo, recent chats, goals, and scheduled work.
- should be opt-in and dismissible.
- aios-specific: "ship this", "ask review", "make plan", "open oracle", "send update".

why later: useful, but only after core run control is strong.

12. mcp app panels

codex pattern: mcp apps can render html/resource content, have devtools, and provide local/worktree launch choices.

aios version:
- mcp/plugin panels inside right side panel.
- strict sandbox, size limits, no broad file access.
- use for connected apps like github, whatsapp, gchat, calendar.

why later: powerful, but security needs design first.

13. profile/usage cockpit

codex pattern: token usage chart, lifetime tokens, peak tokens, longest task, streaks.

aios version:
- usage by project, model, day, outcome.
- "hours saved" is vanity unless tied to shipped artifacts.
- better: shipped changes, reviewed changes, stopped runs, failed runs, proactive interventions accepted.

why later: nice dashboard, not core workflow.

## do not steal blindly

- marketing-style home surfaces. aios should start in work mode, not a generic welcome page.
- heavy cloud/local mode complexity until aios has a clean project/environment model.
- broad html-rendering mcp panels without sandboxing.
- every file preview type. start with code, markdown, images, pdf, csv, html.
- "personalized suggestions" that become noise. aios should be opinionated and sparse.

## codex assets that signaled the strongest patterns

- `reasoning-minimal-*.js`: reasoning effort labels and compact reasoning visuals.
- `thinking-shimmer-*.js/css`: cadenced shimmer for live thinking.
- `queued-message-list-*.js`: queue, steer, retry, edit, delete, queueing toggle.
- `composer-*.js/css`: composer modes, voice, sandbox setup, attachments, permissions, worktree/branch context.
- `composer-view-state-*.js`: normalized composer state with prompt and attachment buckets.
- `above-composer-panel-row-*.js`: compact context chips above composer.
- `above-composer-suggestions-*.js`: plan-mode suggestion row.
- `thread-app-shell-chrome-*.js`: thread side-panel tabs for files, side chat, browser, review, activity.
- `local-conversation-thread-*.js`: artifacts, terminals, environments, reasoning/tool state.
- `thread-actions-*.js`: archive, stop, rename, copy cwd/session/deeplink/markdown, open new window.
- `diff-*`, `file-diff-*`, `editor-diff-page-*`, `review-*`: rich diff/review workflow.
- `pending-request-item-panel-*.js`, `permission-request-model-*`, `permissions-mode-*`: permission queue and modes.
- `workspace-directory-tree-*`, `file-tree-search-input-*`, `workspace-file-command-menu-bridge-*`: workspace file browser and file actions.
- `worktree-*`, `git-branch-*`, `composer-footer-branch-switcher-*`: branch/worktree setup and switching.
- `artifact-*`, `pdf-preview-*`, `notebook-preview-*`, `PopcornElectron*Panel-*`: rich artifact/file previews.
- `keyboard-shortcuts-*`, `command-keybindings-*`, `use-command-hotkey-*`: searchable command and shortcut system.
- `mcp-*`: plugin/app capability views and resource rendering.

## proposed implementation order after current chatpane patch

1. run cockpit v2: one persistent run strip with phases, active tool, changed files, stop/steer/queue state, and expandable raw trace.
2. composer control contract: visible stop vs steer vs queue behavior, queued item edit/retry/delete, and clearer disabled states.
3. right-side contextual panel: activity, files, changes, browser/app, memory per conversation.
4. workspace add-to-chat: fuzzy file picker, previews, recent files, and folder/file context attachments.
5. diff/change panel with review action.
6. permission request queue before enabling richer local tools.
7. worktree isolation for coding runs.
8. command registry and artifact previews.

## deeper local audit: what codex actually has that aios should steal

source detail: `/private/tmp/codex-assets/webview/assets` contains the extracted codex webview chunks. the useful names are not implementation instructions; they reveal product boundaries.

### a. thread shell as a state machine

codex evidence:
- `thread-app-shell-chrome-*`
- `thread-layout-*`
- `thread-page-header-*`
- `thread-scroll-layout-*`
- `thread-panel-state-*`
- `thread-page-bottom-panel-state-*`
- `right-panel-composer-overlay-scroll-reserve-*`
- `thread-context-*`
- `thread-context-inputs-*`
- `thread-detail-level-*`

aios current match:
- global pane shell in `src/App.tsx`.
- chat transcript state in `src/components/ChatPane.tsx`.
- pane bus for cross-pane open/write/submit in `src/lib/paneBus.ts`.

gap:
- aios has a strong app shell but weak thread shell. chat-specific state is inside one large component and is not a reusable model.

steal:
- create `src/lib/runEvents.ts` and `src/lib/threadState.ts`.
- define conversation-scoped state for active run, side panel tabs, attached files, generated files, changed files, browser handoff, memory hits, permission queue, and queued messages.
- keep `App.tsx` global; add thread-local shell inside `ChatPane`.

implementation note:
- do not start by building a new right rail. first extract the data model and derive the existing transcript from it. otherwise the rail becomes another component-local pile.

### b. composer as a controller, not a textarea

codex evidence:
- `composer-*`
- `composer-view-state-*`
- `use-composer-controller-*`
- `composer-external-footer-*`
- `composer-footer-branch-switcher-*`
- `above-composer-panel-row-*`
- `above-composer-suggestions-*`
- `queued-message-list-*`
- `focus-composer-*`
- `user-message-attachments-*`
- `attachment-remove-button-*`
- `slash-command-item-*`

aios current match:
- model picker, effort picker, permission picker, image drop, slash menu, queue/steer behavior already exist in `ChatPane.tsx`.
- queue state has tests in `src/lib/chatPaneState.test.ts`.

gap:
- the composer controls are functional but not contractually clear. "send" can mean send, queue, steer, or blocked depending on hidden state.

steal:
- above-composer context row with chips: project, branch, model, effort, permission, attachments, queue count, active run state.
- explicit send modes:
  - `send now`
  - `queue after run`
  - `steer running codex turn`
  - `interrupt and send`
- queued list with edit, retry, delete, move up/down.
- attachment shelf with preview and remove.

aios upgrade beyond codex:
- add `send to active pane` and `send to background oracle` as first-class composer routes.

### c. review/diff as the coding truth surface

codex evidence:
- `diff-*`
- `file-diff-*`
- `diff-unified-*`
- `diff-stats-*`
- `diff-summary-*`
- `parse-diff-*`
- `parsePatchFiles-*`
- `editor-diff-page-*`
- `review-*`
- `review-header-toolbar-*`
- `review-file-tree-side-pane-*`
- `review-navigation-model-*`
- `review-runtime-bridge-*`
- `pull-request-code-review-comments-*`

aios current match:
- editor pane, file viewer, project detection, terminal run commands.
- no dedicated run diff model yet.

gap:
- after a coding run, the app still trusts the assistant narrative. the actual patch is not the primary object.

steal:
- per-run `changes` tab.
- `git diff --stat`, changed file tree, unified diff, and file-level risk labels.
- diff controls: hide whitespace, wrap, expanded/collapsed, copy patch, open file, open editor.
- "review this run" action that dispatches a reviewer against the actual diff.
- "copy git apply command" is useful for remote handoff.

aios upgrade beyond codex:
- add "ship summary" that turns the diff into a whatsapp/client/dev update.
- add "risk receipt": files touched, tests run, tests missing, secrets/config touched.

### d. workspace files as attachable context

codex evidence:
- `workspace-directory-tree-*`
- `file-tree-search-input-*`
- `use-workspace-file-search-*`
- `workspace-file-command-menu-bridge-*`
- `open-workspace-file-*`
- `send-open-file-request-*`
- `local-active-workspace-root-dropdown-*`
- `workspace-root-icon-*`
- `file-kind-*`
- `get-file-icon-*`

aios current match:
- files pane, file viewer, editor pane, pane-native file routing.

gap:
- browsing files and giving files to the agent are separate workflows.

steal:
- `@file` fuzzy picker in composer.
- file/folder context attachments with size warnings.
- recent files and changed files ranked first.
- file command menu: open pane, open editor, copy path, reveal, attach, remove.

aios upgrade beyond codex:
- drag from files pane directly into chat attachments, terminal path, editor open, or notes link depending on drop target.

### e. permission and trust controls

codex evidence:
- `permissions-mode-*`
- `permissions-mode-defaults-*`
- `permissions-mode-helpers-*`
- `permissions-mode-visibility-*`
- `permission-request-model-*`
- `pending-request-item-panel-*`
- `heartbeat-automation-permissions-*`

aios current match:
- permission mode picker maps to codex sandbox/approval policy.
- approval cards exist for claude control requests.

gap:
- approvals are transcript cards, not a durable queue tied to active run and project trust.

steal:
- permission dock above composer.
- pending request model with `approve once`, `approve session`, `deny`, `edit command`.
- audit log in run inspector.
- project trust state visible in composer.

aios upgrade beyond codex:
- approval profiles per client/repo: agency repos can allow writes; personal finance paths default to ask; production infra requires explicit approve.

### f. worktree/project environment loop

codex evidence:
- `worktree-*`
- `worktree-init-v2-page-*`
- `worktree-environment-dropdown-*`
- `worktrees-settings-page-*`
- `pending-worktree-*`
- `build-worktree-label-from-input-*`
- `worktree-paths-*`
- `git-branch-*`
- `git-branch-picker-dropdown-content-*`
- `git-branch-switcher-*`
- `use-git-current-branch-*`
- `use-git-default-branch-*`
- `use-git-recent-branches-*`
- `use-git-synced-branch-*`

aios current match:
- project detection in `src-tauri/src/files.rs`.
- f5 run command surface.
- terminal panes can spawn in cwd.

gap:
- no explicit "safe coding environment" contract.

steal:
- environment pill: `repo / branch / dirty / current tree`.
- "use current tree" vs "new isolated worktree" before risky coding runs.
- list worktrees and linked conversations.
- cleanup workflow for worktrees.

aios upgrade beyond codex:
- tie worktree to pane layout: a worktree run opens chat + terminal + files + browser as a saved workspace cluster.

### g. artifact previews as product surfaces

codex evidence:
- `artifact-*`
- `artifact-tab-content.electron-*`
- `artifact-preview-page-navigation-*`
- `artifact-preview-status-*`
- `open-artifact-side-panel-tab-*`
- `file-preview-page-*`
- `pdf-preview-panel-*`
- `docx-preview-panel-*`
- `notebook-preview-panel-*`
- `PopcornElectronDocumentPanel-*`
- `PopcornElectronPresentationPanel-*`
- `PopcornElectronWorkbookPanel-*`
- `image-preview-*`
- `filesystem-media-src-*`

aios current match:
- file viewer, office preview, browser pane, motion/studio pane.

gap:
- generated outputs are still just files or links, not artifacts attached to a run.

steal:
- artifact events from created files.
- artifact cards with preview/open/source/status.
- rich previews for md, image, pdf, html, csv, docx/pptx/xlsx where available.

aios upgrade beyond codex:
- "send artifact to whatsapp", "attach to next message", "turn into proposal", "save to client workspace".

### h. browser/app side panel and local app control

codex evidence:
- `browser-sidebar-*`
- `browser-sidebar-manager-*`
- `browser-sidebar-state-*`
- `browser-sidebar-open-source-*`
- `thread-side-panel-browser-tab-state-*`
- `mcp-app-resource-content-*`
- `mcp-capability-*`
- `mcp-settings-*`
- `mcp-tool-item-content-utils-*`

aios current match:
- native WebKit browser panes in `src-tauri/src/browser.rs`.
- pane-native url routing.
- plugins pane.

gap:
- browser/app activity is global pane state, not attached to the active thread.

steal:
- thread-local browser tab that can pop out into a full pane.
- browser state event tied to run: opened url, current url, title, screenshot/appshot, agent controlling browser.
- mcp/app output as constrained side-panel resources.

aios upgrade beyond codex:
- use existing multi-profile browser panes for client accounts and local business workflows.

### i. command system and keyboard model

codex evidence:
- `command-keybindings-*`
- `use-command-hotkey-*`
- `keyboard-shortcuts-*`
- `keyboard-shortcuts-search-input-*`
- `hotkey-window-*`
- `electron-menu-shortcuts-*`
- `thread-actions-*`

aios current match:
- command palette exists in `src/components/CommandPalette.tsx`.
- commands are assembled in `App.tsx`.
- many hardcoded keyboard handlers in `App.tsx` and `ChatPane.tsx`.

gap:
- there is no central command registry, so actions cannot be reused cleanly across palette, menus, hotkeys, buttons, and docs.

steal:
- central command registry with id, title, scope, icon, hotkey, danger, enabled, run.
- searchable shortcut window.
- command scopes: global, pane, chat, file, run, review.

aios upgrade beyond codex:
- voice commands and whatsapp commands can target the same registry.

### j. monitoring, notifications, and background work

codex evidence:
- `run-command-*`
- `run_command_animation-*`
- `list_files_animation-*`
- `edit_files_animation-*`
- `terminal-*`
- `terminal-service-*`
- `heartbeat-automation-*`
- `thread-handoff-store-*`
- `pinned-threads-query-*`
- `set-pinned-thread-*`

aios current match:
- persistent terminal panes, tmux oracles, background chat detach/reattach, bridge/automation panes, monitor watcher.

gap:
- aios has stronger background primitives than codex but weaker run-level summarization.

steal:
- pin/archive/rename/copy transcript/copy session id/copy cwd for conversations.
- handoff store: move a run between foreground chat, background session, and oracle.
- compact "what changed since you left" summary when reattaching.

aios upgrade beyond codex:
- whatsapp notification and oracle roster integration are already unique; wire them into run state.

## brutal product ranking

build in this order:

1. `RunEvent` model and run inspector. everything else depends on this.
2. changes/review tab. this turns coding from trust-me chat into inspectable work.
3. composer context/control row. this fixes the daily-driver feel.
4. workspace add-to-chat. this makes context cheap.
5. thread right rail with activity/files/changes/browser/memory. this gives runs locality.
6. artifact events and previews. this makes outputs tangible.
7. permission queue. this lets us safely expose more power.
8. worktree environments. this prevents repo damage.
9. command registry. this keeps the app from rotting.
10. mcp/app resource panels. only after sandbox and command registry exist.

do not build first:

- ambient suggestions. too easy to become noise.
- usage dashboards. nice, but not why the app feels powerful.
- full mcp html panels. security and lifecycle are not ready.
- huge settings pages. codex needs them because it is a product for everyone; aios should encode firaz defaults.

## aios-specific upgrades beyond codex

- memory-aware run inspector: show which memory/context items affected a run.
- goal-aware suggestions: suggestions should map to firaz's active goals, not generic prompts.
- oracle handoff: any run can be handed to a background oracle with visible status.
- whatsapp/gchat delivery actions: outputs can be shipped directly to people/channels.
- business cockpit: not just code diffs, also leads, proposals, standups, client deliverables.
- "why this matters" summaries for long-running agents: one sentence attached to each tool group.

## immediate next spec candidates

### spec a: run cockpit side panel

scope:
- right panel tabs: activity, changes, files.
- activity timeline from existing message/tool state.
- changes panel initially infers from tool calls and git diff.
- files panel lists attached/generated files.

risk: medium. mostly renderer work, but git diff needs careful process bounds.

### spec b: workspace add-to-chat

scope:
- file search modal.
- attach file/folder references to composer.
- preview selected files.
- recent files.

risk: medium-high because file bridge security must be tightened at the same time.

### spec c: permission queue

scope:
- model permission requests as first-class store items.
- render pending approval dock.
- approve/deny/edit.
- audit log.

risk: high. needs sdk/tooling integration and security design.

recommendation: spec a next. it compounds the work already done and makes every future agent run easier to inspect.
