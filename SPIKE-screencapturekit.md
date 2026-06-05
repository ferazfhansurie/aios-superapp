# SPIKE — Native app window as an interactive AIOS pane (ScreenCaptureKit + CGEvent)

Status: spec only. No source touched. Owner-of-record for `ChatPane.tsx` / `chat.rs` is a
different agent — **do not edit those**. This spike adds a NEW Rust module + a NEW React
component, mirroring the existing browser-pane architecture.

## TL;DR up front — why capture+control, not reparenting

macOS does **not** permit reparenting a foreign `NSWindow` into our process. The window server
isolates each app's windows in its own connection; there is no public API to adopt another
process's `NSWindow`/`CALayer` into our view hierarchy (`mac_apps.rs:3-8` already states this).
So the ONLY viable path to "a real app living inside an AIOS pane" is:

- **capture** the target window's pixels live (ScreenCaptureKit, GPU-resident IOSurface), draw
  them into a native child view we DO own, position-synced to a React slot — exactly how
  `BrowserPane` floats a child `WKWebView`; and
- **control** the target by synthesizing input events (CGEvent) addressed to the target's pid,
  and/or driving it via the Accessibility API (AXUIElement).

This is firaz's "watch + act across the whole PC, surfaced as a pane" moonshot. It is the same
move the browser pane makes (native layer floating over React, bounds-synced) but the native
layer is fed by another app's framebuffer instead of WebKit.

The goal of this spike is narrow and provable: **get Calculator (or TextEdit) live in a pane,
click its buttons / type into it from the pane, and watch it respond — all inside AIOS.**

---

## 0. What we mirror (the BrowserPane pattern — read these first)

The app-cast pane is a structural clone of the browser pane. Concrete references:

| Concern | BrowserPane does it at | App-cast pane mirrors with |
|---|---|---|
| Native child floats over React | `browser.rs:210-216` `window.add_child(builder, pos, size)` | a native `NSView` (layer-backed, hosting the capture `CALayer`) added as a child window/view at the slot rect |
| Slot rect → native bounds | `BrowserPane.tsx:140-146` `rect()` from `getBoundingClientRect`; `:148-180` bounds-sync loop (rAF + ResizeObserver + 300ms poll) | identical loop; call `appcast_set_bounds` instead of `browserSetBounds` |
| Show / create on first sync | `browser.rs:158-237` `browser_show` (async; `add_child` deadlock note `:150-157`) | `appcast_start` — async, same deadlock caveat |
| Reposition / resize | `browser.rs:239-253` `browser_set_bounds` | `appcast_set_bounds` |
| Hide without destroy | `browser.rs:344-350` `browser_hide` (shrink 0×0) | `appcast_hide` (stop compositing / 0×0) |
| Destroy on unmount | `browser.rs:358-368` `browser_close`; `BrowserPane.tsx:266-276` hide-then-close on unmount | `appcast_close` — must `stopCapture` + drop stream + remove view |
| objc2 bridge already in repo | `browser.rs:91-120, 220-235` objc2-web-kit / `with_webview(pw.inner())` | same objc2 toolchain (objc2 0.6, block2 0.6) for SCK + Core Graphics |
| Region screenshot precedent | `browser.rs:441-521` `browser_screenshot` via `screencapture -R` (already needs Screen Recording) | SCK supersedes this with a live stream; TCC service is the same |
| Retina coord handling precedent | drop/hit-test + `getBoundingClientRect` are CSS px; native side uses logical points | input-forwarding must convert pane-local CSS px → target window screen points → device px |

`lib.rs` registers every `browser::*` command in the `generate_handler!` block (`lib.rs:58, 94-174`).
The new module registers there too: add `mod appcast;` beside `mod browser;` (`lib.rs:6`) and list the
`appcast::*` commands in the same handler array.

There is also an existing `mac_apps.rs` (osascript-based app inventory + focus). The picker can reuse
its app-listing UX, but window enumeration for capture must go through SCK (`SCShareableContent`), not
osascript, because we need the numeric `windowID` + `pid` SCK keys on.

---

## 1. Architecture

```
  ┌──────────────────────── target app (e.g. Calculator, pid=P) ─────────────────────┐
  │  its real NSWindow lives on the window server, in ITS process. We never own it.   │
  └───────────────▲──────────────────────────────────────────────────┬───────────────┘
        capture (pixels out)                                  control (events in)
                  │                                                    │
   ScreenCaptureKit                                       Core Graphics / Accessibility
   SCShareableContent ─► pick window {pid, windowID}      pane-local CSS px
   SCContentFilter(desktopIndependentWindow: win)              │ map → screen pts → device px
   SCStream(filter, SCStreamConfiguration, delegate)           ▼
        │  delegate gets CMSampleBuffer per frame       CGEvent mouse/key  ──► CGEventPostToPid(P,…)
        │  CMSampleBuffer.image_buffer().io_surface()         (fallback) AXUIElement(P) AXPress / AXValue
        ▼  (GPU-resident IOSurface — NEVER copied to JS)
   CALayer.contents = IOSurface   (or CAMetalLayer fed via MTLTexture wrap, zero-copy)
        │
   layer-backed NSView  ── added as child of main window, bounds-synced to the React slot
        │
   ┌────┴───────────────── AIOS shell (Tauri main window) ─────────────────────────┐
   │  React: <AppCastPane>  — chrome (picker + toolbar) + a slot <div ref=slotRef>  │
   │  slot.getBoundingClientRect() ──► appcast_set_bounds(label, rect)  (rAF loop)  │
   │  pointer/keyboard events on the slot ──► appcast_forward_mouse / _forward_key  │
   └───────────────────────────────────────────────────────────────────────────────┘
```

Pieces to build:

- **`src-tauri/src/appcast.rs`** — owns: SCK capture session(s) keyed by pane `label`; the native
  child view + its `CALayer`/`CAMetalLayer`; the bounds/hide/show/close lifecycle; the input-forward
  commands. Holds a `parking_lot::Mutex<HashMap<String, AppCastSession>>` in Tauri state (repo already
  uses `parking_lot`, see Cargo.toml). `AppCastSession { stream, layer_view, pid, window_screen_rect, scale }`.
- **`src/components/AppCastPane.tsx`** — clone of `BrowserPane.tsx` chrome: a window-picker dropdown
  (calls `appcast_list_windows`), a slot div, the bounds-sync effect, and pointer/key handlers that
  forward into Rust. Plus `src/lib/appcast.ts` for the `invoke` wrappers (mirrors `src/lib/browser.ts`).

**Hard rule: frame data stays on the GPU.** `CMSampleBuffer.image_buffer().io_surface()` →
assign that IOSurface to `CALayer.contents` (Core Animation composites it directly), or wrap it as an
`MTLTexture` and feed a `CAMetalLayer`. Never read the buffer into bytes, never base64 it through IPC,
never round-trip frames through the React webview — that path is for the one-shot `browser_screenshot`
(`browser.rs:441`), not for 30/60fps. The webview only ever sees the slot rect; pixels are composited by
the OS on top of it, identical to how the child WKWebView composites over the slot in BrowserPane.

---

## 2. Window enumeration (the picker)

**Crate:** `screencapturekit` (the doom-fish / svtlabs `screencapturekit-rs` project; safe idiomatic
wrapper, actively maintained, supports zero-copy IOSurface/Metal). Latest line is v6/v7 — pin a concrete
version at implementation time (`cargo add screencapturekit` then lock). The lower-level alternative is
`objc2-screen-capture-kit` (raw objc2 bindings, part of the objc2 project the repo already uses); fall
back to it if the high-level wrapper is missing a needed knob. **Requires macOS 12.3+.**

Flow:

```rust
let content = SCShareableContent::get()?;        // async/blocking variant per crate
for win in content.windows() {
    let title = win.title();                      // Option<String>
    let window_id = win.window_id();              // u32 — CGWindowID
    let app = win.owning_application();           // SCRunningApplication
    let app_name = app.application_name();         // String
    let pid = app.process_id();                    // pid_t (i32)
    // filter: on_screen, non-zero size, skip our own bundle + system chrome
}
```

`appcast_list_windows` returns `Vec<{ app_name, window_title, window_id: u32, pid: i32 }>` to the picker.

To capture ONE window, build a single-window filter:

```rust
let win = /* the SCWindow whose window_id matches the pick */;
let filter = SCContentFilter::new_with_desktop_independent_window(&win); // desktopIndependentWindow:
let mut cfg = SCStreamConfiguration::new();
cfg.set_width(w_px); cfg.set_height(h_px);        // target device px (Retina = pts * scale)
cfg.set_pixel_format(kCVPixelFormatType_32BGRA);  // BGRA for CALayer.contents
cfg.set_shows_cursor(false);
cfg.set_minimum_frame_interval(CMTime(1, 60));    // cap fps
let mut stream = SCStream::new(&filter, &cfg);
stream.add_output_handler(MyOutput, SCStreamOutputType::Screen); // SCStreamOutput delegate
stream.start_capture()?;                           // startCaptureWithCompletionHandler:
```

Key SCK types (names per the crate): `SCShareableContent`, `SCWindow`, `SCRunningApplication`,
`SCContentFilter`, `SCStreamConfiguration`, `SCStream`, and the `SCStreamOutput` / `SCStreamOutputTrait`
delegate whose callback receives a `CMSampleBuffer`. Get the IOSurface via
`CMSampleBuffer::image_buffer()` → `io_surface()` (the crate documents zero-copy IOSurface/Metal delivery).

---

## 3. Input forwarding (the hard part)

### Coordinate mapping
Pane-local pointer events arrive in **CSS px** relative to the slot (`e.clientX/Y - slotRect.left/top`).
We must map to the target window's **screen rectangle**, then to device px if the API wants it:

```
fraction = (paneLocalCss) / (slotCss.w, slotCss.h)
targetScreenPt = win.frame.origin + fraction * win.frame.size      // CGWindow bounds, in points
```

`win.frame`/bounds comes from SCK (`SCWindow.frame()`) or `CGWindowListCopyWindowInfo` (kCGWindowBounds);
cache it and refresh on each frame or on a slower poll (the real window can move). Handle Retina exactly
like the rest of the app treats logical points: CGEvent mouse coords are in **global display points**, not
device px, so DPR cancels for mouse positioning — but the SCStream `width/height` must be device px
(`pts * NSScreen.backingScaleFactor`) or the captured image is half-res / blurry. Keep `scale` in the
session and apply it only to the capture config, not to the CGEvent coordinates.

### Mouse
```rust
use core_graphics::event::{CGEvent, CGEventType, CGMouseButton};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
let src = CGEventSource::new(CGEventSourceStateID::HIDSystemState)?;
let down = CGEvent::new_mouse_event(src.clone(), CGEventType::LeftMouseDown, pt, CGMouseButton::Left)?;
let up   = CGEvent::new_mouse_event(src,        CGEventType::LeftMouseUp,   pt, CGMouseButton::Left)?;
// Targeted, does NOT hijack the global cursor:
down.post_to_pid(pid);  // CGEventPostToPid(pid, event)
up.post_to_pid(pid);
```
`core-graphics` 0.25 is **already in the dependency tree** (transitively via `tao`; `Cargo.lock:591`,
`core-graphics-0.25.0/src/event.rs`) — it exposes `CGEvent`, `CGEventType`, `CGMouseButton`,
`CGEventSource`, and `post_to_pid`. Add it as a direct dep to be explicit. `objc2-core-graphics` is also
present (`Cargo.lock:2578`) if we want the objc2-flavored path.

**`post_to_pid` vs global post:** `CGEventPostToPid(pid, …)` delivers the event into the target process's
event queue without moving the user's real cursor or stealing focus — exactly what we want (firaz keeps
working; the pane drives the app). The alternative, `CGEventPost(kCGHIDEventTap, …)` at global screen
coords, injects at the HID layer (real cursor jumps, whatever window is under that point gets it) — worse
UX and racy. So: **prefer `post_to_pid`.**

### Keyboard
```rust
let kd = CGEvent::new_keyboard_event(src.clone(), keycode, true)?;   // CGEventCreateKeyboardEvent, keyDown
let ku = CGEvent::new_keyboard_event(src,        keycode, false)?;   // keyUp
kd.set_flags(modifier_flags);                                        // CGEventFlags for ⌘⌥⌃⇧
kd.post_to_pid(pid); ku.post_to_pid(pid);
```
Map JS `KeyboardEvent.code` → macOS virtual keycode (a static table; `kVK_*` constants). For text entry,
`CGEventKeyboardSetUnicodeString` on a synthetic key event lets us inject characters without a keycode
table — simpler for the spike's "type into TextEdit" demo.

### The focus problem — call it honestly
`CGEventPostToPid` is **not fully reliable for an unfocused / background / offscreen window.** Documented
behaviour: some apps' event handling (notably modal dialogs and some controls) only respond when the app
is frontmost; the event lands in the queue but the control's tracking state never updated (Apple dev
forums thread 724835; keybd_event PR #37 needed extra MouseMoved priming + window-location tricks). For
the spike this means:

- **Calculator** (simple AppKit buttons, single window) responds well to `post_to_pid` even when not
  frontmost — good Phase-B target.
- Apps with focus-gated controls may need the window **key/frontmost** first (`NSRunningApplication
  .activate` / AX `AXRaise`), which defeats "firaz keeps working" — or a priming MouseMoved before the
  click.
- **Supplement / fallback: Accessibility (AXUIElement).** Build the app element with
  `AXUIElementCreateApplication(pid)`, walk to the control, and call `AXUIElementPerformAction(el,
  kAXPressAction)` (a button "press" that doesn't depend on cursor/focus) or set values with
  `AXUIElementSetAttributeValue(el, kAXValueAttribute, …)`. This is semantic control, not pixel-coordinate
  poking — more reliable AND more AIOS-native (the oracle acts on the UI tree, not on coordinates).
  Crates: `accessibility-sys` (raw FFI: `AXUIElementCreateApplication`, `AXUIElementCopyAttributeValue`,
  `AXUIElementSetAttributeValue`, `AXUIElementPerformAction`, `kAXPositionAttribute`, `kAXPressAction`) or
  `objc2-accessibility` (objc2-flavored, matches the repo's objc2 stack). `andelf/axcli` is a working
  reference for AX-driven control of arbitrary apps.

Decision for the spike: implement CGEvent `post_to_pid` first (Phase B). If Calculator misbehaves, the
AX `kAXPressAction` path is the documented fallback and feeds directly into decision gate D2 below.

---

## 4. The real window — mirror in-place vs move offscreen

Two options for where the REAL target window physically sits while we mirror it:

- **In-place (RECOMMENDED for the spike).** Leave the real window wherever it is (even behind the AIOS
  window). SCK captures it fine regardless of occlusion — it captures the window's backing store, not the
  screen region — so the pane shows it live even when the real window is hidden behind us. Coordinate
  mapping is trivial: target screen rect = the real window's actual `frame`. Simplest, zero AX writes.
  Downside: the real window may flash visible during space/window-order changes; cosmetic only.
- **Offscreen (v2).** Use AX to shove the real window to `(-10000,-10000)`:
  `AXUIElementSetAttributeValue(window_el, kAXPositionAttribute, AXValue(CGPoint))`. Then ONLY the pane
  shows it. But input mapping still needs the window's *current* AX frame (which is now offscreen), and
  some apps clamp or fight the reposition. More moving parts, requires Accessibility write access.

**Spike = in-place.** Offscreen relocation is explicitly v2.

---

## 5. Permissions + signing

Two distinct TCC services, both prompt-on-first-use, both enforced by the hardened runtime:

| Capability | TCC service | Needed for |
|---|---|---|
| Screen capture | `kTCCServiceScreenCapture` ("Screen & System Audio Recording") | SCK stream + `SCShareableContent` |
| Synthetic input / AX | `kTCCServiceAccessibility` ("Accessibility") | `CGEventPostToPid`, `CGEventPost`, all `AXUIElement` reads/writes |

**The hardened-runtime gotcha — confirmed in this repo.** `Entitlements.plist:5-21` documents exactly
this trap for the microphone: the bundle is **ad-hoc signed WITH hardened runtime**, and under hardened
runtime a TCC service is **refused silently, with no prompt**, unless the matching entitlement/usage-string
is present. Mic needed `com.apple.security.device.audio-input` + `NSMicrophoneUsageDescription`. Expect the
same shape here:

- Screen Recording: no dedicated entitlement key, but add **`NSScreenCaptureUsageDescription`** (?? verify
  — recent SDKs key it via Info.plist usage string) to `Info.plist`; macOS shows the Screen Recording
  prompt on first `SCShareableContent::get()`. If the prompt never appears under hardened runtime, that's
  the mic-gotcha recurring — check `tccutil`/Console and the signing flags before assuming a code bug.
- Accessibility: there is **no entitlement** that grants it — it is user-toggled in System Settings ›
  Privacy & Security › Accessibility, per-app. First `AXIsProcessTrustedWithOptions({prompt:true})` (or
  first CGEvent post) surfaces the "allow AIOS to control your computer" prompt. The app must be added
  manually if the prompt is dismissed. **Note for built-vs-dev:** the bundle id / signing identity must be
  stable or macOS treats each rebuild as a new app and re-prompts (and the `node`-on-PATH / GUI-launch
  class of "works in dev, silently fails when built" bugs this repo has hit before — verify in the built
  `.app`, not just `tauri dev`).

Signing today: `tauri.conf.json:45-46` — `signingIdentity: "Apple Development: Firaz…"`,
`entitlements: ./Entitlements.plist`. App is **not sandboxed** (`Entitlements.plist:35-36`), which is what
makes broad screen-capture + input synthesis even possible.

---

## 6. Hard problems / what breaks

- **Auxiliary windows are separate windows.** Native context menus, tooltips, combo-box popups, color
  pickers, sheets, and palettes open as their OWN `NSWindow`s with their own `windowID`. A single-window
  SCContentFilter **misses all of them** — right-click in the pane and the menu appears on the real
  desktop, not in the pane. Mitigation (out of spike scope): capture by `pid`/application
  (`SCContentFilter` application-scoped) and composite multiple windows, or detect new child windows and
  spawn sub-captures. For the spike, pick apps without these (Calculator, TextEdit main doc).
- **Multi-window apps.** Same root cause — one capture = one window. Document-based apps, inspectors,
  floating panels each need their own stream + their own pane region.
- **Drag-and-drop across the boundary.** Dragging from the pane into another AIOS pane (or vice versa) has
  no path — the drag is synthesized into the target's coordinate space, the OS drag pasteboard isn't
  shared with our synthetic events. Out of scope.
- **Latency & fps.** SCK is low-overhead and GPU-resident, but there's still capture→encode-skip→composite
  latency (~1–2 frames) plus input round-trip (JS event → IPC → CGEvent → target queue → repaint →
  next captured frame). Expect perceptible but usable lag (~30–80ms). Cap fps (`minimum_frame_interval`)
  to keep CPU/GPU sane. Measure in gate D1.
- **macOS version drift.** SCK is 12.3+. API shape shifted across 13/14/15; `SCContentFilter` initializers
  and `SCShareableContent` async forms changed. Pin the crate, test on firaz's actual OS.
- **Trust / privacy optics.** This is a screen-recorder that also synthesizes input — the most invasive
  permission pair macOS has. AIOS's north star is **"trust is the moat"** (MEMORY: SaaS/premium model,
  best-product-first, no public launch). So: only ever capture the ONE user-picked window (never full
  screen), show an explicit "recording this app" indicator in the pane chrome, never persist frames to
  disk, and gate behind an obvious opt-in. The capability has to feel like a co-founder watching a shared
  screen, not spyware.

---

## 7. Phased spike plan

### Phase A — capture-only (no input)
Prove capture + overlay compositing + bounds-sync.
1. Add `screencapturekit` (+ `core-graphics` as a direct dep) to Cargo.toml under the macOS target block,
   beside the existing `objc2-web-kit` deps.
2. `appcast.rs`: `appcast_list_windows` (SCShareableContent enumeration → picker rows).
3. `appcast.rs`: `appcast_start(label, window_id, rect)` — build single-window filter + stream, create a
   layer-backed `NSView`, set `CALayer.contents` from each frame's IOSurface in the SCStreamOutput
   delegate, `window.add_child` the view at the slot rect (mirror `browser.rs:210-216`).
4. `appcast_set_bounds` / `appcast_hide` / `appcast_show` / `appcast_close` (mirror browser commands).
5. `AppCastPane.tsx` + `lib/appcast.ts`: picker dropdown + slot + the bounds-sync effect copied from
   `BrowserPane.tsx:148-180`.
- **Success:** open Calculator, pick it in AIOS, see it live-mirrored in a pane at ~30fps; resize/move the
  pane and the mirror tracks; close the pane and capture stops cleanly (no leaked stream).
- **Rough time:** 2–3 days (SCK delegate + IOSurface→CALayer wiring is the bulk; bounds-sync is copy-paste).

### Phase B — input
Prove control.
6. `appcast_forward_mouse(label, x, y, button, phase)` — map pane-local CSS px → target window screen pt
   (§3), build CGEvent mouse down/up, `post_to_pid(pid)`.
7. `appcast_forward_key(label, code, down, modifiers)` — CGEvent keyboard event (or unicode-string inject)
   → `post_to_pid(pid)`.
8. `AppCastPane.tsx`: attach `onPointerDown/Up/Move` + `onKeyDown/Up` to the slot, forward to Rust. Make
   the slot focusable so it captures keystrokes.
- **Success:** in the pane, click Calculator's `7 × 6 =` and watch `42` appear; click into TextEdit and
  type a sentence — all inside AIOS, real cursor never moves, real window never raised.
- **Rough time:** 2–3 days (coord mapping + keycode table + the focus-reliability debugging).

### Explicitly OUT of scope for the spike
Offscreen window relocation (§4 v2); multi-window / application-scoped capture; native menus / tooltips /
palettes; drag-and-drop across the boundary; perf/latency tuning beyond an fps cap; capturing more than one
app at a time; AX-tree semantic control (only as a fallback if CGEvent fails, not a built-out feature);
Windows support (this is macOS-only — Windows would be a separate DWM-thumbnail/SendInput spike).

### Concrete success demo
**"Calculator live in an AIOS pane — click its buttons and type, it responds, all without leaving AIOS."**

---

## 8. Decision gates (after the spike)

- **D1 — latency/fps.** Is the mirror smooth enough to interact with (subjectively ≤~80ms click-to-repaint,
  ≥24fps)? If no → app-cast is a "glance" surface, not an "interact" surface; re-scope.
- **D2 — input reliability.** Does `post_to_pid` drive Calculator + TextEdit reliably without raising them?
  If flaky → adopt the **fallback framing**: drop direct coordinate input, pivot to **"view-only mirror +
  AI-driven control via Accessibility"** — the oracle reads the AX tree and performs `kAXPressAction` /
  sets values, firaz *watches* the pane. This is arguably MORE AIOS-native (the co-founder acts on the
  UI's semantics, firaz supervises) and sidesteps the whole focus/coordinate fragility. Keep this as the
  designed-in plan-B, not a failure.
- **D3 — permission friction.** Does the Screen Recording + Accessibility double-prompt land cleanly on a
  built+signed `.app` (not just dev), and survive rebuilds without re-prompting? If the hardened-runtime
  mic-gotcha recurs, that's a signing/entitlement fix, not a code fix — resolve before calling the spike
  done.

---

## 9. API surface to add

Tauri commands (register in `lib.rs` `generate_handler!`, beside the `browser::*` block at `lib.rs:94-174`):

| Command | Signature (Rust) | Mirrors |
|---|---|---|
| `appcast_list_windows` | `() -> Vec<WindowInfo>` where `WindowInfo { app_name, window_title, window_id: u32, pid: i32 }` | (new — picker) |
| `appcast_start` | `async (label, window_id: u32, x, y, width, height) -> Result<(), String>` | `browser_show` |
| `appcast_set_bounds` | `(label, x, y, width, height) -> Result<(), String>` | `browser_set_bounds` |
| `appcast_hide` | `(label) -> Result<(), String>` | `browser_hide` |
| `appcast_show` | `(label) -> Result<(), String>` | (re-show after hide) |
| `appcast_close` | `(label) -> Result<(), String>` (stopCapture + drop stream + remove view) | `browser_close` |
| `appcast_forward_mouse` | `(label, x: f64, y: f64, button: u8, phase: String) -> Result<(), String>` | (new — Phase B) |
| `appcast_forward_key` | `(label, code: u32, down: bool, modifiers: u32) -> Result<(), String>` | (new — Phase B) |

`AppCastPane` props (mirror `BrowserPane` props, `BrowserPane.tsx:73-102`):

```ts
{
  label: string;                  // per-pane key, like BrowserPane
  active?: boolean;               // false → appcast_hide (mirrors BrowserPane active)
  initialWindowId?: number;       // deep-link a pre-picked window (cf. initialUrl)
  onWindowChange?: (id: number) => void;   // persist the picked window (cf. onProfileChange)
  onNotify?: (msg: string, level: NotificationLevel) => void; // toast/error surface
}
```
`src/lib/appcast.ts` exports the `invoke` wrappers (`appcastListWindows`, `appcastStart`, `appcastSetBounds`,
`appcastHide`, `appcastShow`, `appcastClose`, `appcastForwardMouse`, `appcastForwardKey`) + the
`WindowInfo` type — mirroring `src/lib/browser.ts`.

---

## Go / no-go

**Go — as a time-boxed spike, in-place mirror, Calculator + TextEdit only, with the AX-control fallback
pre-accepted as plan-B.** The architecture is a near-exact clone of the already-working browser pane
(native child view, bounds-synced to a slot, hide/show/close lifecycle, objc2 bridge), the two scary
external dependencies are real and current (`screencapturekit` for GPU-resident capture, `core-graphics`
0.25 already in the tree for `post_to_pid` input), and the repo has already eaten the hardened-runtime TCC
lesson once (mic), so the permission path is understood rather than unknown. The genuine risk is NOT
capture (SCK is solid) — it's input reliability on unfocused windows (§3), which is exactly why D2 bakes in
the "view-only + AI-drives-via-Accessibility" pivot that's arguably the better AIOS product anyway. Hard
no-go signal would be unacceptable latency (D1) making even view-only interaction feel dead.

**Estimated total spike effort: ~1 week** (Phase A capture ~2–3 days, Phase B input ~2–3 days, ~1 day for
permission/signing shakeout on the built `.app`). One engineer, macOS only.
