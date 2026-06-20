import type { ReactElement } from "react";
import type { PaneContent } from "../lib/apps";
import type { SidebarItem } from "../lib/sidebar";

export type AppIconKey =
  | "aios"
  | "agent"
  | "browser"
  | "chat"
  | "chrome"
  | "discord"
  | "editor"
  | "file"
  | "files"
  | "github"
  | "google"
  | "history"
  | "loop"
  | "mission"
  | "panes"
  | "pin"
  | "settings"
  | "studio"
  | "terminal"
  | "ticket"
  | "whatsapp"
  | "youtube";

type IconProps = {
  size?: number;
  className?: string;
  title?: string;
};

type MarkProps = {
  title?: string;
};

const CORE_BY_APP_ID: Record<string, AppIconKey> = {
  browser: "browser",
  chat: "chat",
  files: "files",
  history: "history",
  loop: "loop",
  mission: "mission",
  terminal: "terminal",
  ticket: "ticket",
};

const CUSTOM_BY_ICON_NAME: Record<string, AppIconKey> = {
  bot: "agent",
  browser: "browser",
  chat: "chat",
  contacts: "whatsapp",
  files: "files",
  layers: "panes",
  pin: "pin",
  settings: "settings",
  studio: "studio",
  terminal: "terminal",
};

function textHaystack(...values: Array<string | undefined | null>): string {
  return values.filter(Boolean).join(" ").toLowerCase();
}

export function brandIconKeyFor(value?: string | null): AppIconKey | null {
  const text = textHaystack(value);
  if (!text) return null;
  if (text.includes("discord") || text.includes("discord.gg")) return "discord";
  if (text.includes("whatsapp") || text.includes("wa.me")) return "whatsapp";
  if (text.includes("youtube") || text.includes("youtu.be")) return "youtube";
  if (text.includes("github.com") || text === "github" || text.includes(" github ")) return "github";
  if (text.includes("google.") || text === "google" || text.includes(" chrome ")) return "google";
  if (text.includes("chrome")) return "chrome";
  return null;
}

export function iconKeyForAppId(appId?: string | null): AppIconKey {
  return CORE_BY_APP_ID[appId ?? ""] ?? "aios";
}

export function iconKeyForPane(kind: PaneContent, label?: string): AppIconKey {
  if (kind.type === "browser") return brandIconKeyFor(textHaystack(kind.url, label)) ?? "browser";
  if (kind.type === "chat") return "chat";
  if (kind.type === "files") return "files";
  if (kind.type === "history") return "history";
  if (kind.type === "mission") return "mission";
  if (kind.type === "loop") return "loop";
  if (kind.type === "ticket") return "ticket";
  if (kind.type === "editor") return "editor";
  if (kind.type === "file") return "file";
  if (kind.type === "shell" || kind.type === "oracle" || kind.type === "tmux") return "terminal";
  if (kind.type === "app") return brandIconKeyFor(textHaystack(kind.name, kind.bundleId, label)) ?? "aios";
  return brandIconKeyFor(label) ?? "aios";
}

export function iconKeyForSidebarItem(item: Pick<SidebarItem, "iconName" | "kind" | "label">): AppIconKey {
  if (item.kind.type === "app") return iconKeyForAppId(item.kind.appId);
  return (
    brandIconKeyFor(textHaystack(item.kind.url, item.label)) ??
    CUSTOM_BY_ICON_NAME[item.iconName] ??
    "browser"
  );
}

function Svg({
  size,
  className,
  title,
  children,
}: IconProps & { children: ReactElement | ReactElement[] }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

function AiosMark({ title }: MarkProps) {
  return (
    <>
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id="aios-a" x1="4" x2="20" y1="20" y2="4" gradientUnits="userSpaceOnUse">
          <stop stopColor="#39D98A" />
          <stop offset="0.52" stopColor="#45B7FF" />
          <stop offset="1" stopColor="#A78BFA" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="9" fill="url(#aios-a)" />
      <path d="M7.5 13.7 10.5 7h3l3 6.7M9 11.7h6" fill="none" stroke="#06110D" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

function ChatMark() {
  return (
    <>
      <rect x="3" y="5" width="18" height="13" rx="5" fill="#22C55E" />
      <path d="M8.5 18.2 6.2 21v-4.2" fill="#22C55E" />
      <circle cx="9" cy="11.5" r="1.15" fill="#052E16" />
      <circle cx="12" cy="11.5" r="1.15" fill="#052E16" />
      <circle cx="15" cy="11.5" r="1.15" fill="#052E16" />
    </>
  );
}

function TerminalMark() {
  return (
    <>
      <rect x="3" y="4" width="18" height="16" rx="4" fill="#05070A" />
      <rect x="4.5" y="5.5" width="15" height="13" rx="2.5" fill="#111827" />
      <path d="m8 10 2.4 2L8 14m4 1h4" fill="none" stroke="#39FF88" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

function FilesMark() {
  return (
    <>
      <path d="M3.2 7.7c0-1.2 1-2.2 2.2-2.2h4.4l2 2.2h6.8c1.2 0 2.2 1 2.2 2.2v7.4c0 1.2-1 2.2-2.2 2.2H5.4c-1.2 0-2.2-1-2.2-2.2Z" fill="#4AA3FF" />
      <path d="M3.7 10.2h16.6l-1.2 7.3c-.2 1.1-1.1 2-2.2 2H5.3c-1.1 0-2-.8-2.2-1.9Z" fill="#78C7FF" />
    </>
  );
}

function BrowserMark() {
  return (
    <>
      <circle cx="12" cy="12" r="9" fill="#FACC15" />
      <path d="M12 12 5.2 7.1A9 9 0 0 1 20.3 8H12Z" fill="#EF4444" />
      <path d="M12 12h8.3A9 9 0 0 1 8.2 20.2Z" fill="#22C55E" />
      <path d="M12 12 8.2 20.2A9 9 0 0 1 5.2 7.1Z" fill="#FACC15" />
      <circle cx="12" cy="12" r="4.1" fill="#2563EB" stroke="#E8F2FF" strokeWidth="1.3" />
    </>
  );
}

function HistoryMark() {
  return (
    <>
      <circle cx="12" cy="12" r="8.5" fill="#7C3AED" />
      <path d="M8 7.6 5.2 8V5.3" fill="none" stroke="#C4B5FD" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.6 8a7 7 0 1 1-1 5" fill="none" stroke="#F5F3FF" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12 8.2V12l2.6 1.7" fill="none" stroke="#F5F3FF" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

function MissionMark() {
  return (
    <>
      <circle cx="12" cy="12" r="8.7" fill="#F59E0B" />
      <circle cx="12" cy="12" r="5.2" fill="#FFF7ED" />
      <circle cx="12" cy="12" r="2.1" fill="#EF4444" />
      <path d="M12 3v3m0 12v3m9-9h-3M6 12H3" stroke="#7C2D12" strokeWidth="1.3" strokeLinecap="round" />
    </>
  );
}

function LoopMark() {
  return (
    <>
      <rect x="3" y="4" width="18" height="16" rx="6" fill="#06B6D4" />
      <path d="M8 9h5.2c2 0 3.6 1.6 3.6 3.6S15.2 16.2 13.2 16.2H7.4" fill="none" stroke="#ECFEFF" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m9.2 6.8-2.4 2.3 2.4 2.3M14.7 18.5l2.4-2.3-2.4-2.3" fill="none" stroke="#083344" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

function TicketMark() {
  return (
    <>
      <path d="M5 6h14v4a2 2 0 0 0 0 4v4H5v-4a2 2 0 0 0 0-4Z" fill="#FB7185" />
      <path d="M9 8v8" stroke="#881337" strokeWidth="1.3" strokeLinecap="round" strokeDasharray="1.5 2.2" />
      <path d="M12 10h4M12 14h3" stroke="#FFF1F2" strokeWidth="1.4" strokeLinecap="round" />
    </>
  );
}

function PanesMark() {
  return (
    <>
      <rect x="4" y="5" width="7" height="6" rx="1.8" fill="#60A5FA" />
      <rect x="13" y="5" width="7" height="6" rx="1.8" fill="#A78BFA" />
      <rect x="4" y="13" width="7" height="6" rx="1.8" fill="#34D399" />
      <rect x="13" y="13" width="7" height="6" rx="1.8" fill="#FBBF24" />
    </>
  );
}

function AgentMark() {
  return (
    <>
      <rect x="4" y="6" width="16" height="12" rx="5" fill="#A78BFA" />
      <path d="M12 3.8v2.4" stroke="#F5F3FF" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="9" cy="12" r="1.4" fill="#2E1065" />
      <circle cx="15" cy="12" r="1.4" fill="#2E1065" />
      <path d="M9.4 15h5.2" stroke="#F5F3FF" strokeWidth="1.4" strokeLinecap="round" />
    </>
  );
}

function EditorMark() {
  return (
    <>
      <path d="M6 3.8h8.5L19 8.3v11.9H6Z" fill="#8B5CF6" />
      <path d="M14.5 3.8v4.5H19" fill="#C4B5FD" />
      <path d="m10 11-2 2 2 2m4-4 2 2-2 2" fill="none" stroke="#F5F3FF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

function FileMark() {
  return (
    <>
      <path d="M6 3.8h8.5L19 8.3v11.9H6Z" fill="#E5E7EB" />
      <path d="M14.5 3.8v4.5H19" fill="#93C5FD" />
      <path d="M9 12h6M9 15h5" stroke="#2563EB" strokeWidth="1.4" strokeLinecap="round" />
    </>
  );
}

function PinMark() {
  return (
    <>
      <circle cx="12" cy="12" r="8.5" fill="#EF4444" />
      <path d="m9.8 7.5 6.7 6.7M14.9 8.6l.5 3.2 2.1 2.1-3.6 3.6-2.1-2.1-3.2-.5Z" fill="#FEE2E2" />
    </>
  );
}

function SettingsMark() {
  return (
    <>
      <circle cx="12" cy="12" r="8.5" fill="#64748B" />
      <path d="M12 7.4v1.3m0 6.6v1.3m4.6-4.6h-1.3M8.7 12H7.4m7.8-3.2-.9.9m-4.6 4.6-.9.9m6.4 0-.9-.9M9.7 9.7l-.9-.9" stroke="#F8FAFC" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.6" fill="#CBD5E1" />
    </>
  );
}

function StudioMark() {
  return (
    <>
      <rect x="4" y="4" width="16" height="16" rx="5" fill="#EC4899" />
      <path d="m8 15 7-7m-1.4-.7 3.1 3.1M7.4 7.7l1.1.3.3 1.1.3-1.1 1.1-.3-1.1-.3-.3-1.1-.3 1.1Zm8.7 7.3 1.3.4.4 1.3.4-1.3 1.3-.4-1.3-.4-.4-1.3-.4 1.3Z" fill="none" stroke="#FFF1F2" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

function DiscordMark() {
  return (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="5" fill="#5865F2" />
      <path d="M8 9.5c2.6-1 5.4-1 8 0l.8 5c-2.5 1.8-3.7 1.8-3.7 1.8l-.5-1.1c-1 .2-1.8.2-2.8 0l-.5 1.1s-1.2 0-3.7-1.8Z" fill="#fff" />
      <circle cx="10" cy="12.2" r="1" fill="#5865F2" />
      <circle cx="14" cy="12.2" r="1" fill="#5865F2" />
    </>
  );
}

function WhatsappMark() {
  return (
    <>
      <circle cx="12" cy="12" r="9" fill="#25D366" />
      <path d="m7.3 19 1-3.1a6.3 6.3 0 1 1 2.5 1.7Z" fill="#fff" />
      <path d="M9.4 8.6c.2-.4.4-.4.7-.4h.5c.2 0 .4.1.5.4l.7 1.7c.1.3.1.5-.1.7l-.5.6c.8 1.3 1.8 2.2 3.2 2.8l.7-.8c.2-.2.4-.2.7-.1l1.6.8c.3.1.4.3.4.6-.1.9-.8 1.7-1.7 1.7-2.9-.1-7.5-3.8-7.7-7 0-.4.2-.8.5-1Z" fill="#25D366" />
    </>
  );
}

function YoutubeMark() {
  return (
    <>
      <rect x="3" y="6" width="18" height="12" rx="4" fill="#FF0000" />
      <path d="m10.5 9.2 5 2.8-5 2.8Z" fill="#fff" />
    </>
  );
}

function GithubMark() {
  return (
    <>
      <circle cx="12" cy="12" r="9" fill="#181717" />
      <path d="M9.3 18.5v-2.1c-2.5.6-3-1-3-1-.4-1-.9-1.3-.9-1.3-.7-.5.1-.5.1-.5.8.1 1.2.9 1.2.9.7 1.2 1.9.9 2.4.7.1-.5.3-.9.5-1.1-2-.2-4.1-1-4.1-4.4 0-1 .3-1.8.9-2.4-.1-.2-.4-1.1.1-2.3 0 0 .7-.2 2.4.9a8.2 8.2 0 0 1 4.4 0c1.7-1.1 2.4-.9 2.4-.9.5 1.2.2 2.1.1 2.3.6.6.9 1.4.9 2.4 0 3.4-2.1 4.2-4.1 4.4.3.3.6.8.6 1.7v3.1" fill="#fff" />
    </>
  );
}

function GoogleMark() {
  return (
    <>
      <path d="M21 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.1a4.4 4.4 0 0 1-1.9 2.9v2.4h3.1c1.8-1.7 2.7-4.1 2.7-7Z" fill="#4285F4" />
      <path d="M12 21c2.6 0 4.7-.8 6.3-2.3l-3.1-2.4c-.9.6-2 .9-3.2.9-2.5 0-4.6-1.7-5.3-3.9H3.5v2.5A9 9 0 0 0 12 21Z" fill="#34A853" />
      <path d="M6.7 13.3a5.4 5.4 0 0 1 0-3.4V7.4H3.5a9 9 0 0 0 0 8.2Z" fill="#FBBC05" />
      <path d="M12 6.8c1.4 0 2.7.5 3.7 1.5l2.7-2.7A9 9 0 0 0 3.5 7.4l3.2 2.5C7.4 8.5 9.5 6.8 12 6.8Z" fill="#EA4335" />
    </>
  );
}

function ChromeMark() {
  return <BrowserMark />;
}

const MARKS: Record<AppIconKey, () => ReactElement> = {
  aios: () => <AiosMark />,
  agent: AgentMark,
  browser: BrowserMark,
  chat: ChatMark,
  chrome: ChromeMark,
  discord: DiscordMark,
  editor: EditorMark,
  file: FileMark,
  files: FilesMark,
  github: GithubMark,
  google: GoogleMark,
  history: HistoryMark,
  loop: LoopMark,
  mission: MissionMark,
  panes: PanesMark,
  pin: PinMark,
  settings: SettingsMark,
  studio: StudioMark,
  terminal: TerminalMark,
  ticket: TicketMark,
  whatsapp: WhatsappMark,
  youtube: YoutubeMark,
};

export function AppSvgIcon({ name, size = 16, className, title }: IconProps & { name: AppIconKey }) {
  const Mark = MARKS[name] ?? MARKS.aios;
  return (
    <Svg size={size} className={className} title={title}>
      <Mark />
    </Svg>
  );
}
