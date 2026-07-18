# aios shell browser pane native deep dive

## thesis

the browser should not be treated as “a website viewer inside a pane.” it should be a first-class pane primitive, equivalent to terminal/chat/files/editor:

- panes can create, focus, split, hide, maximize, persist, restore, and control browsers.
- browsers can create panes, feed chat, open files/downloads, expose page context, and participate in layouts.
- agents can drive browsers through the same control plane they use for panes and terminals.

current code is already past the hardest technical hurdle: `src-tauri/src/browser.rs` creates real native child webviews keyed by pane key. the missing layer is pane-native orchestration.

## current state

### built

- `BrowserPane.tsx` owns browser chrome and a placeholder div.
- `browser.rs` owns native webviews through `Window::add_child`.
- each browser webview is keyed by the pane key, not the human label.
- bounds are synchronized from the html placeholder using `ResizeObserver`, `window.resize`, and a 300ms poll.
- overlays hide native webviews by shrinking inactive panes to `0x0`, because native webviews paint above html.
- browser panes support:
  - navigate/search
  - back/forward/reload
  - screenshot through `screencapture`
  - annotation and selection to chat via clipboard sentinel
  - profile-isolated cookie jars through wkwebview data store ids
  - new-window interception to spawn a new browser pane
  - video fullscreen escalation: pane maximize plus os fullscreen
  - sidebar pinning and last-url memory for pinned links

### partially built

- links in chat open a browser pane.
- memory/database links can open a browser pane.
- pinned sites reopen at remembered last url.
- layout persistence stores browser kind, url, profile, mem key.

### not built enough

- no central browser registry/snapshot in app state.
- no browser actions in `paneBus`.
- no agent-facing browser control plane yet.
- no browser tab/session model beyond one pane equals one webview.
- no page metadata stream: title, favicon, loading state, can-go-back/can-go-forward.
- no real download/upload/file routing story.
- no reusable browser inspector/devtools workflow.
- no split-from-link / open-beside-current placement primitive.
- no page-to-pane drag/drop contract.
- no browser command palette actions scoped to selected browser.

## hard constraints

### 1. native webviews are not dom children

the wkwebview is a sibling/native child of the tauri window, not a react element. react can only control a placeholder rect and call rust commands. that means normal html z-index does not work over it.

consequence: every modal, command palette, overview, drag ghost, tooltip, or floating menu that crosses the browser region must either hide/shrink the webview or be moved into a native/webview-aware layer.

current mitigation is correct but blunt: pass `active=false` and shrink hidden/non-focused browser webviews.

### 2. pane geometry is the source of truth

browser placement should be driven by pane state, not the browser module. react decides the pane rect; rust applies it. this is the right direction.

what is missing is durable grid state. `ResizableGrid` currently resets track fractions when grid shape changes. for a browser-first workflow, that is bad: resizing a preview/docs pane should survive opening another terminal.

### 3. browser state is split across too many places

right now:

- pane kind stores initial url/profile/mem key.
- browser pane local state stores current/input/zoom/device/annotating.
- rust stores the live webview by label.
- sidebar store stores pinned site metadata.
- browser-mem stores last url per pinned site.

this works, but it is not pane-native. pane-native means app-level state can answer: “what browser panes exist, what are they showing, which profile, what title, what can be controlled?”

### 4. agents cannot drive react state directly

`PLAN-control-plane.md` already identifies the real bridge: external ai agents need an app-hosted command surface. rust receives commands, emits them to the frontend, frontend mutates react state, and returns snapshots.

browser pane-native work should ride on that control plane, not invent a separate browser api.

## target behavior

### pane to browser

any pane should be able to hand work to a browser:

- chat link click opens in a browser pane.
- terminal url detection can open in a browser pane.
- files/editor can open local previews in browser where useful.
- database/memory links open beside the source pane.
- command palette can “open url in selected browser”, “open beside”, “duplicate”, “pin”, “send selection to chat”.

### browser to pane

the browser should be able to hand work back:

- selection or annotation routes to selected chat, active chat, or a new chat.
- screenshot routes to chat as image attachment or opens as file viewer.
- downloaded files appear in files pane and can open in editor/viewer.
- page source/dom snapshot can route to chat.
- page console errors can route to chat.
- new windows become sibling browser panes preserving profile.
- dev server preview can pair with terminal process pane.

### agent to browser

agents should be able to:

- list browser panes with url/title/profile/loading state.
- open a browser pane at url.
- navigate/back/forward/reload.
- screenshot and receive file path.
- send selected text/current page context into chat.
- start annotation mode.
- open new browser beside a terminal/editor.
- create a named workspace layout: terminal + editor + browser + chat.

## architecture recommendation

### build a `pane runtime` layer

add a single frontend runtime facade around pane state:

```ts
type PaneSnapshot = {
  key: string;
  label: string;
  kind: PaneContent;
  hidden: boolean;
  maximized: boolean;
  active: boolean;
};

type BrowserSnapshot = PaneSnapshot & {
  kind: { type: "browser"; url?: string; profile?: string; memKey?: string };
  currentUrl: string | null;
  title: string | null;
  faviconUrl: string | null;
  loading: boolean;
  zoom: number;
  deviceMode: boolean;
};
```

do not move all pane state out of `App.tsx` immediately. first expose a typed snapshot/action boundary. once that is stable, refactor internals later.

### promote browser actions into `paneBus`

today `paneBus` is terminal/chat/file oriented. add browser handles:

```ts
export interface BrowserHandle {
  snapshot: () => BrowserRuntimeSnapshot;
  navigate: (url: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
  screenshot: () => Promise<string | null>;
  setProfile: (profile: string) => void;
  setZoom: (pct: number) => void;
  setDeviceMode: (on: boolean) => void;
  annotate: () => void;
  copySelectionToChat: () => void;
}

export const browserHandles = new Map<string, BrowserHandle>();
```

`BrowserPane` registers/unregisters this handle by pane key. `App.tsx`, command palette, and future control plane call handles instead of reaching into component internals.

### create browser metadata events in rust

polling `browser_current_url` works, but pane-native needs title/favicon/loading state. add a small injected script and rust events:

- after navigation, inject:
  - `document.title`
  - canonical url
  - favicon candidate
  - selection availability if cheap
- emit to frontend:
  - `browser-state-changed`
  - payload `{ key, url, title, faviconUrl, loading? }`

if tauri/wry exposes navigation events cleanly, use those. if not, keep polling but centralize it in `BrowserPane` and publish to app state.

### make layouts stable

pane-native browser work depends on layout fidelity. upgrade `ResizableGrid` to persist:

- `cols`
- `rows`
- `colFr`
- `rowFr`
- pane order
- hidden keys
- maximized key

then add workspace presets:

- “research”: browser + chat + notes
- “dev preview”: terminal + editor + browser + chat
- “ops”: browser + database + automations + chat

### make browser placement intentional

add spawn placement options:

```ts
type SpawnOptions = {
  label?: string;
  placement?: "append" | "beside-active" | "replace-active" | "split-right" | "split-down";
  focus?: boolean;
};
```

then update browser entry points:

- chat links: open beside chat if no browser active, else reuse active browser when modifier is held.
- terminal-detected localhost urls: open beside terminal.
- command palette: explicit “new browser”, “open in active browser”, “open beside”.

## implementation phases

### phase 1: browser handle registry

files:

- `src/lib/paneBus.ts`
- `src/components/BrowserPane.tsx`
- `src/App.tsx`

outcome:

- every browser pane registers a typed handle.
- app can list and control browser panes without reaching into component local state.
- command palette can target the selected browser.

### phase 2: browser snapshot and title/favicon

files:

- `src/components/BrowserPane.tsx`
- `src-tauri/src/browser.rs`
- `src/lib/browser.ts`
- `src/App.tsx`

outcome:

- pane headers can show real page title/favicon instead of generic `browser`.
- `pane.list` can include live browser url/title/profile.
- pinned site memory becomes more visible and debuggable.

### phase 3: control plane browser verbs

files:

- whatever implements `PLAN-control-plane.md`
- `src/lib/browser.ts`
- `src/App.tsx`

verbs:

- `browser.list`
- `browser.navigate`
- `browser.back`
- `browser.forward`
- `browser.reload`
- `browser.screenshot`
- `browser.annotate`
- `browser.selectionToChat`
- `browser.setProfile`
- `browser.setZoom`
- `browser.setDeviceMode`

outcome:

- oracle/chat agents can drive browser panes.
- browser can become part of ai workflows, not just a manual preview.

### phase 4: layout/workspace fidelity

files:

- `src/components/ResizableGrid.tsx`
- `src/App.tsx`
- new `src/lib/layouts.ts`

outcome:

- resized pane grids persist.
- workspaces can be saved/restored.
- browser-preview layouts become durable.

### phase 5: browser-to-pane workflows

files:

- `src/components/BrowserPane.tsx`
- `src/lib/paneBus.ts`
- `src/App.tsx`
- `src/components/CommandPalette.tsx`

outcome:

- send selection/screenshot/dom context to chosen chat pane.
- open downloads in files/editor/viewer.
- duplicate browser pane.
- split browser beside source pane.

## product details that matter

### browser chrome should become quieter

the pane already has outer chrome. browser toolbar should feel like in-pane tool chrome, not a second app. keep:

- back
- forward
- reload
- url/search
- pin
- screenshot
- send selection
- annotate
- profile
- more menu

move zoom/device/clear cookies into more menu. if title/favicon exists, show title in outer pane header and keep url bar focused on navigation.

### browser should support “preview mode” and “research mode”

same engine, different defaults:

- preview mode:
  - localhost/dev server detection
  - reload prominent
  - screenshot/send-to-chat prominent
  - device mode prominent

- research mode:
  - selection/annotation prominent
  - pin/profile prominent
  - notes/chat routing prominent

don’t create two pane types. create a mode flag in browser pane state.

### reuse active browser intelligently

opening 20 one-off browser panes will make the shell feel messy. default behavior should be:

- if active pane is browser: navigate it.
- if active pane is chat/terminal/editor and no browser exists nearby: open beside.
- if user explicitly asks new browser/new tab: spawn new pane.
- command palette should expose both “open in active browser” and “new browser pane.”

## risks

### native layering will keep biting

any html overlay crossing a native webview is suspect. testing must include:

- command palette over browser
- pane overview over browser
- settings modal over browser
- context menus over browser
- drag from files over browser
- maximize/restore while browser loads
- youtube fullscreen

### profile switching destroys webview

that is correct because wkwebview data store is fixed at creation. but user-facing state should make this clear. switching profile should preserve current url and reload in the new profile.

### clipboard bridge is clever but fragile

annotation currently uses clipboard as ipc. it works, but it can race with user clipboard activity and permissions. longer term, consider a proper custom protocol/message handler if wry/tauri exposes it cleanly for child webviews.

### screenshot coordinates may be off on retina/multi-monitor

`screencapture -R` uses screen coordinates. browser rect comes from css/logical pixels. verify on:

- retina macbook display
- external monitor
- scaled display settings
- app not at origin

## best next step

do not start by redesigning the browser ui. start by making the current browser controllable:

1. add `browserHandles` to `paneBus`.
2. register browser runtime actions from `BrowserPane`.
3. expose browser snapshots in `App.tsx`.
4. add command palette actions scoped to active browser.
5. then wire the same actions into the control plane.

that gives immediate pane-native behavior without destabilizing the wkwebview layer.
