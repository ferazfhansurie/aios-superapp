# Implementation Plan — Customizable, Pinnable, Reorderable Sidebar

**Repo:** `/Users/firazfhansurie/Repo/firaz/aios/shell` (the AIOS cockpit shell)
**Stack:** Tauri 2 + React 19 + Vite 7 + Tailwind 4 + TypeScript. pnpm.
**Audience:** an AI engineer implementing this end-to-end. Read this whole doc before writing code.

---

## 1. Goal (what we're building)

Turn the static left sidebar into a **user-personalizable rail**:

1. **Pin anything** to the sidebar — including a specific website (e.g. `youtube.com`) that opens in our existing embedded browser as a pinned tab with a custom label + icon.
2. **Drag to reorder** sidebar items; order **persists** across app restarts.
3. **Pin/unpin** the built-in apps too (chat, terminal, files, browser, database, etc.) and hide ones the user doesn't want.
4. Everything saved locally (no backend) and restored on launch.

Non-goals: building a YouTube player (we use the embedded browser pointed at youtube.com — full account/premium via the user's own Google login persists in the webview session). No cloud sync in v1.

---

## 2. Current state — exactly what exists today

### Sidebar render
`src/App.tsx` (~852 lines). The sidebar is hardcoded:

- **Line 99–109:** the app catalog —
  ```ts
  export type AppDef = { kind: PaneContent; icon: typeof Folder; label: string };
  const SPAWN: AppDef[] = [
    { kind: { type: "chat" }, icon: MessageSquare, label: "chat" },
    { kind: { type: "shell" }, icon: TerminalSquare, label: "terminal" },
    { kind: { type: "shell", cmd: "claude --dangerously-skip-permissions" }, icon: Bot, label: "claude code" },
    { kind: { type: "files" }, icon: Folder, label: "files" },
    { kind: { type: "browser" }, icon: Globe, label: "browser" },
    { kind: { type: "memory" }, icon: Database, label: "database" },
    { kind: { type: "automations" }, icon: Clock, label: "automations" },
    { kind: { type: "customers" }, icon: MessageCircle, label: "contacts" },
    { kind: { type: "motion" }, icon: Wand2, label: "studio" },
  ];
  ```
- **Lines 522–543:** the `<aside>` rail. It renders `SPAWN` split into two static groups ("sessions" = chat/terminal, "tools" = everything else) via `<NavRow icon label onClick={() => spawn(s.kind, s.label)} />`, then `<OracleRoster/>`, then a footer with settings + account.
- **`NavRow`** component is defined lower in the same file (~line 658). Simple icon+label button.
- **`spawn(kind, label)`** — `src/App.tsx:141` — appends a pane: `setPanes(p => [...p, { key: nextKey(), kind, label }])`.

### Pane model
`src/App.tsx:55–72`:
```ts
type PaneContent = PaneKind | { type: "files" } | { type: "browser" } | { type: "memory" } | ... ;
interface Pane { key: string; label: string; kind: PaneContent; }
```
`PaneKind` (terminal-backed kinds) is imported from `./components/TerminalPane`.

### Embedded browser (already built — reuse, don't rebuild)
- `src/components/BrowserPane.tsx` — renders a browser pane backed by a **native Tauri child webview** (paints above the HTML layer), with its own toolbar.
- `src/lib/browser.ts` — IPC wrappers: `browserShow(label, url, rect)`, `browserNavigate`, `browserSetBounds`, `browserBack/Forward/Reload`, `browserHide`, `browserClose`, `browserScreenshot`, plus annotate-mode helpers.
- Rust side: `src-tauri/src/` implements the `browser_*` commands. The webview is addressed by a per-pane `label`. Sessions/cookies persist (Google login sticks → real YouTube account + premium).
- **Important constraint already noted in `App.tsx:124`:** native webviews paint ABOVE the HTML, so overlays/modals need care. The sidebar rail is to the *left* of the main pane area so it's fine, but **never render a live webview inside a sidebar item** (use a static icon/favicon, not a mini-webview).

### Persistence pattern to mirror
`src/lib/settings.ts` — the canonical local store pattern in this codebase:
- single localStorage key (`"aios.settings"`), JSON, merged over defaults (forward-compatible).
- `loadSettings()`, `saveSettings(partial)`, `getSetting(key)`, `subscribe(fn)` pub/sub.
- **Copy this exact shape** for the new sidebar store. Do NOT pull in zustand/redux.

### What's missing
- No drag-and-drop library installed (check `package.json` — no `@dnd-kit`, no `react-dnd`).
- The browser pane currently opens to a default URL; confirm whether `spawn({type:"browser"})` accepts an initial URL (see Task 3).

---

## 3. Data model (new)

Create `src/lib/sidebar.ts` mirroring `settings.ts` (localStorage key `"aios.sidebar"`).

```ts
export type SidebarItemKind =
  | { type: "app"; appId: string }                 // references a built-in SPAWN entry by stable id
  | { type: "link"; url: string };                 // pinned website → embedded browser

export interface SidebarItem {
  id: string;            // stable uuid (crypto.randomUUID())
  label: string;         // user-editable display label
  iconName: string;      // lucide icon name OR "favicon" for links
  faviconUrl?: string;   // for link items: cached favicon (https://www.google.com/s2/favicons?domain=...&sz=64)
  kind: SidebarItemKind;
  group: "sessions" | "tools" | "pinned"; // which section it lives in
  hidden?: boolean;      // user hid a default app
}

export interface SidebarState {
  items: SidebarItem[];  // ORDER in this array == render order
  version: number;       // schema version for migrations
}
```

**Seeding:** on first load (no stored state), build `items` from the existing `SPAWN` array so the default sidebar is identical to today. Give each built-in a **stable `appId`** (add an `id` field to `AppDef`, e.g. `"chat"`, `"terminal"`, `"claude-code"`, `"files"`, `"browser"`, `"database"`, `"automations"`, `"contacts"`, `"studio"`). Lookup at render time maps `appId → { kind, icon }`.

Store API (same shape as settings.ts):
- `loadSidebar(): SidebarState`
- `saveSidebar(next: SidebarState): void`
- `reorder(fromIndex, toIndex)`, `addLink(url, label?)`, `removeItem(id)`, `renameItem(id, label)`, `toggleHidden(id)`, `setGroup(id, group)`
- `subscribe(fn)` pub/sub so the rail re-renders on change.

---

## 4. Tasks (in order)

### Task 1 — Add the sidebar store
- Create `src/lib/sidebar.ts` per §3. Copy the load/save/subscribe scaffolding from `src/lib/settings.ts` verbatim, swap the key + types.
- Add a `SPAWN_BY_ID: Record<string, AppDef>` map and give each `AppDef` a stable `id`. Export `SPAWN` + the map from a small module (e.g. move `SPAWN` into `src/lib/apps.ts`) so both `App.tsx` and `sidebar.ts` import it without a cycle.
- Unit-free check: `loadSidebar()` on a fresh localStorage returns the seeded default that matches today's order.

### Task 2 — Render the sidebar from the store
- In `src/App.tsx`, replace the hardcoded `SPAWN.filter(...)` blocks (lines 526–536) with a render over `loadSidebar().items`, grouped by `item.group`, skipping `hidden`.
- Each item resolves to a click handler:
  - `kind.type === "app"` → `spawn(SPAWN_BY_ID[appId].kind, item.label)`
  - `kind.type === "link"` → `spawn({ type: "browser", url: kind.url }, item.label)` (see Task 3)
- Subscribe to the store at the top of `App` (`useState` + `useEffect(() => subscribe(setSidebar), [])`) so reorders/pins re-render live.
- Keep `OracleRoster`, settings, and `AccountMenu` exactly where they are (footer/roster are not part of the reorderable list in v1).

### Task 3 — Pinnable website → embedded browser tab
- Confirm the browser pane accepts an initial URL. If `PaneContent`'s browser variant is bare `{ type: "browser" }`, **extend it** to `{ type: "browser"; url?: string }` and thread `url` into `BrowserPane` (it should call `browserShow(label, url ?? defaultUrl, rect)` / `browserNavigate`). Edit `src/components/BrowserPane.tsx` + the `PaneContent` union in `App.tsx:55`.
- "Pin current site" affordance: in `BrowserPane`'s toolbar add a **pin button** that calls `addLink(currentUrl, pageTitle)` → adds a `link` item to the sidebar (`group: "pinned"`), fetching favicon via `https://www.google.com/s2/favicons?domain=<host>&sz=64`.
- Also add a generic **"+ Pin a site"** entry at the bottom of the pinned group that prompts for a URL (use `CommandPalette` style input or a small inline form) and calls `addLink`.

### Task 4 — Drag to reorder (persisted)
Two acceptable approaches — **prefer A**:

**A. `@dnd-kit` (recommended, best UX):**
- `pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`.
- Wrap the rail's item list in `<DndContext onDragEnd>` + `<SortableContext items={ids} strategy={verticalListSortingStrategy}>`. Make `NavRow` (or a wrapper) a `useSortable` item with a drag handle (whole row draggable is fine; add a subtle grip on hover).
- On `onDragEnd`, compute new order with `arrayMove`, call `reorder(from, to)` → `saveSidebar`. Store persists automatically.
- Allow dragging *between* groups (sessions/tools/pinned) by treating all visible items as one sortable list but tagging group boundaries; OR keep three independent SortableContexts (simpler v1 — reorder within a group only). **Ship within-group reorder first**, cross-group as a stretch.

**B. Native HTML5 DnD (zero deps):** `draggable`, `onDragStart/Over/Drop` on `NavRow`, reorder array, persist. Works but jankier; only if avoiding deps is a hard requirement.

- **Gotcha:** the main pane area may host a native webview (paints above HTML). The sidebar `<aside>` is a sibling to the left and is pure HTML, so drag ghosts render fine — but verify the drag preview isn't clipped by the webview when dragging near the right edge. Keep drag inside the rail.

### Task 5 — Manage/edit affordances
- Right-click (or a `⋯` hover button) on a sidebar item → context menu: **Rename**, **Hide / Unhide**, **Unpin/Remove** (links only), **Move to group**.
- A small "edit sidebar" toggle in Settings (`src/components/Settings.tsx`) that reveals hidden defaults so they can be re-added. Settings already uses the localStorage store pattern — add a "Sidebar" section there listing all items with show/hide checkboxes + a reset-to-default button (`resetSidebar()`).

### Task 6 — Polish
- Favicon caching: store the resolved favicon URL on the item so we don't refetch each render; lazy-load with a fallback lucide `Globe` icon on error.
- Animations respect `reduceMotion` setting (`getSetting("reduceMotion")`) — disable drag spring/transition when true.
- Empty "pinned" group shows a subtle "+ Pin a site" placeholder.

---

## 5. Files to touch (summary)

| File | Change |
|---|---|
| `src/lib/sidebar.ts` | **NEW** — store (mirror settings.ts), data model, mutators |
| `src/lib/apps.ts` | **NEW** — move `SPAWN` here, add stable `id` per app, export `SPAWN_BY_ID` |
| `src/App.tsx` | Render rail from store (lines ~522–543); subscribe; extend `PaneContent` browser variant with `url`; remove hardcoded SPAWN groups |
| `src/components/BrowserPane.tsx` | Accept initial `url`; add toolbar "pin current site" button |
| `src/components/Settings.tsx` | Add "Sidebar" section (show/hide, reset) |
| `src/components/NavRow` (in App.tsx, or extract) | Make sortable (dnd-kit handle), add hover `⋯` menu |
| `package.json` | `+ @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities` |

---

## 6. Acceptance criteria

- [ ] Default sidebar on a fresh profile looks identical to today (same items, same two groups).
- [ ] User can drag a sidebar item to a new position; after **quit + relaunch**, the new order persists.
- [ ] User can open the browser, go to `youtube.com`, click **pin** → a YouTube item with a YouTube favicon appears in the "pinned" group. Clicking it opens an embedded browser pane already at youtube.com, logged into the user's Google account (session persists → no ads if they have Premium).
- [ ] User can rename a pinned item, hide a default app, and unpin a site; all persist.
- [ ] "Reset sidebar" in Settings restores defaults.
- [ ] No regressions: `OracleRoster`, settings, account menu, command palette (⌘K), ⌘B toggle still work.
- [ ] `pnpm build` (tsc + vite) passes clean.

---

## 7. Gotchas / constraints (read these)

1. **Native webview layering** (`App.tsx:124`): never embed a live webview inside a sidebar row; use a static favicon. Modals/drag-ghosts that overlap the main pane's webview can be occluded — keep drag interactions inside the `<aside>`.
2. **No cycle:** `sidebar.ts` needs the app catalog; `App.tsx` needs the store. Break the cycle by putting `SPAWN`/`SPAWN_BY_ID` in `src/lib/apps.ts` (icons are lucide components — fine to import in a lib file).
3. **Stable ids over labels:** persistence references apps by `appId`, not by `label` (labels are user-editable). Renaming must not break the link to the underlying `kind`.
4. **Forward-compatible storage:** merge stored state over a freshly-seeded default and bump `version` for migrations, exactly like `settings.ts` merges over `DEFAULT_SETTINGS`.
5. **Favicon source:** `https://www.google.com/s2/favicons?domain=<host>&sz=64` is simplest; fall back to lucide `Globe` on load error.
6. **Browser session = real login:** we do NOT use YouTube OAuth/Data API for playback. The embedded webview holds the user's actual Google session; that's what unlocks their account + Premium. The sidebar just deep-links into it.

---

## 8. Suggested commit sequence

1. `feat(sidebar): extract app catalog to lib/apps.ts with stable ids`
2. `feat(sidebar): add localStorage sidebar store (lib/sidebar.ts)`
3. `feat(sidebar): render rail from store + live subscribe`
4. `feat(browser): accept initial url + pin-current-site button`
5. `feat(sidebar): drag-to-reorder via dnd-kit, persisted`
6. `feat(sidebar): rename/hide/unpin context menu + Settings section`
7. `chore: polish — favicon cache, reduceMotion, empty-state`
