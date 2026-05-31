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
