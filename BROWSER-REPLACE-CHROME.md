# BROWSER — replacing Chrome inside the AIOS shell

Research + design. **No source touched.** Goal: firaz never opens Chrome (or any
browser) again — the AIOS browser pane handles all browsing and *feels* like a
full browser. This doc assesses the current pane, evaluates the three honest
architectural paths with current (June 2026) facts, and recommends a phased plan.

The browser pane is owned by this session's code map below; the SCK app-cast
spike (`SPIKE-screencapturekit.md`) is the overlapping capture+input infra for
the CDP path. Where a piece would hook into existing code, file:line is given.

---

## 0. TL;DR — the recommendation up front

**WKWebView will never *be* Chrome.** It's Safari's engine (Blink ≠ WebKit), and
three things are *fundamentally* impossible on it, verified below:

1. **No Chrome/Web-Store extensions, ever** — uBlock Origin, 1Password, etc.
   WKWebView (in-app embedded) has *no* access to Safari Web Extensions either.
2. **No Widevine DRM** — Netflix (needs Widevine VMP), Spotify Web Player,
   Amazon Prime degrade or break. WebKit has FairPlay, but the *sites* gate on
   Widevine for non-Safari engines.
3. **Chrome-only / PWA-gated flows** — Teams dropped Safari PWA install (mid-2025),
   Google Meet historically blocks Safari, some sites sniff Chrome and degrade.

So "never need Chrome again" cannot be reached by polishing WebKit alone. But the
*vast majority* of browsing (Google, Gmail, GitHub, Vercel, X, Notion, YouTube —
YouTube works on WebKit) is fine on WKWebView today, and the things that make a
browser *feel* whole (history, bookmarks, autofill, downloads UI, session
restore) are **engine-independent** and worth building first regardless of path.

**Recommended: hybrid, phased.**

- **Phase 1 (do now, any path): cross-cutting UX completeness on WebKit.**
  Persistent history + address-bar autocomplete, bookmarks (firaz already has
  pinned sites — promote to first-class), downloads manager UI, session restore,
  credential autofill via macOS Keychain. These close 80% of the "feels like a
  toy" gap and are pure value on *every* path. ~2–3 weeks.
- **Phase 2 (the engine escape hatch): a second "real Chrome" pane via CDP**,
  driving a **dedicated AIOS-managed Chrome profile** (NOT the default profile —
  Chrome 136+ forbids that, see §4), surfaced through the *exact same*
  capture+input architecture as the SCK app-cast spike. This is the only path
  that gives real Blink + Widevine + the user's logins/extensions while staying a
  solo-dev OSS app. WKWebView stays the default fast pane; the CDP pane is the
  "open this in real Chrome" button for the ~15% WebKit can't do.
- **CEF (embed Chromium): keep on the shelf, not now.** It's the *technically*
  cleanest "real browser inside the pane" — `cef` crate is tauri-co-owned, at
  CEF 148 (Chromium 148, May 30 2026), all three platforms — but +200MB bundle,
  multi-helper-process codesign/notarization, and it replaces the engine rather
  than composing with WebKit. Revisit only if the CDP pane's puppeteering UX
  proves too janky AND firaz wants Widevine/extensions natively in-app.

Why CDP over CEF for Phase 2: CDP reuses the SCK spike's capture+input infra
(near-zero *new* architectural risk), adds ~0 to the bundle, and gives the user's
*actual* Chrome (their real Widevine license, real extensions, real logins). CEF
gives a *fresh* Chromium with none of the user's state and a fat binary. For a
"never open Chrome again" wedge where the user already *has* Chrome installed,
puppeteering the real thing beats shipping a second one.

The honest catch on CDP (§4): **screencast is base64-per-frame with an ack
round-trip → laggy**, and you can't drive the *default* profile. So the CDP pane
is a "heavy compatibility surface," not the everyday fast pane. That's exactly
why it's the *second* pane, not the replacement.

---

## 1. Current baseline (what we already have)

Architecture: native child **WKWebView** floated over the React layer,
bounds-synced to a slot div. wry 0.55.1 / tauri 2.11.2, `unstable` feature for
`Window::add_child`. macOS reaches the raw `WKWebView` through
`objc2-web-kit` 0.3 via `with_webview(pw.inner())`.

| Capability | Where | Notes |
|---|---|---|
| Native child webview create/show | `browser.rs:166-337` `browser_show` | async (Windows `add_child` deadlock note `:159-165`); `window.add_child` at `:310-316` |
| Bounds sync (rAF + ResizeObserver + poll) | `BrowserPane.tsx` slot rect → `browserSetBounds` | mirror target for SCK spike |
| Honest UA (Safari on mac, Chrome on Win) | `browser.rs:25-30` | Safari UA so Google OAuth doesn't flag a fake-Chrome fingerprint |
| Per-profile cookie partitions | `browser.rs:139-154, 304-307` `data_store_identifier` | multi-account; macOS-only (`WKWebsiteDataStore`) |
| Native back/fwd/reload/reloadFromOrigin | `browser.rs:445-499` | real WKWebView selectors, not JS-history hacks |
| Nav state (canGoBack/Forward) | `browser.rs:505-525` | real history read |
| DevTools (in release) | `browser.rs:530-535` + Cargo `devtools` feature | |
| Find-in-page | `browser.rs:542-601` | WebKit has no match-COUNT → found/not-found only |
| Real cookie/cache clear | `browser.rs:652-742` | reaches HttpOnly + on-disk via `WKWebsiteDataStore` |
| Native page zoom (persists) | `browser.rs:635-646` `setPageZoom` | |
| Element fullscreen + true window FS | `browser.rs:320-335, 377-417` | YouTube video FS works |
| Standard adblock (content rules) | `browser.rs:57-128` | WKContentRuleList, NOT uBlock — hardcoded ruleset |
| tab=pane / popup handling | `browser.rs:288-300` `on_new_window` → `browser-new-pane` | OAuth popups = transient children |
| Downloads → open-in-pane | `browser.rs:252-287` `on_download` | emits `browser-download`; **no downloads-manager UI yet** |
| Region screenshot | `browser.rs:779-859` `screencapture -R` | one-shot; needs Screen Recording |
| Annotate / selection→chat (clipboard bridge) | `browser.rs:886-1067` | AIOS-native, not a browser feature |
| Pinned sites (sidebar) | `App.tsx:726-727, 3046`; `lib/sidebar` | the seed of a bookmarks system |
| Per-pane URL memory | `lib/browser-mem` (`rememberUrl`) | session-restore primitive already exists |

Signing: `tauri.conf.json:45-46` — ad-hoc `Apple Development: Firaz…`, hardened
runtime, **not sandboxed** (`Entitlements.plist`). The repo already ate the
hardened-runtime TCC lesson (mic), documented in `Entitlements.plist`.

**What's MISSING to feel like a full browser (engine-independent):**
history (no persistent visited-URL store / no address-bar autocomplete beyond
the current pane's memory), real bookmarks UI (pinned sites are close but not a
bookmark bar/manager), a downloads manager (downloads open but aren't listed/
re-openable), password manager / autofill (none — every login is typed), session
restore across app restart (per-pane memory exists, no "reopen all tabs"),
multi-profile *account picker* UX (partitions exist, the picker is minimal).

---

## 2. Path 1 — Polish WebKit (stay on wry/WKWebView)

### What it CAN become (close the UX gaps)
All of these are buildable on the current native-WKWebView base, no engine change:

- **Persistent history + address-bar autocomplete.** New `history.rs` (or fold
  into `browser.rs`) writing a small SQLite table (`sqlx` is already a dep,
  Cargo.toml). Hook the write on `on_navigation` / `on_page_load:finished`
  (`browser.rs:223-251` already emits every navigation). Autocomplete = a
  frontend query against that store in the address bar (`BrowserPane.tsx` input).
- **Bookmarks, first-class.** Promote pinned sites (`lib/sidebar`, `App.tsx`) into
  a bookmarks model + a bookmark bar in `BrowserPane.tsx` chrome. The `addLink`
  path (`BrowserPane.tsx:63`) is already wired.
- **Downloads manager UI.** The native download events already fire
  (`browser.rs:252-287`). Add a downloads store + a panel listing
  name/path/status with re-open/reveal-in-Finder. Pure frontend + a thin Rust
  `reveal_in_finder` command.
- **Credential autofill / password manager.** Two sub-options:
  - **macOS Keychain (recommended).** A Rust command set (`keychain.rs`) using
    the `security-framework` crate to read/write generic passwords keyed by
    origin; inject on form-focus via `wv.eval`. Honest, OS-native, no new vault to
    secure. *Limitation:* not as slick as Chrome's autofill; you build the
    detect-form + offer-to-save UX yourself.
  - **Built-in vault** (SQLite + OS-keychain-sealed master key). More work, more
    attack surface. Skip for solo-dev unless Keychain proves insufficient.
- **Multi-profile accounts.** Partitions already exist (`browser.rs:139-154`).
  Build a proper account-picker (avatar chips) in the chrome; persist
  per-profile favicons/names.
- **Session restore.** Per-pane URL memory (`lib/browser-mem`) → extend to a
  full "open panes" snapshot persisted on quit, restored on launch.
- **PDF / media.** WKWebView renders PDF natively; HTML5 media works; YouTube
  (incl. fullscreen) works (`browser.rs:320-335`).

Effort for the above bundle: ~2–3 weeks solo. **All of it is reusable on every
path** — this is Phase 1 no matter what.

### What WebKit FUNDAMENTALLY CANNOT do (verified, June 2026)
- **No Chrome extensions AND no Safari Web Extensions in an embedded webview.**
  An embedded WKWebView has *no* access to extensions — confirmed: "WebKit views
  (in-app/embedded browser) do not have access to extensions." So uBlock Origin,
  password-manager extensions, etc. are simply not loadable. The only ad-blocking
  is `WKContentRuleList` (what `browser.rs:57-128` already does) — a static
  declarative ruleset, far weaker than uBlock's dynamic filtering. (Standalone
  Safari.app got *uBO Lite* in Aug 2025, a stripped MV3 content-blocker — but
  that's the Safari *browser*, not anything we can load into our WKWebView.)
- **No Widevine DRM.** iOS/macOS WKWebView does not support Widevine, and
  critically does not support Widevine **VMP (Verified Media Path)** which
  **Netflix requires**. WebKit's DRM is **FairPlay** (AVFoundation, CBCS). Real
  breakage:
  - **Netflix** — breaks (requires Widevine VMP; FairPlay path is Safari-app +
    native HLS, not reliably available to an embedded webview).
  - **Spotify Web Player** — Widevine-gated → breaks/refuses.
  - **Amazon Prime Video, HBO Max, Hulu (web)** — Widevine-first; degrade to
    SD or refuse on non-Safari engines.
  - **YouTube** — works (no Widevine gate for normal playback). **Apple TV+** —
    works (FairPlay). So it's the *Widevine* services specifically that die.
- **Chrome-only / PWA-gated sites.** Microsoft **Teams** removed Safari PWA
  install (mid-2025); docs list only Edge/Chrome. **Google Meet** has a long
  history of blocking/degrading Safari. Sites that sniff Chrome (some Google
  properties, Amazon video) serve degraded experiences to WebKit; WebKit even
  ships UA-quirks to *pretend to be Chrome* for some of them — which is exactly
  the brittleness our `browser.rs:25-30` UA note dances around.
- **DevTools differences.** WebKit Web Inspector ≠ Chrome DevTools — different
  panels, no Lighthouse, no full CDP. Fine for casual use, not parity for a
  web dev who lives in Chrome DevTools.

### Verdict on Path 1
Compatibility: ~85% of real browsing, **0% of Widevine streaming + extensions +
Chrome-gated apps.** Effort: low (incremental on a working base). Bundle: zero
added. UX fidelity: high *for what WebKit supports*. Distance to "never need
Chrome": **cannot reach it** — there's a hard floor at Netflix/Spotify/Teams/
extensions. **Conclusion: necessary (Phase 1) but not sufficient.**

---

## 3. Path 2 — Embed Chromium (CEF / Blink-based webview)

### Facts (June 2026)
- **`cef` crate (tauri-co-owned, `tauri-apps/cef-rs`).** Active: 297 releases,
  ~1,079 commits on dev. Latest **cef-v148.3.0+148.0.9** (Chromium 148, dated
  **May 30 2026**) — i.e. tracking current Chromium within weeks. macOS x86_64 +
  ARM64 supported (also Linux + Windows, both arches). There is a `feat/cef`
  branch in `tauri-apps/tauri` exploring first-class integration, **but CEF is
  NOT a standard option in Tauri 2.x today** — you'd wire `cef` yourself, parallel
  to (not through) the existing wry webview.
- **Widevine: enabled by default since CEF M93.** The CDM auto-downloads shortly
  after app start. So **Netflix/Spotify/Prime would work** in a CEF pane —
  modulo VMP provisioning, which has historically needed extra setup on some CEF
  versions (CEF issue #3820 "widevine on recent versions seems to not work out of
  the box"). Plan for a provisioning shakeout, not a free win.
- **Chrome extensions (MV3): partial/limited.** CEF has historical extension
  support but it is **not full Chrome-Web-Store MV3 parity**; loading uBlock-class
  extensions reliably is a known rough edge, not a checkbox. Treat extensions as
  "maybe, with effort," not a guarantee.
- **Bundle size + build.** The CEF framework alone is ~106MB; with libs + helper
  apps an app reaches **~200MB**. macOS structure:
  `Contents/Frameworks/Chromium Embedded Framework.framework` + `.pak` resources +
  V8 snapshots + **multiple helper apps** (renderer/GPU/plugin). Today's AIOS
  bundle is a few tens of MB; CEF makes it an order of magnitude bigger.
- **Signing/notarization.** Each helper app *and* the framework must be
  individually codesigned with the hardened runtime, in the right order, then the
  outer app notarized. This is the single biggest solo-dev tax — the repo is
  currently *ad-hoc* signed (`tauri.conf.json:45`); CEF essentially forces a
  proper Developer-ID + notarization pipeline. Doable, but it's real ongoing
  build complexity (universal `cef.framework` builds are a known forum headache).

### Where it would hook
This is a *second engine*, not a tweak. You'd add a `cef.rs` module that creates a
CEF browser view and floats it as a child — conceptually mirroring
`browser.rs:310-316` `window.add_child`, but CEF manages its own OSR/windowed
view and process model rather than a wry `WebviewBuilder`. The bounds-sync loop
in `BrowserPane.tsx` could be reused; everything below (UA, content rules, the
objc2 WKWebView selectors) is WebKit-specific and would NOT carry over.

### Verdict on Path 2
Compatibility: **highest** — real Blink, Widevine, near-full site compat,
possibly-extensions. Effort: **high** — new engine, process model, signing/
notarization overhaul. Bundle: **+~200MB** + multi-helper signing. UX fidelity:
Chrome-grade. Distance to "never need Chrome": **closest of the three** — it's
literally Chromium in the pane. **But** for a solo OSS dev it's the heaviest lift,
and it ships a *fresh* Chromium with none of firaz's existing logins/extensions/
Widevine license — he'd re-login everywhere. **Conclusion: the "right" answer in a
vacuum; wrong cost/benefit for now. Shelve as the fallback if CDP UX fails.**

---

## 4. Path 3 — Drive the user's REAL Chrome via CDP

The north-star wedge: control the *actual installed Chrome* (real profile,
extensions, logins, Widevine license) and surface it inside an AIOS pane via
capture+input — composing directly with the SCK spike's architecture.

### How it works
- **Launch Chrome with `--remote-debugging-port=9222 --user-data-dir=<dir>`.**
  Connect over CDP (`/json/version` → WebSocket).
- **Surface it in a pane.** Two compositing options:
  1. **CDP-native: `Page.startScreencast`** → base64 JPEG frames streamed to the
     frontend, drawn to a canvas; forward input with `Input.dispatchMouseEvent` /
     `Input.dispatchKeyEvent`. Pure CDP, cross-platform, no native capture code.
     **But: base64-per-frame + an ack round-trip per frame → laggy, low fps**
     (JPEG q80 ≈ 50–100KB/frame at 720p; "each frame requires round-trip to
     acknowledge, which affects latency"). Fine for "glance + occasional click,"
     not for smooth scrolling/video.
  2. **SCK capture + CDP input (recommended, composes with the spike).** Use
     **ScreenCaptureKit** to capture the real Chrome window's pixels (GPU-resident
     IOSurface → CALayer, 30/60fps, zero base64) — *exactly* the SCK spike's
     capture path (`SPIKE-screencapturekit.md` §1–2). Use **CDP** for *input*
     (`Input.dispatchMouseEvent`/`dispatchKeyEvent`) instead of the spike's
     CGEvent `post_to_pid` — CDP input is more reliable than synthesizing OS
     events to an unfocused window (the spike's §3 "focus problem" largely
     evaporates because CDP injects into Chrome's own input pipeline, not the
     window server). This is the **best of both**: SCK's smooth capture + CDP's
     reliable, focus-independent input + multi-target/tab handling.
- **Tabs.** CDP exposes each tab as a *target*; `Target.getTargets` /
  `Target.attachToTarget` → an AIOS pane can be a tab, or AIOS can present a tab
  strip. `on_new_window`-style behavior maps to `Target.targetCreated`.

### The hard, honest blockers (verified June 2026)
- **Chrome 136+ REFUSES remote debugging on the DEFAULT profile.** This is the
  big one. Since Chrome 136, `--remote-debugging-port` is *silently ignored*
  unless paired with `--user-data-dir` pointing at a **non-default** directory.
  Chrome's own blog + the official Chrome DevTools docs say there is **no
  supported way to debug the real/default profile** — they explicitly steer you
  to a separate data dir or "Chrome for Testing." So the dream of "puppeteer
  firaz's *actual everyday* Chrome profile, with all his logins live" is **not
  officially possible** anymore.
  - **What this means in practice:** AIOS would manage a **dedicated AIOS Chrome
    profile** (its own `--user-data-dir`, e.g. `~/.aios/chrome-profile`). firaz
    logs into it once; thereafter it persists logins/extensions/Widevine *in that
    profile*. It's "real Chrome with real Widevine and real extensions," just not
    *the same* profile as his standalone Chrome. (Copying the default profile dir
    to a temp location and pointing `--user-data-dir` at the copy is a known
    *bypass* Google is actively closing — do NOT build on it; it's fragile and
    adversarial.)
- **Chrome must be installed + AIOS launches/manages a Chrome process.** If Chrome
  isn't installed, this pane doesn't exist. AIOS becomes a Chrome *supervisor*
  (launch, health-check, relaunch) — more like the bridge/tmux supervision the
  repo already does than like a webview.
- **It's puppeteering, not embedding.** The window is a real separate Chrome
  process; AIOS captures+drives it. Latency is perceptible (SCK capture ~1–2
  frames + input round-trip; CDP screencast worse). Auxiliary windows (native
  menus, file pickers) are separate windows — same caveat as the SCK spike §6.

### Permissions / infra
- SCK capture path = **Screen Recording** TCC (same as `browser_screenshot`
  already needs, `browser.rs:779`) + the hardened-runtime entitlement shakeout the
  SCK spike §5 documents. CDP input needs *no* Accessibility (it goes through
  Chrome's debug socket, not CGEvent) — a genuine win over the spike's CGEvent
  path. If you use the *pure-CDP screencast* path instead, you need **neither**
  Screen Recording nor Accessibility — just the debug socket. (That's a real
  argument for shipping pure-CDP first as the simplest spike, then upgrading
  capture to SCK for smoothness.)

### Where it hooks
- New `chrome_cdp.rs` (launch/manage Chrome + CDP client over WebSocket) +
  `cdp_pane` commands mirroring the SCK spike's `appcast_*` surface
  (`SPIKE-screencapturekit.md` §9): `cdp_start`, `cdp_set_bounds`, `cdp_hide`,
  `cdp_close`, `cdp_forward_mouse`, `cdp_forward_key`, plus `cdp_list_tabs`.
- Capture/composite = the SCK spike's `appcast.rs` native view + IOSurface→CALayer
  (`SPIKE-screencapturekit.md` §1) — **literally the same module**, just pointed
  at the Chrome window and fed input via CDP instead of CGEvent.
- Frontend = a `CdpChromePane.tsx` clone of `BrowserPane.tsx` chrome + the
  bounds-sync loop, with pointer/key handlers forwarding to CDP.
- A WebSocket CDP client in Rust: `tokio-tungstenite` (tokio is already a dep) +
  serde_json (already a dep). No heavyweight new crate needed for a thin client.

### Verdict on Path 3
Compatibility: **100% real Chrome** (Blink, Widevine, the AIOS-profile's
extensions/logins). Effort: **medium** — reuses SCK spike infra; the new work is a
CDP client + Chrome process management. Bundle: **~zero added** (uses the Chrome
already installed). UX fidelity: **functional but puppeteered** — perceptible lag,
separate-window caveats. Distance to "never need Chrome": **closest *practical*
path** for the Widevine/extension/Chrome-only cases — *if* firaz accepts a
dedicated AIOS-managed Chrome profile (not his literal default). **Conclusion:
the right Phase-2 engine strategy** — it's the only way to get real-Chrome compat
without shipping 200MB, and it slots into the capture+input infra already
spec'd.

---

## 5. Side-by-side

| | Path 1 WebKit polish | Path 2 CEF embed | Path 3 CDP real-Chrome |
|---|---|---|---|
| Engine | WebKit (Safari) | Blink (Chromium 148) | Blink (user's real Chrome) |
| Chrome extensions | ❌ none (no Safari ext either) | ⚠️ partial, rough | ✅ (in the AIOS profile) |
| Widevine (Netflix/Spotify/Prime) | ❌ FairPlay only → break | ✅ default since M93 (VMP shakeout) | ✅ real Chrome license |
| Chrome-only sites (Teams/Meet) | ❌ degrade/break | ✅ | ✅ |
| Bundle size added | 0 | **+~200MB** + helper signing | ~0 (uses installed Chrome) |
| Build/sign complexity | none new | **high** (notarize + per-helper sign) | medium (CDP client + Chrome supervisor) |
| Solo-dev effort | low | high | medium (reuses SCK infra) |
| UX fidelity | native, instant | Chrome-grade, native | puppeteered, perceptible lag |
| Uses firaz's existing logins | n/a | ❌ fresh Chromium | ⚠️ a *new* AIOS Chrome profile (Chrome 136 blocks default) |
| Reaches "never open Chrome again" | ❌ hard floor | ✅ closest | ✅ closest practical |

---

## 6. Recommended path + phased roadmap

**Hybrid: WebKit-default-pane + CDP real-Chrome escape-hatch pane. CEF shelved.**

### Phase 1 — cross-cutting UX completeness (WebKit, ~2–3 weeks, do now)
Pure value on every path. Makes the *default* pane feel like a real browser.
1. **Persistent history + address-bar autocomplete.** SQLite (`sqlx` already a
   dep) written from `on_navigation`/`on_page_load` (`browser.rs:223-251`); query
   it in the `BrowserPane.tsx` address input.
2. **Bookmarks, first-class.** Promote pinned sites (`lib/sidebar`, `App.tsx:3046`)
   to a bookmarks model + bookmark bar in the pane chrome.
3. **Downloads manager UI.** List/re-open/reveal from the already-firing download
   events (`browser.rs:252-287`); add a thin `reveal_in_finder` command.
4. **Session restore.** Extend `lib/browser-mem` per-pane memory to a full
   open-panes snapshot on quit → restore on launch.
5. **Credential autofill via Keychain.** `keychain.rs` using `security-framework`;
   detect-form + offer-to-save + inject-on-focus via `wv.eval`.
6. **Multi-profile account picker.** Build the avatar/account UX on the existing
   partitions (`browser.rs:139-154`).

Acceptance: history+autocomplete, a bookmark bar, a downloads list, "reopen my
panes," and "AIOS filled my login" all work — WebKit pane now *feels* whole.

### Phase 2 — the engine escape hatch (CDP real-Chrome pane)
For the ~15% WebKit can't do (Widevine streaming, Chrome-only apps, extensions).
1. **Spike pure-CDP first (cheapest, no TCC).** `chrome_cdp.rs`: launch Chrome
   `--remote-debugging-port --user-data-dir ~/.aios/chrome-profile`; thin CDP
   client (`tokio-tungstenite` + `serde_json`, both deps already present);
   `Page.startScreencast` → canvas; `Input.dispatch*` for control. Prove a real
   Chrome tab is interactive inside a pane. Decision gate: is base64-screencast
   lag tolerable?
2. **Upgrade capture to SCK (smoothness).** Swap the screencast canvas for the SCK
   spike's IOSurface→CALayer capture (`SPIKE-screencapturekit.md` §1–2) of the
   Chrome window; keep CDP for input. This is where Path 3 *composes* with the
   spike — same `appcast.rs` native view, Chrome window as the target, CDP input
   instead of CGEvent (sidesteps the spike's §3 focus problem entirely).
3. **Tab + lifecycle.** `Target.*` for tabs; Chrome process supervision
   (launch/health/relaunch) modeled on the repo's existing bridge/tmux supervision.
4. **UX framing.** A "open in real Chrome" affordance from the WebKit pane (e.g.
   when a site is Widevine/Chrome-gated, offer to hand it to the CDP pane). The
   CDP pane is clearly labeled "real Chrome (slower)."

### Phase 3 — only if needed: CEF
Revisit *only* if the CDP pane's puppeteering UX proves unacceptable AND firaz
wants native-in-app Widevine/extensions badly enough to accept +200MB and a
notarization pipeline. The `cef` crate (CEF 148, tauri-co-owned) is the vehicle.
Most likely **never reached** — Phase 2 covers the compat gap at a fraction of
the cost.

---

## 7. Honest risks

- **Phase 1 is the easy, safe value — but it does NOT reach "never open Chrome
  again."** Netflix/Spotify/extensions/Teams remain broken on WebKit, full stop.
- **CDP can't touch the default profile (Chrome 136+).** The "drive firaz's exact
  everyday Chrome" fantasy is dead per Google's own docs. The realistic product is
  a *dedicated AIOS Chrome profile* he logs into once. Set that expectation now.
- **CDP capture is laggy.** Pure-CDP screencast (base64 + per-frame ack) is
  glance-grade. SCK upgrade fixes smoothness but adds the Screen Recording TCC +
  hardened-runtime shakeout the SCK spike already flags (§5) — the same mic-gotcha
  class of "works in dev, silently denied when built." Verify on the built `.app`.
- **Widevine in CEF isn't a free checkbox.** "Default since M93" is true, but VMP
  provisioning has bitten people on recent CEF (issue #3820). Budget a shakeout.
- **CEF bundle/signing is a real ongoing tax**, not a one-time cost — every release
  re-signs every helper + re-notarizes. Heavy for a solo OSS app.
- **Chrome-as-dependency (Path 3) couples AIOS to an external app's update cadence
  and CDP stability.** CDP is not a stable API contract; Chrome can change it
  between versions (e.g. the `/json/version` churn around 136).
- **Trust optics.** Path 3 with SCK capture = a screen recorder driving a browser.
  Same "trust is the moat" framing as the SCK spike §6: capture only the one
  managed Chrome window, never persist frames, obvious opt-in.

## 8. What firaz must accept, per path

- **Path 1 (WebKit polish):** "no uBlock/extensions, no Netflix/Spotify-web, no
  Teams/Meet — but everything else feels like a real browser." Free, fast, native.
- **Path 2 (CEF):** "+200MB app, a notarization pipeline, and a *fresh* Chromium
  with none of my current logins/extensions — in exchange for Chrome-grade compat
  in-app." Heaviest; probably not worth it.
- **Path 3 (CDP real-Chrome):** "Chrome must be installed; AIOS drives a
  *dedicated AIOS Chrome profile* (not my literal default — Google forbids that);
  it's real Chrome (Widevine, extensions, logins in that profile) but
  puppeteered, so slightly laggy and a separate window under the hood." Best
  practical route to the Widevine/extension cases at ~zero bundle cost.

**Bottom line: build Phase 1 now (wins on every path), then Phase 2 CDP-real-Chrome
as the compatibility escape hatch composed onto the SCK capture+input infra. Keep
CEF on the shelf.**

---

## Sources (June 2026)
- WKWebView no Widevine / Netflix VMP: Vuplex 3D WebView Widevine docs; Apple
  Developer Forums (Widevine vs FairPlay on iOS); FairPlay/Widevine DRM
  comparisons (DoveRunner, Gumlet, Kinescope 2026 guide).
- WKWebView/embedded no extensions: Vuplex; uBlock-Safari issue #158 (Safari
  dropped uBO after v13); uBO Lite for Safari (gHacks, Aug 2025).
- CEF maturity/Widevine/bundle: `tauri-apps/cef-rs` (CEF 148.3.0+148.0.9, May 30
  2026, mac/win/linux all arches); cef-announce "Widevine enabled by default M93";
  CEF issue #3820 (Widevine VMP shakeout); CEF forums on ~200MB framework + mac
  helper signing.
- CDP: Chrome DevTools Protocol Page/Input domains; Chrome 136 remote-debugging
  default-profile block (Chrome for Developers blog; browser-use #1520;
  chrome-devtools-mcp #1830); screencast base64/ack latency (vercel-labs
  agent-browser DeepWiki; browserless #214).
- Chrome-only sites: Microsoft Q&A (Teams Safari PWA dropped, mid-2025); HN /
  Google Meet Safari; WebKit UA-quirk overrides (Den Odell).
