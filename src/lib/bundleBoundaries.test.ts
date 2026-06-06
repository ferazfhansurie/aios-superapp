// @ts-nocheck -- source-boundary regression checks run directly in node.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const hasRuntimeImport = (source: string, specifier: string) => {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^import(?!\\\\s+type)[^\\n]*from\\\\s+["']${escaped}["']`, "m").test(source);
};

test("app shell does not statically import heavy pane implementations", () => {
  const app = read("src/App.tsx");
  const forbidden = [
    "./components/ChatPane",
    "./components/EditorPane",
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
  assert.match(app, /lazy\(\(\) =>\s*import\("\.\/components\/EditorPane"\)/);
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

test("pet pane uses a seeded code-drawn 8-bit game pet", () => {
  const pane = read("src/components/PetPane.tsx");
  const idle = read("src/components/IdleControlCenter.tsx");
  const css = read("src/App.css");

  assert.match(pane, /PET_VARIANT_KEY/);
  assert.match(pane, /PET_LEGACY_VARIANT_KEY/);
  assert.match(pane, /PET_REROLL_DAILY_LIMIT/);
  assert.match(pane, /PET_REROLL_KEY/);
  assert.match(pane, /PET_ONBOARDING_KEY/);
  assert.match(pane, /ACCENT_ORDER/);
  assert.match(pane, /setAccent/);
  assert.match(pane, /accentToHex/);
  assert.match(pane, /subscribeAccent/);
  assert.match(pane, /THEME_TONES/);
  assert.match(pane, /theme locked/);
  assert.match(pane, /first hatch/);
  assert.match(pane, /chooseStarter/);
  assert.match(pane, /makeVariant/);
  assert.match(pane, /TOPPERS/);
  assert.match(pane, /PATTERNS/);
  assert.match(pane, /TAILS/);
  assert.match(pane, /variant\.tone/);
  assert.match(pane, /variant\.eyes/);
  assert.match(pane, /variant\.legs/);
  assert.match(pane, /variant\.environment/);
  assert.match(pane, /variant\.topper/);
  assert.match(pane, /variant\.pattern/);
  assert.match(pane, /variant\.tail/);
  assert.match(pane, /ACTIVITY_BY_MOOD/);
  assert.match(pane, /pet-pixel/);
  assert.match(pane, /pet-pixel-body/);
  assert.match(pane, /pet-pixel-pattern/);
  assert.match(pane, /pet-pixel-tail/);
  assert.match(pane, /pet-world/);
  assert.match(pane, /pet-job/);
  assert.match(pane, /hatch roll/);
  assert.match(pane, /PetDashboardCompanion/);
  assert.match(pane, /pet-dashboard/);
  assert.match(pane, /ask jarvis/);
  assert.match(idle, /PetDashboardCompanion/);
  assert.match(idle, /onOpenPet/);
  assert.match(pane, /disabled=\{rerollsLeft <= 0\}/);
  assert.doesNotMatch(pane, /pet-antenna/);
  assert.doesNotMatch(pane, /<img/);
  assert.match(css, /seeded code-drawn 8-bit game pet/);
  assert.match(css, /\.pet-reroll-bank/);
  assert.match(css, /\.pet-action-btn:disabled/);
  assert.match(css, /\.pet-dashboard/);
  assert.match(css, /\.pet-dashboard-canvas/);
  assert.match(css, /\.pet-hatch-onboarding/);
  assert.match(css, /\.pet-hatch-swatch/);
  assert.match(css, /\.pet-starter-card/);
  assert.match(css, /\.pet-pixel--starter/);
  assert.match(css, /\.pet-canvas--arcade/);
  assert.match(css, /\.pet-canvas--lagoon/);
  assert.match(css, /--pet-room-glow/);
  assert.match(css, /\.pet-world-avatar/);
  assert.match(css, /\.pet-job--coding/);
  assert.match(css, /\.pet-pixel-topper--horns/);
  assert.match(css, /\.pet-pixel-tail--spark/);
  assert.match(css, /\.pet-pixel-pattern--stripe/);
  assert.match(css, /\.pet-pixel/);
  assert.match(css, /image-rendering: pixelated/);
  assert.match(css, /grid-template-columns: repeat\(var\(--pet-leg-count\), 1fr\)/);
  assert.match(css, /\.pet-pixel--happy/);
  assert.match(css, /\.pet-pixel--critical/);
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

test("sidebar exposes an icon-only rail mode", () => {
  const app = read("src/App.tsx");
  const settings = read("src/lib/settings.ts");
  const settingsPane = read("src/components/Settings.tsx");

  assert.match(settings, /sidebarMode: SidebarMode/);
  assert.match(settings, /export type SidebarMode = "full" \| "icons"/);
  assert.match(settingsPane, /rail style/);
  assert.match(app, /iconsOnly/);
});

test("shell exposes a shared notification center and controls", () => {
  const app = read("src/App.tsx");
  const settings = read("src/lib/settings.ts");
  const settingsPane = read("src/components/Settings.tsx");

  assert.match(app, /NotificationCenter/);
  assert.match(app, /subscribeNotifications/);
  assert.match(app, /openNotificationTarget/);
  assert.match(app, /reattach: t\.sessionId/);
  assert.match(app, /focusPane\(pane\.key\)/);
  assert.match(settings, /notificationNativeMode: NotificationNativeMode/);
  assert.match(settingsPane, /native alerts/);
});

test("money agents open as chatpane-backed agents", () => {
  const app = read("src/App.tsx");
  const pane = read("src/components/MoneyAgentsPane.tsx");
  const section = read("src/components/MoneyAgentsSection.tsx");
  const idle = read("src/components/IdleDashboard.tsx");
  const apps = read("src/lib/apps.ts");
  const agents = read("src/lib/moneyAgents.ts");

  assert.match(apps, /\| \{ type: "money-agents" \}/);
  assert.match(apps, /agentId\?: string/);
  assert.match(apps, /modelId\?: string/);
  assert.match(app, /import\("\.\/components\/MoneyAgentsPane"\)/);
  assert.match(app, /pane\.kind\.type === "money-agents"/);
  assert.match(app, /<MoneyAgentsPane onOpenAgentChat=\{onOpenMoneyAgentChat\} \/>/);
  assert.match(app, /moneyAgentsSlot=/);
  assert.match(app, /chatpaneAgentsOnly/);
  assert.match(app, /embedded/);
  assert.match(app, /moneyAgentChatStates/);
  assert.match(app, /AGENT_CHAT_MODEL/);
  assert.match(app, /modelId=\{pane\.kind\.type === "chat" \? pane\.kind\.modelId : undefined\}/);
  assert.match(app, /focusPane\(existingPane\.key\)/);
  assert.match(app, /reattach: live\.id/);
  assert.match(app, /moneyAgentBootstrapRef/);
  assert.match(app, /setHiddenKeys\(\(current\)/);
  assert.match(app, /if \(command\) submitWhenReady\(existingPane\.key, command\);\s*else focusPane\(existingPane\.key\)/);
  assert.match(app, /if \(command\) \{\s*setHiddenKeys\(\(current\) => \(current\.includes\(key\) \? current : \[\.\.\.current, key\]\)\);/);
  assert.match(app, /buildMoneyAgentChatSeed/);
  assert.match(app, /loadMoneyAgentChatSession/);
  assert.match(app, /resume: \{ id: saved\.sessionId, title: saved\.title \}/);
  assert.match(section, /embedded/);
  assert.match(section, /createMoneyAgent/);
  assert.match(section, /new chatpane agent/);
  assert.match(section, /chatStateLabel/);
  assert.match(section, /onOpenAgentChat/);
  assert.doesNotMatch(section, /Terminal/);
  assert.match(pane, /aios sales agents/);
  assert.match(pane, /open chatpane/);
  assert.match(pane, /run sales pulse/);
  assert.match(pane, /control update for all agents/);
  assert.match(pane, /state and evidence/);
  assert.match(idle, /onOpenMoneyAgentChat/);
  assert.match(agents, /buildMoneyAgentChatSeed/);
  assert.match(agents, /buildMoneyAgentRunCommand/);
  assert.match(agents, /shell control plane/);
  assert.match(agents, /saveMoneyAgentChatSession/);
  assert.match(agents, /AGENT_CHAT_MODEL = "gpt-5\.3-codex-spark"/);
  assert.match(agents, /loadConfiguredMoneyAgents/);
  assert.match(agents, /createMoneyAgent/);
});

test("idle dashboard is a minimal home: clock + command line + usage glance, not lanes", () => {
  const app = read("src/App.tsx");
  const idle = read("src/components/IdleDashboard.tsx");
  const controlCenter = read("src/components/IdleControlCenter.tsx");
  const usageGlance = read("src/components/dashboard/UsageGlance.tsx");
  const sidebarUsage = read("src/components/SidebarUsage.tsx");

  // IdleDashboard is a thin loader that hands data to IdleControlCenter.
  assert.match(idle, /<IdleControlCenter/);
  assert.match(idle, /notifications=\{notifications\}/);

  // The home is the Option-B layout: hero clock, the seed-a-chat command line,
  // claude+codex usage via the shared ProviderBlock, recent/quick launch row.
  assert.match(controlCenter, /HeroClock/);
  assert.match(controlCenter, /CommandLine/);
  assert.match(controlCenter, /ProviderBlock/);
  assert.match(controlCenter, /useUsageRates/);
  assert.match(controlCenter, /recent/);
  assert.match(controlCenter, /QuickActions/);
  assert.match(controlCenter, /PetDashboardCompanion/);

  // The overloaded control-center lanes are gone (deleted, not just hidden).
  assert.doesNotMatch(controlCenter, /JarvisBriefingLane/);
  assert.doesNotMatch(controlCenter, /NotificationCommandLane/);
  assert.doesNotMatch(controlCenter, /AgentOperationsLane/);
  assert.doesNotMatch(controlCenter, /ControlCenterCharts/);
  assert.doesNotMatch(controlCenter, /PulseIdentityBand/);

  // usage rendering is shared: SidebarUsage aliases the dashboard UsageGlance,
  // so the sidebar + home draw the bars from one source.
  assert.match(usageGlance, /export function ProviderBlock/);
  assert.match(usageGlance, /export function useUsageRates/);
  assert.match(sidebarUsage, /UsageGlance as SidebarUsage/);

  assert.match(app, /notifications=\{notifications\}/);
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
  assert.match(chatPane, /est tok/);
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

test("shell still surfaces source build state via the source-status backend", () => {
  const chatRust = read("src-tauri/src/chat.rs");

  assert.match(chatRust, /detached\.load\(Ordering::SeqCst\) \|\| s\.busy\.load/);
  assert.match(chatRust, /stopped by user/);
  assert.match(read("src/lib/fs.ts"), /shell_source_status/);
  assert.match(read("src-tauri/src/files.rs"), /pub fn shell_source_status/);
  assert.match(read("src-tauri/src/lib.rs"), /files::shell_source_status/);
});

test("shell exposes running mac apps as attachable pane targets", () => {
  const app = read("src/App.tsx");
  const apps = read("src/lib/apps.ts");
  const pane = read("src/components/AttachAppsPane.tsx");
  const attachedPane = read("src/components/AppAttachPane.tsx");
  const bridge = read("src/lib/macApps.ts");
  const rust = read("src-tauri/src/mac_apps.rs");
  const lib = read("src-tauri/src/lib.rs");

  assert.match(app, /AttachAppsPane/);
  assert.match(app, /AppAttachPane/);
  assert.match(app, /onAttachApp/);
  assert.match(apps, /type: "apps"/);
  assert.match(apps, /type: "app"/);
  assert.match(pane, /attach as pane/);
  assert.match(pane, /focusMacApp/);
  assert.match(attachedPane, /attached external app/);
  assert.match(attachedPane, /capture preview/);
  assert.match(attachedPane, /captureMacApp/);
  assert.match(attachedPane, /fileSrc\(capturePath\)/);
  assert.match(attachedPane, /direct native window embedding is not reliable on macos/);
  assert.match(bridge, /mac_list_apps/);
  assert.match(bridge, /mac_focus_app/);
  assert.match(bridge, /mac_capture_app/);
  assert.match(rust, /MacAppInfo/);
  assert.match(rust, /screencapture/);
  assert.match(lib, /mac_apps::mac_list_apps/);
  assert.match(lib, /mac_apps::mac_focus_app/);
  assert.match(lib, /mac_apps::mac_capture_app/);
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
