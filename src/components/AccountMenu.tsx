/** Bottom-left account row. Slimmed down — usage + activity now live on the
 *  homescreen PULSE, so this is just identity → settings. The avatar doubles as
 *  a profile-picture picker: click it to choose an image; it's downscaled to a
 *  small square, stored as a data URL in localStorage, and shown across the
 *  sidebar. Falls back to the "f" monogram when no picture is set. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Settings as SettingsIcon } from "lucide-react";

const AVATAR_KEY = "aios.avatar";
/** Broadcast within the tab so other avatar instances update live. */
const AVATAR_EVENT = "aios:avatar";

export function loadAvatar(): string | null {
  try {
    return localStorage.getItem(AVATAR_KEY);
  } catch {
    return null;
  }
}

/** Downscale + center-crop an image file to a `size`px square JPEG data URL so
 *  localStorage stays tiny (a raw camera photo would blow the ~5MB quota). */
function fileToAvatar(file: File, size = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no 2d ctx"));
        // center-crop to a square, then draw scaled into the canvas.
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

import { getSetting } from "../lib/settings";

export function AccountMenu({
  onOpenSettings,
}: {
  onOpenSettings?: () => void;
  /** kept for call-site compatibility; the popover is gone so it's unused. */
  onOpenChange?: (open: boolean) => void;
}) {
  // firaz's avatar-picker, wired to the dynamic userName (defaults to "faeez")
  // instead of the hardcoded "firaz"/"f".
  const name = (getSetting("userName") || "").trim() || "you";
  const initial = name.charAt(0).toLowerCase();
  const [avatar, setAvatar] = useState<string | null>(() => loadAvatar());
  const fileRef = useRef<HTMLInputElement>(null);

  // keep in sync if another instance (or settings) changes the avatar.
  useEffect(() => {
    const sync = () => setAvatar(loadAvatar());
    window.addEventListener(AVATAR_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(AVATAR_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const onPick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    try {
      const data = await fileToAvatar(file);
      localStorage.setItem(AVATAR_KEY, data);
      setAvatar(data);
      window.dispatchEvent(new Event(AVATAR_EVENT));
    } catch {
      /* ignore bad image */
    }
  }, []);

  return (
    <div className="flex w-full items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1.5 text-left transition-colors hover:border-[var(--color-border-strong)]">
      {/* avatar = profile-picture picker (own control so it doesn't open settings) */}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        title={avatar ? "Change profile picture" : "Set a profile picture"}
        className="group relative grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--color-accent)] text-[11px] font-bold text-[var(--color-bg)]"
      >
        {avatar ? (
          <img src={avatar} alt={name} className="h-full w-full object-cover" />
        ) : (
          initial
        )}
        <span className="absolute inset-0 grid place-items-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100">
          <Camera size={12} className="text-white" />
        </span>
      </button>
      <input ref={fileRef} type="file" accept="image/*" onChange={onPick} className="hidden" />

      {/* identity → settings */}
      <button
        type="button"
        onClick={() => onOpenSettings?.()}
        title="Account · settings"
        className="flex min-w-0 flex-1 items-center gap-2"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-[var(--color-text)]">{name}</div>
          <div className="truncate text-[10px] text-[var(--color-muted)]">adletic · owner</div>
        </div>
        <SettingsIcon size={13} className="text-[var(--color-muted)]" />
      </button>
    </div>
  );
}
