/** Instant home screen for the core shell. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  Folder,
  Globe,
  History,
  MessageSquare,
  PanelLeft,
  Search,
  Terminal,
} from "lucide-react";

import type { AppDef } from "../App";
import type { SidebarItem, SidebarState } from "../lib/sidebar";
import { MissionBoard } from "./MissionBoard";

const CORE_LAUNCHERS: Array<{
  label: string;
  hint: string;
  icon: ReactNode;
  kind: AppDef["kind"];
}> = [
  { label: "new chat", hint: "chat", icon: <MessageSquare size={14} />, kind: { type: "chat" } },
  { label: "new terminal", hint: "shell", icon: <Terminal size={14} />, kind: { type: "shell" } },
  { label: "new browser", hint: "web", icon: <Globe size={14} />, kind: { type: "browser" } },
  { label: "new files", hint: "files", icon: <Folder size={14} />, kind: { type: "files" } },
  { label: "history", hint: "open", icon: <History size={14} />, kind: { type: "history" } },
];

export function IdleControlCenter({
  sidebar,
  onSpawn,
  onOpenSidebarItem,
  onRevealSidebar,
  onOpenPalette,
  onTalkToJarvis,
}: {
  sidebar: SidebarState;
  onSpawn: (kind: AppDef["kind"], label: string) => void;
  onOpenSidebarItem: (item: SidebarItem) => void;
  onRevealSidebar: () => void;
  onOpenPalette: () => void;
  onTalkToJarvis: (seed: string) => void;
}) {
  const pinned = sidebar.items
    .filter((item) => item.group === "pinned" && !item.hidden)
    .slice(0, 8);

  return (
    <div className="relative h-full min-h-0 overflow-y-auto">
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-[1100px] flex-col gap-4 px-6 py-6">
        <div className="flex shrink-0 flex-col items-center gap-5">
          <div className="flex flex-col items-center gap-2 text-center">
            <Greeting />
            <HeroClock />
          </div>

          <div className="w-full max-w-[760px]">
            <CommandLine onSeedChat={onTalkToJarvis} onOpenPalette={onOpenPalette} />
          </div>
        </div>

        <MissionBoard />
        <QuickActions onSpawn={onSpawn} onOpenPalette={onOpenPalette} onRevealSidebar={onRevealSidebar} />
        {pinned.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center justify-center gap-1.5 border-t border-[var(--color-border)] pt-3">
            {pinned.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpenSidebarItem(item)}
                className="rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]/40 px-2.5 py-1 text-[11px] text-[var(--color-text-2)] transition-colors hover:border-[color-mix(in_srgb,var(--color-accent)_45%,var(--color-border))] hover:text-[var(--color-text)]"
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Greeting() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const t = window.setInterval(tick, 30_000);
    return () => window.clearInterval(t);
  }, []);
  const h = now.getHours();
  const part =
    h < 5 ? "still up" : h < 12 ? "good morning" : h < 18 ? "good afternoon" : "good evening";
  return (
    <div className="aios-fade-in flex flex-col items-center gap-1">
      <span className="text-[15px] font-medium tracking-tight text-[var(--color-text-2)]">
        {part}, <span className="aios-greet-name">firaz</span>
      </span>
      <span className="font-mono text-[11px] tracking-[0.08em] text-[var(--color-muted)]">
        {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }).toLowerCase()}
      </span>
    </div>
  );
}

function HeroClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return (
    <div className="aios-fade-in flex items-baseline justify-center gap-2 font-mono tabular-nums text-[var(--color-text)]" style={{ animationDelay: "40ms" }}>
      <span className="text-[clamp(44px,7vw,86px)] font-light leading-none">{hh}</span>
      <span className="aios-colon text-[clamp(44px,7vw,86px)] font-light leading-none text-[var(--color-accent)]">:</span>
      <span className="text-[clamp(44px,7vw,86px)] font-light leading-none">{mm}</span>
      <span className="self-end pb-[0.45vw] font-mono text-[clamp(13px,1.5vw,18px)] font-light leading-none tracking-tight text-[var(--color-faint)]">{ss}</span>
    </div>
  );
}

function CommandLine({
  onSeedChat,
  onOpenPalette,
}: {
  onSeedChat: (seed: string) => void;
  onOpenPalette: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text) {
      onOpenPalette();
      return;
    }
    onSeedChat(text);
    setValue("");
  }, [value, onSeedChat, onOpenPalette]);

  const hasContent = value.trim().length > 0;

  return (
    <form
      className="aios-fade-in w-full"
      style={{ animationDelay: "80ms" }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="group/cmd relative flex items-center gap-3 overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-gradient-to-b from-[var(--color-panel-2)]/80 to-[var(--color-panel-2)]/55 px-4 py-3 shadow-2xl shadow-black/40 backdrop-blur transition-all duration-300 focus-within:border-[var(--color-accent)]/60 focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_50%,transparent),0_18px_50px_-12px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]">
        <span className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-gradient-to-r from-transparent via-[var(--color-accent)] to-transparent opacity-0 transition-opacity duration-500 group-focus-within/cmd:opacity-80" />
        <Search
          size={17}
          className="shrink-0 text-[var(--color-muted)] transition-colors group-focus-within/cmd:text-[var(--color-accent)]"
        />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          placeholder="start something... ask, launch, or resume"
          className="min-w-0 flex-1 bg-transparent font-sans text-[15px] leading-relaxed text-[var(--color-text)] caret-[var(--color-accent)] placeholder:text-[var(--color-faint)] focus:outline-none"
        />
        {hasContent ? (
          <button
            type="submit"
            title="start a chat with this"
            className="group/send grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[var(--color-accent)] to-[color-mix(in_srgb,var(--color-accent)_62%,#000)] text-[var(--color-accent-fg)] shadow-[0_2px_12px_-2px_color-mix(in_srgb,var(--color-accent)_70%,transparent)] transition-all duration-200 hover:scale-110 hover:shadow-[0_4px_22px_-2px_var(--color-accent)] active:scale-90"
          >
            <ArrowUp size={16} className="transition-transform duration-200 group-hover/send:-translate-y-0.5" />
          </button>
        ) : (
          <kbd className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
            cmd k
          </kbd>
        )}
      </div>
    </form>
  );
}

function QuickActions({
  onSpawn,
  onOpenPalette,
  onRevealSidebar,
}: {
  onSpawn: (kind: AppDef["kind"], label: string) => void;
  onOpenPalette: () => void;
  onRevealSidebar: () => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {CORE_LAUNCHERS.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => onSpawn(action.kind, action.label.replace(/^new /, ""))}
          className="group flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/35 px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]/45 hover:bg-[var(--color-panel-2)]"
        >
          <span className="text-[var(--color-muted)] group-hover:text-[var(--color-accent)]">{action.icon}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">{action.label}</span>
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">{action.hint}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={onOpenPalette}
        className="group flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/35 px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]/45 hover:bg-[var(--color-panel-2)]"
      >
        <Search size={14} className="text-[var(--color-muted)] group-hover:text-[var(--color-accent)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">palette</span>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">cmd k</span>
      </button>
      <button
        type="button"
        onClick={onRevealSidebar}
        className="group flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/35 px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]/45 hover:bg-[var(--color-panel-2)]"
      >
        <PanelLeft size={14} className="text-[var(--color-muted)] group-hover:text-[var(--color-accent)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-2)] group-hover:text-[var(--color-text)]">rail</span>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-faint)]">spaces</span>
      </button>
    </div>
  );
}
