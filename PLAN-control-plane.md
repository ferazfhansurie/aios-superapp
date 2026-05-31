# PLAN — AIOS Control Plane (oracle drives the shell like the human)

> Status: design plan, no code changes. Read-only exploration done against
> `src/App.tsx` (full), `aios-bridge/mcp/aios-spawn-tab/index.js`, `package.json`,
> and the full file inventory of `src-tauri/src/*.rs` + `src/lib/*.ts`.
> Items marked **(verify)** are config/rust files whose exact contents must be
> confirmed at implementation time (the planning session could not load them):
> `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
> `src-tauri/src/browser.rs`. Their roles are unambiguous from Tauri v2
> conventions and the imports already present in `App.tsx`.

## Goal

> firaz: "it's very important that AIOS has every control of the shell app just
> as I do, so I can technically tell it to do everything I do in shell."

Give an external AI agent (the "oracle" — a claude session in a terminal pane or
over WhatsApp) a programmatic control plane that can perform **every user-facing
action** in the running shell app: open/close/arrange panes, drive terminals and
browsers, change settings/theme, save layouts, and read back current app state so
it can act on what it sees. The oracle should reach the SAME code paths the human
UI reaches — one source of truth, no parallel logic.

---

## 1. Action surface (categorized)

Enumerated from `src/App.tsx` (the cockpit) and the pane components. Each row is a
capability the control plane must expose.

### A. Pane lifecycle
| Capability | Today in App.tsx |
|---|---|
| open a pane of any content type | `spawn(kind, label)` `App.tsx:185` |
| open a sidebar item (app or pinned link) | `spawnSidebarItem` `App.tsx:191` |
| open a file (editor vs viewer auto-pick) | `openFile` `App.tsx:210`, `paneForFile` `App.tsx:108` |
| open a URL in a browser pane | `onOpenUrl={(url)=>spawn({type:"browser",url})}` `App.tsx:653` |
| close a pane (with busy-chat confirm) | `requestClose` `App.tsx:252` → `closePane` `App.tsx:245` |
| force-close / keep-running-in-bg | `chatHandles.get(key).detach()` `App.tsx:739-749` |
| resume a recent chat | `resumeChat` `App.tsx:263` |
| reattach a background chat | `spawn({type:"chat",reattach:lc.id})` `App.tsx:688` |
| spawn shell / oracle / tmux | `addShell` `:236`, `addOracle` `:237`, `addTmux` `:241` |
| run focused project (F5) | `runF5` `App.tsx:221`, `runProject` `:311` |

Pane content types (`PaneContent`, defined in `src/lib/apps.ts`): `shell`,
`oracle`, `tmux`, `browser`, `files`, `file` (viewer), `editor`, `chat`,
`memory`, `automations`, `bridges`, `plugins`, `pulse`, `customers`, `motion`.
(The `Pane` interface itself is `App.tsx:88`.)

### B. Layout
| Capability | Today |
|---|---|
| maximize / restore a pane | `toggleMax` `App.tsx:136`, `maximizedKey` state `:134` |
| hide / restore a pane (keeps it running) | `toggleHide` `App.tsx:140`, `hiddenKeys` state `:135` |
| grid arrangement (auto sqrt layout) | `cols/rows` memo `App.tsx:479`; `ResizableGrid` `src/components/ResizableGrid.tsx` |
| move / resize splits | `ResizableGrid` (react-resizable-panels) **(verify exact API)** |
| video → true fullscreen | `onVideoFullscreen` `App.tsx:149` |
| toggle sidebar | `setSidebarOpen` `App.tsx:120,388` |
| **save / load named layout (workspaces)** | NOT BUILT — new feature; persist `panes[] + hidden + maximized + grid` to a store like `src/lib/sidebar.ts` does |

### C. Terminal (TerminalPane + paneBus)
| Capability | Today |
|---|---|
| send text to a pane | `paneWriters.get(key)(text)` `src/lib/paneBus.ts` (used at `App.tsx:353,368`) |
| run a command | spawn `{type:"shell",cmd,cwd}` `App.tsx:230,318` |
| raw bytes / interrupt (Ctrl-C) | via paneWriter writing `\x03` etc. (verify `TerminalPane.tsx` write surface) |
| dictate into focused pane | `handleTranscript` `App.tsx:348` |
| monitor a pane → WhatsApp | `monitorStart/Stop` `App.tsx:1397`, `src/lib/monitor.ts` |
| appshot (screenshot → oracle) | `fireAppshot` `App.tsx:337`, `appshot()` from `src/lib/pty.ts` |

### D. Browser (BrowserPane + src-tauri/src/browser.rs)
| Capability | Today |
|---|---|
| navigate / back / fwd / reload / screenshot | tauri commands in `src-tauri/src/browser.rs` **(verify command names)**; surfaced via `BrowserPane` `src/components/BrowserPane.tsx` |
| set profile | `onProfileChange` `App.tsx:654`, `src/lib/profiles.ts` |
| annotate selection → chat | `routeToChat` `App.tsx:364` |
| recall last URL for a pinned site | `recallUrl` `src/lib/browser-mem.ts` (`App.tsx:197`) |

### E. Files
| Capability | Today |
|---|---|
| browse / open file | `FilesPane` → `onOpenFile` `App.tsx:1471` |
| file ops (read/write/move) | `src-tauri/src/files.rs` tauri commands (verify) |

### F. Settings
| Capability | Today |
|---|---|
| theme / accent / font | `Settings` modal `App.tsx:771`, `src/lib/settings.ts`, `src/lib/theme.ts` (`initTheme` `App.tsx:178`) |
| switch theme quick | `ThemeSwitcher` `App.tsx:583` |
| projects CRUD | `src/lib/projects.ts` (`App.tsx:278`) |
| sidebar personalization | `src/lib/sidebar.ts` — addLink/reorder/rename/hide/setGroup/addSpace/etc. (`App.tsx:66-82`) |

### G. Oracles / fleet
| Capability | Today |
|---|---|
| list oracles | `listOracles()` `src/lib/pty.ts` (`App.tsx:285`) |
| attach oracle / tmux | `addOracle` / `addTmux` (`App.tsx:602`) |
| list/resume chats | `listChatSessions` / `listChatLive` `src/lib/chat.ts` (`App.tsx:286-288`) |
| list customers | `listCustomers` `src/lib/inbox.ts` (`App.tsx:287`) |
| command palette (every ⌘K action) | `commands` memo `App.tsx:485-553`; `CommandPalette` `src/components/CommandPalette.tsx` |

**Read surface the agent needs (so it can see before it acts):** current panes
(`panes` state `App.tsx:119` — key/label/kind), hidden set (`hiddenKeys`),
maximized (`maximizedKey`), sidebar open, the live lists above, current settings.

---

## 2. Existing control channels to build on

### aios-spawn-tab MCP (the pattern to mirror)
`aios-bridge/mcp/aios-spawn-tab/index.js` — a minimal **stdio MCP server** using
`@modelcontextprotocol/sdk` `Server` + `StdioServerTransport`. It registers ONE
tool (`spawn_tab`) via `ListToolsRequestSchema` / `CallToolRequestSchema`, and on
call it **shells out to the `aios` CLI** (`spawn("aios", args)` `index.js:60`) and
returns stdout/stderr as MCP `content`. It does NOT talk to the running webview —
it drives tmux through the CLI. (`aios-recall` is a sibling MCP dir; same shape.)

**Implication:** the oracle already mounts stdio MCP servers and is comfortable
calling tools that shell out. A new `aios-control` MCP can mirror this exactly —
the only new thing is the *transport into the running app* (spawn-tab never needed
that because tmux is external; our panes live in React state inside the webview).

### Does the Tauri app expose an external interface today?
- The app is **Tauri v2** (`package.json`: `@tauri-apps/api ^2`, `@tauri-apps/cli ^2`).
- Frontend↔backend already uses the standard `invoke` / `emit` / `listen` seam:
  `App.tsx` imports `getCurrentWebview` from `@tauri-apps/api/webview` (`:53`) and
  every `src/lib/*.ts` wrapper (pty, browser, monitor, chat, …) calls rust
  commands via `invoke`. There is an active webview event listener already:
  `getCurrentWebview().onDragDropEvent(...)` `App.tsx:436`.
- **(verify)** `src-tauri/src/lib.rs`: confirm the `tauri::Builder`, its
  `invoke_handler(generate_handler![...])`, registered plugins, and any `setup`
  hook — this is where a control listener / HTTP server gets wired.
- **(verify)** `src-tauri/Cargo.toml`: which plugins are present (single-instance,
  deep-link, global-shortcut, an http server crate). **No external control
  surface is assumed to exist today** — there is no evidence of one in the file
  inventory, so the plan adds it.

---

## 3. Recommended architecture (the chosen seam)

### The hard part
`spawn` / `openFile` / `panes` / `maximizedKey` etc. live in **React state inside
the webview**. An external claude process cannot call React. We need a bridge
from an out-of-process MCP tool call into App.tsx state — going through ONE
dispatcher so external == UI.

### Options evaluated
**(a) MCP → rust local HTTP listener → `app.emit` → App.tsx `listen` → dispatcher.**
A new stdio MCP (`aios-control`) HTTP-POSTs a JSON command to a tiny localhost
server hosted *inside* the Tauri app (rust). Rust forwards it to the webview with
`app.emit("aios://control", cmd)`. App.tsx `listen("aios://control")` calls
`dispatchControl(cmd)`. Read commands return via a correlation id (rust holds the
HTTP request open; App.tsx replies with `emit("aios://control-reply", {id,result})`
which rust matches and returns as the HTTP body).
*Pros:* exactly mirrors the existing `invoke`/`emit`/`listen` seam already in the
app; request/response works (needed for READ commands); MCP stays a thin shell
like spawn-tab; testable with `curl`. *Cons:* adds an HTTP server dep to rust
(small — `tiny_http` or `axum`) and a setup hook.

**(b) localhost HTTP control server, MCP optional.** Same rust listener as (a) but
treat HTTP as the primary public contract; MCP becomes one of many clients.
*Pros:* anything (curl, the WhatsApp bridge, future web UI) can drive the app.
*Cons:* without MCP the oracle doesn't get typed tools; still need the same rust +
App.tsx wiring. This is really (a) with a wider door — adopt its server, add the
MCP on top.

**(c) Tauri deep-links (`aios://...`).** Fire-and-forget only.
*Pros:* zero server, uses `tauri-plugin-deep-link`. *Cons:* **no return value** →
can't do READ commands (`pane.list`, `state.get`) which the spec explicitly
requires; fragile encoding; OS round-trip latency. Reject as primary.

### RECOMMENDATION: **(a)**, with the HTTP server written so (b) falls out for free.

A localhost-only HTTP control server inside the Tauri app, fronted by a new
`aios-control` stdio MCP for the oracle. Chosen because it is the only option that
supports request/response (mandatory for read-back), it reuses the app's existing
`emit`/`listen` seam, and the MCP layer stays a thin shell exactly like
`aios-spawn-tab`. HTTP (not raw deep-link) means `curl` and the WhatsApp bridge
can drive the app too — (b) for free.

### Diagram
```
 firaz (terminal pane / WhatsApp)
        │  "open a browser to X, run npm dev, save layout"
        ▼
 oracle (claude session)
        │  MCP tool call: control({action:"pane.open", ...})
        ▼
 aios-control  (NEW stdio MCP, mirrors aios-spawn-tab)
        │  HTTP POST http://127.0.0.1:<port>/control   (+ token header)
        ▼
 Tauri rust: control_server (NEW: src-tauri/src/control.rs)
        │  app.emit("aios://control", {id, action, ...})
        ▼
 App.tsx:  listen("aios://control")  →  dispatchControl(cmd)   ◀── ONE dispatcher
        │  (same fn the UI calls: spawn / closePane / toggleMax / settings / …)
        │  for READ/result:  emit("aios://control-reply", {id, result})
        ▼
 rust matches id → returns HTTP 200 {result}  → MCP returns content to oracle
```

### Security
This lets **anything local drive the app** — opt-in + token-gated:
- Bind **127.0.0.1 only** (never 0.0.0.0).
- Require a bearer token in an `X-AIOS-Token` header. Generate on first launch,
  write to `~/.aios/control-token` (0600). The MCP reads the same file. Reject
  mismatches with 401.
- **Off by default**; enable via a Settings toggle ("Allow agent control") that
  starts/stops the listener, plus an env override `AIOS_CONTROL=1`.
- Random ephemeral port written next to the token (`~/.aios/control-port`) so the
  MCP discovers it; avoids a fixed well-known port other apps could squat.
- Optional: a toast on each external action (`flash(...)` `App.tsx:180`) so the
  human always sees what the oracle did.

---

## 4. Command schema (JSON vocabulary)

Envelope (every command):
```jsonc
{ "id": "uuid",            // correlation id (rust ↔ webview ↔ http)
  "action": "pane.open",   // dotted verb
  "...": "action-specific fields" }
```
Reply envelope: `{ "id": "uuid", "ok": true, "result": <any>, "error": null }`.

### Pane lifecycle
```jsonc
{"action":"pane.open","content":{"type":"browser","url":"https://x.com"},"label":"x"}
{"action":"pane.open","content":{"type":"shell","cmd":"npm run dev","cwd":"/p"}}
{"action":"pane.open","content":{"type":"oracle","identity":"firaz"}}
{"action":"pane.open","content":{"type":"editor","path":"/p/a.ts","name":"a.ts"}}
{"action":"pane.openFile","path":"/p/a.ts"}            // auto editor-vs-viewer
{"action":"pane.openSidebarItem","itemId":"<sidebar id>"}
{"action":"pane.close","key":"k3-abcd","force":false}  // force skips busy-chat confirm
{"action":"pane.resumeChat","id":"<chat id>"}
{"action":"pane.reattachChat","id":"<live chat id>"}
{"action":"pane.runProject","root":"/Users/.../repo"}  // F5 for a specific project
```
### Layout
```jsonc
{"action":"pane.maximize","key":"k3","on":true}
{"action":"pane.hide","key":"k3","on":true}
{"action":"sidebar.toggle","on":true}
{"action":"layout.save","name":"dev"}      // NEW store
{"action":"layout.load","name":"dev"}
{"action":"layout.list"}
```
### Terminal
```jsonc
{"action":"terminal.send","key":"k3","text":"ls -la\n"}
{"action":"terminal.runCommand","key":"k3","cmd":"git status"}  // appends \n
{"action":"terminal.interrupt","key":"k3"}                       // writes \x03
{"action":"terminal.monitor","key":"k3","on":true}              // → WhatsApp
{"action":"app.appshot"}                                         // screenshot→oracle
```
### Browser
```jsonc
{"action":"browser.navigate","key":"k3","url":"https://x.com"}
{"action":"browser.back","key":"k3"}
{"action":"browser.forward","key":"k3"}
{"action":"browser.reload","key":"k3"}
{"action":"browser.screenshot","key":"k3"}     // returns path / base64
{"action":"browser.setProfile","key":"k3","profile":"work"}
```
### Files
```jsonc
{"action":"files.list","path":"/p"}
{"action":"files.read","path":"/p/a.ts"}
{"action":"files.open","path":"/p/a.ts"}    // = pane.openFile
```
### Settings
```jsonc
{"action":"settings.set","key":"theme","value":"dark"}
{"action":"settings.set","key":"accent","value":"#7c5cff"}
{"action":"settings.set","key":"font","value":"JetBrains Mono"}
{"action":"settings.get"}
{"action":"sidebar.pinSite","url":"youtube.com","label":"yt","space":"pinned"}
```
### Oracles / fleet
```jsonc
{"action":"oracle.attach","identity":"firaz"}
{"action":"oracle.list"}
{"action":"chat.list"}
{"action":"palette.run","commandId":"spawn-terminal"}   // run any ⌘K command by id
```
### READ commands (so the agent can see the app)
```jsonc
{"action":"pane.list"}     // → [{key,label,kind,hidden,maximized}]
{"action":"state.get"}     // → {panes[],sidebarOpen,maximizedKey,hiddenKeys,settings,counts}
{"action":"capabilities"}  // → static list of supported actions (self-describing)
```
Reads are the critical half — without them the oracle is blind. Every write that
mutates panes returns the new `pane.list` in `result` so the agent stays in sync
in one round-trip.

---

## 5. Central `dispatchControl(cmd)` in App.tsx

Today actions are scattered closures (`spawn`, `closePane`, `toggleMax`,
`toggleHide`, `setSidebarOpen`, `setSettingsOpen`, `runProject`, `openFile`,
`monitorStart`, settings setters). Introduce ONE dispatcher so UI and external
channel share a single source of truth.

```ts
// App.tsx — new, after all the closures (~ after App.tsx:378)
const dispatchControl = useCallback((cmd: ControlCmd): ControlResult => {
  switch (cmd.action) {
    case "pane.open":      spawn(cmd.content, cmd.label ?? defaultLabel(cmd.content)); break;
    case "pane.openFile":  openFile(cmd.path, basename(cmd.path)); break;
    case "pane.close":     cmd.force ? closePane(cmd.key) : requestClose(cmd.key); break;
    case "pane.maximize":  setMaximizedKey(cmd.on ? cmd.key : null); break;
    case "pane.hide":      toggleHide(cmd.key); break;        // (or set-explicit variant)
    case "sidebar.toggle": setSidebarOpen(v => cmd.on ?? !v); break;
    case "terminal.send":  paneWriters.get(cmd.key)?.(cmd.text); break;
    case "terminal.interrupt": paneWriters.get(cmd.key)?.("\x03"); break;
    case "browser.navigate": browserCmd(cmd.key,"navigate",cmd.url); break;  // → lib/browser
    case "settings.set":   setSetting(cmd.key, cmd.value); break;            // → lib/settings
    case "layout.save":    saveLayout(cmd.name, snapshot()); break;          // NEW lib/layouts
    case "pane.list":      return ok(panesSnapshot());
    case "state.get":      return ok(stateSnapshot());
    ...
  }
  return ok(panesSnapshot()); // writes echo new pane list
}, [spawn, closePane, requestClose, openFile, toggleHide, panes, ...deps]);
```

Then a listener effect (new, alongside the existing drag-drop effect at
`App.tsx:426`):
```ts
useEffect(() => {
  const un = listen("aios://control", (e) => {
    const cmd = e.payload as ControlCmd;
    const res = dispatchControl(cmd);
    emit("aios://control-reply", { id: cmd.id, ...res });
  });
  return () => { void un.then(f => f()); };
}, [dispatchControl]);
```

**Refactors to route existing UI through it (incremental, low-risk):**
- Keep the existing closures; have the UI call them as today. `dispatchControl`
  calls the SAME closures — so there is one place per action even if the UI
  doesn't go through the switch yet.
- Optionally migrate ⌘K `commands` (`App.tsx:485`) and toolbar buttons to call
  `dispatchControl({action:...})` so the palette and the oracle are provably
  identical. Do this in Phase 3 to avoid churn while the dispatcher stabilizes.
- Add a `palette.run` action that looks up a `commands[]` entry by `id` and calls
  its `.run()` — instantly gives the oracle EVERY palette command for free.
- Extract the new types (`ControlCmd`, `ControlResult`) + snapshot helpers into a
  new collision-free file `src/lib/control.ts` so App.tsx only gains the
  dispatcher + listener.

---

## 6. Phasing (each phase independently testable)

> COLLISION NOTE: a background agent is currently editing `App.tsx`,
> `ChatPane.tsx`, `MemoryPane.tsx`, `DatabasePane.tsx` (doc-links feature). Any
> App.tsx edits here MUST wait for / rebase on that work. Everything on the rust
> side, the new MCP, and new `src/lib/*.ts` files are **collision-free** and can
> start immediately.

**Phase 0 — collision-free foundation (START NOW).** No App.tsx edits.
- NEW `src-tauri/src/control.rs`: localhost HTTP listener (`tiny_http`/`axum`),
  token + ephemeral-port files under `~/.aios/`, forwards POST `/control` →
  `app.emit("aios://control", body)`, awaits a matching `aios://control-reply`
  (id-keyed oneshot map), returns the JSON. Add the dep to `Cargo.toml` and wire
  `mod control; ...setup(start_control_server)` in `lib.rs` **(verify builder)**.
- NEW `aios-bridge/mcp/aios-control/index.js` + `package.json`: mirror
  `aios-spawn-tab`; one tool `control(action, ...)` that reads token+port from
  `~/.aios/` and POSTs. Testable with `curl` against the rust server alone (emit
  a no-op reply) before App.tsx exists.
- NEW `src/lib/control.ts`: `ControlCmd`/`ControlResult` types + snapshot helpers.

**Phase 1 — dispatcher + core pane ops (needs App.tsx; AFTER doc-links rebase).**
Add `dispatchControl` + the `listen("aios://control")` effect. Implement
`pane.open`, `pane.close`, `pane.list`, `state.get`, `sidebar.toggle`,
`pane.maximize`, `pane.hide`. End-to-end: oracle opens/closes/lists panes.

**Phase 2 — terminal + browser control.** `terminal.send/runCommand/interrupt`
(via `paneWriters`), `browser.navigate/back/forward/reload/screenshot` (via
`src/lib/browser.ts` + `browser.rs` commands), `app.appshot`. Verify browser.rs
command names during impl.

**Phase 3 — layout + settings + palette parity.** NEW `src/lib/layouts.ts`
(save/load named workspace = panes+hidden+maximized+grid, store pattern from
`src/lib/sidebar.ts`). `settings.set/get`, `sidebar.pinSite`, and `palette.run`
(exposes all ⌘K commands). Optionally migrate UI buttons to `dispatchControl`.

**Phase 4 — MCP polish / oracle ergonomics.** Flesh out `aios-control` tool
descriptions + the `capabilities` self-describing action; register the MCP in the
oracle's MCP config so firaz's sessions get the tools automatically. Add the
WhatsApp-bridge path (bridge can POST the same `/control` endpoint).

**Phase 5 — security hardening.** Settings toggle to enable/disable the listener,
token rotation, per-action toast/audit log, optional confirm-prompt for
destructive actions (close-all, settings nuke).

---

## 7. First collision-free slice (do this first)

1. `src-tauri/src/control.rs` (NEW) + `Cargo.toml` dep + `lib.rs` setup wiring.
2. `aios-bridge/mcp/aios-control/index.js` + `package.json` (NEW), mirroring
   `aios-spawn-tab`.
3. `src/lib/control.ts` (NEW) — shared types + snapshot helpers.

Validate the whole transport with `curl -H "X-AIOS-Token: $(cat ~/.aios/control-token)"
-d '{"id":"1","action":"capabilities"}' http://127.0.0.1:$(cat ~/.aios/control-port)/control`
against a temporary hard-coded reply in rust — BEFORE the App.tsx dispatcher
lands. Only Phase 1 onward touches `App.tsx`, which must rebase on the in-flight
doc-links work.

## Critical Files for Implementation
- /Users/firazfhansurie/Repo/firaz/aios/shell/src/App.tsx
- /Users/firazfhansurie/Repo/firaz/aios/shell/src-tauri/src/lib.rs
- /Users/firazfhansurie/Repo/firaz/aios/shell/src-tauri/Cargo.toml
- /Users/firazfhansurie/Repo/firaz/aios-bridge/mcp/aios-spawn-tab/index.js
- /Users/firazfhansurie/Repo/firaz/aios/shell/src/lib/apps.ts
