/** Bottom-left account row. Slimmed down — usage + activity now live on the
 *  homescreen PULSE, so this is just identity → settings. */
import { Settings as SettingsIcon } from "lucide-react";

import { getSetting } from "../lib/settings";

export function AccountMenu({
  onOpenSettings,
}: {
  onOpenSettings?: () => void;
  /** kept for call-site compatibility; the popover is gone so it's unused. */
  onOpenChange?: (open: boolean) => void;
}) {
  const name = (getSetting("userName") || "").trim() || "you";
  const initial = name.charAt(0).toLowerCase();
  return (
    <button
      onClick={() => onOpenSettings?.()}
      className="flex w-full items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1.5 text-left transition-colors hover:border-[var(--color-border-strong)]"
      title="Account · settings"
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--color-accent)] text-[10px] font-bold text-[var(--color-bg)]">
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-[var(--color-text)]">{name}</div>
        <div className="truncate text-[10px] text-[var(--color-muted)]">adletic · owner</div>
      </div>
      <SettingsIcon size={13} className="text-[var(--color-muted)]" />
    </button>
  );
}
