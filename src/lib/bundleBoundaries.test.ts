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
    "./components/DatabasePane",
    "./components/EditorPane",
    "./components/TerminalRuntime",
    "./components/MemoryPane",
    "./components/MotionPane",
  ];

  for (const specifier of forbidden) {
    assert.equal(
      hasRuntimeImport(app, specifier),
      false,
      `${specifier} must stay behind a lazy import`,
    );
  }

  assert.match(app, /lazy\(\(\) =>\s*import\("\.\/components\/ChatPane"\)/);
  assert.match(app, /lazy\(\(\) =>\s*import\("\.\/components\/DatabasePane"\)/);
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

test("memory pane keeps three.js graph behind graph runtime", () => {
  const pane = read("src/components/MemoryPane.tsx");
  const graph = read("src/components/MemoryGraph3D.tsx");

  assert.equal(hasRuntimeImport(pane, "3d-force-graph"), false);
  assert.equal(hasRuntimeImport(pane, "three"), false);
  assert.equal(hasRuntimeImport(pane, "three/examples/jsm/postprocessing/UnrealBloomPass.js"), false);
  assert.match(pane, /import\("\.\/MemoryGraph3D"\)/);
  assert.match(graph, /3d-force-graph/);
  assert.match(graph, /from "three"/);
});

test("pet pane uses a seeded code-drawn 8-bit game pet", () => {
  const pane = read("src/components/PetPane.tsx");
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
  assert.match(pane, /disabled=\{rerollsLeft <= 0\}/);
  assert.doesNotMatch(pane, /pet-antenna/);
  assert.doesNotMatch(pane, /<img/);
  assert.match(css, /seeded code-drawn 8-bit game pet/);
  assert.match(css, /\.pet-reroll-bank/);
  assert.match(css, /\.pet-action-btn:disabled/);
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

test("sidebar usage does not render claude account usage", () => {
  const source = read("src/components/SidebarUsage.tsx");

  assert.equal(source.includes('ProviderBlock name="claude"'), false);
  assert.equal(source.includes("idleRate()"), false);
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
  assert.match(chatPane, /if \(!isTauriRuntime\(\)\) \{/);
  assert.match(chatPane, /web preview loaded\. live chat runs inside the desktop shell/);
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
  const pagesFn = read("functions/api/mirror/[room].ts");
  const workflow = read(".github/workflows/cloudflare-pages.yml");
  const wrangler = read("wrangler.jsonc");

  assert.match(app, /ensureMirrorPairing/);
  assert.match(app, /mirrorShareUrl/);
  assert.match(app, /parseMirrorSocketMessage/);
  assert.match(app, /<MirrorViewer/);
  assert.match(app, /source: "mirror"/);
  assert.match(viewer, /desktop mirror/);
  assert.match(viewer, /pixel streaming is not enabled yet/);
  assert.match(transport, /aios-superapp\.pages\.dev\/api\/mirror/);
  assert.match(transport, /#mirror=/);
  assert.match(worker, /class MirrorRoom extends DurableObject/);
  assert.match(worker, /ctx\.acceptWebSocket/);
  assert.match(worker, /type: "snapshot"/);
  assert.match(worker, /type: "control"/);
  assert.match(pagesFn, /AIOS_MIRROR\.idFromName/);
  assert.match(workflow, /wrangler@latest deploy --config workers\/mirror\/wrangler\.jsonc/);
  assert.match(wrangler, /script_name/);
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
  assert.match(app, /open source pane/);
  assert.match(app, /focusPane\(pane\.key\)/);
  assert.match(settings, /notificationNativeMode: NotificationNativeMode/);
  assert.match(settingsPane, /native alerts/);
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
  const sidebarUsage = read("src/components/SidebarUsage.tsx");
  const usagePace = read("src/lib/usagePace.ts");

  assert.match(chatPane, /usagePaceRisk/);
  assert.match(chatPane, /contextLedger/);
  assert.match(chatPane, /est tok/);
  assert.match(sidebarUsage, /PaceWarning/);
  assert.match(sidebarUsage, /usagePaceRisk/);
  assert.match(usagePace, /fast pace/);
  assert.match(usagePace, /slow down/);
});

test("gpt chatpane stop hard-stops and restarts the backend", () => {
  const chatPane = read("src/components/ChatPane.tsx");
  const state = read("src/lib/chatPaneState.ts");
  const chat = read("src/lib/chat.ts");
  const rust = read("src-tauri/src/chat.rs");

  assert.match(state, /stopStrategy/);
  assert.match(state, /kill-and-restart/);
  assert.match(chatPane, /chatStop\(id\)/);
  assert.match(chatPane, /gpt backend restarted/);
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
  assert.match(chatPane, /return "gpt-5\.3 spark"/);
  assert.match(sidebarUsage, /return "gpt-5\.3 spark"/);
  assert.match(chatPane, /\^gpt-5\\\.3-codex-spark\$/);
  assert.match(sidebarUsage, /\^gpt-5\\\.3-codex-spark\$/);
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

test("status pane surfaces long-running build status inside the shell", () => {
  const app = read("src/App.tsx");
  const apps = read("src/lib/apps.ts");
  const statusPane = read("src/components/StatusPane.tsx");
  const chatRust = read("src-tauri/src/chat.rs");

  assert.match(app, /StatusPane/);
  assert.match(app, /onReattachChat/);
  assert.match(apps, /type: "status"/);
  assert.match(statusPane, /aios-shell-tauri-build\.log/);
  assert.match(statusPane, /pending install note/);
  assert.match(statusPane, /source state/);
  assert.match(statusPane, /shellSourceStatus/);
  assert.match(statusPane, /source has changes not guaranteed to be in the installed app/);
  assert.match(statusPane, /listChatLive/);
  assert.match(statusPane, /chatStop/);
  assert.match(statusPane, /stop chat run/);
  assert.match(statusPane, /listAutomations/);
  assert.match(statusPane, /chatpane runs/);
  assert.match(statusPane, /background agents/);
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
