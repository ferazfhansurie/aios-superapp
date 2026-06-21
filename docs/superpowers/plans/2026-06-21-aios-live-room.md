# AIOS Live Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first shippable AIOS live room pane: a hybrid Google Meet / OBS-style capture surface with meeting/content/mirror modes, source preview, markers, snapshots, durable manifests, and a native recording spike that saves separate screen + mic tracks.

**Architecture:** Start with pure TypeScript state and manifest helpers so pane integration is testable without touching native capture. Add a new `live-room` pane that wraps the existing ScreenCaptureKit `appcast` preview path instead of replacing it. Native work extends the current Tauri backend with live-room storage and recording commands, while v1 keeps mp4 export best-effort and post-capture AI disabled/stubbed.

**Tech Stack:** React 19, TypeScript, Tauri v2, Rust, ScreenCaptureKit/AppKit via existing `appcast.rs`, AVFoundation/CoreAudio for mic track spike, optional `ffmpeg`, Node test runner, Cargo tests/checks.

---

## File Structure

- Create `src/lib/liveRoom.ts`: pure state model, mode definitions, status transitions, manifest schema, path helpers, and UI copy helpers.
- Create `src/lib/liveRoom.test.ts`: unit tests for mode availability, default/last-used restore, state transitions, markers, manifest validation, and export fallback labels.
- Create `src/lib/liveRoomApi.ts`: typed Tauri invoke wrappers for native live-room commands.
- Create `src/components/LiveRoomPane.tsx`: meet-style live room pane UI, mode switch, source picker, preview slot, controls, right rail, markers/snapshots surface.
- Modify `src/components/AppCastPane.tsx`: extract reusable picker/preview primitives only if needed; do not regress standalone appcast.
- Modify `src/lib/apps.ts`: add `{ type: "live-room"; mode?: LiveRoomMode; sessionId?: string }` to `PaneContent` and add a SPAWN entry.
- Modify `src/lib/paneLayout.ts` and `src/lib/paneLayout.test.ts`: include `live-room` as a core pane.
- Modify `src/lib/paneHistory.ts` and `src/lib/paneHistory.test.ts`: describe and dedupe live room panes/sessions.
- Modify `src/lib/sidebar.ts` tests only if default sidebar expectations need updating.
- Modify `src/App.tsx`: lazy/import/render `LiveRoomPane`, wire pane updates for mode/session source, and preserve existing pane behavior.
- Modify `src/App.css`: live room layout styling, responsive control dock, right rail, status/permission states.
- Create `src-tauri/src/live_room.rs`: manifest/index storage, session folder creation, marker/snapshot metadata, recording state API, optional export command.
- Modify `src-tauri/src/lib.rs`: `mod live_room`, manage state, register commands.
- Modify `src-tauri/capabilities/default.json`: allow new live-room commands if capabilities list is explicit.
- Modify `src-tauri/Cargo.toml`: add AVFoundation/CoreAudio bindings only when implementing the native mic recorder task.
- Create/extend Rust tests if the repo has suitable test harnesses for pure storage helpers; otherwise keep storage helpers small and test through commands/manual checklist.

## Task 1: Pure Live Room State Model

**Files:**
- Create: `src/lib/liveRoom.ts`
- Create: `src/lib/liveRoom.test.ts`
- Modify: `package.json` test script only if needed to include the new test file

- [ ] **Step 1: Write failing tests for mode availability and defaults**

```ts
// src/lib/liveRoom.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_ROOM_MODES,
  defaultLiveRoomMode,
  isLiveRoomModeEnabled,
  restoreLiveRoomMode,
} from "./liveRoom.ts";

test("live room v1 enables meeting content and mirror only", () => {
  assert.deepEqual(LIVE_ROOM_MODES.map((m) => m.id), ["meeting", "content", "mirror", "control", "annotate", "observe"]);
  assert.equal(isLiveRoomModeEnabled("meeting"), true);
  assert.equal(isLiveRoomModeEnabled("content"), true);
  assert.equal(isLiveRoomModeEnabled("mirror"), true);
  assert.equal(isLiveRoomModeEnabled("control"), false);
  assert.equal(isLiveRoomModeEnabled("annotate"), false);
  assert.equal(isLiveRoomModeEnabled("observe"), false);
});

test("live room defaults to meeting and restores valid last-used modes", () => {
  assert.equal(defaultLiveRoomMode(), "meeting");
  assert.equal(restoreLiveRoomMode("content"), "content");
  assert.equal(restoreLiveRoomMode("observe"), "meeting");
  assert.equal(restoreLiveRoomMode("wat" as never), "meeting");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/lib/liveRoom.test.ts`

Expected: fail because `src/lib/liveRoom.ts` does not exist.

- [ ] **Step 3: Implement mode model**

```ts
// src/lib/liveRoom.ts
export type LiveRoomMode = "meeting" | "content" | "mirror" | "control" | "annotate" | "observe";

export interface LiveRoomModeDef {
  id: LiveRoomMode;
  label: string;
  enabled: boolean;
  disabledReason?: string;
}

export const LIVE_ROOM_MODES: LiveRoomModeDef[] = [
  { id: "meeting", label: "meeting", enabled: true },
  { id: "content", label: "content", enabled: true },
  { id: "mirror", label: "mirror", enabled: true },
  { id: "control", label: "control", enabled: false, disabledReason: "future slice: accessibility input forwarding" },
  { id: "annotate", label: "annotate", enabled: false, disabledReason: "future slice: annotation tools" },
  { id: "observe", label: "observe", enabled: false, disabledReason: "future slice: agent observers" },
];

const ENABLED = new Set(LIVE_ROOM_MODES.filter((m) => m.enabled).map((m) => m.id));

export function defaultLiveRoomMode(): LiveRoomMode {
  return "meeting";
}

export function isLiveRoomMode(value: unknown): value is LiveRoomMode {
  return typeof value === "string" && LIVE_ROOM_MODES.some((m) => m.id === value);
}

export function isLiveRoomModeEnabled(value: unknown): value is LiveRoomMode {
  return isLiveRoomMode(value) && ENABLED.has(value);
}

export function restoreLiveRoomMode(value: unknown): LiveRoomMode {
  return isLiveRoomModeEnabled(value) ? value : defaultLiveRoomMode();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/lib/liveRoom.test.ts`

Expected: pass.

- [ ] **Step 5: Add state transition and marker tests**

```ts
import {
  addLiveRoomMarker,
  canTransitionLiveRoomStatus,
  createLiveRoomDraft,
  liveRoomPermissionSummary,
} from "./liveRoom.ts";

test("live room status transitions protect saved partial output", () => {
  assert.equal(canTransitionLiveRoomStatus("idle", "preview"), true);
  assert.equal(canTransitionLiveRoomStatus("recording", "saving"), true);
  assert.equal(canTransitionLiveRoomStatus("recording", "partial"), true);
  assert.equal(canTransitionLiveRoomStatus("saved", "failed"), false);
  assert.equal(canTransitionLiveRoomStatus("partial", "idle"), false);
});

test("markers are timestamped and sorted", () => {
  const draft = createLiveRoomDraft({ id: "lr-1", mode: "meeting", now: 1000 });
  const next = addLiveRoomMarker(draft, { label: "decision", atMs: 2500 });
  assert.deepEqual(next.markers, [{ id: "m-0001", label: "decision", atMs: 2500 }]);
});

test("permission summary separates required and optional sources", () => {
  assert.deepEqual(
    liveRoomPermissionSummary({ screen: "granted", mic: "missing", camera: "missing" }),
    {
      canPreview: true,
      canRecord: false,
      requiredMissing: ["mic"],
      optionalMissing: ["camera"],
    },
  );
});
```

- [ ] **Step 6: Implement minimal state helpers**

Add `LiveRoomStatus`, `LiveRoomDraft`, `LiveRoomPermissionState`, `canTransitionLiveRoomStatus`, `createLiveRoomDraft`, `addLiveRoomMarker`, and `liveRoomPermissionSummary` to `src/lib/liveRoom.ts`.

- [ ] **Step 7: Run focused tests**

Run: `node --experimental-strip-types --test src/lib/liveRoom.test.ts`

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/liveRoom.ts src/lib/liveRoom.test.ts package.json
git commit -m "feat(live-room): add state model"
```

## Task 2: Pane Catalog, History, and Layout Integration

**Files:**
- Modify: `src/lib/apps.ts`
- Modify: `src/lib/paneLayout.ts`
- Modify: `src/lib/paneLayout.test.ts`
- Modify: `src/lib/paneHistory.ts`
- Modify: `src/lib/paneHistory.test.ts`
- Modify: `src/lib/sidebar.test.ts` if default catalog assertions fail

- [ ] **Step 1: Update failing pane layout test**

In `src/lib/paneLayout.test.ts`, update the core list expectation to include `"live-room"` and add it to the positive core loop.

Expected core list:

```ts
["browser", "chat", "files", "file", "editor", "history", "oracle", "shell", "tmux", "loop", "ticket", "analytics", "wrms-device", "live-room"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/lib/paneLayout.test.ts`

Expected: fail because `live-room` is not core yet.

- [ ] **Step 3: Add live-room pane type and catalog entry**

In `src/lib/apps.ts`:

```ts
import { Video } from "lucide-react";
import type { LiveRoomMode } from "./liveRoom";

export type PaneContent =
  // existing variants...
  | { type: "live-room"; mode?: LiveRoomMode; sessionId?: string };

export const SPAWN: AppDef[] = [
  // existing entries...
  { id: "live-room", kind: { type: "live-room" }, icon: Video, label: "live room", group: "tools" },
];
```

In `src/lib/paneLayout.ts`, append `"live-room"` to `CORE_PANE_TYPES`.

- [ ] **Step 4: Add pane history tests**

In `src/lib/paneHistory.test.ts`:

```ts
test("pane history describes live room panes by mode and session", () => {
  const item = describePaneHistoryItem({ type: "live-room", mode: "content", sessionId: "lr-abc123" }, "live room");
  assert.equal(item.label, "live room");
  assert.equal(item.indicator, "live");
  assert.match(item.detail, /content/);
  assert.match(item.detail, /lr-abc123/);
});
```

- [ ] **Step 5: Implement pane history support**

In `src/lib/paneHistory.ts`, add cases:

```ts
case "live-room":
  return "live";
```

and:

```ts
case "live-room":
  return {
    label: label || "live room",
    detail: [kind.mode ?? "meeting", kind.sessionId].filter(Boolean).join(" · ") || "meeting",
    indicator: "live",
  };
```

In `paneHistoryIdentity`, use `live-room:${kind.sessionId ?? kind.mode ?? label}`.

- [ ] **Step 6: Run focused tests**

Run: `node --experimental-strip-types --test src/lib/paneLayout.test.ts src/lib/paneHistory.test.ts src/lib/sidebar.test.ts`

Expected: pass. If `sidebar.test.ts` fails due default catalog state, update the expected/default fixture only.

- [ ] **Step 7: Commit**

```bash
git add src/lib/apps.ts src/lib/paneLayout.ts src/lib/paneLayout.test.ts src/lib/paneHistory.ts src/lib/paneHistory.test.ts src/lib/sidebar.test.ts
git commit -m "feat(live-room): register pane"
```

## Task 3: Live Room Pane UI Shell

**Files:**
- Create: `src/components/LiveRoomPane.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`
- Modify: `src/lib/bundleBoundaries.test.ts` if lazy-import boundary assertions mention pane imports

- [ ] **Step 1: Create a minimal pane component**

Create `src/components/LiveRoomPane.tsx` with props:

```ts
export function LiveRoomPane({
  paneKey,
  initialMode,
  sessionId,
  onModeChange,
  onSessionChange,
}: {
  paneKey: string;
  initialMode?: LiveRoomMode;
  sessionId?: string;
  onModeChange?: (mode: LiveRoomMode) => void;
  onSessionChange?: (sessionId: string) => void;
}) {
  // start with restoreLiveRoomMode(initialMode)
}
```

UI required in first pass:

- `.live-room`
- `.live-room__topbar`
- `.live-room__stage`
- `.live-room__dock`
- `.live-room__rail`
- mode buttons from `LIVE_ROOM_MODES`
- disabled state with `disabledReason`

Mode-specific first pass requirements:

- `meeting`: right rail sections are `agenda`, `notes`, `markers`, and `post-call`. `post-call` actions render disabled buttons: `summarize`, `follow-up`, `tasks`.
- `content`: right rail sections are `scenes`, `sources`, `takes`, and `clips`. V1 scene buttons are `camera`, `window`, `window + camera`; only `window` is active until camera preview lands.
- `mirror`: right rail sections are `selected window`, `permission`, `fit`, and `send frame`. `send frame` is disabled until snapshot support lands.
- `control`, `annotate`, `observe`: mode buttons are visible but disabled and show their `disabledReason`.
- top bar always shows room title, selected source label or `no source`, recording status, elapsed time placeholder, and permission health.
- bottom dock always shows `mic`, `camera`, `share window`, `record`, `snapshot`, `add marker`, `stop`; unavailable controls are disabled with a short reason.

- [ ] **Step 2: Wire rendering in `src/App.tsx`**

Add a lazy import matching existing pane import style:

```ts
const LiveRoomPane = lazy(() => import("./components/LiveRoomPane").then((m) => ({ default: m.LiveRoomPane })));
```

Add render branch near other non-terminal panes:

```tsx
) : pane.kind.type === "live-room" ? (
  <LiveRoomPane
    paneKey={pane.key}
    initialMode={pane.kind.mode}
    sessionId={pane.kind.sessionId}
    onModeChange={(mode) => updatePaneKind(pane.key, { ...pane.kind, mode })}
    onSessionChange={(sessionId) => updatePaneKind(pane.key, { ...pane.kind, sessionId })}
  />
```

Use the repo's existing pane-kind update helper if named differently; do not introduce duplicate pane state mutation logic.

- [ ] **Step 3: Add basic CSS**

In `src/App.css`, add stable responsive classes for the live room. Keep controls compact, icon-first, and avoid nested card-in-card styling.

- [ ] **Step 4: Add permission rendering tests**

In `src/lib/liveRoom.test.ts`, cover UI helper output that the pane consumes:

```ts
import { liveRoomControlState } from "./liveRoom.ts";

test("record is disabled until screen and mic are granted", () => {
  const state = liveRoomControlState({ screen: "granted", mic: "missing", camera: "missing" });
  assert.equal(state.record.enabled, false);
  assert.match(state.record.reason ?? "", /mic/i);
  assert.equal(state.camera.enabled, false);
  assert.match(state.camera.reason ?? "", /camera/i);
});
```

Implement `liveRoomControlState` in `src/lib/liveRoom.ts`. Keep it pure so browserless tests cover permission health and camera/mic control availability.

- [ ] **Step 5: Run app TypeScript check**

Run: `pnpm exec tsc --noEmit`

Expected: pass or fail only on unrelated dirty-tree issues. If failure is from live room, fix before continuing.

- [ ] **Step 6: Run focused node tests**

Run: `node --experimental-strip-types --test src/lib/liveRoom.test.ts src/lib/paneLayout.test.ts src/lib/paneHistory.test.ts src/lib/bundleBoundaries.test.ts`

Expected: pass. Update bundle-boundary test only if the new pane follows the repo's lazy pane boundary rules.

- [ ] **Step 7: Commit**

```bash
git add src/components/LiveRoomPane.tsx src/App.tsx src/App.css src/lib/bundleBoundaries.test.ts
git commit -m "feat(live-room): add pane shell"
```

## Task 4: Source Picker and Existing AppCast Preview Bridge

**Files:**
- Modify: `src/components/LiveRoomPane.tsx`
- Modify: `src/components/AppCastPane.tsx` only if extracting shared picker code is cleaner
- Modify: `src/lib/appcast.ts` only if extra typed helper is needed
- Test: existing TypeScript checks and manual preview

- [ ] **Step 1: Add source picker UI using existing `appcastListWindows`**

In `LiveRoomPane`, load windows with:

```ts
const rows = await appcastListWindows();
```

Reuse `WindowInfo` from `src/lib/appcast.ts`. Show grouped app/window labels. Show screen-recording permission errors in the stage, not as a fatal app error.

- [ ] **Step 2: Use existing native preview commands**

Add a stage slot ref and mirror the bounds-sync pattern from `AppCastPane.tsx`:

- `appcastStart(paneKey, selectedWindowId, rect)`
- `appcastSetBounds(paneKey, rect)`
- `appcastHide(paneKey)` while dropdowns/rails cover the native overlay
- `appcastClose(paneKey)` on unmount

Keep frame data native. Do not pipe pixels through React.

- [ ] **Step 3: Persist selected source to pane kind**

Extend `PaneContent` live-room shape in `src/lib/apps.ts`:

```ts
| { type: "live-room"; mode?: LiveRoomMode; sessionId?: string; windowId?: number }
```

Wire `onSourceChange` from `App.tsx` similarly to mode changes.

- [ ] **Step 4: Run checks**

Run:

```bash
pnpm exec tsc --noEmit
node --experimental-strip-types --test src/lib/liveRoom.test.ts src/lib/paneLayout.test.ts src/lib/paneHistory.test.ts
```

Expected: pass.

- [ ] **Step 5: Manual smoke**

Run: `pnpm tauri dev`

Manual expected:

- open `live room` from sidebar/palette.
- pick a visible window.
- preview appears in the stage.
- resizing the pane keeps preview aligned.
- opening source picker hides the native overlay so dropdown is usable.
- closing pane stops the preview.

- [ ] **Step 6: Commit**

```bash
git add src/components/LiveRoomPane.tsx src/components/AppCastPane.tsx src/lib/appcast.ts src/lib/apps.ts src/App.tsx
git commit -m "feat(live-room): preview selected window"
```

## Task 5: Native Manifest Storage API

**Files:**
- Create: `src-tauri/src/live_room.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`
- Create: `src/lib/liveRoomApi.ts`
- Modify: `src/lib/liveRoom.ts`
- Modify: `src/lib/liveRoom.test.ts`

- [ ] **Step 1: Add manifest schema tests in TypeScript**

In `src/lib/liveRoom.test.ts`:

```ts
import { liveRoomSessionFolder, validateLiveRoomManifest } from "./liveRoom.ts";

test("live room session folders are scoped under state live-room sessions", () => {
  assert.equal(
    liveRoomSessionFolder("/Users/firazfhansurie/.aios/state", "lr-abc"),
    "/Users/firazfhansurie/.aios/state/live-room/sessions/lr-abc",
  );
});

test("manifest validation requires screen and mic paths for saved sessions", () => {
  assert.equal(validateLiveRoomManifest({ id: "x", status: "saved", screen_path: "screen.mov", audio_path: "mic.wav" }).ok, true);
  assert.equal(validateLiveRoomManifest({ id: "x", status: "saved", screen_path: "screen.mov" }).ok, false);
});
```

- [ ] **Step 2: Implement TypeScript manifest helpers**

Add `LiveRoomManifest`, `liveRoomSessionFolder`, and `validateLiveRoomManifest` to `src/lib/liveRoom.ts`.

- [ ] **Step 3: Implement native storage commands**

In `src-tauri/src/live_room.rs`, implement:

```rust
#[tauri::command]
pub fn live_room_create_session(title: Option<String>, mode: String) -> Result<LiveRoomManifest, String>;

#[tauri::command]
pub fn live_room_add_marker(session_id: String, label: String, at_ms: u64) -> Result<LiveRoomManifest, String>;

#[tauri::command]
pub fn live_room_get_manifest(session_id: String) -> Result<LiveRoomManifest, String>;

#[tauri::command]
pub fn live_room_list_sessions() -> Result<Vec<LiveRoomIndexItem>, String>;
```

Storage root:

```rust
dirs::home_dir()
  .ok_or("home dir unavailable")?
  .join(".aios/state/live-room")
```

Use atomic-ish writes: write `manifest.json.tmp`, then rename to `manifest.json`. Keep `index.json` small and derived from manifests where possible.

- [ ] **Step 4: Register native commands**

In `src-tauri/src/lib.rs`:

```rust
mod live_room;
```

Add commands to `tauri::generate_handler!`.

Update `src-tauri/capabilities/default.json` if this repo uses explicit command permissions.

- [ ] **Step 5: Add frontend invoke wrappers**

In `src/lib/liveRoomApi.ts`:

```ts
import { invoke } from "./tauri";
import type { LiveRoomManifest, LiveRoomMode } from "./liveRoom";

export const liveRoomCreateSession = (input: { title?: string; mode: LiveRoomMode }) =>
  invoke<LiveRoomManifest>("live_room_create_session", input);
```

Add wrappers for marker/get/list.

- [ ] **Step 6: Run checks**

Run:

```bash
node --experimental-strip-types --test src/lib/liveRoom.test.ts
pnpm exec tsc --noEmit
cd src-tauri && cargo check
```

Expected: pass or fail only on unrelated dirty-tree issues. Fix live-room failures.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/live_room.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json src/lib/liveRoomApi.ts src/lib/liveRoom.ts src/lib/liveRoom.test.ts
git commit -m "feat(live-room): add session manifests"
```

## Task 6: Markers, Snapshots, and Session Reopen UI

**Files:**
- Modify: `src/components/LiveRoomPane.tsx`
- Modify: `src/lib/liveRoomApi.ts`
- Modify: `src/lib/paneHistory.ts`
- Modify: `src-tauri/src/live_room.rs`

- [ ] **Step 1: Wire session creation**

When the pane first needs durable state, call `liveRoomCreateSession({ mode })`. Persist returned `sessionId` to pane kind through `onSessionChange`.

- [ ] **Step 2: Wire marker action**

The dock `add marker` button calls `liveRoomAddMarker(sessionId, label, elapsedMs)`. Use a default label like `"marker"` in v1; editable labels can come later.

- [ ] **Step 3: Implement real snapshot command**

Snapshots are required v1 output. Do not use manifest-only placeholders.

Preferred command:

```rust
#[tauri::command]
pub async fn live_room_capture_snapshot(session_id: String, window_id: u32, at_ms: u64) -> Result<LiveRoomManifest, String>
```

Implementation options:

- Prefer reusing the current appcast/window capture path if it can capture a single frame to `snapshots/<timestamp>.png`.
- Otherwise use macOS `screencapture -l <window_id> <path>` as a v1 fallback, because it produces a real visible saved frame and keeps the plan moving.
- Append the saved file path and timestamp to `manifest.snapshot_paths`.
- If snapshot capture fails, show a snapshot error and preserve the current recording/session state.

- [ ] **Step 4: Reopen existing session**

If `pane.kind.sessionId` exists, load manifest on mount and show prior markers/status in the rail.

- [ ] **Step 5: Run checks**

Run:

```bash
pnpm exec tsc --noEmit
node --experimental-strip-types --test src/lib/liveRoom.test.ts src/lib/paneHistory.test.ts
cd src-tauri && cargo check
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/LiveRoomPane.tsx src/lib/liveRoomApi.ts src/lib/paneHistory.ts src-tauri/src/live_room.rs
git commit -m "feat(live-room): persist markers"
```

## Task 7: Recording Command State Machine

**Files:**
- Modify: `src-tauri/src/live_room.rs`
- Modify: `src/lib/liveRoomApi.ts`
- Modify: `src/components/LiveRoomPane.tsx`
- Modify: `src/lib/liveRoom.ts`
- Modify: `src/lib/liveRoom.test.ts`

- [ ] **Step 1: Add frontend state tests for recording/export labels**

In `src/lib/liveRoom.test.ts`:

```ts
import { liveRoomStatusLabel } from "./liveRoom.ts";

test("saved tracks with failed export are not shown as recording failure", () => {
  assert.equal(liveRoomStatusLabel("export_failed"), "saved tracks · mp4 export failed");
  assert.equal(liveRoomStatusLabel("partial"), "partial recording saved");
});
```

- [ ] **Step 2: Define recording commands**

In `src-tauri/src/live_room.rs`:

```rust
#[tauri::command]
pub async fn live_room_start_recording(session_id: String, window_id: u32) -> Result<LiveRoomManifest, String>;

#[tauri::command]
pub async fn live_room_stop_recording(session_id: String) -> Result<LiveRoomManifest, String>;
```

State model:

- reserve paths for `screen.<container>` and `mic.<container>` in the session folder.
- update manifest to `recording` on start.
- update manifest to `saving`, then `saved` on stop.
- update to `partial` if source disappears after at least one track exists.
- update to `failed` only if no usable track/manifest can be saved.

- [ ] **Step 3: Implement no-op native recorder handles**

Add a `LiveRoomRecordingState` map in `src-tauri/src/live_room.rs` keyed by `session_id`. This task only creates the command/state plumbing:

- start creates/reserves output paths and writes manifest `recording`.
- stop writes manifest `saved` only if both reserved paths exist; otherwise `partial` or `failed`.
- no actual screen/mic writers yet.

This intentionally fails manual recording acceptance but makes later writer tasks narrow.

- [ ] **Step 4: Wire frontend controls**

Dock buttons:

- `record` calls `liveRoomStartRecording`.
- `stop` calls `liveRoomStopRecording`.

Disable source/mode changes while `recording` or `saving`.

- [ ] **Step 5: Run checks**

Run:

```bash
node --experimental-strip-types --test src/lib/liveRoom.test.ts
pnpm exec tsc --noEmit
cd src-tauri && cargo check
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/live_room.rs src/lib/liveRoomApi.ts src/components/LiveRoomPane.tsx src/lib/liveRoom.ts src/lib/liveRoom.test.ts
git commit -m "feat(live-room): add recording state machine"
```

## Task 8: Screen Track Writer

**Files:**
- Modify: `src-tauri/src/live_room.rs`
- Create: `src-tauri/src/live_room_screen.rs` if `live_room.rs` grows too large
- Modify: `src-tauri/src/lib.rs` only if a new module is created

- [ ] **Step 1: Isolate screen writer interface**

Define a small internal API:

```rust
struct ScreenTrackWriter {
    session_id: String,
    window_id: u32,
    output_path: PathBuf,
    started_at_ms: u64,
}

impl ScreenTrackWriter {
    async fn start(...) -> Result<Self, String>;
    async fn stop(self) -> Result<TrackSummary, String>;
}
```

`TrackSummary` must include `path`, `start_offset_ms`, `duration_ms`, and `frames_written` when available.

- [ ] **Step 2: Implement minimum screen track recording path**

Reuse the existing ScreenCaptureKit/appcast session where feasible. If current `appcast.rs` cannot expose frames to a writer without risky surgery, create a separate capture stream in `live_room.rs` for recording the selected `window_id`.

Do not route video frames through JS. Keep capture native.

- [ ] **Step 3: Add partial recovery behavior**

If the selected window disappears mid-record:

- stop the writer.
- keep whatever screen track exists.
- update manifest to `partial`.
- record an error message in manifest/status metadata.

- [ ] **Step 4: Run Rust check**

Run: `cd src-tauri && cargo check`

Expected: pass.

- [ ] **Step 5: Manual smoke**

Run `pnpm tauri dev`, select a window, record 30 seconds, stop.

Expected:

- session folder contains a non-empty screen track.
- manifest has `screen_path`, screen duration, and status `partial` if mic writer is not implemented yet.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/live_room.rs src-tauri/src/live_room_screen.rs src-tauri/src/lib.rs
git commit -m "feat(live-room): record screen track"
```

## Task 9: Mic Track Writer and Sync Offsets

**Files:**
- Modify: `src-tauri/src/live_room.rs`
- Create: `src-tauri/src/live_room_audio.rs` if audio code needs isolation
- Modify: `src-tauri/src/lib.rs` only if a new module is created
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Choose and add native audio binding**

Use native AVFoundation/CoreAudio. Add macOS-only dependencies to `src-tauri/Cargo.toml` only after selecting the binding path. Keep the API small and isolated behind `live_room.rs` or a nested `live_room::audio` module.

Hard requirement: manifest records track offsets/durations so drift can be measured.

- [ ] **Step 2: Isolate mic writer interface**

Define:

```rust
struct MicTrackWriter {
    session_id: String,
    output_path: PathBuf,
    started_at_ms: u64,
}

impl MicTrackWriter {
    async fn start(...) -> Result<Self, String>;
    async fn stop(self) -> Result<TrackSummary, String>;
}
```

- [ ] **Step 3: Wire screen + mic start from the same session clock**

At `live_room_start_recording`, capture one shared monotonic start time and pass it to both writers. On stop, write:

- `screen_path`
- `audio_path`
- `track_offsets_ms.screen`
- `track_offsets_ms.mic`
- per-track durations when available

- [ ] **Step 4: Update manifest status rules**

After mic writer lands:

- `saved` requires both screen and mic track present.
- `partial` means only one track survived or one writer errored after start.
- `failed` means neither track is usable.

- [ ] **Step 5: Run checks**

Run:

```bash
cd src-tauri && cargo check
pnpm exec tsc --noEmit
```

Expected: pass.

- [ ] **Step 6: Manual smoke**

Run `pnpm tauri dev`, record 60 seconds.

Expected:

- session folder contains non-empty screen and mic tracks.
- manifest status is `saved`.
- manifest includes screen/mic offsets and durations.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/live_room.rs src-tauri/src/live_room_audio.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(live-room): record mic track"
```

## Task 10: Optional MP4 Export

**Files:**
- Modify: `src-tauri/src/live_room.rs`
- Modify: `src/lib/liveRoomApi.ts`
- Modify: `src/components/LiveRoomPane.tsx`
- Modify: `src/lib/liveRoom.ts`
- Modify: `src/lib/liveRoom.test.ts`

- [ ] **Step 1: Add export API**

In `src-tauri/src/live_room.rs`:

```rust
#[tauri::command]
pub async fn live_room_export_mp4(session_id: String) -> Result<LiveRoomManifest, String>;
```

Check for `ffmpeg` in PATH. If unavailable, return a manifest with export unavailable/failed state only when export is requested. Recording itself must still work.

- [ ] **Step 2: Implement export command**

Run `ffmpeg` against the saved screen + mic tracks and write `export.mp4` in the session folder.

Rules:

- missing ffmpeg -> status `export_failed`, tracks remain `saved`.
- ffmpeg non-zero -> status `export_failed`, include error text.
- success -> status `exported`, set `export_path`.

- [ ] **Step 3: Wire frontend export control**

Add `export mp4` as a post-recording action only when status is `saved` or `export_failed`.

- [ ] **Step 4: Run checks**

Run:

```bash
node --experimental-strip-types --test src/lib/liveRoom.test.ts
pnpm exec tsc --noEmit
cd src-tauri && cargo check
```

Expected: pass.

- [ ] **Step 5: Manual ffmpeg-missing check**

Temporarily run the built app with PATH that excludes ffmpeg, then request export.

Expected: recording remains saved, status shows `saved tracks · mp4 export failed`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/live_room.rs src/lib/liveRoomApi.ts src/components/LiveRoomPane.tsx src/lib/liveRoom.ts src/lib/liveRoom.test.ts
git commit -m "feat(live-room): export mp4 when available"
```

## Task 11: Acceptance Verification and Polish

**Files:**
- Modify: `docs/superpowers/specs/2026-06-21-aios-live-room-design.md` only if implementation reality changes the approved design
- Modify: `README.md` only if public feature docs need an entry
- Add screenshots only if this repo convention requires them

- [ ] **Step 1: Run full relevant test set**

Run:

```bash
pnpm exec tsc --noEmit
pnpm test:chatpane
cd src-tauri && cargo check
```

Expected: pass. If unrelated dirty-tree failures exist, document exact failures and prove live-room focused tests pass.

- [ ] **Step 2: Built-app permission checks**

Run:

```bash
pnpm tauri build
```

Open the built `.app`, not only dev mode.

Manual expected:

- permission prompts are legible for screen and mic.
- record 60 seconds of one selected window plus mic.
- stop produces `~/.aios/state/live-room/sessions/<id>/manifest.json`.
- manifest references screen and mic tracks.
- no mp4 dependency is required for success.

- [ ] **Step 3: Acceptance checks**

Manual checklist:

- built `.app` fresh permission flow works after TCC reset.
- selected window preview resizes with pane.
- source picker hides native overlay while open.
- 5-minute recording produces screen + mic tracks and manifest.
- manifest drift/offset fields exist and are plausible.
- source disappearance mid-record preserves partial output.
- ffmpeg missing does not block track recording.
- low-disk simulation does not corrupt previous sessions.
- history reopen restores live room session and mode.

- [ ] **Step 4: Visual verification**

Take screenshots of:

- meeting mode idle/preview.
- content mode with source rail.
- recording state with red indicator and elapsed time.
- saved state with manifest/session path.

Check mobile-sized/narrow pane behavior in the Tauri app if the layout can be resized that small.

- [ ] **Step 5: Final commit**

```bash
git add .
git commit -m "test(live-room): verify capture flow"
```

If no files changed, skip the commit and record verification in the final handoff.

## Execution Notes

- Keep worktree hygiene strict. This repo is already dirty; do not revert unrelated changes.
- Prefer one fresh subagent per task during implementation. Each worker owns only the files listed in its task.
- Do not implement transcript, diarization, system audio, virtual camera, or full scene compositor during this plan.
- If native recording proves unstable, stop after Task 6 and update the spec/plan with measured blocker details instead of grinding.
