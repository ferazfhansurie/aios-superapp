# aios live room design

## problem

aios needs a native capture surface for face-to-face meetings, demos, and content creation. the first attempt as an artifact/dashboard shape is wrong. firaz is imagining something closer to google meet or obs: a live room where the preview is the product, controls are immediate, and ai only becomes prominent when it helps the current capture.

the feature belongs in supershell because recording is not the end state. aios can use the capture session as context for agents, notes, follow-ups, content drafts, clips, and proof. but during capture, the interface must feel live within one second.

## goals

- create a first-class `live room` pane inside the existing pane grid.
- make the first viewport feel like google meet: large live preview, obvious camera/mic/screen/record controls, visible permission and recording state.
- make the pane visually and behaviorally as polished as existing core panes: sidebar/palette/history integration, consistent pane chrome, refined empty/loading/error states, responsive layout, icon-first controls, and no debug-looking surfaces.
- support a hybrid mode model where the same room morphs based on selected mode, without making every mode fully functional in the first slice.
- make v1 technically shippable on macos without promising full obs/system-audio complexity.
- produce durable local recording artifacts that later aios panes/agents can process.
- keep recording trust high: clear source name, elapsed time, red recording state, permission health, and save location.

## non-goals

- no virtual camera in v1.
- no streaming/broadcasting in v1.
- no full obs scene compositor in v1.
- no multi-window timeline editor in v1.
- no system audio guarantee in v1.
- no background/unfocused google meet capture guarantee in v1.
- no cross-platform capture implementation in v1.
- no ai transcript/diarization dependency for the first recording spike.

## product shape

the pane is named `live room`.

it opens as a simple meeting-style room. the stage dominates the viewport. the bottom dock contains primary controls. the right rail is minimal by default and changes based on mode.

default behavior:

- first launch: `meeting` mode.
- later launches: restore the last-used mode per pane/user when available.

### core layout

- top bar: room title, active source, elapsed time, fps/health dot, recording/mirroring indicator.
- center stage: live preview of camera, screen, selected window, or composed view.
- bottom dock: icon-first controls for mic, camera, share window/screen, record, snapshot, annotate, marker, stop.
- right rail: collapsible mode-specific tools.
- pane chrome: same resize, minimize, maximize, history, and command palette behavior as other aios panes.

the live preview must be the largest object. generated artifacts, history, analytics, and content queues are after-capture surfaces, not the live room's first state.

### first-class pane quality

live room is a core pane, not an experimental utility hidden behind a debug route.

requirements:

- appears in the sidebar and command palette as `live room` with an appropriate icon.
- opens, duplicates, minimizes, maximizes, closes, and restores through history like other panes.
- uses the standard pane chrome and error boundary behavior.
- has polished empty, loading, permission-blocked, preview, recording, saved, partial, and failed states.
- uses icon-first controls with tooltips/labels for unfamiliar actions.
- keeps text inside controls readable at narrow and wide pane sizes.
- does not expose implementation jargon such as `screencapturekit`, `ffmpeg`, `manifest`, or raw file paths in the primary live viewport.
- shows raw session paths only in a secondary details/action area after saving.
- survives pane resizing without overlapping controls, rails, or native preview layers.

## modes

v1 has a single pane and a real mode switch, but the first implementation must keep the mode matrix narrow:

- functional in slice 1: `meeting`, `content`, `mirror`.
- visible but disabled/stubbed in slice 1: `control`, `annotate`, `observe`.

disabled modes should explain what permission or future slice unlocks them. this keeps the product direction visible without forcing obs-grade scope into the recorder spike.

### meeting

google meet style. optimized for face-to-face meetings and client calls.

right rail:

- agenda.
- notes.
- markers.
- ai listener status.
- post-call actions after recording ends.

primary actions:

- mute/unmute mic.
- camera on/off.
- share window/screen.
- record/pause/stop.
- add marker.
- snapshot.

deferred post-recording actions:

- summarize discussion.
- extract decisions.
- draft whatsapp/email follow-up.
- create task list.
- attach recording/transcript to the meeting artifact.

these actions may appear as disabled buttons or queued stubs in v1. they must not block capture, saving, or reopening the recording.

### content

obs-lite. optimized for demos, founder content, tutorials, and build-in-public capture.

right rail:

- scenes.
- sources.
- webcam thumbnail toggle.
- overlays.
- takes.
- recent snapshots/clips.

v1 scenes should stay simple:

- camera only.
- screen/window only.
- screen/window with webcam thumbnail.

v2 can add richer source stacking, overlays, and templates.

deferred post-recording actions:

- generate clip candidates.
- create hooks and captions.
- draft threads/linkedin/youtube notes.
- send selected frames or clips to an oracle.
- hand off an edit package to the content room pipeline.

these actions are v2 unless the implementation plan explicitly adds a small non-transcript-based post action.

### mirror/control

selected app/window becomes the stage. this aligns with the existing appcast direction.

submodes:

- `mirror`: view the selected app/window live.
- `control`: forward input to the selected app/window when accessibility permission is available.

control must be explicit. recording/mirroring should not require accessibility permission.

right rail:

- selected app/window.
- permission status.
- input forwarding state.
- cursor visibility.
- fit/fill.
- send frame to oracle.

### annotate

capture explanation mode.

right rail:

- draw.
- arrow.
- rectangle.
- blur/hide region.
- snapshot.
- send annotated frame to chat/oracle.

annotate is useful for bugs, client walkthroughs, demos, and quick visual instructions.

### observe

agents may watch frames/events, mark moments, and create suggestions, but cannot control input.

right rail:

- observing agents.
- recent markers.
- suggested clips.
- suggested follow-up notes.

observe is opt-in per session. it should not feel like hidden surveillance.

## v1 technical scope

v1 should ship the live room interface and one reliable recording path:

- select one screen, app window, or chrome pane as the stage.
- record mic audio.
- optionally show webcam preview/thumbnail.
- write separate synchronized local tracks plus a session manifest.
- optionally export an mp4 when `ffmpeg` is available, but do not make mp4 export required for v1 success.
- support snapshots.
- support timestamped markers.
- show permission status.
- show save location.

technical notes from existing repo context:

- screen/window capture should reuse the `appcast` direction based on screencapturekit.
- chrome/meet capture can later use the existing chrome/cdp direction, but v1 should prefer selected-window capture over cdp screencast if quality matters.
- mic recording for v1 should be native avfoundation/coreaudio so audio timestamps can be aligned with screen capture timestamps. webview `getUserMedia` is acceptable only for throwaway preview spikes, not the approved recording path.
- camera in slice 1 is preview/thumbnail only. it may use webview `getUserMedia` for preview if that is faster, but camera video is not part of the required saved recording unless native avfoundation capture is already implemented.
- encoding/muxing should not be invented. v1 success is separate tracks plus manifest. if `ffmpeg` is available, expose `export mp4` as a best-effort post action; if not, keep the saved tracks and show "mp4 export unavailable".
- test built `.app`, not only `tauri dev`, because macos tcc/hardened-runtime behavior differs.

## v1 recording contract

the first shippable recording result is a folder, not necessarily a single mp4.

folder shape:

```text
~/.aios/state/live-room/sessions/<session-id>/
  manifest.json
  screen.<container-or-codec>
  mic.<container-or-codec>
  snapshots/
```

required:

- screen/window track.
- mic track.
- manifest with shared start time, per-track start offset, duration, markers, source labels, and permission state.
- snapshot files when captured.

optional:

- `camera.<container-or-codec>` only if native camera recording is implemented.
- `export.mp4` only if muxing succeeds.

if muxing fails, the session is still saved. the user should see `saved tracks · mp4 export failed`, not `recording failed`.

## artifacts

the live room produces durable session artifacts after or during capture.

v1 storage:

- manifests and media live under `~/.aios/state/live-room/sessions/<session-id>/`.
- a lightweight index lives at `~/.aios/state/live-room/index.json`.
- later, a first-class sqlite/db table can mirror this if other aios surfaces need sync.

artifact fields:

- `id`.
- `title`.
- `mode`.
- `source_kind`.
- `source_label`.
- `recording_path`.
- `screen_path`.
- `audio_path`.
- `camera_path` when present.
- `export_path` when mp4 export succeeds.
- `snapshot_paths`.
- `markers`.
- `started_at`.
- `ended_at`.
- `duration_ms`.
- `track_offsets_ms`.
- `permissions`.
- `post_actions`.
- `status`.

the pane should not depend on artifact processing to finish recording. capture must remain reliable even if ai processing fails.

## data flow

1. user opens `live room`.
2. pane restores last mode or starts in meeting mode.
3. user selects camera/mic/screen/window sources.
4. app checks and displays permissions.
5. user starts preview.
6. user records, snapshots, and adds markers.
7. app writes local tracks and a session manifest.
8. app attempts optional mp4 export only when muxing is available.
9. after stop, aios shows deferred post-capture actions based on mode.
10. artifacts can reopen in history, files, editor/viewer, chat, or content workflows.

## error handling

- missing screen permission: show blocked state with direct action guidance, keep the room open.
- missing mic/camera permission: disable that source, keep screen recording possible.
- ffmpeg missing: keep recording enabled, save separate tracks, and show `mp4 export unavailable`.
- capture source disappears: transition to `partial`, stop safely, preserve partial tracks, record error in manifest.
- ai post-processing fails: keep recording artifact and show retry action.
- disk path unavailable/full: block recording start before capture begins.

### states

- `idle`: no active source.
- `preview`: source selected and visible, not recording.
- `recording`: tracks are being written.
- `paused`: recording temporarily stopped, session still active.
- `saving`: stop requested, files/manifests being finalized.
- `saved`: manifest and required tracks are present.
- `partial`: recording ended unexpectedly but at least one valid track/manifest exists.
- `failed`: no usable track could be saved.
- `exporting`: optional mp4 export is running.
- `exported`: optional mp4 export succeeded.
- `export_failed`: separate tracks are saved but mp4 export failed.

state transitions must never delete partial output automatically.

## ui language

use live-room words, not document words.

preferred:

- `share window`.
- `record`.
- `pause`.
- `snapshot`.
- `add marker`.
- `send frame`.
- `stop capture`.
- `meeting`.
- `content`.
- `mirror`.
- `control`.
- `annotate`.

avoid in the live viewport:

- `artifact`.
- `output`.
- `asset`.
- `dashboard`.
- `pipeline`.
- `analytics`.

those can appear in post-capture/history surfaces.

## testing

unit tests:

- pane mode state and default/last-used restore.
- marker/session manifest helpers.
- artifact path creation and validation.
- permission-state rendering helpers.

integration/manual tests:

- built mac `.app` can request screen, mic, and camera permission.
- selected window preview appears and resizes with the pane.
- sidebar, command palette, history, duplicate, minimize, maximize, and close behavior match other core panes.
- empty, loading, permission-blocked, preview, recording, saved, partial, and failed states are visually checked.
- recording start/stop creates required separate tracks and `manifest.json`.
- marker timestamps are saved.
- snapshot saves a visible frame.
- missing permission states are legible and non-crashing.
- live room can be minimized/maximized/resumed like other panes.

acceptance checks:

- screen and mic drift stays within an agreed threshold after a 5-minute recording, measured from manifest offsets.
- source disappearance mid-record creates `partial`, preserves output, and records the error.
- ffmpeg missing still allows recording and produces `export_failed` only when export is attempted.
- low-disk simulation blocks recording start or stops into `partial` without corrupting previous sessions.
- fresh tcc reset/fresh install shows correct screen, mic, and camera permission states.
- signed/hardened built `.app` is tested, not only `tauri dev`.

## open decisions

- exact capture source picker design.
- exact separate-track container/codec choices.
- exact sync drift threshold.
- whether webcam preview uses webview media APIs first or native avfoundation from the start. webcam preview is not required saved output in v1.
- whether the first implementation plan includes any small non-transcript post-capture action.

## recommended implementation slice

slice 1 should prove the room without overbuilding obs:

1. live room pane shell with hybrid mode switch and static source controls.
2. permission/status model.
3. source picker for one screen/window.
4. live preview using the existing screencapturekit/appcast direction.
5. record selected source + mic to separate tracks plus manifest.
6. markers and snapshots.
7. session manifest and history reopen.
8. optional ffmpeg export action if available.

post-capture ai actions can follow once recording is stable.
