# control plane mcp implementation plan

## goal

let external oracle/codex/claude sessions control the running aios shell through the same command registry as the human ui.

## files

- create `src-tauri/src/control.rs`
- modify `src-tauri/src/lib.rs`
- create `aios-bridge/mcp/aios-control/index.js`
- modify `src/App.tsx`
- modify `src/lib/commands.tsx`

## architecture

external agent → `aios-control` mcp → localhost token-gated tauri control server → webview event → command registry dispatcher → reply.

## security

- bind only `127.0.0.1`
- token in `~/.aios/control-token`
- port in `~/.aios/control-port`
- off by default or gated by setting/env
- audit every external command as run event

## phases

1. add local control server.
2. add request/reply bridge to app webview.
3. add `aios-control` mcp.
4. support read commands: list panes, current layout, active project.
5. support write commands: open/focus/resize panes, browser open, terminal send.
6. add permissions for risky commands.

## acceptance

- oracle can list panes.
- oracle can open/control panes.
- oracle actions are visible and auditable.
- human ui and external ai use the same command ids.
