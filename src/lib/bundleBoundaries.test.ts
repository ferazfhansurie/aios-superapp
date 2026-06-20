// @ts-nocheck -- source-boundary regression checks run directly in node.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const exists = (path: string) => existsSync(join(root, path));
const hasRuntimeImport = (source: string, specifier: string) => {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^import(?!\\\\s+type)[^\\n]*from\\\\s+["']${escaped}["']`, "m").test(source);
};

test("app shell does not statically import heavy pane implementations", () => {
  const app = read("src/App.tsx");
  const forbidden = [
    "./components/BrowserPane",
    "./components/ChatPane",
    "./components/EditorPane",
    "./components/FilesPane",
    "./components/TerminalRuntime",
  ];

  for (const specifier of forbidden) {
    assert.equal(
      hasRuntimeImport(app, specifier),
      false,
      `${specifier} must stay behind a lazy import`,
    );
  }

  assert.match(app, /lazy\(\(\) =>\s*import\("\.\/components\/ChatPane"\)/);
  assert.match(app, /lazy\(\(\) =>\s*import\("\.\/components\/BrowserPane"\)/);
  assert.match(app, /lazy\(\(\) =>\s*import\("\.\/components\/EditorPane"\)/);
  assert.match(app, /lazy\(\(\) =>\s*import\("\.\/components\/FileViewerPane"\)/);
  assert.match(app, /lazy\(\(\) =>\s*import\("\.\/components\/FilesPane"\)/);
  assert.match(app, /lazy\(\(\) =>\s*import\("\.\/components\/TerminalPane"\)/);
  assert.doesNotMatch(app, /import\("\.\/components\/GitPane"\)/);
  assert.doesNotMatch(app, /import\("\.\/components\/MoneyAgentsPane"\)/);
  assert.doesNotMatch(app, /import\("\.\/components\/MemoryPane"\)/);
});

test("editor pane keeps monaco behind an async runtime import", () => {
  const editor = read("src/components/EditorPane.tsx");

  assert.equal(hasRuntimeImport(editor, "monaco-editor"), false);
  assert.equal(hasRuntimeImport(editor, "../lib/monaco"), false);
  assert.match(editor, /await import\("\.\.\/lib\/monaco"\)/);
});

test("terminal pane keeps xterm behind terminal runtime", () => {
  const shell = read("src/components/TerminalPane.tsx");
  const runtime = read("src/components/TerminalRuntime.tsx");

  assert.equal(shell.includes("@xterm/"), false);
  assert.match(shell, /import\("\.\/TerminalRuntime"\)/);
  assert.match(runtime, /@xterm\/xterm/);
});

test("pet system stays removed from shell surfaces", () => {
  const removedFiles = [
    "src/components/PetPane.tsx",
    "src/components/DesktopPetOverlay.tsx",
    "src/lib/pet.ts",
    "src/lib/desktopPet.ts",
    "public/pets/aios-bot/pet.json",
    "public/pets/aios-bot/spritesheet.svg",
    "public/pets/aios-bot/spritesheet.png",
    "docs/pet-concepts/aios-robot-concept-sheet.png",
  ];
  for (const file of removedFiles) {
    assert.equal(exists(file), false, `${file} should not exist`);
  }

  const app = read("src/App.tsx");
  const apps = read("src/lib/apps.ts");
  const main = read("src/main.tsx");
  const idle = read("src/components/IdleControlCenter.tsx");
  const dashboard = read("src/components/IdleDashboard.tsx");
  const chat = read("src/components/ChatPane.tsx");
  const css = read("src/App.css");
  const capabilities = read("src-tauri/capabilities/default.json");
  const tauriConfig = read("src-tauri/tauri.conf.json");

  assert.doesNotMatch(apps, /\{ type: "pet" \}/);
  assert.doesNotMatch(apps, /id: "pet"/);
  assert.doesNotMatch(app, /PetPane|type: "pet"|onOpenPet/);
  assert.doesNotMatch(main, /DesktopPetOverlay|pet-overlay/);
  assert.doesNotMatch(idle, /PetDashboardCompanion|PetPane|onOpenPet|aios-mascot|pet pane/);
  assert.doesNotMatch(dashboard, /onOpenPet/);
  assert.doesNotMatch(chat, /onPet|"\.\.\/lib\/pet"/);
  assert.doesNotMatch(css, /\.pet-|\.aios-pet-|\.aios-mascot-|aios-bot/);
  assert.doesNotMatch(capabilities, /aios-pet-overlay|allow-create|allow-set-always-on-top/);
  assert.doesNotMatch(tauriConfig, /macOSPrivateApi/);
});

test("sidebar usage renders a real claude meter (not the spark proxy)", () => {
  // The usage rendering moved to the shared UsageGlance (components/dashboard);
  // SidebarUsage is now a thin alias of it. Both surfaces draw from one source.
  const source = read("src/components/dashboard/UsageGlance.tsx");
  const sidebar = read("src/components/SidebarUsage.tsx");

  // firaz 2026-06-06: replaced the gpt-5.3-codex-spark block with a real claude
  // meter sourced from ~/.aios/state/usage.json (claude_usage → claudeRate).
  assert.match(source, /ProviderBlock name="claude"/);
  assert.match(source, /claudeRate\(\)/);
  assert.match(source, /% used/);
  assert.doesNotMatch(source, /showRemaining/);
  assert.equal(source.includes("gpt-5.3-codex-spark"), false);
  assert.equal(source.includes("idleRate()"), false);
  assert.match(sidebar, /UsageGlance as SidebarUsage/);
});

test("browser video fullscreen avoids macos native space transition", () => {
  const source = read("src-tauri/src/browser.rs");

  assert.match(source, /set_simple_fullscreen\(on\)/);
});

test("web shell guards tauri-only runtime APIs", () => {
  const app = read("src/App.tsx");
  const chatPane = read("src/components/ChatPane.tsx");
  const terminalRuntime = read("src/components/TerminalRuntime.tsx");
  const tauri = read("src/lib/tauri.ts");
  const fs = read("src/lib/fs.ts");

  assert.match(tauri, /function isTauriRuntime/);
  assert.match(tauri, /__TAURI_INTERNALS__/);
  assert.match(tauri, /Promise\.reject\(new Error\(`tauri runtime unavailable/);
  assert.match(app, /import \{ isTauriRuntime \} from "\.\/lib\/tauri"/);
  assert.match(app, /if \(!isTauriRuntime\(\)\) return;\s+void getCurrentWindow\(\)\.startDragging\(\)\.catch/);
  assert.match(app, /if \(!isTauriRuntime\(\)\) return;\s+let disposed = false/);
  assert.match(app, /const win = getCurrentWindow\(\)/);
  assert.match(app, /await win\.hide\(\)\.catch/);
  assert.match(app, /if \(!isTauriRuntime\(\)\) return;\s+\/\/ Resolve the pane key/);
  assert.match(app, /onDragDropEvent/);
  assert.match(fs, /if \(!isTauriRuntime\(\)\) return path/);
  assert.match(chatPane, /if \(webChatRuntime\) \{/);
  assert.match(chatPane, /webChatSend\(wire/);
  assert.doesNotMatch(chatPane, /web preview loaded\. live chat runs inside the desktop shell/);
  assert.match(chatPane, /url: fileSrc\(path\)/);
  assert.doesNotMatch(chatPane, /convertFileSrc/);
  assert.match(terminalRuntime, /if \(!isTauriRuntime\(\)\) \{/);
  assert.match(terminalRuntime, /terminal panes run inside the desktop shell/);
});

test("web mirror uses a cloudflare durable object transport", () => {
  const app = read("src/App.tsx");
  const viewer = read("src/components/MirrorViewer.tsx");
  const transport = read("src/lib/mirrorTransport.ts");
  const worker = read("workers/mirror/src/index.ts");
  const workflow = read(".github/workflows/cloudflare-pages.yml");

  assert.match(app, /ensureMirrorPairing/);
  assert.match(app, /mirrorShareUrl/);
  assert.match(app, /parseMirrorSocketMessage/);
  assert.match(app, /<MirrorViewer/);
  assert.match(app, /source: "mirror"/);
  assert.match(viewer, /desktop mirror/);
  assert.match(viewer, /pixel streaming is not enabled yet/);
  assert.match(transport, /aios-mirror-worker\.firazfhansurie\.workers\.dev/);
  assert.match(transport, /#mirror=/);
  assert.match(worker, /class MirrorRoom extends DurableObject/);
  assert.match(worker, /ctx\.acceptWebSocket/);
  assert.match(worker, /type: "snapshot"/);
  assert.match(worker, /type: "control"/);
  assert.match(workflow, /wrangler@latest deploy --config workers\/mirror\/wrangler\.jsonc/);
});

test("hosted web opens the real shell unless the url is a mirror link", () => {
  const app = read("src/App.tsx");

  assert.match(app, /const webMirrorMode = !nativeRuntime && mirrorPairing != null/);
  assert.match(app, /if \(webMirrorMode\) \{/);
  assert.doesNotMatch(app, /if \(!nativeRuntime\) \{\s+return \(\s+<MirrorViewer/);
  assert.match(app, /if \(panes\.length === 0\) return idleDash/);
});

test("hosted web chat uses a cloud chat transport instead of a dead preview", () => {
  const chatPane = read("src/components/ChatPane.tsx");
  const chatLib = read("src/lib/chat.ts");
  const fn = read("functions/api/chat.ts");

  assert.match(chatLib, /export async function webChatSend/);
  assert.match(chatLib, /fetch\("\/api\/chat"/);
  assert.match(chatPane, /const webChatRuntime = !nativeRuntime/);
  assert.match(chatPane, /webChatSend\(wire/);
  assert.doesNotMatch(chatPane, /web preview loaded\. live chat runs inside the desktop shell/);
  assert.match(fn, /OPENAI_API_KEY/);
  assert.match(fn, /AIOS_CHAT_MODEL/);
  assert.match(fn, /https:\/\/api\.openai\.com\/v1\/responses/);
});

test("hosted web shell is mobile and ipad first", () => {
  const app = read("src/App.tsx");

  assert.match(app, /const compactWebLayout = !nativeRuntime && webViewportCompact/);
  assert.match(app, /matchMedia\("\(max-width: 1024px\)"/);
  assert.match(app, /useState\(\(\) => !\(!nativeRuntime && window\.matchMedia/);
  assert.match(app, /if \(compactWebLayout\) return \{ cols: 1, rows: n \}/);
  assert.match(app, /sidebarOpen && !compactWebLayout/);
  assert.match(app, /compactWebLayout && \(\s+<MobileBottomNav/);
  assert.match(app, /function MobileBottomNav/);
});

test("superapp runtime keeps core panes plus local file/editor surfaces", () => {
  const app = read("src/App.tsx");
  const apps = read("src/lib/apps.ts");
  const commands = read("src/lib/appCommands.ts");
  const sidebar = read("src/lib/sidebar.ts");
  const paneBus = read("src/lib/paneBus.ts");
  const palette = read("src/components/CommandPalette.tsx");
  const settings = read("src/components/Settings.tsx");

  for (const id of ["chat", "terminal", "files", "browser", "history"]) {
    assert.match(apps, new RegExp(`id: "${id}"`));
  }
  for (const cut of ["notes", "memory", "git", "chrome", "appcast", "apps", "money-agents"]) {
    assert.doesNotMatch(apps, new RegExp(`id: "${cut}"`));
  }

  assert.match(app, /const EditorPane = lazy/);
  assert.match(app, /const FileViewerPane = lazy/);
  assert.doesNotMatch(app, /AttachAppsPane|AppAttachPane|AppCastPane|BridgesPane|CdpChromePane|GitPane|MoneyAgentsPane|MemoryPane|NotesPane|PluginsPane|PulsePane/);
  assert.doesNotMatch(app, /moneyAgentBootstrapRef|loadConfiguredMoneyAgents|buildMoneyAgentRunCommand|MoneyAgentsSection|OracleRoster/);
  assert.doesNotMatch(commands, /oracle\.attach|project\.run\.(?!focused)|project\.rescan|oracle\.appshot|app\.settings\.open/);
  assert.doesNotMatch(palette, /CdpChromePane|dev\.cdp-chrome|cdp spike/);
  assert.doesNotMatch(settings, /BridgesPane|PluginsPane|channels|plugins/);
  assert.match(sidebar, /SCHEMA_VERSION = 6/);
  assert.match(paneBus, /export type SpawnPaneKind = "terminal" \| "files" \| "browser" \| "chat"/);
});

test("idle dashboard renders instantly without mount-time data loaders", () => {
  const idle = read("src/components/IdleDashboard.tsx");
  const controlCenter = read("src/components/IdleControlCenter.tsx");

  assert.doesNotMatch(idle, /usageExtras|idleRate|memoryFocus|gitPulse|loadMoneyAgentSummaries|pm2List|setInterval|windowVisible|useUsageRates|ProviderBlock/);
  assert.doesNotMatch(controlCenter, /useUsageRates|ProviderBlock|claudeRate|codexRate/);
  assert.doesNotMatch(controlCenter, /MemoryFocus|RepoPulse|MoneyAgentSummary|AiosNotification|Pm2Monitor|StatusFooter|AmbientLine|Flame|Target|GitBranch/);
  assert.match(controlCenter, /const CORE_LAUNCHERS/);
  assert.match(controlCenter, /new browser/);
  assert.match(controlCenter, /new files/);
});

test("sidebar exposes an icon-only rail mode", () => {
  const app = read("src/App.tsx");
  const settings = read("src/lib/settings.ts");
  const settingsPane = read("src/components/Settings.tsx");

  assert.match(settings, /sidebarMode: SidebarMode/);
  assert.match(settings, /export type SidebarMode = "full" \| "icons"/);
  assert.match(settingsPane, /rail style/);
  assert.match(app, /iconsOnly/);
});

test("sidebar keeps usage visible outside the idle dashboard", () => {
  const app = read("src/App.tsx");
  const sidebarUsage = read("src/components/SidebarUsage.tsx");
  const controlCenter = read("src/components/IdleControlCenter.tsx");

  assert.match(sidebarUsage, /UsageGlance as SidebarUsage/);
  assert.match(app, /<SidebarUsage \/>/);
  assert.doesNotMatch(controlCenter, /SidebarUsage|UsageGlance|useUsageRates/);
});

test("notification center pane is cut from the core shell runtime", () => {
  const app = read("src/App.tsx");
  const settings = read("src/lib/settings.ts");
  const settingsPane = read("src/components/Settings.tsx");
  const commands = read("src/lib/appCommands.ts");
  const apps = read("src/lib/apps.ts");

  assert.doesNotMatch(app, /NotificationCenter|subscribeNotifications|openNotificationTarget|openNotificationsPane/);
  assert.doesNotMatch(apps, /id: "notifications"/);
  assert.doesNotMatch(commands, /notifications|notification center/i);
  assert.match(settings, /notificationNativeMode: NotificationNativeMode/);
  assert.match(settingsPane, /native alerts/);
});

test("money agents are cut from the core shell runtime", () => {
  const app = read("src/App.tsx");
  const idle = read("src/components/IdleDashboard.tsx");
  const controlCenter = read("src/components/IdleControlCenter.tsx");
  const apps = read("src/lib/apps.ts");
  const chatPane = read("src/components/ChatPane.tsx");

  assert.doesNotMatch(apps, /id: "money-agents"|agentId\?:/);
  assert.doesNotMatch(app, /MoneyAgentsPane|MoneyAgentsSection|moneyAgent|loadConfiguredMoneyAgents|buildMoneyAgentRunCommand/);
  assert.doesNotMatch(idle, /onOpenMoneyAgentChat|MoneyAgent/);
  assert.doesNotMatch(controlCenter, /MoneyAgent/);
  assert.doesNotMatch(chatPane, /moneyAgents|saveMoneyAgentChatSession/);
});

test("idle dashboard is a minimal home: clock + command line + usage glance, not lanes", () => {
  const app = read("src/App.tsx");
  const idle = read("src/components/IdleDashboard.tsx");
  const controlCenter = read("src/components/IdleControlCenter.tsx");
  const usageGlance = read("src/components/dashboard/UsageGlance.tsx");
  const sidebarUsage = read("src/components/SidebarUsage.tsx");

  // IdleDashboard is a pure wrapper: no mount-time loaders before the dashboard
  // appears. The instant control center owns only local clock state.
  assert.match(idle, /<IdleControlCenter/);
  assert.doesNotMatch(idle, /useEffect|setInterval|load[A-Z]|pm2List|gitPulse|notifications=\{notifications\}/);

  // The home is core-only: hero clock, command line, and direct launchers for
  // chat/terminal/browser/files. Usage polling belongs outside the idle route.
  assert.match(controlCenter, /HeroClock/);
  assert.match(controlCenter, /CommandLine/);
  assert.doesNotMatch(controlCenter, /ProviderBlock|useUsageRates/);
  assert.match(controlCenter, /CORE_LAUNCHERS/);
  assert.match(controlCenter, /new chat/);
  assert.match(controlCenter, /new terminal/);
  assert.match(controlCenter, /new browser/);
  assert.match(controlCenter, /new files/);
  assert.match(controlCenter, /QuickActions/);
  assert.doesNotMatch(controlCenter, /PetDashboardCompanion/);

  // The overloaded control-center lanes are gone (deleted, not just hidden).
  assert.doesNotMatch(controlCenter, /JarvisBriefingLane|NotificationCommandLane|AgentOperationsLane|ControlCenterCharts|PulseIdentityBand/);
  assert.doesNotMatch(controlCenter, /RecentProjects|StatusFooter|Pm2Monitor|AmbientLine|MoneyAgent|RepoPulse|MemoryFocus/);

  // usage rendering is shared: SidebarUsage aliases the dashboard UsageGlance,
  // so the sidebar + home draw the bars from one source.
  assert.match(usageGlance, /export function ProviderBlock/);
  assert.match(usageGlance, /export function useUsageRates/);
  assert.match(sidebarUsage, /UsageGlance as SidebarUsage/);
  assert.doesNotMatch(app, /notifications=\{notifications\}/);
});

test("sidebar leaves session resume to history and in-chat resume", () => {
  const app = read("src/App.tsx");
  const commands = read("src/lib/appCommands.ts");

  assert.doesNotMatch(app, /latestSessions|LatestSessionsSection|onResumeChat|resumeChat|setChats|listChatSessions|ChatSessionInfo/);
  assert.doesNotMatch(commands, /ChatSessionInfo|deps\.chats|resumeChat|chat\.resume/);
  assert.match(app, /HistoryPane/);
  assert.match(app, /recordPaneHistory/);
});

test("chat panes opened from sidebar history hydrate the resumed transcript", () => {
  const chatPane = read("src/components/ChatPane.tsx");

  assert.match(chatPane, /useEffect\(\(\) => \{[\s\S]*const incomingResume = resume;[\s\S]*shouldApplyResumeProp\(incomingResume\.id, ownSessionIdsRef\.current\)[\s\S]*readChatTranscript\(incomingResume\.id\)[\s\S]*setTurns\(transcriptToTurns\(rows\)\)/);
});

test("pane history is a lightweight core pane with reopen and cleanup controls", () => {
  const app = read("src/App.tsx");
  const apps = read("src/lib/apps.ts");
  const layout = read("src/lib/paneLayout.ts");
  const tauriLib = read("src-tauri/src/lib.rs");

  assert.equal(exists("src/lib/paneHistory.ts"), true);
  assert.equal(exists("src/components/HistoryPane.tsx"), true);
  assert.equal(exists("src-tauri/src/pane_history.rs"), true);
  const history = read("src/lib/paneHistory.ts");
  const pane = read("src/components/HistoryPane.tsx");
  const rustHistory = read("src-tauri/src/pane_history.rs");

  assert.match(apps, /id: "history"/);
  assert.match(apps, /type: "history"/);
  assert.match(layout, /"history"/);
  assert.match(app, /HistoryPane/);
  assert.match(app, /recordPaneHistory/);
  assert.match(app, /onOpenHistoryItem/);
  assert.match(history, /describePaneHistoryItem/);
  assert.match(history, /paneHistoryKindLabel/);
  assert.match(history, /removePaneHistory/);
  assert.match(history, /clearPaneHistory/);
  assert.match(history, /hydratePaneHistoryStore/);
  assert.match(history, /load_pane_history/);
  assert.match(history, /save_pane_history/);
  assert.match(pane, /reopen/);
  assert.match(pane, /delete/);
  assert.match(pane, /clear all/);
  assert.match(pane, /hydratePaneHistoryStore/);
  assert.match(rustHistory, /\.aios\/state\/pane-history\.json/);
  assert.match(rustHistory, /pub fn load_pane_history/);
  assert.match(rustHistory, /pub fn save_pane_history/);
  assert.match(rustHistory, /with_extension\("json\.tmp"\)/);
  assert.match(rustHistory, /std::fs::rename\(&tmp, &path\)/);
  assert.match(tauriLib, /mod pane_history/);
  assert.match(tauriLib, /pane_history::load_pane_history/);
  assert.match(tauriLib, /pane_history::save_pane_history/);
  assert.doesNotMatch(pane, /kind\.resume\.title[\s\S]*item\.detail/);
  assert.doesNotMatch(pane, /useUsageRates|claudeRate|codexRate|listChatSessions/);
});

test("pane overview is button driven, not a global scroll gesture", () => {
  const app = read("src/App.tsx");

  assert.match(app, /Show all panes/);
  assert.equal(app.includes('addEventListener("wheel", onWheel'), false);
  assert.equal(app.includes("wheelAccum"), false);
});

test("top bar can be compacted or hidden", () => {
  const app = read("src/App.tsx");
  const settings = read("src/lib/settings.ts");
  const settingsPane = read("src/components/Settings.tsx");
  const commands = read("src/lib/appCommands.ts");

  assert.match(settings, /topBarMode: TopBarMode/);
  assert.match(settings, /export type TopBarMode = "full" \| "compact" \| "hidden"/);
  assert.match(settings, /topBarMode: "hidden"/);
  assert.match(settings, /parsed\.topBarMode === "full" \|\| parsed\.topBarMode === "compact"/);
  assert.match(settingsPane, /top bar/);
  assert.match(app, /topBarMode === "hidden"/);
  assert.doesNotMatch(app, /uppercase tracking-\[0\.2em\][\s\S]*superapp/);
  assert.match(app, /className="glass flex h-7 shrink-0/);
  assert.match(commands, /view\.topbar\.hide/);
  assert.match(commands, /view\.topbar\.compact/);
  assert.doesNotMatch(app, /ThemeSwitcher/);
  assert.doesNotMatch(app, /superapp/i);
  assert.doesNotMatch(settingsPane, /superapp/i);
  assert.match(settingsPane, /prompt<\/span>/);
});

test("command palette promotes chatpane intelligence for freeform search", () => {
  const app = read("src/App.tsx");
  const palette = read("src/components/CommandPalette.tsx");

  assert.match(palette, /onAsk/);
  assert.match(palette, /onDeepSearch/);
  assert.match(palette, /ask aios:/);
  assert.match(palette, /deep search:/);
  assert.match(app, /askFromPalette/);
  assert.match(app, /deepSearchFromPalette/);
  assert.match(app, /type: "chat", seed: query/);
});

test("codex usage surfaces pace-risk warnings", () => {
  const chatPane = read("src/components/ChatPane.tsx");
  // pace-risk rendering lives in the shared UsageGlance (sidebar + idle home).
  const usageGlance = read("src/components/dashboard/UsageGlance.tsx");
  const usagePace = read("src/lib/usagePace.ts");

  assert.match(chatPane, /usagePaceRisk/);
  assert.match(chatPane, /contextLedger/);
  assert.match(chatPane, /tok next send/);
  assert.match(usageGlance, /PaceWarning/);
  assert.match(usageGlance, /usagePaceRisk/);
  assert.match(usagePace, /fast pace/);
  assert.match(usagePace, /slow down/);
});

test("chatpane stop: codex interrupts, only opencode kill-restarts", () => {
  const chatPane = read("src/components/ChatPane.tsx");
  const state = read("src/lib/chatPaneState.ts");
  const chat = read("src/lib/chat.ts");
  const rust = read("src-tauri/src/chat.rs");

  assert.match(state, /stopStrategy/);
  // Round-1 parity: codex now stops via turn/interrupt (keeps the persistent
  // app-server + thread); only opencode still kill-and-restarts.
  assert.match(state, /kill-and-restart/);
  assert.match(state, /"interrupt"/);
  assert.match(rust, /codex_interrupt/);
  assert.match(chatPane, /chatStop\(id\)/);
  assert.match(chatPane, /backend restarted/);
  assert.match(chatPane, /backendBusy/);
  assert.match(chatPane, /activeRunRef\.current = streaming \|\| backendBusy/);
  assert.match(chatPane, /busy: \(\) => activeRunRef\.current/);
  assert.match(chat, /ChatReattachInfo/);
  assert.match(rust, /ChatReattachInfo/);
});

test("codex chatpane uses terminal-grade codex context by default", () => {
  const rust = read("src-tauri/src/chat.rs");
  const chat = read("src/lib/chat.ts");

  assert.match(rust, /deliberately uses the user's real `~\/\.codex`/);
  assert.match(rust, /AIOS_CODEX_FAST_HOME/);
  assert.match(rust, /let fast = fast_requested \|\| fast_env;/);
  assert.match(rust, /start_codex_appserver[\s\S]*if let Some\(ch\) = codex_chat_home\(fast\)/);
  assert.match(rust, /params\["model"\] = json!\(m\)/);
  assert.match(chat, /gpt-5\.3-codex-spark/);
  assert.match(chat, /gpt-5\.5/);
});

test("spark model labeling is explicitly gpt-5.3, never 5.5", () => {
  const chatPane = read("src/components/ChatPane.tsx");
  const sidebarUsage = read("src/components/SidebarUsage.tsx");
  const chat = read("src/lib/chat.ts");
  const source = [chatPane, sidebarUsage, chat].join("\n");

  assert.match(chat, /id: "gpt-5\.3-codex-spark"/);
  // SidebarUsage no longer labels spark (its block became the claude meter);
  // the spark model labeling now lives only in the chat model picker.
  assert.match(chatPane, /return "gpt-5\.3 spark"/);
  assert.match(chatPane, /\^gpt-5\\\.3-codex-spark\$/);
  assert.doesNotMatch(source, /5\.5[^"\n]*spark|spark[^"\n]*5\.5/i);
  assert.doesNotMatch(chatPane, /return "spark"/);
}
);

test("chatpane handoff can target any model", () => {
  const chatPane = read("src/components/ChatPane.tsx");

  assert.match(chatPane, /handoffPanelOpen/);
  assert.match(chatPane, /handoff target/);
  assert.match(chatPane, /CHAT_MODELS\.map\(\(target\)/);
  assert.match(chatPane, /continuing this exact session in \$\{target\.label\}/);
});

test("chatpane does not auto-timeout long agent runs", () => {
  const chatPane = read("src/components/ChatPane.tsx");

  assert.doesNotMatch(chatPane, /request timed out after 2 minutes/);
  assert.doesNotMatch(chatPane, /turnTimeoutRef/);
});

test("chatpane memory search is explicit slash command only", () => {
  const chatPane = read("src/components/ChatPane.tsx");

  assert.match(chatPane, /id: "memory"/);
  assert.match(chatPane, /setMemoryPanelOpen\(true\)/);
  assert.match(chatPane, /memoryPanelOpen &&/);
  assert.doesNotMatch(chatPane, /q\.length < 4/);
});

test("memory pane is cut; chat memory stays inline", () => {
  const app = read("src/App.tsx");
  const apps = read("src/lib/apps.ts");
  const chatPane = read("src/components/ChatPane.tsx");
  const rust = read("src-tauri/src/memory.rs");
  const lib = read("src-tauri/src/lib.rs");

  assert.doesNotMatch(apps, /id: "memory"/);
  assert.doesNotMatch(app, /MemoryPane|type: "memory"/);
  assert.match(chatPane, /memoryPanelOpen/);
  assert.match(chatPane, /setMemoryPanelOpen\(true\)/);
  assert.match(chatPane, /memorySearch\(/);
  assert.doesNotMatch(chatPane, /spawnPane\("memory"/);
  assert.match(rust, /fn vault_dirs\(\)/);
  assert.match(rust, /pub fn memory_save_raw/);
  assert.match(lib, /memory::memory_save_raw/);
});

test("claude usage prefers live claude web session before stale local fallbacks", () => {
  const usage = read("src-tauri/src/usage.rs");
  const dashboard = read("src/lib/dashboard.ts");

  assert.match(usage, /claude_usage_from_webview/);
  assert.match(usage, /claude_usage_from_helper/);
  assert.match(usage, /getAllCookies/);
  assert.match(usage, /claude\.ai\/api\/organizations/);
  assert.match(usage, /api\.anthropic\.com\/api\/oauth\/usage/);
  assert.match(usage, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(usage, /oauth-2025-04-20/);
  assert.match(dashboard, /Anthropic OAuth API/);
  const webFirst = usage.indexOf("claude_usage_from_webview(app)");
  const oauthSecond = usage.indexOf("claude_usage_from_oauth()");
  const helperThird = usage.indexOf("claude_usage_from_helper()");
  assert.ok(webFirst >= 0, "claude webview usage source must exist");
  assert.ok(oauthSecond > webFirst, "oauth fallback must come after the live web source");
  assert.ok(helperThird > oauthSecond, "helper fallback must not mask oauth usage");
});

test("shell still surfaces source build state via the source-status backend", () => {
  const chatRust = read("src-tauri/src/chat.rs");

  assert.match(chatRust, /detached\.load\(Ordering::SeqCst\) \|\| s\.busy\.load/);
  assert.match(chatRust, /stopped by user/);
  assert.match(read("src/lib/fs.ts"), /shell_source_status/);
  assert.match(read("src-tauri/src/files.rs"), /pub fn shell_source_status/);
  assert.match(read("src-tauri/src/lib.rs"), /files::shell_source_status/);
});

test("mac app attach panes are cut from the core shell runtime", () => {
  const app = read("src/App.tsx");
  const apps = read("src/lib/apps.ts");
  const rust = read("src-tauri/src/mac_apps.rs");
  const lib = read("src-tauri/src/lib.rs");

  assert.doesNotMatch(app, /AttachAppsPane|AppAttachPane|onAttachApp/);
  assert.doesNotMatch(apps, /id: "apps"/);
  assert.match(rust, /MacAppInfo/);
  assert.match(rust, /screencapture/);
  assert.match(lib, /mac_apps::mac_list_apps/);
  assert.match(lib, /mac_apps::mac_focus_app/);
  assert.match(lib, /mac_apps::mac_capture_app/);
});

test("appcast separates screen recording from accessibility control", () => {
  const pane = read("src/components/AppCastPane.tsx");
  const rust = read("src-tauri/src/appcast.rs");

  assert.match(pane, /ACCESSIBILITY_SETTINGS_URL/);
  assert.match(pane, /Privacy_Accessibility/);
  assert.match(pane, /isAccessibilityDeclined/);
  assert.match(pane, /no mirrorable windows found/);
  assert.doesNotMatch(pane, /m\.includes\("no capturable windows"\)/);
  assert.match(pane, /Accessibility not enabled/);
  assert.match(pane, /control mirrored windows/);
  assert.match(rust, /AXIsProcessTrusted/);
  assert.match(rust, /AXIsProcessTrustedWithOptions/);
  assert.match(rust, /AXTrustedCheckOptionPrompt/);
  assert.match(rust, /accessibility_trusted/);
  assert.match(rust, /accessibility_trusted_or_prompt/);
  assert.match(rust, /Accessibility not enabled/);
});

test("local mac install keeps a stable tcc identity", () => {
  const pkg = read("package.json");
  const script = read("scripts/install-mac-local.sh");

  assert.match(pkg, /"install:mac-local": "bash scripts\/install-mac-local\.sh"/);
  assert.match(script, /tauri -- build --bundles app --no-sign/);
  assert.match(script, /stable_requirement='=designated => identifier "com\.adletic\.aios"'/);
  assert.match(script, /codesign --force --deep --sign - --requirements "\$stable_requirement"/);
  assert.match(script, /codesign --verify --deep --strict "\$installed_app"/);
});

test("native browser and appcast panes resync through fullscreen settle", () => {
  const browser = read("src/components/BrowserPane.tsx");
  const appcast = read("src/components/AppCastPane.tsx");

  for (const source of [browser, appcast]) {
    assert.match(source, /syncSettled/);
    assert.match(source, /fullscreenchange/);
  }
  // AppCast still uses the staged settle cadence, with a slow 1s safety poll.
  assert.match(appcast, /\[40, 120, 260, 520, 900\]/);
  assert.match(appcast, /setInterval\(\(\) => sync\(\), 1000\)/);
  // BrowserPane was reworked: debounced settle (no timer storm) + RO-driven
  // bounds with a slow 1s safety poll instead of the 250ms hammer.
  assert.match(browser, /resizeTimer = setTimeout\(sync, 120\)/);
  assert.match(browser, /setInterval\(sync, 1000\)/);
  assert.match(browser, /new ResizeObserver\(sync\)/);
});

test("background utility panes are not mounted by the core shell runtime", () => {
  const app = read("src/App.tsx");

  assert.doesNotMatch(app, /windowVisible|visibilitychange|listChatSessions/);
  assert.doesNotMatch(app, /<NotesPane|<BridgesPane|<PulsePane|<AppAttachPane/);
  assert.doesNotMatch(app, /import\("\.\/components\/NotesPane"\)|import\("\.\/components\/BridgesPane"\)|import\("\.\/components\/PulsePane"\)/);
  assert.doesNotMatch(app, /import\("\.\/components\/AppAttachPane"\)/);
});

test("files pane exposes fast core workspace context actions", () => {
  const files = read("src/components/FilesPane.tsx");

  assert.match(files, /detectProject/);
  assert.match(files, /contextMenu/);
  assert.match(files, /onContextMenu/);
  assert.match(files, /runContextProject/);
  assert.match(files, /copyPath/);
  assert.match(files, /openContextTerminal/);
  assert.match(files, /openContextDefault/);
  assert.match(files, /openContextEditor/);
  assert.match(files, /openContextViewer/);
  assert.match(files, /openContextChat/);
  assert.match(files, /open containing files pane/);
  assert.doesNotMatch(files, /openContextGit|openGitPane|spawnPane\("git"|gitStatus|gitDecorations/);
});

test("git pane is cut from the core shell runtime", () => {
  const app = read("src/App.tsx");
  const apps = read("src/lib/apps.ts");
  const paneBus = read("src/lib/paneBus.ts");
  const tauriFiles = read("src-tauri/src/files.rs");
  const tauriLib = read("src-tauri/src/lib.rs");
  const filesPane = read("src/components/FilesPane.tsx");

  assert.doesNotMatch(apps, /id: "git"/);
  assert.doesNotMatch(app, /GitPane|pane\.kind\.type === "git"|type: "git"/);
  assert.doesNotMatch(paneBus, /"git"/);
  assert.doesNotMatch(filesPane, /spawnPane\("git"|openContextGit|gitStatus/);
  assert.match(tauriFiles, /pub fn git_snapshot/);
  assert.match(tauriFiles, /pub fn git_checkout/);
  assert.match(tauriLib, /files::git_snapshot/);
  assert.match(tauriLib, /files::git_checkout/);
});

test("global appshot attaches to chat instead of only the focused webview", () => {
  const app = read("src/App.tsx");
  const pty = read("src/lib/pty.ts");
  const oracles = read("src-tauri/src/oracles.rs");
  const lib = read("src-tauri/src/lib.rs");
  const commands = read("src/lib/appCommands.ts");

  assert.equal(exists("src-tauri/src/global_monitor.rs"), true);
  assert.match(lib, /mod global_monitor/);
  assert.match(lib, /global_monitor::start\(app\.handle\(\)\.clone\(\)\)/);
  assert.match(lib, /oracles::appshot_capture/);
  assert.match(oracles, /pub fn appshot_capture/);
  assert.match(pty, /export async function appshotCapture/);
  assert.match(app, /import \{ appshotCapture/);
  assert.match(app, /listen<\{ source: string \}>\("global-appshot"/);
  assert.match(app, /paneImageDrop\.get\(key\)/);
  assert.match(app, /appshot attached to chat/);
  assert.doesNotMatch(commands, /appshot - attach to chat|oracle\.appshot/);
  assert.doesNotMatch(commands, /screenshot to oracle/);
});

test("closing panes is visually instant even for busy chats", () => {
  const app = read("src/App.tsx");

  assert.match(app, /if \(handle\?\.busy\(\)\) handle\.detach\(true\);[\s\S]*closePane\(key\)/);
  assert.doesNotMatch(app, /setClosePrompt\(key\)/);
  assert.doesNotMatch(app, /this chat is still working/);
});

test("chatpane autoscroll follows live output until user scrolls away", () => {
  const chatPane = read("src/components/ChatPane.tsx");
  const scroll = read("src/lib/chatScroll.ts");

  assert.match(chatPane, /useLayoutEffect/);
  assert.match(chatPane, /nextAutoscrollPaused/);
  assert.match(chatPane, /syncJumpVisibility/);
  assert.match(chatPane, /distanceFromBottom/);
  assert.match(chatPane, /scroll to bottom/);
  assert.match(chatPane, /lastArrowDownRef/);
  assert.match(chatPane, /e\.key === "ArrowDown" && !overlay/);
  assert.match(chatPane, /jumpToLatest\(\)/);
  assert.match(scroll, /nextAutoscrollPaused/);
});

test("chatpane pending steer queue stays attached to the shared composer", () => {
  const chatPane = read("src/components/ChatPane.tsx");
  const composerStart = chatPane.indexOf("const composer = useMemo");
  const queueStart = chatPane.indexOf("pending steer queue belongs with the composer");
  const composerShell = chatPane.indexOf("flash-composer", queueStart);
  const dockStart = chatPane.indexOf("shrink-0 border-t border-[var(--color-border)]");

  assert.notEqual(composerStart, -1);
  assert.ok(queueStart > composerStart, "queued steer list must render inside the shared composer");
  assert.ok(composerShell > queueStart, "queued steer list must sit above the composer input shell");
  assert.ok(dockStart > composerShell, "queued steer list must not be owned only by the docked footer");
  assert.match(chatPane, /steerQueued\(q\.id\)/);
  assert.match(chatPane, /moveQueued\(q\.id, -1\)/);
  assert.match(chatPane, /editQueued\(q\)/);
});

test("chatpane docked composer can collapse and reopen", () => {
  const chatPane = read("src/components/ChatPane.tsx");
  const composerStart = chatPane.indexOf("const composer = useMemo");
  const dockStart = chatPane.indexOf("shrink-0 border-t border-[var(--color-border)]");
  const hideButton = chatPane.indexOf("hide composer");
  const showButton = chatPane.indexOf("show composer");

  assert.notEqual(composerStart, -1);
  assert.notEqual(dockStart, -1);
  assert.ok(hideButton > composerStart, "hide control must live with the composer");
  assert.ok(showButton > dockStart, "reopen control must be available in the docked footer");
  assert.match(chatPane, /isComposerCollapsed/);
  assert.match(chatPane, /setComposerCollapsed\(true\)/);
  assert.match(chatPane, /setComposerCollapsed\(false\)/);
});

test("chat panes receive concrete cwd for shell context", () => {
  const app = read("src/App.tsx");
  const apps = read("src/lib/apps.ts");

  assert.match(apps, /type: "chat";[\s\S]*cwd\?: string/);
  assert.match(app, /const chatCwd = pane\.kind\.type === "chat"/);
  assert.match(app, /<ChatPane[\s\S]*cwd=\{chatCwd\}/);
});

test("shell exposes a policy-gated agent control bridge", () => {
  const app = read("src/App.tsx");
  const actions = read("src/lib/agentActions.ts");
  const controller = read("src/lib/agentController.ts");

  assert.match(app, /__aiosAgentControl/);
  assert.match(app, /aios-agent-action/);
  assert.match(actions, /agentActionPolicy/);
  assert.match(actions, /requires confirmation/);
  assert.match(controller, /createAgentController/);
  assert.match(controller, /!policy\.allowed/);
});

test("mac bundle uses stable development signing for tcc permissions", () => {
  const tauri = read("src-tauri/tauri.conf.json");

  assert.equal(tauri.includes('"signingIdentity": "-"'), false);
  assert.match(tauri, /Apple Development: Firaz Fhansurie \(KL78M575FW\)/);
  assert.match(tauri, /"entitlements": "\.\/Entitlements\.plist"/);
});
