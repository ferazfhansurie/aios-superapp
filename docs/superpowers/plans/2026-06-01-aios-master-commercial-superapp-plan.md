# aios master commercial superapp plan

> status: planning-first master plan. build only after this plan set is accepted.

## product law

more, better, more, better. if adding more makes a surface worse, the answer is not to remove power. the answer is a better primitive: command registry, runevent state, pane window manager, right rail, or workflow cockpit.

aios should not be a chat app with tools. it should be a pane-native operating cockpit where chat, terminal, browser, files, memory, agents, automations, whatsapp, and background work share one state model.

## source plans consolidated

- `PLAN-control-plane.md`
- `PLAN-customizable-sidebar.md`
- `PLAN-chatpane-daily-driver.md`
- `PLAN-chatpane-steer-usage-detach.md`
- `PLAN-chat-engines.md`
- `PLAN-model-agnostic.md`
- `docs/superpowers/plans/2026-06-01-aios-codex-grade-thread-system.md`

## non-negotiables

- plans first, implementation second.
- all major actions become command ids.
- all model/tool/pane/file/browser actions become run events.
- chatpane and terminal codex sessions must sync through shared session discovery/replay.
- ai inside chatpane must know aios-native concepts: panes, browser panes, terminal panes, editor panes, memory, oracle, plugins, whatsapp, automations, artifacts.
- pane and browser systems must be first-class, customizable, persistent, and ai-controllable.
- no fake ui for missing backend primitives. ship vertical slices with real state.

## dependency spine

### layer 0: command registry

one source of truth for actions.

must power:
- command palette
- slash commands
- hotkeys
- pane chrome buttons
- chat run actions
- file/review actions
- browser actions
- ai-callable tool actions
- future whatsapp/voice command routing

core schema:
- `id`
- `label`
- `description`
- `icon`
- `scope`
- `danger`
- `enabled`
- `hotkeys`
- `run(ctx)`
- `auditEvent`

why first: without this, every button becomes a one-off handler and ai control becomes brittle.

### layer 1: runevent model

every run is structured state, not transcript text.

events:
- `reasoning`
- `message.delta`
- `action.started`
- `action.completed`
- `permission.requested`
- `permission.resolved`
- `artifact.created`
- `file.changed`
- `diff.ready`
- `pane.opened`
- `pane.focused`
- `pane.resized`
- `pane.moved`
- `pane.written`
- `pane.submitted`
- `browser.opened`
- `browser.navigated`
- `oracle.handoff`
- `run.completed`
- `run.failed`
- `run.interrupted`

why early: run cockpit, right rail, artifacts, permissions, changes, review, and replay all depend on it.

### layer 2: pane window manager

panes become windows, not static grid cells.

must support:
- resize any pane with stable min/max constraints
- drag reorder
- split horizontal/vertical
- stack panes into tab groups
- pop out / pin / duplicate / close / focus
- per-project and per-conversation layout persistence
- ai-visible pane state: key, kind, title, cwd/url/path, dimensions, focus, group
- ai-controllable commands: `pane.open`, `pane.focus`, `pane.resize`, `pane.move`, `pane.split`, `pane.stack`, `pane.popout`, `pane.close`

why before deeper browser: browser tabs should be pane groups, not a separate mini-browser concept.

### layer 3: browser panes as aios-native tabs

browser becomes a pane-native research/work surface.

must support:
- multiple browser panes acting like chrome tabs/groups
- open url into current group, new pane, side-by-side compare, or background pane
- back/forward/reload/duplicate/screenshot/inspect/attach page to chat
- route http links to panes, not external tabs by default
- ai can open multiple browser panes for comparison/research
- browser state persists per conversation/project
- visible page context can be attached to chat

why: aios should own browsing workflows instead of leaking them to chrome.

## build phases

### phase 1: planning completion

deliverables:
- master plan doc
- normalized task order
- each loose plan either referenced or merged
- no code build work until approved

acceptance:
- there is one canonical order for the next implementation passes.
- pane/browser/composer/control-plane/sidebar/model plans do not contradict each other.

### phase 2: commercial shell foundation

features:
- command registry v1
- pane window manager v1
- browser panes v1
- sidebar personalization plan implementation

key outputs:
- resizable/reorderable panes
- pane layout persistence
- browser groups
- sidebar pin/reorder/hide/pin-site
- command registry powering visible buttons

acceptance:
- the app feels like a customizable shell, not a fixed dashboard.
- every visible pane/browser/sidebar action has a command id.

### phase 3: best-in-world composer and run surface

features:
- composer v3
- run cockpit v2
- permission queue
- workspace add-to-chat
- resume v3

composer v3:
- explicit `send`, `queue`, `steer`, `interrupt+send`
- model/effort/permission/project/branch/pane chips
- `@file`, `@folder`, `@pane`, `@session`, `@artifact`
- queue stack with drag reorder
- prompt/context preview
- context budget meter

resume v3:
- codex terminal + chatpane + oracle sessions in one picker
- grouped by project
- searchable by title/project/model/branch/file/command/id
- preview transcript before resume
- actions: resume, fork, review, open files, open terminal, archive

acceptance:
- chatpane is at least as smart and observable as codex terminal.
- user can see what the ai is doing, what it touched, what it needs, and what it will do next.

### phase 4: ai control plane

features:
- local token-gated control server
- `aios-control` mcp
- app dispatcher in `App.tsx`
- read/write app state bridge

ai can:
- list panes
- open/control panes
- write/submit terminal pane text
- open browser panes
- attach context
- route files
- save/load layouts
- hand off to oracle

acceptance:
- external codex/claude/oracle can drive the same app actions the human can.
- all external actions are audited as run events.

### phase 5: review, artifacts, memory, worktrees

features:
- changes/review tab
- artifact system
- thread right rail
- memory tab
- worktree environments

right rail tabs:
- activity
- files
- changes
- browser
- memory

artifact actions:
- preview
- open
- source
- attach-next
- send-to-whatsapp
- route-to-pane

acceptance:
- every generated file/output becomes inspectable and reusable.
- every risky run can be reviewed before trust.

### phase 6: model/provider excellence

features:
- provider registry
- model catalog
- codex app-server daemon path
- opencode/openrouter fallback
- byo key api fallback
- first-run provider setup

acceptance:
- chatpane is model-agnostic but still agentic.
- codex subscription remains first-class.
- fallback models work when codex limits are exhausted.

### phase 7: autonomous operating layer

features:
- background agents
- goal mode
- workflow recorder
- run replay
- self-debug mode
- watch mode
- project cockpit

acceptance:
- a successful run can become a reusable workflow.
- a failed run can debug itself from structured events.
- a goal can persist across app restarts and keep moving.

## specific plans still needed before build

write these as separate implementation plans before coding:

1. `command-registry-plan.md`
2. `pane-window-manager-plan.md`
3. `browser-pane-groups-plan.md`
4. `composer-v3-plan.md`
5. `control-plane-mcp-plan.md`
6. `right-rail-artifacts-review-plan.md`
7. `model-provider-registry-plan.md`

## first implementation order after plans are accepted

1. command registry
2. pane window manager
3. browser pane groups
4. sidebar customization
5. runevent expansion
6. composer v3
7. run cockpit
8. permission queue
9. right rail / changes / artifacts
10. control-plane mcp

## risk rules

- do not build artifacts before `file.changed` and `artifact.created` events exist.
- do not build right rail before runevent state is durable.
- do not build ai pane control before command registry exists.
- do not build browser groups before pane grouping exists.
- do not add more buttons unless each maps to a command id and a visible state.
- do not add hidden model prompting as a substitute for native tools.
