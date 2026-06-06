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
//!   the CALayer backs an NSView added as a child of the main window's contentView,
//!   bounds-synced to the React slot via appcast_set_bounds (mirrors browser.rs).
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
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS implementation
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod imp {
    use super::WindowInfo;
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSView, NSWindow};
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

    /// One live capture session, keyed by pane `label`.
    struct AppCastSession {
        stream: Retained<SCStream>,
        // The delegate must outlive the stream (SCK holds it weakly-ish via the
        // output registration); keep it alive here.
        _output: Retained<ProtocolObject<dyn SCStreamOutput>>,
        // The layer-hosting NSView added as a child of the main window's
        // contentView. Removed from its superview on close.
        view: Retained<NSView>,
        layer: Retained<CALayer>,
        pid: i32,
    }

    // The objc objects are main-thread-affine; we only ever touch this map from
    // Tauri commands (which we keep on main via the AppHandle). Mark Send so it
    // can live in Tauri-managed state.
    unsafe impl Send for AppCastSession {}

    #[derive(Default)]
    pub struct AppCastState {
        sessions: Mutex<std::collections::HashMap<String, AppCastSession>>,
    }

    /// Reach the main window's contentView (NSView) to add capture child views to.
    fn main_content_view(app: &AppHandle) -> Result<Retained<NSView>, String> {
        let window = app
            .get_window("main")
            .or_else(|| app.windows().into_values().next())
            .ok_or("no main window")?;
        let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())?;
        if ns_window_ptr.is_null() {
            return Err("ns_window is null".into());
        }
        // SAFETY: Tauri hands us the real NSWindow pointer for the main window.
        let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *const NSWindow) };
        ns_window
            .contentView()
            .ok_or_else(|| "main window has no contentView".into())
    }

    /// Convert a top-left-origin React slot rect (CSS px, == AppKit points since
    /// Tauri uses logical points) into an AppKit bottom-left-origin frame within
    /// the contentView. AppKit's contentView is NOT flipped by default, so y must
    /// be measured from the bottom: ny = parentHeight - (rect.y + rect.height).
    fn slot_to_frame(parent: &NSView, x: f64, y: f64, width: f64, height: f64) -> CGRect {
        let parent_h = parent.frame().size.height;
        let w = width.max(1.0);
        let h = height.max(1.0);
        let ny = parent_h - (y + h);
        CGRect {
            origin: CGPoint { x, y: ny },
            size: CGSize { width: w, height: h },
        }
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
                    if !on_screen || frame.size.width < 2.0 || frame.size.height < 2.0 {
                        continue;
                    }
                    let title = unsafe { win.title() }
                        .map(|s| s.to_string())
                        .unwrap_or_default();
                    let window_id = unsafe { win.windowID() };
                    let (app_name, pid) = match unsafe { win.owningApplication() } {
                        Some(app) => (
                            unsafe { app.applicationName() }.to_string(),
                            unsafe { app.processID() },
                        ),
                        None => (String::new(), -1),
                    };
                    // Skip our own bundle so the picker never lists AIOS itself.
                    if app_name == "AIOS" {
                        continue;
                    }
                    out.push(WindowInfo {
                        app_name,
                        window_title: title,
                        window_id,
                        pid,
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

        // ── Build the native child view + its CALayer ──
        let content_view = main_content_view(app)?;
        // Backing scale (Retina): capture at device px so the mirror is sharp.
        let scale = content_view
            .window()
            .map(|w| w.backingScaleFactor())
            .unwrap_or(2.0);

        let frame = slot_to_frame(&content_view, x, y, width, height);
        // NSView is MainThreadOnly. This command is SYNC (see appcast_start), so
        // Tauri runs it on the main thread — assert + capture the marker for alloc.
        let mtm = MainThreadMarker::new()
            .ok_or("appcast_start must run on the main thread")?;
        // SAFETY: standard NSView designated initializer on a fresh allocation.
        let view: Retained<NSView> = unsafe {
            let alloc = NSView::alloc(mtm);
            msg_send![alloc, initWithFrame: frame]
        };
        let layer = CALayer::new();
        // Aspect-fit the captured surface inside the slot. kCAGravityResizeAspect.
        layer.setContentsGravity(&NSString::from_str("resizeAspect"));
        view.setLayer(Some(&layer));
        view.setWantsLayer(true);
        content_view.addSubview(&view);

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
                view,
                layer,
                pid,
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
        let content_view = main_content_view(app)?;
        let frame = slot_to_frame(&content_view, x, y, width, height);
        let state = app.state::<AppCastState>();
        let sessions = state.sessions.lock();
        if let Some(s) = sessions.get(&label) {
            s.view.setFrame(frame);
        }
        Ok(())
    }

    pub fn hide(app: &AppHandle, label: String) -> Result<(), String> {
        let state = app.state::<AppCastState>();
        let sessions = state.sessions.lock();
        if let Some(s) = sessions.get(&label) {
            s.view.setHidden(true);
        }
        Ok(())
    }

    pub fn show(app: &AppHandle, label: String) -> Result<(), String> {
        let state = app.state::<AppCastState>();
        let sessions = state.sessions.lock();
        if let Some(s) = sessions.get(&label) {
            s.view.setHidden(false);
        }
        Ok(())
    }

    pub fn close(app: &AppHandle, label: String) -> Result<(), String> {
        let state = app.state::<AppCastState>();
        let session = state.sessions.lock().remove(&label);
        if let Some(s) = session {
            // Stop the stream (best-effort, async — we don't wait), drop the
            // layer contents, and pull the view out of the hierarchy.
            let stop_handler = RcBlock::new(|_error: *mut objc2_foundation::NSError| {});
            unsafe {
                s.stream.stopCaptureWithCompletionHandler(Some(&stop_handler));
                s.layer.setContents(None);
                s.view.removeFromSuperview();
            }
            let _ = s.pid;
            // `s` (incl. stream + output delegate) drops here, releasing SCK refs.
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
