# NOTIFICATIONS-PLAN.md — make the bell actually useful

> Design principle (firaz's verdict, verbatim): *"notifications are no use at
> all except maybe chat running in background — but I should be able to CLICK it
> and go to that chat."*
>
> So the whole system reduces to **one rule**: **every notification is
> actionable and deep-links to its source pane.** If a notification can't deep-link
> to something firaz would act on, it doesn't fire. Everything else is noise and
> gets pruned.

Status: design only. Read-only audit of current code. No source edited.
All file:line refs are against the tree at audit time (2026-06-06). SidebarUsage /
BrowserPane are being edited concurrently — refs into those two are by symbol, not
line.

---

## 1. Audit — what exists today

### 1.1 The store (`src/lib/notifications.ts`)

A clean, already-decent in-memory + `localStorage` store. Key facts:

- `STORAGE_KEY = "aios.notifications"`, cap `MAX_NOTIFICATIONS = 200`
  (notifications.ts:1-2).
- Shape `AiosNotification` (notifications.ts:12-23):
  `{ id, source, sourceId?, sourceLabel?, level, title, body?, actions?, read, at }`.
  - `source: "system"|"pane"|"chat"|"browser"|"monitor"` (notifications.ts:5).
  - `level: "info"|"success"|"warning"|"error"` (notifications.ts:4).
  - `actions?: AiosNotificationAction[]` — `{id,label}` (notifications.ts:7-10).
    **NB: `actions` is in the type but NOTHING reads or renders it. Dead field.**
- API: `pushNotification` (100), `emitPaneNotification` (116),
  `listNotifications` (86), `unreadNotificationCount` (96),
  `markNotificationRead` (141), `markAllNotificationsRead` (145),
  `clearNotification` (149), `clearAllNotifications` (153),
  `subscribeNotifications` (157). Pub/sub via a `Set<Listener>` (32) — App
  re-renders on every push.
- Persistence: `localStorage`, survives reload, cap 200, sorted newest-first.

**The one thing that makes it useless: the only deep-link is `sourceId`, which is
treated as a *pane key*.** The click handler (App.tsx:1720-1725):

```
const openNotificationTarget = useCallback((item: AiosNotification) => {
  markNotificationRead(item.id);
  if (!item.sourceId) return;
  const pane = panes.find((p) => p.key === item.sourceId);   // must already exist
  if (pane) focusPane(pane.key);
}, [panes, focusPane]);
```

So a click only works if a pane with that exact key is **still open**. It cannot:
- reattach a **detached** chat (the pane was closed — no key to find),
- open the **Diagnostics** tab,
- open/reveal a **file**,
- jump to a **terminal** by anything but a stale pane key.

That's why it feels like noise — the killer case (background chat) produces a
notification whose click does *nothing* once the pane is closed.

### 1.2 The Bell + unread count (`src/App.tsx`)

- State: `const [notifications, setNotifications] = useState(listNotifications)`
  (App.tsx:386); live via `useEffect(() => subscribeNotifications(setNotifications), [])`
  (App.tsx:502).
- `unreadNotifications = notifications.filter(n => !n.read).length` (App.tsx:1709).
- Bell button renders in two rails (collapsed + expanded), `onClick={openNotificationsPane}`,
  badge `unreadNotifications > 9 ? "9+" : N` (App.tsx:1983-1995, 2026-2038).
- `openNotificationsPane` (App.tsx:1712-1719): focus existing notifications pane or
  `spawn({type:"notifications"}, "notifications")`.
- Registered as a launchable pane kind `{name:"notifications", label:"alerts", icon: Bell}`
  (App.tsx:2843), rendered as `<NotificationCenter>` (App.tsx:3822-3828).

### 1.3 The panel (`NotificationCenter`, App.tsx:2457-2570ish)

- Header: title + "{n} unread / all caught up", mark-all-read (`CheckCheck`),
  clear-all (`Trash2`) (App.tsx:2475-2499).
- List rows (App.tsx:2507-2560): colored level dot, title, 2-line body,
  footer `sourceLabel · "open pane" · time`. Row click →
  `item.sourceId ? onOpenTarget(item) : onMarkRead(item.id)` (App.tsx:2527).
  Per-row clear X (2552-2559).
- It's a **pane**, not a popover/dropdown off the bell. Functional but heavy —
  firaz has to open a whole pane to see a list, then the click often dead-ends.

### 1.4 What CREATES notifications today (the noise audit)

Only **four** call sites push notifications. Every one is a status echo, none
deep-links usefully:

| # | Site | What it fires | Deep-link? | Verdict |
|---|------|---------------|-----------|---------|
| 1 | `App.tsx:597` (window-hide handler) | "chat running in background" / "chat still running" on cockpit hide | **No** (no `sourceId`) | **KILL** — duplicates the `flash()` toast right above it (App.tsx:592). Pure status echo; not actionable. |
| 2 | `App.tsx:2278` (close-busy-chat modal, "keep running" button) | "chat kept running — you'll get a native alert when it finishes" | **No** (no `sourceId`) | **KILL as a notification** — it's an ack of an action the user *just took*. The real signal (chat *done*) should fire later, with a deep-link. |
| 3 | `BridgesPane.tsx:138` (`showToast`) | Mirrors every in-pane toast (e.g. "connect is a no-op") into a notification | `sourceId:"channels"` (the *literal string*, not a pane key — won't resolve) | **KILL** — these are ephemeral UI toasts; the pane already shows them. Broken deep-link. |
| 4 | `BrowserPane.tsx:534` (`showToast`) | Mirrors every browser toast ("screenshot saved", "couldn't reveal file", etc.) | `sourceId:label` (browser pane key — resolves IF still open) | **KILL the mirror; keep ONE real one** — most browser toasts are noise. Only **download complete** is worth a notification, and it should deep-link to *reveal the file*, not just focus the pane. |

**Net: 100% of what fires today is either a status echo, an action-ack, or a
broken deep-link.** firaz is right — it's noise.

### 1.5 The native (OS) notification — half-built

`chat.rs::notify_done` (chat.rs:2057-2065) fires a real macOS notification when a
**detached** chat's turn ends:

```
.title("✓ chat finished")
.body(format!("{title} — done. click to reopen."))
.show();
```

Armed by `notify_on_done` (chat.rs:131, set in `chat_detach`, chat.rs:2117),
fired in `ingest_line` on the `result` event (chat.rs:1923-1934). The plumbing is
solid. **But:** the body literally says "click to reopen" and **no click action is
wired** — the OS notification is a dead end, and it never creates an in-app
`AiosNotification`, so the bell stays empty. Two disconnected systems.

`tauri_plugin_notification` is registered (lib.rs:202).

### 1.6 Diagnostics / error telemetry (`src/lib/diag.ts` + `src-tauri/src/diag.rs`)

- `reportDiag(source, err, ctx)` (diag.ts:106) — the single sink for ~91 former
  silent catches + the React error boundary + global `window.error` /
  `unhandledrejection` (diag.ts:209-223). Persists `kind:"error"` events to a JSONL
  in app-data via `diag_report`. **Zero UI surfacing** — events only show in the
  Diagnostics tab (Settings.tsx:688 `DiagnosticsSection`, tab id `"diagnostics"`
  Settings.tsx:639/653/1447). So crashes are recorded but firaz never *sees* them
  unless he opens Settings → Diagnostics.
- `reportUsage` (diag.ts:163) — `kind:"usage"`, must NEVER notify.
- `PaneErrorBoundary` has an `onError` hook (PaneErrorBoundary.tsx:16,38) that
  currently feeds `reportDiag` only.

### 1.7 Other signals already in the tree (cheap to wire)

- **Approval / needs-input**: ChatPane control protocol `can_use_tool`
  (ChatPane.tsx:1229-1252) renders an inline approval card. **If the chat is
  hidden/detached, firaz has no idea it's blocked waiting on him.** This is the
  *second* killer case and it's currently invisible.
- **Browser download complete**: backend already emits a `browser-download` event
  (`listen("browser-download")`, BrowserPane.tsx:640) and `revealDownload`
  (BrowserPane.tsx:656) already exists. Trivial to deep-link to reveal.
- **Editor save-conflict** (external file changed under an open editor):
  EditorPane.tsx:69-74 already detects it (`conflict` state, `mtimeRef`), with
  `reloadFromDisk` (196) / overwrite (211). A notification could deep-link to that
  editor pane.
- **Chat process crash/exit**: `chat-exit` event emitted by backend
  (chat.rs:725, 1293). Currently the front-end handles it per-pane; no notification.

### 1.8 The deep-link primitives already exist (`src/lib/paneBus.ts`)

This is the good news — the actionable-target machinery is **already built**, just
not connected to notifications:

- `focusPane(key)` (App.tsx:1055) — focus an open pane.
- `spawn({type:"chat", reattach: <numericSessionId>}, label)` — **reattach a
  detached chat** (App.tsx:1767, 1903; backend `chat_reattach` chat.rs:2141
  replays the buffer and goes live). This is the missing link for the killer case.
- `openFileInPane` / `openEditorFileInPane(path,name,at?)` / `openViewerFileInPane`
  / `revealFileInPane` (paneBus.ts:134-183) — open/reveal a file in-app.
- `spawnPane(kind, ctx)` (paneBus.ts:226) — spawn terminal/files/browser/chat with
  context.
- `openUrlInPane` (paneBus.ts:246).
- Open Settings → Diagnostics: needs a tiny new channel (Settings tab is local
  state inside `Settings.tsx`; see §6.2).

Everything firaz wants to click *to* already has an opener. The notification just
needs to carry **which opener + which argument**, instead of a bare pane key.

---

## 2. The actionable-target model (the core change)

Replace the single `sourceId: string` with a discriminated-union `target` that
names *what to do on click*. `sourceId`/`sourceLabel` stay only for display/grouping
(back-compat), but the click dispatches on `target`.

```ts
// src/lib/notifications.ts — new

export type NotificationTarget =
  // focus an open pane by key (today's behavior; back-compat)
  | { type: "pane"; key: string }
  // reattach (or focus, if still open) a chat by its BACKEND numeric session id.
  // This is the killer case. dispatch: find open pane bound to this id →
  // focusPane; else spawn({type:"chat", reattach: sessionId}).
  | { type: "chat"; sessionId: number; title?: string }
  // open Settings → Diagnostics (optionally pre-filtered to a source tag)
  | { type: "diagnostics"; filterSource?: string }
  // open a file in-app: "editor" (editable) | "viewer" (preview) | "reveal" (Finder)
  | { type: "file"; path: string; name?: string; mode?: "editor" | "viewer" | "reveal"; at?: { line?: number; col?: number } }
  // open a terminal pane by key (alias of pane, but semantically a terminal)
  | { type: "terminal"; key: string }
  // open a url in an in-app browser pane
  | { type: "url"; url: string; label?: string };

export interface AiosNotification {
  id: string;
  kind: NotificationKind;        // see taxonomy §3 — replaces the vague `source`
  title: string;
  body?: string;
  ts: number;                    // was `at`; keep `at` as alias one release for safety
  read: boolean;
  level: NotificationLevel;
  priority?: "normal" | "high";  // "high" → also fires a transient toast + native OS notif
  target?: NotificationTarget;   // THE deep-link. no target = informational only (rare)
  sourceLabel?: string;          // display only (e.g. "chat", "browser", "diagnostics")
}
```

The firaz-requested shape `{ id, kind, title, body, ts, read, target }` maps 1:1;
`level`/`priority`/`sourceLabel` are additive metadata.

### 2.1 Click dispatch (replaces App.tsx:1720-1725)

```ts
const openNotificationTarget = useCallback((item: AiosNotification) => {
  markNotificationRead(item.id);
  const t = item.target;
  if (!t) return;
  switch (t.type) {
    case "pane":
    case "terminal": {
      const pane = panes.find((p) => p.key === t.key);
      if (pane) focusPane(pane.key);
      break;
    }
    case "chat": {
      // already open? focus it. else reattach the backend session.
      const open = panes.find(
        (p) => p.kind.type === "chat" && chatPaneBoundToSession(p, t.sessionId),
      );
      if (open) focusPane(open.key);
      else spawn({ type: "chat", reattach: t.sessionId }, t.title ?? "chat");
      break;
    }
    case "diagnostics":
      openSettingsTo("diagnostics");          // §6.2 new channel
      break;
    case "file":
      if (t.mode === "reveal") revealFileInPane(t.path, t.name ?? t.path);
      else if (t.mode === "viewer") openViewerFileInPane(t.path, t.name ?? t.path);
      else openEditorFileInPane(t.path, t.name ?? t.path, t.at);
      break;
    case "url":
      openUrlInPane(t.url, t.label);
      break;
  }
}, [panes, focusPane, spawn]);
```

`chatPaneBoundToSession` (small helper): a chat pane is "bound" to a backend
session id when its `kind.reattach === id` OR a live registry maps its pane key →
session id. Cleanest: have ChatPane register `paneKey → backendSessionId` in a tiny
map in `paneBus.ts` (mirrors `chatHandles`), set when `sessionIdRef.current` is
known (ChatPane.tsx:1521). Then both close-interception and notification click can
resolve a chat by backend id. (Cheap; see §7.)

---

## 3. Notification taxonomy — keep / kill

### KILL (prune — none of these deserve to interrupt firaz)

| Source | Why it's noise | Action |
|--------|----------------|--------|
| App.tsx:597 "chat running in background" | duplicate of the `flash()` toast on the same hide; no target | delete the `pushNotification` call (keep `flash`) |
| App.tsx:2278 "chat kept running" | ack of an action firaz just clicked | delete (the real signal is "done", fired later w/ target) |
| BridgesPane.tsx:138 toast-mirror | ephemeral UI toast; broken `sourceId:"channels"` | stop mirroring to notifications; keep the local toast |
| BrowserPane.tsx:534 toast-mirror (all but download) | "screenshot saved", "couldn't reveal", etc. — pane already shows them | stop mirroring; keep local toast. Wire ONE real one for downloads (see keep) |
| any `kind:"usage"` diag | not user-relevant | never notify (already true) |
| silent `.catch` diags that are polling-loop / backend-down spam | dedupe already collapses them; not actionable | never auto-notify error diags wholesale — only the specific kinds in "keep" |

### KEEP / ADD (each MUST deep-link)

| kind | Fires when | priority | target | Killer? |
|------|-----------|----------|--------|---------|
| `chat.done` | a **detached/background** chat's turn completes (`result` while detached) | high | `{type:"chat", sessionId}` → reattach | **YES (firaz's #1)** |
| `chat.needs_input` | a **hidden/detached** chat hits `can_use_tool` (approval) and is blocked on the user | high | `{type:"chat", sessionId}` → reattach + focus the approval card | **YES (#2)** |
| `chat.crashed` | `chat-exit` for a session that wasn't user-stopped | normal | `{type:"chat", sessionId}` (reattach to show the error) or `{type:"diagnostics"}` | — |
| `error.pane_crash` | `PaneErrorBoundary.onError` fires (a pane white-screened) | high | `{type:"diagnostics", filterSource:"react.*"}` | — |
| `error.tool_failed` | a *user-relevant* failure: a command/tool the user invoked errored (curated allowlist of diag sources, NOT all) | normal | `{type:"diagnostics", filterSource}` or `{type:"pane", key}` | — |
| `task.terminal_done` | a long-running terminal/agent command finishes (opt-in marker, see §7) | normal | `{type:"terminal", key}` | — |
| `download.complete` | `browser-download` event | normal | `{type:"file", path, mode:"reveal"}` | — |
| `editor.conflict` | external change detected under an open editor (EditorPane conflict) | normal | `{type:"file", path, mode:"editor"}` → focus that editor | — |

**Guardrail:** errors only notify for the *curated* set above. The default for a
`reportDiag` error is **silent** (status quo). We add an explicit `notify: true`
opt-in on the specific call sites that are user-relevant (pane crash, an
invoked-tool failure), so we never regress into "notify on every catch".

---

## 4. Surfacing — tasteful, not a wall

Three tiers, by priority:

1. **Bell + badge (always).** Unchanged location (App.tsx:1983/2026). Badge =
   unread count. This is the durable inbox.
2. **Panel — convert from a full pane to a popover off the bell (nice-to-have,
   phase 2).** Phase 1 keeps the existing `NotificationCenter` pane; only the
   *click behavior* and *what fires* change. A bell-anchored dropdown is a later
   polish so firaz doesn't have to open a pane to triage. The rows get an explicit
   action verb derived from `target.type` ("reopen chat", "reveal file", "open
   diagnostics", "go to terminal") instead of the generic "open pane".
3. **Transient toast for `priority:"high"` only.** `chat.needs_input` and
   `chat.done` (when the window is focused) pop a small auto-dismiss toast in the
   corner with the same click action — so firaz sees the killer cases immediately
   without opening the bell. Reuse the existing `flash()` mechanism's slot or a
   minimal toast host. When the window is **hidden/unfocused**, fire the **native
   OS notification** instead (so it shows on the desktop) — and finally wire its
   **click** (see §5).

### 4.1 Unread-count semantics

- Unread = `notifications.filter(n => !n.read)` (unchanged).
- Clicking a notification marks it read (already true).
- `chat.done`/`download.complete` auto-clear (mark read) once the target is
  opened. `chat.needs_input` should **not** auto-clear on mere bell-open — only
  when the chat is actually reattached/focused (it's still blocking).
- De-dupe: at most one live `chat.needs_input` per `sessionId` (replace, don't
  stack). Same for `chat.done` per session. Prevents a chatty agent from spamming.

---

## 5. Native OS notification — close the loop (chat.rs)

Today `notify_done` (chat.rs:2057) shows a dead notification. Two fixes:

1. **Emit an in-app event so the bell + toast also fire**, not just the OS toast.
   In `notify_done` (and a new `notify_needs_input`), also
   `app.emit("aios-notify", payload)` where payload carries
   `{ kind, sessionId, title }`. App.tsx already `listen`s for app events; add a
   `listen("aios-notify", ...)` that calls `pushNotification` with the right
   `target`. This unifies the two systems — one event, surfaced in-app AND on the
   OS.
2. **Wire the OS-notification click.** `tauri-plugin-notification` supports action
   handling; on click, focus/show the window and emit the same `aios-notify` (or a
   dedicated `aios-notify-open`) so the front-end runs `openNotificationTarget`.
   The body text "click to reopen" finally becomes true. (Needs the plugin's
   click/activation callback wired in lib.rs alongside the existing
   `tauri_plugin_notification::init()` at lib.rs:202.)

`notify_needs_input` is new but trivial — same shape as `notify_done`, fired from
`ingest_line` when a `control_request`/`can_use_tool` is seen while
`detached` (mirror the detection ChatPane does at ChatPane.tsx:1231, but on the
Rust side, or simpler: let the front-end ChatPane fire the in-app notification
directly when it receives `can_use_tool` AND the pane is currently hidden — no Rust
change needed for phase 1; see §7 "easy").

---

## 6. Where the deep-links land

### 6.1 Chat (the killer): already solved by reattach

- `chat.done` / `chat.needs_input` carry `{type:"chat", sessionId}`.
- Click → if a chat pane is bound to that id, `focusPane`; else
  `spawn({type:"chat", reattach: sessionId}, title)` (App.tsx:1767 pattern;
  backend `chat_reattach` chat.rs:2141 replays buffer + goes live). firaz lands
  back in the exact chat, scrolled to where it finished / the approval card.

### 6.2 Diagnostics: one small new channel

`Settings` owns its active tab as local state (Settings.tsx:639/1447). Add a
paneBus-style channel `openSettingsTo(section)` (mirror `registerOpenFile`): App
registers a setter that opens the Settings overlay/pane and sets its section to
`"diagnostics"`. The `{type:"diagnostics", filterSource?}` target calls it. Small,
self-contained.

### 6.3 Files / downloads / editor-conflict: already solved by paneBus

- download → `{type:"file", path, mode:"reveal"}` → `revealFileInPane`
  (paneBus.ts:179). Wire at the `browser-download` listener (BrowserPane.tsx:640):
  on event, `pushNotification({kind:"download.complete", target:{type:"file", path,
  mode:"reveal"}, ...})`.
- editor conflict → `{type:"file", path, mode:"editor", at}` → `openEditorFileInPane`.
  Wire where EditorPane sets `conflict=true` (EditorPane.tsx:~150).

### 6.4 Terminal task done

`{type:"terminal", key}` → `focusPane(key)`. Needs a "this command finished" signal
(see §7 "needs plumbing").

---

## 7. Build plan (phased) + easy-vs-plumbing honesty

### Phase 1 — the killer case + prune the noise (highest value, mostly easy)

1. **Add `target` to the store** (notifications.ts): add `NotificationTarget`
   union + `kind`/`priority`/`ts` fields; keep `sourceId`→`{type:"pane",key}`
   shim in `sanitize` so persisted old items still click. Update `notifications.test.ts`
   for the new shape. — *Easy.*
2. **Rewrite the click dispatch** (App.tsx:1720-1725) to switch on `target` (§2.1).
   — *Easy* (all openers already exist except diagnostics).
3. **Prune**: delete the 4 noise call sites (App.tsx:597, App.tsx:2278,
   BridgesPane.tsx:138 mirror, BrowserPane.tsx:534 mirror). — *Easy / deletions.*
4. **chat.done → clickable.** Unify the native + in-app path: `notify_done`
   (chat.rs:2057) also `app.emit("aios-notify", {kind:"chat.done", sessionId,
   title})`; App `listen("aios-notify")` → `pushNotification` with
   `target:{type:"chat", sessionId}`. Click reattaches. — *Easy front-end; small
   Rust emit.* The session id is in scope at the fire site (it's the session whose
   `ingest_line` is running — thread it in).
5. **chat.needs_input → clickable + toast.** Front-end-only path: in ChatPane's
   `can_use_tool` handler (ChatPane.tsx:1231), if the pane is hidden/detached, fire
   `pushNotification({kind:"chat.needs_input", priority:"high",
   target:{type:"chat", sessionId: backendId}})`. Needs the pane→backend-id map
   (§2.1 helper). — *Easy once the id map exists.*
6. **chat pane ↔ backend-session-id registry** in paneBus.ts (mirror `chatHandles`):
   `chatSessions = new Map<paneKey, number>()`, set from ChatPane.tsx:1521. Lets
   both close-interception and notif-click resolve a chat by backend id. — *Easy.*

Phase-1 outcome: firaz's exact ask — background chat done **and** blocked-on-input
both notify, and clicking lands him in that chat. Everything else stops firing.

### Phase 2 — errors, downloads, conflicts, terminal tasks (medium)

7. **download.complete** → reveal (BrowserPane.tsx:640 listener). — *Easy.*
8. **editor.conflict** → open that editor (EditorPane conflict path). — *Easy.*
9. **error.pane_crash** → `PaneErrorBoundary.onError` (PaneErrorBoundary.tsx:38)
   also `pushNotification({kind:"error.pane_crash", priority:"high",
   target:{type:"diagnostics"}})`. — *Easy; needs the `openSettingsTo` channel
   (§6.2).*
10. **openSettingsTo("diagnostics")** channel (paneBus + Settings wiring). —
    *Small new plumbing.*
11. **error.tool_failed** — curate a small allowlist of `reportDiag` sources that
    are user-invoked + user-relevant (e.g. a command the user ran failed), gate
    behind an explicit `notify:true` ctx flag so the default stays silent. —
    *Medium (judgment call on which sources qualify; do NOT auto-notify all).* 
12. **Native OS notification click** wired through the plugin (lib.rs:202) so the
    desktop toast is clickable when the window is hidden. — *Medium — needs the
    plugin's activation callback + window-show + event emit.*

### Phase 3 — polish (optional)

13. Convert the panel from a full pane to a **bell-anchored popover** with explicit
    per-row action verbs derived from `target.type`. — *Medium UI work.*
14. **task.terminal_done**: a "notify when this finishes" affordance on a terminal
    command. — *Needs real new plumbing* (PTY has no concept of "command N exited";
    would need shell integration / prompt-marker parsing or an explicit user "ping
    me when done" wrapper). Lowest ROI; defer.

### Easy vs needs-plumbing — honest summary

- **Easy (openers already exist):** chat reattach, file reveal/open, url open,
  pane focus, prune the noise, the store change. This covers the entire killer
  case + most of phase 2.
- **Small new plumbing:** `aios-notify` event bridge (Rust emit + App listen),
  pane↔session-id map, `openSettingsTo` channel.
- **Real plumbing / lowest ROI:** native OS-notification click activation;
  terminal-command-done detection. Defer both; phase 1+2 deliver firaz's actual
  ask without them.

---

## 8. File:line index (everything this plan touches)

- Store: `src/lib/notifications.ts` (shape :12-23, click-relevant `actions`
  dead-field :7-10/20, store API :86-160).
- Bell + count + click: `src/App.tsx` :386, :502, :1709, :1712-1719 (open),
  **:1720-1725 (click — rewrite)**, :1983-1995 / :2026-2038 (bell), :2843 (pane
  reg), :3822-3828 (render).
- Panel: `src/App.tsx` `NotificationCenter` :2457-2570ish.
- Noise to kill: `src/App.tsx` :597, :2278; `BridgesPane.tsx` :138;
  `BrowserPane.tsx` :534.
- Killer-case backend: `src-tauri/src/chat.rs` `notify_done` :2056-2065,
  arm `notify_on_done` :131 / :2117, fire :1923-1934 (`ingest_line`),
  `chat_detach` :2113, `chat_reattach` :2141, `list_chat_live` :2192,
  `chat-exit` :725/:1293.
- Reattach spawn pattern: `src/App.tsx` :1767, :1899-1924.
- Needs-input source: `src/components/ChatPane.tsx` `can_use_tool` :1229-1252;
  backend session id `sessionIdRef` :901/:1521.
- Deep-link openers: `src/lib/paneBus.ts` `focusPane` (App :1055),
  `openFileInPane` :134, `openEditorFileInPane` :167, `openViewerFileInPane` :173,
  `revealFileInPane` :179, `spawnPane` :226, `openUrlInPane` :246, `chatHandles`
  :25 (model for the new session-id map).
- Errors: `src/lib/diag.ts` `reportDiag` :106, global handlers :209-223;
  `src/components/PaneErrorBoundary.tsx` `onError` :16/:38; Diagnostics UI
  `src/components/Settings.tsx` :639/:653/:688/:1447.
- Download: `src/components/BrowserPane.tsx` `browser-download` listen :640,
  `revealDownload` :656.
- Editor conflict: `src/components/EditorPane.tsx` conflict state :69-74,
  `reloadFromDisk` :196, overwrite :211.
- Native plugin reg: `src-tauri/src/lib.rs` :202.
