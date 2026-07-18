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

const ENABLED_MODES = new Set(LIVE_ROOM_MODES.filter((m) => m.enabled).map((m) => m.id));
const MODE_IDS = new Set(LIVE_ROOM_MODES.map((m) => m.id));

export const LIVE_ROOM_RECORDING_AVAILABLE = false;
export const LIVE_ROOM_RECORDING_UNAVAILABLE_REASON = "recording backend unavailable";

export type LiveRoomStatus =
  | "idle"
  | "loading"
  | "permission-blocked"
  | "preview"
  | "recording"
  | "paused"
  | "saving"
  | "saved"
  | "partial"
  | "failed"
  | "exporting"
  | "exported"
  | "export_failed";

export type LiveRoomPermission = "unknown" | "granted" | "missing" | "blocked";

export interface LiveRoomPermissions {
  screen: LiveRoomPermission;
  mic: LiveRoomPermission;
  camera: LiveRoomPermission;
}

export interface LiveRoomMarker {
  id: string;
  label: string;
  atMs: number;
}

export interface LiveRoomDraft {
  id: string;
  mode: LiveRoomMode;
  status: LiveRoomStatus;
  createdAt: number;
  updatedAt: number;
  markers: LiveRoomMarker[];
}

export interface LiveRoomManifest {
  schema: "aios.live-room.v1";
  id: string;
  mode: LiveRoomMode;
  status: LiveRoomStatus;
  createdAt: number;
  updatedAt: number;
  markers: LiveRoomMarker[];
  assets: {
    screen?: string;
    mic?: string;
    camera?: string;
    export?: string;
    snapshots?: string[];
  };
}

export function defaultLiveRoomMode(): LiveRoomMode {
  return "meeting";
}

export function isLiveRoomMode(value: unknown): value is LiveRoomMode {
  return typeof value === "string" && MODE_IDS.has(value as LiveRoomMode);
}

export function isLiveRoomModeEnabled(value: unknown): value is LiveRoomMode {
  return isLiveRoomMode(value) && ENABLED_MODES.has(value);
}

export function restoreLiveRoomMode(value: unknown): LiveRoomMode {
  return isLiveRoomModeEnabled(value) ? value : defaultLiveRoomMode();
}

const ALLOWED_TRANSITIONS: Record<LiveRoomStatus, LiveRoomStatus[]> = {
  idle: ["loading", "permission-blocked", "preview", "failed"],
  loading: ["idle", "permission-blocked", "preview", "failed"],
  "permission-blocked": ["idle", "loading", "preview"],
  preview: ["idle", "failed"],
  recording: ["paused", "saving", "partial", "failed"],
  paused: ["recording", "saving", "partial", "failed"],
  saving: ["saved", "partial", "failed"],
  saved: ["exporting", "exported", "export_failed"],
  partial: ["exporting", "export_failed"],
  failed: ["idle"],
  exporting: ["exported", "export_failed", "saved"],
  exported: [],
  export_failed: ["exporting"],
};

export function canTransitionLiveRoomStatus(from: LiveRoomStatus, to: LiveRoomStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function createLiveRoomDraft({
  id,
  mode,
  now = Date.now(),
}: {
  id: string;
  mode: LiveRoomMode;
  now?: number;
}): LiveRoomDraft {
  return { id, mode, status: "idle", createdAt: now, updatedAt: now, markers: [] };
}

export function addLiveRoomMarker(draft: LiveRoomDraft, marker: { label: string; atMs: number }): LiveRoomDraft {
  const next: LiveRoomMarker = {
    id: `m-${String(draft.markers.length + 1).padStart(4, "0")}`,
    label: marker.label.trim() || "marker",
    atMs: Math.max(0, Math.round(marker.atMs)),
  };
  return {
    ...draft,
    updatedAt: Math.max(draft.updatedAt, next.atMs),
    markers: [...draft.markers, next].sort((a, b) => a.atMs - b.atMs),
  };
}

export function liveRoomPermissionSummary(permissions: LiveRoomPermissions): {
  canPreview: boolean;
  canRecord: boolean;
  requiredMissing: string[];
  optionalMissing: string[];
} {
  const requiredMissing = [
    permissions.screen === "granted" ? null : "screen",
    permissions.mic === "granted" ? null : "mic",
  ].filter((v): v is string => Boolean(v));
  const optionalMissing = [permissions.camera === "granted" ? null : "camera"].filter((v): v is string => Boolean(v));
  return {
    canPreview: permissions.screen === "granted",
    canRecord: LIVE_ROOM_RECORDING_AVAILABLE && requiredMissing.length === 0,
    requiredMissing,
    optionalMissing,
  };
}

export function describeLiveRoomControls({
  status,
  permissions,
}: {
  status: LiveRoomStatus;
  permissions: LiveRoomPermissions;
}): {
  canStartPreview: boolean;
  canStartRecording: boolean;
  canStopRecording: boolean;
  canSave: boolean;
} {
  const summary = liveRoomPermissionSummary(permissions);
  return {
    canStartPreview: status === "idle" || status === "permission-blocked" || status === "loading" || status === "preview",
    canStartRecording: LIVE_ROOM_RECORDING_AVAILABLE && status === "preview" && summary.canRecord,
    canStopRecording: false,
    canSave: false,
  };
}

export function liveRoomStatusLabel(status: LiveRoomStatus): string {
  switch (status) {
    case "idle":
      return "ready";
    case "loading":
      return "loading sources";
    case "permission-blocked":
      return "permissions needed";
    case "preview":
      return "preview";
    case "recording":
      return "recording";
    case "paused":
      return "paused";
    case "saving":
      return "saving";
    case "saved":
      return "saved";
    case "partial":
      return "saved with gaps";
    case "failed":
      return "recording failed";
    case "exporting":
      return "exporting";
    case "exported":
      return "exported";
    case "export_failed":
      return "saved tracks · mp4 export failed";
  }
}

function validSessionId(id: string): boolean {
  return /^lr-[a-z0-9-]+$/i.test(id);
}

export function liveRoomSessionManifestPath(sessionId: string): string {
  if (!validSessionId(sessionId)) throw new Error("invalid live room session id");
  return `${sessionId}/manifest.json`;
}

export function isLiveRoomManifest(value: unknown): value is LiveRoomManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<LiveRoomManifest>;
  return (
    v.schema === "aios.live-room.v1" &&
    typeof v.id === "string" &&
    validSessionId(v.id) &&
    isLiveRoomMode(v.mode) &&
    typeof v.status === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number" &&
    Array.isArray(v.markers) &&
    Boolean(v.assets && typeof v.assets === "object")
  );
}
