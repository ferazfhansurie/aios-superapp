// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_ROOM_MODES,
  LIVE_ROOM_RECORDING_AVAILABLE,
  addLiveRoomMarker,
  canTransitionLiveRoomStatus,
  createLiveRoomDraft,
  defaultLiveRoomMode,
  describeLiveRoomControls,
  isLiveRoomManifest,
  isLiveRoomModeEnabled,
  liveRoomPermissionSummary,
  liveRoomSessionManifestPath,
  liveRoomStatusLabel,
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

test("live room status transitions protect saved partial output", () => {
  assert.equal(canTransitionLiveRoomStatus("idle", "preview"), true);
  assert.equal(canTransitionLiveRoomStatus("preview", "recording"), false);
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

test("recording controls stay unavailable until a durable backend exists", () => {
  assert.equal(LIVE_ROOM_RECORDING_AVAILABLE, false);
  assert.deepEqual(
    liveRoomPermissionSummary({ screen: "granted", mic: "granted", camera: "missing" }),
    {
      canPreview: true,
      canRecord: false,
      requiredMissing: [],
      optionalMissing: ["camera"],
    },
  );
  assert.deepEqual(
    describeLiveRoomControls({ status: "preview", permissions: { screen: "granted", mic: "granted", camera: "missing" } }),
    { canStartPreview: true, canStartRecording: false, canStopRecording: false, canSave: false },
  );
  assert.deepEqual(
    describeLiveRoomControls({ status: "recording", permissions: { screen: "granted", mic: "granted", camera: "missing" } }),
    { canStartPreview: false, canStartRecording: false, canStopRecording: false, canSave: false },
  );
});

test("status labels are user-facing and avoid implementation terms", () => {
  assert.equal(liveRoomStatusLabel("idle"), "ready");
  assert.equal(liveRoomStatusLabel("permission-blocked"), "permissions needed");
  assert.equal(liveRoomStatusLabel("partial"), "saved with gaps");
});

test("manifest and path helpers validate durable session shape", () => {
  assert.equal(liveRoomSessionManifestPath("lr-abc123"), "lr-abc123/manifest.json");
  assert.throws(() => liveRoomSessionManifestPath("../nope"), /invalid live room session id/);
  assert.equal(
    isLiveRoomManifest({
      schema: "aios.live-room.v1",
      id: "lr-abc123",
      mode: "content",
      status: "saved",
      createdAt: 1000,
      updatedAt: 2000,
      markers: [],
      assets: { screen: "screen.mp4", mic: "mic.m4a" },
    }),
    true,
  );
  assert.equal(isLiveRoomManifest({ schema: "aios.live-room.v1", id: "../nope" }), false);
});
