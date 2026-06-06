//! App-cast panes — live-mirror ONE foreign macOS app window inside an AIOS pane
//! (ScreenCaptureKit spike, Phase A: capture + mirror, NO input forwarding).
//!
//! macOS forbids reparenting another process's `NSWindow` into ours, so the only
//! way to put "a real app inside a pane" is to CAPTURE the target window's pixels
//! live (ScreenCaptureKit, GPU-resident IOSurface) and draw them into a native
//! child view we DO own — position-synced to a React slot, exactly how
//! `browser.rs`/`BrowserPane.tsx` floats a child WKWebView over a slot div.
//!
//! Pipeline (frames stay on the GPU — never copied through JS):
//!   SCShareableContent → pick SCWindow {windowID, pid}
//!   SCContentFilter(initWithDesktopIndependentWindow:) — single window
//!   SCStreamConfiguration (BGRA, device-px width/height, fps cap)
//!   SCStream(filter, cfg, delegate) + addStreamOutput(self, .screen, queue)
//!   delegate stream:didOutputSampleBuffer:ofType: gets a CMSampleBuffer
//!     → CMSampleBufferGetImageBuffer → CVPixelBufferGetIOSurface
//!     → CALayer.setContents(IOSurface)   (Core Animation composites zero-copy)
//!   the CALayer backs an NSView that is the contentView of a borderless CHILD
//!   NSWindow floated over the React slot, NOT a subview of the main window's
//!   contentView — bounds-synced (in SCREEN coords) via appcast_set_bounds.
//!
//! WHY A CHILD WINDOW (and not addSubview):
//!   tao (the windowing layer wry/Tauri sits on) routes mouseMoved events through
//!   its OWN NSView, loading a weak ref to that view. Adding a layer-HOSTING NSView
//!   (setLayer + setWantsLayer) into tao's contentView forces layer-backing to
//!   propagate up tao's view tree and corrupts that weak ref → tao's
//!   `mouse_moved` → `objc_loadWeakRetained` deref of null → EXC_BAD_ACCESS the
//!   moment the mouse moves over the pane (crash report 2026-06-06). BrowserPane
//!   survives because wry's `add_child` integrates with tao; our raw addSubview
//!   did not. A separate borderless child NSWindow lives ENTIRELY OUTSIDE tao's
//!   view hierarchy + event routing, so tao's mouseMoved never touches it. For
//!   Phase A (no input forwarding yet) the overlay also sets
//!   `ignoresMouseEvents = true`, so it can't route into any broken path at all.
//!
//! Lower-level objc2-* bindings (not the high-level `screencapturekit` crate) so
//! every NSObject type unifies with the objc2 0.6 / objc2-* 0.3 stack
//! objc2-web-kit already pins. Requires macOS 12.3+. See SPIKE-screencapturekit.md.
//!
//! NON-macOS: every command is a stubbed no-op so the crate still compiles + the
//! frontend can call the wrappers without a platform guard at the call site.

use serde::Serialize;

/// One picker row: an enumerated capturable window.
#[derive(Clone, Debug, Serialize)]
pub struct WindowInfo {
    pub app_name: String,
    pub window_title: String,
    pub window_id: u32,
    pub pid: i32,
    /// Owning app's bundle id (e.g. "com.apple.Safari"), if SCK exposes it.
    pub bundle_id: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS implementation
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod imp {
    use super::WindowInfo;
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::Duration;

    use block2::RcBlock;
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventType, CGMouseButton};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{
        define_class, msg_send, AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly,
        Message,
    };
    use objc2_app_kit::{
        NSBackingStoreType, NSColor, NSEvent, NSEventModifierFlags, NSResponder, NSView, NSWindow,
        NSWindowOrderingMode, NSWindowStyleMask,
    };
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_media::CMSampleBuffer;
    use objc2_core_video::CVPixelBufferGetIOSurface;
    use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSString};
    use objc2_quartz_core::CALayer;
    use objc2_screen_capture_kit::{
        SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamOutput,
        SCStreamOutputType, SCWindow,
    };
    use parking_lot::Mutex;
    use tauri::{AppHandle, Manager};

    /// kCVPixelFormatType_32BGRA — a CALayer.contents IOSurface must be BGRA so
    /// Core Animation composites it directly. FourCC 'BGRA' = 0x42475241.
    const PIXEL_FORMAT_BGRA: u32 = 0x42475241;

    // ── The SCStreamOutput delegate ─────────────────────────────────────────
    //
    // Holds the target CALayer (whose `contents` we set per frame). The layer is
    // only ever mutated on the MAIN thread (Core Animation requirement); the
    // sample-handler queue we hand to SCK is the main DispatchQueue, so the
    // callback already runs on main and can touch the layer directly.
    struct DelegateIvars {
        layer: Retained<CALayer>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "AiosAppCastOutput"]
        #[ivars = DelegateIvars]
        struct AppCastOutput;

        unsafe impl NSObjectProtocol for AppCastOutput {}

        unsafe impl SCStreamOutput for AppCastOutput {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            unsafe fn stream_did_output(
                &self,
                _stream: &SCStream,
                sample_buffer: &CMSampleBuffer,
                ty: SCStreamOutputType,
            ) {
                // Only screen frames carry the video IOSurface we want.
                if ty != SCStreamOutputType::Screen {
                    return;
                }
                // CMSampleBuffer → CVImageBuffer (== CVPixelBuffer).
                let Some(image_buffer) = sample_buffer.image_buffer() else {
                    return;
                };
                // CVPixelBuffer → IOSurface (GPU-resident, zero-copy).
                let Some(surface) = CVPixelBufferGetIOSurface(Some(&image_buffer)) else {
                    return;
                };
                // IOSurfaceRef is toll-free-bridged to the IOSurface object that
                // CALayer.contents accepts. Cast the CF pointer to an objc object
                // pointer and hand it to setContents: (Core Animation composites
                // it directly — zero pixel copy). `surface` is a CFRetained<IOSurfaceRef>.
                let surface_ptr = (&*surface) as *const _ as *const AnyObject;
                let layer = &self.ivars().layer;
                unsafe {
                    layer.setContents(surface_ptr.as_ref());
                }
            }
        }
    );

    impl AppCastOutput {
        fn new(layer: Retained<CALayer>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(DelegateIvars { layer });
            unsafe { msg_send![super(this), init] }
        }
    }

    // ── Phase B: input forwarding ────────────────────────────────────────────
    //
    // The overlay is a SEPARATE borderless child NSWindow living OUTSIDE tao's
    // view tree (see module doc), so it can safely receive its OWN mouse/key
    // events without ever touching tao's broken mouseMoved weak-ref path. We make
    // the overlay's contentView a custom NSView subclass that overrides the event
    // methods; each handler maps the overlay-local point → the captured window's
    // content coordinate (accounting for the aspect-fit letterbox + capture
    // scale) → the GLOBAL screen point of that pixel on the REAL window, then
    // synthesizes a CGEvent and posts it to the target app's pid.
    //
    // Coordinate spaces (all top-left origin unless noted):
    //   • NSEvent.locationInWindow → BOTTOM-left, window-local. We convert to the
    //     view via convertPoint:fromView:nil, giving a BOTTOM-left view-local pt.
    //     Flip to top-left:  vy_tl = view_h - vy_bl.
    //   • The captured frame is drawn with kCAGravityResizeAspect (letterboxed),
    //     so only a centered sub-rect of the view shows pixels. With
    //     s = min(view_w/win_w, view_h/win_h):
    //         displayed = (win_w*s, win_h*s)
    //         offset    = ((view_w-disp_w)/2, (view_h-disp_h)/2)
    //         content_pt = ((vx - off_x)/s, (vy_tl - off_y)/s)   // top-left, pts
    //   • SCWindow.frame is already a TOP-LEFT global-screen rect in points, and
    //     CGEvent global coords are also top-left, so:
    //         global = (win_frame.x + content_x, win_frame.y + content_y)
    //   The `scale` (Retina) cancels out: capture px width = win_w*scale, but we
    //   map against win_w in POINTS, and CGEvent wants points — so backing scale
    //   never enters the mouse math. (It only set the capture buffer resolution.)
    #[derive(Clone, Copy)]
    struct CaptureGeom {
        /// Target window content frame in TOP-LEFT global-screen points.
        win_x: f64,
        win_y: f64,
        win_w: f64,
        win_h: f64,
        /// Target app pid for CGEventPostToPid.
        pid: i32,
    }

    /// Shared, mutable capture geometry: the event handlers read it, the bounds
    /// poll refreshes `win_*` (the real window can move/resize while mirrored).
    type GeomCell = Arc<Mutex<CaptureGeom>>;

    /// Map an overlay view-local point (TOP-LEFT origin, points) to the GLOBAL
    /// screen point of the corresponding pixel on the real window. Returns None if
    /// the click lands in the letterbox bars (outside the displayed image).
    fn view_to_global(g: &CaptureGeom, view_w: f64, view_h: f64, vx: f64, vy_tl: f64) -> Option<CGPoint> {
        if g.win_w <= 0.0 || g.win_h <= 0.0 || view_w <= 0.0 || view_h <= 0.0 {
            return None;
        }
        let s = (view_w / g.win_w).min(view_h / g.win_h);
        if s <= 0.0 {
            return None;
        }
        let disp_w = g.win_w * s;
        let disp_h = g.win_h * s;
        let off_x = (view_w - disp_w) / 2.0;
        let off_y = (view_h - disp_h) / 2.0;
        let cx = (vx - off_x) / s;
        let cy = (vy_tl - off_y) / s;
        // Reject letterbox / outside-content clicks (small epsilon slack).
        if cx < -0.5 || cy < -0.5 || cx > g.win_w + 0.5 || cy > g.win_h + 0.5 {
            return None;
        }
        Some(CGPoint {
            x: g.win_x + cx,
            y: g.win_y + cy,
        })
    }

    /// Translate AppKit modifier flags → CGEventFlags so synthesized events carry
    /// the live shift/ctrl/opt/cmd state.
    fn cg_flags(m: NSEventModifierFlags) -> CGEventFlags {
        let mut f = CGEventFlags::CGEventFlagNull;
        if m.contains(NSEventModifierFlags::Shift) {
            f |= CGEventFlags::CGEventFlagShift;
        }
        if m.contains(NSEventModifierFlags::Control) {
            f |= CGEventFlags::CGEventFlagControl;
        }
        if m.contains(NSEventModifierFlags::Option) {
            f |= CGEventFlags::CGEventFlagAlternate;
        }
        if m.contains(NSEventModifierFlags::Command) {
            f |= CGEventFlags::CGEventFlagCommand;
        }
        if m.contains(NSEventModifierFlags::CapsLock) {
            f |= CGEventFlags::CGEventFlagAlphaShift;
        }
        f
    }

    /// Synthesize + post a mouse CGEvent at `global` to `pid`. HID-private source.
    fn post_mouse(pid: i32, kind: CGEventType, button: CGMouseButton, global: CGPoint, flags: CGEventFlags) {
        let Ok(src) = CGEventSource::new(CGEventSourceStateID::Private) else {
            return;
        };
        // core-graphics has its own CGPoint (core_graphics_types); layout-identical.
        let pt = core_graphics::geometry::CGPoint {
            x: global.x,
            y: global.y,
        };
        if let Ok(ev) = CGEvent::new_mouse_event(src, kind, pt, button) {
            ev.set_flags(flags);
            ev.post_to_pid(pid);
        }
    }

    /// Synthesize + post a scroll CGEvent to `pid` (line units).
    fn post_scroll(pid: i32, dy: i32, dx: i32, flags: CGEventFlags) {
        let Ok(src) = CGEventSource::new(CGEventSourceStateID::Private) else {
            return;
        };
        // units=Line, wheel_count=2 (vertical + horizontal).
        if let Ok(ev) = CGEvent::new_scroll_event(
            src,
            core_graphics::event::ScrollEventUnit::LINE,
            2,
            dy,
            dx,
            0,
        ) {
            ev.set_flags(flags);
            ev.post_to_pid(pid);
        }
    }

    /// Synthesize + post a keyboard CGEvent to `pid`.
    fn post_key(pid: i32, keycode: u16, down: bool, flags: CGEventFlags) {
        let Ok(src) = CGEventSource::new(CGEventSourceStateID::Private) else {
            return;
        };
        if let Ok(ev) = CGEvent::new_keyboard_event(src, keycode, down) {
            ev.set_flags(flags);
            ev.post_to_pid(pid);
        }
    }

    struct OverlayViewIvars {
        geom: GeomCell,
    }

    // Custom contentView for the overlay: receives the overlay window's own mouse
    // + key events (the overlay sets ignoresMouseEvents=false) and forwards them
    // to the captured app. acceptsFirstResponder=true so keyDown/keyUp route here.
    define_class!(
        #[unsafe(super(NSView))]
        #[thread_kind = MainThreadOnly]
        #[name = "AiosAppCastInputView"]
        #[ivars = OverlayViewIvars]
        struct AppCastInputView;

        impl AppCastInputView {
            // Compute (view_w, view_h, view-local TOP-LEFT point) for an event and
            // map to a global screen point, then post a mouse event of `kind`.
            #[unsafe(method(mouseDown:))]
            fn mouse_down(&self, event: &NSEvent) {
                self.forward_mouse(event, CGEventType::LeftMouseDown, CGMouseButton::Left);
            }
            #[unsafe(method(mouseUp:))]
            fn mouse_up(&self, event: &NSEvent) {
                self.forward_mouse(event, CGEventType::LeftMouseUp, CGMouseButton::Left);
            }
            #[unsafe(method(mouseDragged:))]
            fn mouse_dragged(&self, event: &NSEvent) {
                self.forward_mouse(event, CGEventType::LeftMouseDragged, CGMouseButton::Left);
            }
            #[unsafe(method(mouseMoved:))]
            fn mouse_moved(&self, event: &NSEvent) {
                self.forward_mouse(event, CGEventType::MouseMoved, CGMouseButton::Left);
            }
            #[unsafe(method(rightMouseDown:))]
            fn right_mouse_down(&self, event: &NSEvent) {
                self.forward_mouse(event, CGEventType::RightMouseDown, CGMouseButton::Right);
            }
            #[unsafe(method(rightMouseUp:))]
            fn right_mouse_up(&self, event: &NSEvent) {
                self.forward_mouse(event, CGEventType::RightMouseUp, CGMouseButton::Right);
            }
            #[unsafe(method(rightMouseDragged:))]
            fn right_mouse_dragged(&self, event: &NSEvent) {
                self.forward_mouse(event, CGEventType::RightMouseDragged, CGMouseButton::Right);
            }

            #[unsafe(method(scrollWheel:))]
            fn scroll_wheel(&self, event: &NSEvent) {
                let g = *self.ivars().geom.lock();
                if g.pid < 0 {
                    return;
                }
                let dy = event.scrollingDeltaY().round() as i32;
                let dx = event.deltaX().round() as i32;
                let flags = cg_flags(event.modifierFlags());
                post_scroll(g.pid, dy, dx, flags);
            }

            #[unsafe(method(keyDown:))]
            fn key_down(&self, event: &NSEvent) {
                let g = *self.ivars().geom.lock();
                if g.pid < 0 {
                    return;
                }
                let kc = event.keyCode();
                let flags = cg_flags(event.modifierFlags());
                post_key(g.pid, kc, true, flags);
            }
            #[unsafe(method(keyUp:))]
            fn key_up(&self, event: &NSEvent) {
                let g = *self.ivars().geom.lock();
                if g.pid < 0 {
                    return;
                }
                let kc = event.keyCode();
                let flags = cg_flags(event.modifierFlags());
                post_key(g.pid, kc, false, flags);
            }

            // Be the first responder so the window routes keyDown/keyUp to us, and
            // accept clicks even when the overlay isn't key (so the first click
            // lands on the captured app rather than just focusing the overlay).
            #[unsafe(method(acceptsFirstResponder))]
            fn accepts_first_responder(&self) -> bool {
                true
            }
            #[unsafe(method(acceptsFirstMouse:))]
            fn accepts_first_mouse(&self, _event: *mut NSEvent) -> bool {
                true
            }
        }
    );

    impl AppCastInputView {
        fn new(mtm: MainThreadMarker, frame: CGRect, geom: GeomCell) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(OverlayViewIvars { geom });
            unsafe { msg_send![super(this), initWithFrame: frame] }
        }

        /// Shared mouse path: derive the global point + post.
        fn forward_mouse(&self, event: &NSEvent, kind: CGEventType, button: CGMouseButton) {
            let g = *self.ivars().geom.lock();
            if g.pid < 0 {
                return;
            }
            // Bottom-left, window-local → bottom-left, view-local.
            let win_pt = event.locationInWindow();
            let as_view: &NSView = self;
            let v_bl = as_view.convertPoint_fromView(win_pt, None);
            let bounds = as_view.bounds();
            let view_w = bounds.size.width;
            let view_h = bounds.size.height;
            // Flip Y to top-left to match the captured (top-left) content space.
            let vy_tl = view_h - v_bl.y;
            let flags = cg_flags(event.modifierFlags());
            if let Some(global) = view_to_global(&g, view_w, view_h, v_bl.x, vy_tl) {
                post_mouse(g.pid, kind, button, global, flags);
            }
        }
    }

    /// One live capture session, keyed by pane `label`.
    struct AppCastSession {
        stream: Retained<SCStream>,
        // The delegate must outlive the stream (SCK holds it weakly-ish via the
        // output registration); keep it alive here.
        _output: Retained<ProtocolObject<dyn SCStreamOutput>>,
        // The borderless child NSWindow whose contentView's layer we feed frames
        // into. It lives OUTSIDE tao's view hierarchy (see module doc) — that is
        // what avoids the mouseMoved crash. Removed as a child + ordered out +
        // closed on teardown.
        overlay: Retained<NSWindow>,
        // The main window the overlay is parented to — kept so close() can
        // removeChildWindow: it.
        parent: Retained<NSWindow>,
        layer: Retained<CALayer>,
        pid: i32,
        // Shared capture geometry — read by the overlay's event handlers to map a
        // click → the real window's global screen point; refreshed on every
        // bounds poll so it tracks the target window moving/resizing.
        geom: GeomCell,
        // The captured SCWindow, kept so set_bounds can cheaply re-read its
        // (possibly moved/resized) frame and refresh `geom` without re-running a
        // full SCShareableContent enumeration each poll tick.
        sc_window: Retained<SCWindow>,
    }

    // The objc objects are main-thread-affine; we only ever touch this map from
    // Tauri commands (which we keep on main via the AppHandle). Mark Send so it
    // can live in Tauri-managed state.
    unsafe impl Send for AppCastSession {}

    #[derive(Default)]
    pub struct AppCastState {
        sessions: Mutex<std::collections::HashMap<String, AppCastSession>>,
    }

    /// Reach the main window's `NSWindow` — both to parent the overlay onto and to
    /// map slot rects into screen coordinates.
    fn main_window(app: &AppHandle) -> Result<Retained<NSWindow>, String> {
        let window = app
            .get_window("main")
            .or_else(|| app.windows().into_values().next())
            .ok_or("no main window")?;
        let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())?;
        if ns_window_ptr.is_null() {
            return Err("ns_window is null".into());
        }
        // SAFETY: Tauri hands us the real NSWindow pointer for the main window.
        // Retain it (not just borrow) so the overlay's parent reference is stable
        // for the session's lifetime.
        let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *const NSWindow) };
        Ok(ns_window.retain())
    }

    /// Convert a top-left-origin React slot rect (CSS px, == AppKit points since
    /// Tauri uses logical points), measured RELATIVE TO THE MAIN WINDOW's content
    /// area, into a bottom-left-origin frame in SCREEN coordinates — where a child
    /// NSWindow's frame lives.
    ///
    /// The frontend's `getBoundingClientRect()` is relative to the web view's
    /// viewport, which fills the main window's content area, so the slot's window-
    /// local top-left is `(x, y)` measured from the content area's TOP-left.
    ///
    /// Screen mapping (AppKit's screen origin is bottom-left):
    ///   screen_x = window_frame.x + x
    ///   screen_y = window_frame.y + window_frame.height - (y + height)
    /// where `window_frame` is the main window's frame in screen coords. Using the
    /// full window frame (titlebar included) keeps the slot's relative offset
    /// intact because the web content sits at the window's top edge in this app
    /// (no native titlebar inset); if a chrome inset is later added, subtract it
    /// from the height term.
    fn slot_to_screen_frame(
        parent: &NSWindow,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> CGRect {
        let wf = parent.frame();
        let w = width.max(1.0);
        let h = height.max(1.0);
        let sx = wf.origin.x + x;
        let sy = wf.origin.y + wf.size.height - (y + h);
        CGRect {
            origin: CGPoint { x: sx, y: sy },
            size: CGSize { width: w, height: h },
        }
    }

    /// True if this window belongs to a system/chrome process the picker should
    /// hide (Dock, Control Center, menubar, WindowServer, etc.) — by owning-app
    /// name OR bundle id, so renamed/localized builds are still caught.
    fn is_system_junk(app_name: &str, bundle_id: &str) -> bool {
        const JUNK_NAMES: &[&str] = &[
            "Dock",
            "Control Center",
            "Controle",            // localized Control Center variants
            "WindowServer",
            "SystemUIServer",
            "Notification Center",
            "NotificationCenter",
            "Spotlight",
            "universalAccessAuthWarn",
            "UniversalAccessAuthWarn",
            "screencaptureui",
            "ScreenSaverEngine",
            "loginwindow",
            "Wallpaper",
            "Window Manager",
            "WallpaperAgent",
        ];
        const JUNK_BUNDLES: &[&str] = &[
            "com.apple.dock",
            "com.apple.controlcenter",
            "com.apple.WindowManager",
            "com.apple.systemuiserver",
            "com.apple.notificationcenterui",
            "com.apple.Spotlight",
            "com.apple.universalaccessAuthWarn",
            "com.apple.screencaptureui",
            "com.apple.ScreenSaver.Engine",
            "com.apple.loginwindow",
            "com.apple.wallpaper.agent",
        ];
        JUNK_NAMES.iter().any(|j| app_name == *j)
            || (!bundle_id.is_empty() && JUNK_BUNDLES.iter().any(|j| bundle_id == *j))
    }

    // ── Enumeration ─────────────────────────────────────────────────────────
    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        // SCShareableContent::get is completion-handler-only (async). Bridge it to
        // a blocking call over a channel — this is the first SCK call, so it also
        // triggers the Screen Recording TCC prompt on first use.
        let (tx, rx) = mpsc::channel::<Result<Vec<WindowInfo>, String>>();
        let tx_block = tx.clone();
        let handler = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut objc2_foundation::NSError| {
                if !error.is_null() {
                    let msg = unsafe { (*error).localizedDescription() };
                    let _ = tx_block.send(Err(format!("SCShareableContent failed: {}", msg)));
                    return;
                }
                let Some(content) = (unsafe { content.as_ref() }) else {
                    let _ = tx_block.send(Err("SCShareableContent returned null".into()));
                    return;
                };
                let windows: Retained<NSArray<SCWindow>> = unsafe { content.windows() };
                let mut out = Vec::new();
                for win in windows.iter() {
                    let on_screen = unsafe { win.isOnScreen() };
                    let frame = unsafe { win.frame() };
                    // Drop off-screen + tiny windows (menubar extras, status items,
                    // 1px helper windows) — a real mirrorable window is ≥ 80px.
                    if !on_screen || frame.size.width < 80.0 || frame.size.height < 80.0 {
                        continue;
                    }
                    let title = unsafe { win.title() }
                        .map(|s| s.to_string())
                        .unwrap_or_default();
                    let window_id = unsafe { win.windowID() };
                    let (app_name, pid, bundle_id) = match unsafe { win.owningApplication() } {
                        Some(app) => (
                            unsafe { app.applicationName() }.to_string(),
                            unsafe { app.processID() },
                            unsafe { app.bundleIdentifier() }.to_string(),
                        ),
                        None => (String::new(), -1, String::new()),
                    };
                    // Skip our own bundle so the picker never lists AIOS itself.
                    if app_name == "AIOS" {
                        continue;
                    }
                    if is_system_junk(&app_name, &bundle_id) {
                        continue;
                    }
                    // Empty-title windows are almost always system/helper surfaces
                    // (sheets, popovers, the desktop) — skip them.
                    if title.trim().is_empty() {
                        continue;
                    }
                    out.push(WindowInfo {
                        app_name,
                        window_title: title,
                        window_id,
                        pid,
                        bundle_id,
                    });
                }
                let _ = tx_block.send(Ok(out));
            },
        );
        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                true,
                true,
                &handler,
            );
        }
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "timed out waiting for SCShareableContent (Screen Recording permission?)".to_string())?
    }

    /// Find the SCWindow whose windowID matches, then build + start a stream that
    /// renders it into a fresh layer-backed NSView child at the slot rect.
    pub fn start(
        app: &AppHandle,
        label: String,
        window_id: u32,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        // Already running for this label? just reposition.
        {
            let state = app.state::<AppCastState>();
            if state.sessions.lock().contains_key(&label) {
                return set_bounds(app, label, x, y, width, height);
            }
        }

        // Resolve the SCWindow object (blocking enumeration again — SCK gives us
        // SCWindow objects only through SCShareableContent).
        let (tx, rx) = mpsc::channel::<Result<Retained<SCWindow>, String>>();
        let handler = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut objc2_foundation::NSError| {
                if !error.is_null() {
                    let msg = unsafe { (*error).localizedDescription() };
                    let _ = tx.send(Err(format!("SCShareableContent failed: {}", msg)));
                    return;
                }
                let Some(content) = (unsafe { content.as_ref() }) else {
                    let _ = tx.send(Err("SCShareableContent returned null".into()));
                    return;
                };
                let windows = unsafe { content.windows() };
                for win in windows.iter() {
                    // `win` is a `Retained<SCWindow>` (default Iter yields owned).
                    if unsafe { win.windowID() } == window_id {
                        let _ = tx.send(Ok(win.clone()));
                        return;
                    }
                }
                let _ = tx.send(Err(format!("window {window_id} not found / not capturable")));
            },
        );
        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                false,
                false,
                &handler,
            );
        }
        let sc_window = rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "timed out resolving window".to_string())??;

        let pid = match unsafe { sc_window.owningApplication() } {
            Some(a) => unsafe { a.processID() },
            None => -1,
        };
        let win_frame = unsafe { sc_window.frame() };

        // ── Build the overlay child window + its layer-hosting contentView ──
        let parent = main_window(app)?;
        // Backing scale (Retina): capture at device px so the mirror is sharp.
        let scale = parent.backingScaleFactor();

        // Screen-coord frame for the overlay (child NSWindow frames are in screen
        // space). Mirrors browser.rs slot positioning, just window→screen mapped.
        let frame = slot_to_screen_frame(&parent, x, y, width, height);

        // NSWindow + NSView are MainThreadOnly. This command is SYNC (see
        // appcast_start), so Tauri runs it on the main thread — assert + capture
        // the marker for alloc.
        let mtm = MainThreadMarker::new()
            .ok_or("appcast_start must run on the main thread")?;

        // Borderless overlay window. Buffered backing, deferred creation off.
        // SAFETY: standard NSWindow designated initializer on a fresh allocation.
        let overlay: Retained<NSWindow> = unsafe {
            let alloc = NSWindow::alloc(mtm);
            NSWindow::initWithContentRect_styleMask_backing_defer(
                alloc,
                frame,
                NSWindowStyleMask::Borderless,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        // Transparent overlay: no opaque chrome, clear background so only the
        // captured layer is visible. Phase B: the overlay RECEIVES its own mouse +
        // key events (ignoresMouseEvents=false) and forwards them to the captured
        // app. Safe because this is a SEPARATE child NSWindow outside tao's view
        // tree — its events never touch tao's broken mouseMoved weak-ref path
        // (the window isolation, not the Phase-A passthrough guard, is what
        // prevents that crash).
        overlay.setOpaque(false);
        overlay.setBackgroundColor(Some(&NSColor::clearColor()));
        overlay.setIgnoresMouseEvents(false);
        // Don't auto-release on close — we manage its lifetime via the Retained
        // handle in the session map and explicitly close() on teardown.
        // SAFETY: setting the released-when-closed flag; the Retained handle keeps
        // the window alive regardless, so close() won't dangle.
        unsafe { overlay.setReleasedWhenClosed(false) };

        // Shared capture geometry the input view reads to map clicks. SCWindow
        // frame is in TOP-LEFT global-screen points (matches CGEvent globals).
        let geom: GeomCell = Arc::new(Mutex::new(CaptureGeom {
            win_x: win_frame.origin.x,
            win_y: win_frame.origin.y,
            win_w: win_frame.size.width,
            win_h: win_frame.size.height,
            pid,
        }));

        // Layer-hosting contentView for the overlay — a custom NSView subclass
        // that receives the overlay's mouse/key events and forwards them to the
        // captured app. The overlay's content area is the full borderless frame,
        // so the capture view fills it at origin (0,0).
        let view_frame = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: frame.size,
        };
        let view = AppCastInputView::new(mtm, view_frame, geom.clone());
        let layer = CALayer::new();
        // Aspect-fit the captured surface inside the slot. kCAGravityResizeAspect.
        layer.setContentsGravity(&NSString::from_str("resizeAspect"));
        view.setLayer(Some(&layer));
        view.setWantsLayer(true);
        overlay.setContentView(Some(&view));
        // Route keyDown/keyUp into the input view while the overlay is key.
        // NSView : NSResponder, so deref the view to its NSResponder base.
        let responder: &NSResponder = &view;
        overlay.makeFirstResponder(Some(responder));

        // Parent the overlay onto the main window so it moves + orders with it.
        // NSWindowOrderingMode::Above = stacked in front of the parent.
        unsafe {
            parent.addChildWindow_ordered(&overlay, NSWindowOrderingMode::Above);
        }

        // ── SCContentFilter (single window) ──
        let filter: Retained<SCContentFilter> = unsafe {
            let alloc = SCContentFilter::alloc();
            SCContentFilter::initWithDesktopIndependentWindow(alloc, &sc_window)
        };

        // ── SCStreamConfiguration ──
        let cfg = unsafe { SCStreamConfiguration::new() };
        let cap_w = (win_frame.size.width * scale).round() as usize;
        let cap_h = (win_frame.size.height * scale).round() as usize;
        unsafe {
            cfg.setWidth(cap_w.max(2));
            cfg.setHeight(cap_h.max(2));
            cfg.setPixelFormat(PIXEL_FORMAT_BGRA);
            cfg.setShowsCursor(false);
            cfg.setQueueDepth(5);
            // Cap to ~30fps: minimumFrameInterval = 1/30s as CMTime(value=1, ts=30).
            cfg.setMinimumFrameInterval(objc2_core_media::CMTime {
                value: 1,
                timescale: 30,
                flags: objc2_core_media::CMTimeFlags(1), // kCMTimeFlags_Valid
                epoch: 0,
            });
        }

        // ── Delegate + stream ──
        let output = AppCastOutput::new(layer.clone());
        let output_proto = ProtocolObject::from_retained(output);
        let stream: Retained<SCStream> = unsafe {
            let alloc = SCStream::alloc();
            msg_send![
                alloc,
                initWithFilter: &*filter,
                configuration: &*cfg,
                delegate: std::ptr::null::<AnyObject>(),
            ]
        };
        // Sample handler queue: main, so CALayer.contents is set on the main
        // thread (Core Animation requirement) without an extra dispatch hop.
        let main_q = dispatch2::DispatchQueue::main();
        unsafe {
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    &output_proto,
                    SCStreamOutputType::Screen,
                    Some(main_q),
                )
                .map_err(|e| format!("addStreamOutput failed: {}", e.localizedDescription()))?;
        }

        // startCaptureWithCompletionHandler: — async; bridge to blocking so we can
        // report a start failure synchronously to the frontend.
        let (stx, srx) = mpsc::channel::<Result<(), String>>();
        let start_handler = RcBlock::new(move |error: *mut objc2_foundation::NSError| {
            if error.is_null() {
                let _ = stx.send(Ok(()));
            } else {
                let msg = unsafe { (*error).localizedDescription() };
                let _ = stx.send(Err(format!("startCapture failed: {}", msg)));
            }
        });
        unsafe {
            stream.startCaptureWithCompletionHandler(Some(&start_handler));
        }
        srx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "timed out starting capture".to_string())??;

        let state = app.state::<AppCastState>();
        state.sessions.lock().insert(
            label,
            AppCastSession {
                stream,
                _output: output_proto,
                overlay,
                parent,
                layer,
                pid,
                geom,
                sc_window,
            },
        );
        Ok(())
    }

    pub fn set_bounds(
        app: &AppHandle,
        label: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        let parent = main_window(app)?;
        // Map the window-local slot rect to a SCREEN frame for the child window.
        let frame = slot_to_screen_frame(&parent, x, y, width, height);
        let state = app.state::<AppCastState>();
        let sessions = state.sessions.lock();
        if let Some(s) = sessions.get(&label) {
            // Reposition the overlay window itself (screen coords)…
            s.overlay.setFrame_display(frame, false);
            // …and resize its contentView to fill the new frame so the layer
            // tracks the slot. (Origin stays (0,0); only size matters.)
            if let Some(v) = s.overlay.contentView() {
                v.setFrame(CGRect {
                    origin: CGPoint { x: 0.0, y: 0.0 },
                    size: frame.size,
                });
            }
            // Refresh cached capture geometry: the REAL target window may have
            // moved/resized since start, which shifts where a click maps to. Cheap
            // — just re-reads the retained SCWindow's frame (no SCK enumeration).
            let wf = unsafe { s.sc_window.frame() };
            let mut g = s.geom.lock();
            g.win_x = wf.origin.x;
            g.win_y = wf.origin.y;
            g.win_w = wf.size.width;
            g.win_h = wf.size.height;
        }
        Ok(())
    }

    pub fn hide(app: &AppHandle, label: String) -> Result<(), String> {
        let state = app.state::<AppCastState>();
        let sessions = state.sessions.lock();
        if let Some(s) = sessions.get(&label) {
            s.overlay.orderOut(None);
        }
        Ok(())
    }

    pub fn show(app: &AppHandle, label: String) -> Result<(), String> {
        let state = app.state::<AppCastState>();
        let sessions = state.sessions.lock();
        if let Some(s) = sessions.get(&label) {
            // orderFront re-shows; the child-window parenting keeps z-order with
            // the main window.
            s.overlay.orderFront(None);
        }
        Ok(())
    }

    pub fn close(app: &AppHandle, label: String) -> Result<(), String> {
        let state = app.state::<AppCastState>();
        let session = state.sessions.lock().remove(&label);
        if let Some(s) = session {
            // Stop the stream (best-effort, async — we don't wait), drop the
            // layer contents, detach the overlay from the parent + tear it down.
            let stop_handler = RcBlock::new(|_error: *mut objc2_foundation::NSError| {});
            unsafe {
                s.stream.stopCaptureWithCompletionHandler(Some(&stop_handler));
                s.layer.setContents(None);
            }
            s.parent.removeChildWindow(&s.overlay);
            s.overlay.orderOut(None);
            s.overlay.close();
            let _ = s.pid;
            // `s` (incl. stream + output delegate + retained overlay/parent) drops
            // here, releasing SCK refs and the overlay window.
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands — thin wrappers over imp::* (macOS) / no-ops (other platforms).
// Registered in lib.rs `generate_handler!`, beside the browser::* block.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub use imp::AppCastState;

/// Non-macOS placeholder state so `.manage()` in lib.rs compiles everywhere.
#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct AppCastState;

#[tauri::command]
pub fn appcast_list_windows() -> Result<Vec<WindowInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        imp::list_windows()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("app-cast is macOS-only".into())
    }
}

// SYNC (not async) on purpose: this builds a MainThreadOnly NSView + touches the
// NSWindow, so it must run on the MAIN thread. Tauri dispatches SYNC commands on
// the main thread on macOS — the inverse of browser_show, which is async ONLY to
// dodge a Windows `add_child` deadlock (browser.rs:159-165). App-cast is macOS-
// only and uses raw objc (no add_child), so sync is both correct and required.
#[tauri::command]
pub fn appcast_start(
    app: tauri::AppHandle,
    label: String,
    window_id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        imp::start(&app, label, window_id, x, y, width, height)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label, window_id, x, y, width, height);
        Err("app-cast is macOS-only".into())
    }
}

#[tauri::command]
pub fn appcast_set_bounds(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        imp::set_bounds(&app, label, x, y, width, height)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label, x, y, width, height);
        Ok(())
    }
}

#[tauri::command]
pub fn appcast_hide(app: tauri::AppHandle, label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        imp::hide(&app, label)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label);
        Ok(())
    }
}

#[tauri::command]
pub fn appcast_show(app: tauri::AppHandle, label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        imp::show(&app, label)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label);
        Ok(())
    }
}

#[tauri::command]
pub fn appcast_close(app: tauri::AppHandle, label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        imp::close(&app, label)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label);
        Ok(())
    }
}
