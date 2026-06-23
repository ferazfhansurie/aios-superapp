//! Embedded browser panes backed by NATIVE child webviews (real WebKit, not
//! iframes) so X-Frame-Options / frame-ancestors sites (vercel, google, …)
//! render. Each browser PANE owns its own webview, keyed by a per-pane label,
//! so the user can spawn as many as they like. The frontend reports each pane's
//! on-screen rect; we create/position/resize/hide/close the matching webview.
//!
//! Requires the tauri `unstable` feature (child webviews via `Window::add_child`).

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

/// The webview UA, matched to the host engine so the fingerprint is honest.
///
/// macOS: present as desktop **Safari**, NOT Chrome. We're a WKWebView — Safari's
/// own engine — so a Safari UA is the consistent fingerprint and Google fully
/// supports Safari sign-in. A Chrome UA gets flagged on Google's OAuth pages
/// ("this browser or app may not be secure"): real Chrome sends `Sec-CH-UA`
/// client-hint headers a WKWebView can't, so "claims Chrome + no client hints"
/// reads as a fake/embedded browser. The `Version/… Safari/…` suffix separates
/// real Safari from a bare embedded webview (whose default UA omits it).
///
/// Windows: the webview is WebView2 (Chromium), so a Windows-Chrome UA is the
/// honest match — a Mac-Safari UA on Windows would be the obviously-wrong combo.
/// Cookies persist on-disk per profile, so logins stick on both.
#[cfg(windows)]
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
#[cfg(not(windows))]
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

fn parse(url: &str) -> Result<Url, String> {
    Url::parse(url).map_err(|e| format!("bad url: {e}"))
}

static BROWSER_LIFECYCLE: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn begin_browser_lifecycle(label: &str) -> bool {
    BROWSER_LIFECYCLE
        .lock()
        .map(|mut labels| labels.insert(label.to_string()))
        .unwrap_or(false)
}

fn browser_lifecycle_is_active(label: &str) -> bool {
    BROWSER_LIFECYCLE
        .lock()
        .map(|labels| labels.contains(label))
        .unwrap_or(false)
}

fn end_browser_lifecycle(label: &str) {
    if let Ok(mut labels) = BROWSER_LIFECYCLE.lock() {
        labels.remove(label);
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct BrowserNewPane {
    url: String,
    profile: Option<String>,
    /// True when the page requested this via `window.open` with explicit window
    /// features (a size was specified) — the classic OAuth / "sign in with …"
    /// popup shape (`window.open(url, "_blank", "width=500,height=600,menubar=no")`).
    /// The frontend treats a popup as a TRANSIENT child tied to its opener (so an
    /// auth flow doesn't strand a permanent pane), versus a plain link/⌘-click
    /// (`is_popup=false`) which becomes a normal persistent pane.
    is_popup: bool,
}

fn browser_new_pane(url: &Url, profile: &Option<String>, is_popup: bool) -> BrowserNewPane {
    BrowserNewPane {
        url: url.to_string(),
        profile: profile.clone(),
        is_popup,
    }
}

fn standard_adblock_content_rules_json() -> String {
    let cosmetic_selectors = [
        "[id*=\"ad-\"]",
        "[id^=\"ad_\"]",
        "[class*=\" ad-\"]",
        "[class^=\"ad-\"]",
        "[class*=\" ads-\"]",
        "[class*=\"advert\"]",
        "[class*=\"sponsor\"]",
        ".google-auto-placed",
        "ins.adsbygoogle",
        "iframe[src*=\"doubleclick\"]",
        "iframe[src*=\"googlesyndication\"]",
    ]
    .join(",");

    serde_json::json!([
        {
            "trigger": {
                "url-filter": r".*://([^/]+\.)?(acscdn|adcash|adform|adkernel|admaven|adnxs|adservice|adsterra|adsystem|adskeeper|clickadu|clickaine|connect\.facebook|doubleclick|exoclick|facebook|googleadservices|googleads|googlesyndication|googletagmanager|googletagservices|hilltopads|mgid|onclickads|outbrain|popads|popcash|propellerads|revcontent|scorecardresearch|taboola|trafficjunky)\.",
                "resource-type": ["document", "image", "script", "style-sheet", "font", "raw", "popup"]
            },
            "action": { "type": "block" }
        },
        {
            "trigger": {
                "url-filter": r".*(/ads?|/adserver|/pagead/|/gampad/|/advertising/|/banner(ad)?/|/sponsor(ed)?/|/tracking/|/track/|/pixel\b|/beacon\b|utm_source=|utm_campaign=).*",
                "resource-type": ["document", "image", "script", "style-sheet", "font", "raw", "popup"]
            },
            "action": { "type": "block" }
        },
        {
            "trigger": { "url-filter": ".*" },
            "action": {
                "type": "css-display-none",
                "selector": cosmetic_selectors
            }
        }
    ])
    .to_string()
}

#[cfg(target_os = "macos")]
fn install_standard_adblock(wk: &objc2_web_kit::WKWebView) {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_foundation::NSString;
    use objc2_web_kit::WKContentRuleListStore;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
        return;
    };
    let controller = unsafe { wk.configuration().userContentController() };
    let identifier = NSString::from_str("aios-standard-adblock-v1");
    let rules = NSString::from_str(&standard_adblock_content_rules_json());
    let block = RcBlock::new(
        move |rule_list: *mut objc2_web_kit::WKContentRuleList,
              _err: *mut objc2_foundation::NSError| {
            if let Some(rule_list) = unsafe { rule_list.as_ref() } {
                unsafe { controller.addContentRuleList(rule_list) };
            }
        },
    );

    unsafe {
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&identifier),
            Some(&rules),
            Some(&block),
        );
    }
}

/// Derive a stable 16-byte WKWebsiteDataStore identifier from a profile name.
/// Each distinct profile gets its OWN persistent cookie jar — so two Google
/// accounts can be logged in simultaneously (each is a *fresh first login* in
/// its own partition, sidestepping Google's stricter "add account" webview
/// check that throws "this browser or app may not be secure"). Deterministic
/// (FNV-1a, two salted passes) so a profile's login persists across restarts.
///
/// macOS only: `data_store_identifier` is a WKWebView API. On Windows (WebView2)
/// this helper is unused — see `browser_show`.
#[cfg(target_os = "macos")]
fn profile_store_id(profile: &str) -> [u8; 16] {
    fn fnv1a(bytes: &[u8], mut hash: u64) -> u64 {
        for &b in bytes {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
        }
        hash
    }
    let lo = fnv1a(profile.as_bytes(), 0xcbf2_9ce4_8422_2325);
    let hi = fnv1a(profile.as_bytes(), 0x9e37_79b9_7f4a_7c15);
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&lo.to_le_bytes());
    id[8..].copy_from_slice(&hi.to_le_bytes());
    id
}

// ─── Push-based nav state + load errors (macOS) ──────────────────────────────
//
// Replaces the frontend's 350ms `browser_nav_state`/`browser_current_url` poll
// with real push events. One `AiosNavObserver` per browser webview does two
// jobs:
//
//   1. KVO-observes the WKWebView's `canGoBack` / `canGoForward` / `URL` /
//      `estimatedProgress` / `loading` and emits a coalesced
//      `browser-nav-state` event whenever the composed snapshot changes.
//   2. Becomes the webview's `navigationDelegate`, RETAINING wry's original
//      delegate and forwarding every selector it doesn't implement back to it
//      (`respondsToSelector:` + `forwardingTargetForSelector:` — the standard
//      ObjC proxy pattern), while adding the two `didFail*` callbacks wry never
//      implemented → `browser-load-error` events. wry's policy decisions,
//      page-load hooks and download delegate all keep firing through the proxy.
//
// TEARDOWN (read before touching): a WKWebView deallocated while KVO observers
// are still registered is a use-after-free-shaped crash on older macOS (10.13+
// auto-unregisters, but we don't lean on that). `browser_close` calls
// `nav_state::detach` BEFORE navigating away / closing — it removes every
// observer and restores wry's original delegate, all inside a `with_webview`
// main-thread closure, which the runtime serializes ahead of the subsequent
// `close()`. The observer itself is kept alive by the `OBSERVERS` registry
// (the webview's delegate reference is weak), so dropping the registry entry
// after detach is the whole lifecycle.
#[cfg(target_os = "macos")]
mod nav_state {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject, Sel};
    use objc2::{
        define_class, msg_send, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly,
    };
    use objc2_foundation::{
        NSError, NSKeyValueObservingOptions, NSObject, NSObjectNSKeyValueObserverRegistration,
        NSObjectProtocol, NSString,
    };
    use objc2_web_kit::{WKNavigation, WKNavigationDelegate, WKWebView};
    use tauri::{AppHandle, Emitter, Manager};

    /// The observed key paths. Every one of these changing re-emits the full
    /// composed snapshot (the frontend wants the whole state, not deltas).
    const KEY_PATHS: &[&str] = &[
        "canGoBack",
        "canGoForward",
        "URL",
        "estimatedProgress",
        "loading",
    ];

    pub struct Ivars {
        app: AppHandle,
        label: String,
        /// wry's original navigation delegate — retained so policy decisions,
        /// page-load events and downloads keep flowing via forwarding.
        inner: RefCell<Option<Retained<ProtocolObject<dyn WKNavigationDelegate>>>>,
        /// Last emitted nav-state JSON; identical snapshots are coalesced away
        /// (KVO fires in bursts during a navigation — 5 keys × several phases).
        last_emit: RefCell<String>,
        /// True while KVO observers are registered — guarantees exactly-once
        /// `removeObserver` even if detach is somehow entered twice.
        attached: Cell<bool>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        pub struct AiosNavObserver;

        unsafe impl NSObjectProtocol for AiosNavObserver {}

        /// KVO sink + delegate-forwarding plumbing.
        impl AiosNavObserver {
            #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
            fn observe_value(
                &self,
                _key_path: Option<&NSString>,
                object: Option<&AnyObject>,
                _change: Option<&AnyObject>,
                _context: *mut std::ffi::c_void,
            ) {
                // We only ever register on a WKWebView; verify anyway before
                // casting — a wrong-object crash here takes the whole app down.
                let Some(object) = object else { return };
                let is_wk: bool = unsafe { msg_send![object, isKindOfClass: WKWebView::class()] };
                if !is_wk {
                    return;
                }
                let wk = unsafe { &*(object as *const AnyObject as *const WKWebView) };
                self.emit_nav_state(wk);
            }

            #[unsafe(method(respondsToSelector:))]
            fn responds_to_selector(&self, sel: Sel) -> objc2::runtime::Bool {
                // Own methods (didFail*, observeValue…, NSObject) first…
                let own: bool = unsafe { msg_send![super(self), respondsToSelector: sel] };
                // …then whatever wry's delegate answers, so WebKit keeps
                // calling decidePolicy…/didCommit…/download hooks through us.
                let fwd = || {
                    self.ivars()
                        .inner
                        .borrow()
                        .as_ref()
                        .is_some_and(|inner| inner.respondsToSelector(sel))
                };
                objc2::runtime::Bool::new(own || fwd())
            }

            #[unsafe(method(forwardingTargetForSelector:))]
            fn forwarding_target_for_selector(&self, sel: Sel) -> *mut AnyObject {
                if let Some(inner) = self.ivars().inner.borrow().as_ref() {
                    if inner.respondsToSelector(sel) {
                        // +0 (unretained) return is the forwardingTarget contract.
                        return Retained::as_ptr(inner) as *mut AnyObject;
                    }
                }
                std::ptr::null_mut()
            }
        }

        // The two navigation-failure callbacks wry's delegate doesn't implement.
        // Everything else in the protocol forwards to wry (above).
        unsafe impl WKNavigationDelegate for AiosNavObserver {
            #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
            fn did_fail_provisional_navigation(
                &self,
                webview: &WKWebView,
                _navigation: Option<&WKNavigation>,
                error: &NSError,
            ) {
                self.emit_load_error(webview, error, true);
                self.emit_nav_state(webview);
            }

            #[unsafe(method(webView:didFailNavigation:withError:))]
            fn did_fail_navigation(
                &self,
                webview: &WKWebView,
                _navigation: Option<&WKNavigation>,
                error: &NSError,
            ) {
                self.emit_load_error(webview, error, false);
                self.emit_nav_state(webview);
            }
        }
    );

    impl AiosNavObserver {
        fn new(mtm: MainThreadMarker, app: AppHandle, label: String) -> Retained<Self> {
            let this = mtm.alloc::<Self>().set_ivars(Ivars {
                app,
                label,
                inner: RefCell::new(None),
                last_emit: RefCell::new(String::new()),
                attached: Cell::new(false),
            });
            unsafe { msg_send![super(this), init] }
        }

        /// Composes the full nav snapshot and emits `browser-nav-state` if it
        /// differs from the last one sent (burst coalescing).
        fn emit_nav_state(&self, wk: &WKWebView) {
            let iv = self.ivars();
            let url = unsafe { wk.URL() }
                .and_then(|u| u.absoluteString())
                .map(|s| s.to_string())
                .unwrap_or_default();
            // 0..1; round to 2dp so progress jitter doesn't defeat coalescing.
            let progress = (unsafe { wk.estimatedProgress() } * 100.0).round() / 100.0;
            let payload = serde_json::json!({
                "label": iv.label,
                "url": url,
                "canBack": unsafe { wk.canGoBack() },
                "canFwd": unsafe { wk.canGoForward() },
                "loading": unsafe { wk.isLoading() },
                "progress": progress,
            });
            let snapshot = payload.to_string();
            if *iv.last_emit.borrow() == snapshot {
                return;
            }
            iv.last_emit.replace(snapshot);
            let _ = iv.app.emit("browser-nav-state", payload);
        }

        /// Emits `browser-load-error` for a real navigation failure. Filters the
        /// non-errors: NSURLErrorCancelled (-999, fired by rapid re-navigation /
        /// JS-initiated stops) and WebKitErrorDomain 102 "frame load interrupted"
        /// (fired when a navigation turns into a download or a policy redirect).
        fn emit_load_error(&self, wk: &WKWebView, error: &NSError, provisional: bool) {
            let code = error.code() as i64;
            if code == -999 {
                return;
            }
            let domain = error.domain().to_string();
            if domain == "WebKitErrorDomain" && (code == 102 || code == 204) {
                return;
            }
            let url = failing_url(error)
                .or_else(|| {
                    unsafe { wk.URL() }
                        .and_then(|u| u.absoluteString())
                        .map(|s| s.to_string())
                })
                .unwrap_or_default();
            let iv = self.ivars();
            let _ = iv.app.emit(
                "browser-load-error",
                serde_json::json!({
                    "label": iv.label,
                    "code": code,
                    "url": url,
                    "description": error.localizedDescription().to_string(),
                    "provisional": provisional,
                }),
            );
        }
    }

    /// The url that actually failed, from the NSError userInfo (the webview's
    /// `URL()` may already point elsewhere by the time the failure lands).
    fn failing_url(error: &NSError) -> Option<String> {
        let info = error.userInfo();
        let key = NSString::from_str("NSErrorFailingURLStringKey");
        let val = info.objectForKey(&key)?;
        val.downcast::<NSString>().ok().map(|s| s.to_string())
    }

    /// Registry keeping each observer alive (the webview's delegate ref is
    /// weak). Keyed by webview label; entry removed on detach.
    struct RegistryCell(Retained<AiosNavObserver>);
    impl RegistryCell {
        /// Consumes the WHOLE cell (not just `.0`) — keeps Rust-2021 disjoint
        /// closure capture from grabbing the non-Send `Retained` field directly,
        /// which would defeat the `unsafe impl Send` below.
        fn take(self) -> Retained<AiosNavObserver> {
            self.0
        }
    }
    // SAFETY: the Retained is only created, dereferenced and (in the normal
    // path) dropped on the main thread — attach/detach bodies run inside
    // `with_webview` main-thread closures. Off-main-thread the registry only
    // moves the pointer; in the worst (webview-already-gone) case the drop is
    // an off-thread objc release of an object whose dealloc touches only
    // plain Rust ivars, which is safe.
    unsafe impl Send for RegistryCell {}

    static OBSERVERS: LazyLock<Mutex<HashMap<String, RegistryCell>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    /// Installs the observer on a freshly-created browser webview. Idempotent
    /// per label. Emits one initial `browser-nav-state` so the frontend has
    /// the state without waiting for the first change.
    pub fn attach(app: &AppHandle, label: &str) {
        let Some(wv) = app.get_webview(label) else {
            return;
        };
        let app = app.clone();
        let label = label.to_string();
        let _ = wv.with_webview(move |pw| {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let ptr = pw.inner() as *mut WKWebView;
            let Some(wk) = (unsafe { ptr.as_ref() }) else {
                return;
            };
            {
                let Ok(map) = OBSERVERS.lock() else { return };
                if map.contains_key(&label) {
                    return;
                }
            }
            let this = AiosNavObserver::new(mtm, app, label.clone());
            this.ivars()
                .inner
                .replace(unsafe { wk.navigationDelegate() });
            unsafe { wk.setNavigationDelegate(Some(ProtocolObject::from_ref(&*this))) };
            for kp in KEY_PATHS {
                unsafe {
                    wk.addObserver_forKeyPath_options_context(
                        &this,
                        &NSString::from_str(kp),
                        NSKeyValueObservingOptions::New,
                        std::ptr::null_mut(),
                    )
                };
            }
            this.ivars().attached.set(true);
            this.emit_nav_state(wk);
            if let Ok(mut map) = OBSERVERS.lock() {
                map.insert(label, RegistryCell(this));
            }
        });
    }

    /// Removes KVO observers + restores wry's original delegate. MUST run
    /// before the webview is closed — see the module header. Safe to call for
    /// labels that were never attached.
    pub fn detach(app: &AppHandle, label: &str) {
        let cell = OBSERVERS.lock().ok().and_then(|mut m| m.remove(label));
        let Some(cell) = cell else { return };
        let Some(wv) = app.get_webview(label) else {
            return;
        };
        let _ = wv.with_webview(move |pw| {
            let this = cell.take();
            let ptr = pw.inner() as *mut WKWebView;
            let Some(wk) = (unsafe { ptr.as_ref() }) else {
                return;
            };
            if this.ivars().attached.replace(false) {
                for kp in KEY_PATHS {
                    unsafe { wk.removeObserver_forKeyPath(&this, &NSString::from_str(kp)) };
                }
            }
            let inner = this.ivars().inner.borrow_mut().take();
            unsafe { wk.setNavigationDelegate(inner.as_deref()) };
        });
    }
}

// Linux (webkit2gtk via wry) nav-state. There's NO KVO on webkit2gtk, so we
// can't observe `canGoBack`/`canGoForward` the way the macOS observer does, and
// `wv.eval` is fire-and-forget (no value round-trips back from the page).
// Instead we track a per-label, Rust-side navigation counter fed by wry's
// `on_navigation` callback (which DOES fire on Linux) and emit the same
// `browser-nav-state` event the frontend already consumes — so no frontend
// change is needed. We can know `canGoBack` (counter > 1) reliably; `canGoFwd`
// is not observable without a JS round-trip webkit2gtk doesn't cheaply give us,
// so it's reported best-effort as the page's own `history.forward()` is still a
// no-op-safe call. TODO(linux nav-state push): a true forward-availability
// signal would need a JS-side counter shuttled back over the IPC bridge.
#[cfg(not(target_os = "macos"))]
mod nav_state {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    use tauri::{AppHandle, Emitter};

    /// Per-label navigation count. `attach` resets it to 0 for the label; each
    /// top-level navigation bumps it. `count >= 2` means there's somewhere to go
    /// back to (the first nav is the initial page, no back target yet).
    static NAV_COUNT: LazyLock<Mutex<HashMap<String, u32>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    /// Initialises the per-label counter so a freshly-created pane starts with
    /// `canGoBack = false`.
    pub fn attach(_app: &AppHandle, label: &str) {
        if let Ok(mut m) = NAV_COUNT.lock() {
            m.insert(label.to_string(), 0);
        }
    }

    /// Drops the per-label counter when the pane closes.
    pub fn detach(label: &str) {
        if let Ok(mut m) = NAV_COUNT.lock() {
            m.remove(label);
        }
    }

    /// Records a top-level navigation for `label` and emits a `browser-nav-state`
    /// snapshot matching the macOS payload shape (label/url/canBack/canFwd/
    /// loading/progress). Called from the `on_navigation` callback.
    pub fn record_nav(app: &AppHandle, label: &str, url: &str) {
        let count = {
            let mut m = match NAV_COUNT.lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            let c = m.entry(label.to_string()).or_insert(0);
            *c = c.saturating_add(1);
            *c
        };
        let _ = app.emit(
            "browser-nav-state",
            serde_json::json!({
                "label": label,
                "url": url,
                "canBack": count >= 2,
                // Not observable on webkit2gtk without a JS round-trip; the
                // forward button stays enabled (history.forward() is a safe
                // no-op when there's nothing ahead). See module TODO.
                "canFwd": true,
                "loading": false,
                "progress": 1.0,
            }),
        );
    }

    /// Best-effort `[canGoBack, canGoForward]` for the pull command, read from
    /// the Rust-side counter (no live webkit2gtk introspection available).
    pub fn nav_pair(label: &str) -> [bool; 2] {
        let count = NAV_COUNT
            .lock()
            .ok()
            .and_then(|m| m.get(label).copied())
            .unwrap_or(0);
        [count >= 2, true]
    }
}

/// Shows the browser `label` at the given rect, creating it (loading `url`) on
/// first call or just repositioning an existing one.
///
/// MUST be `async`: on Windows, `Window::add_child` (below) DEADLOCKS when called
/// from a synchronous Tauri command — the call blocks waiting on the main-thread
/// event loop that a sync command is itself occupying, so the webview never
/// attaches and the pane hangs on "loading...". An async command runs on the
/// async runtime (off the main thread), so `add_child`'s internal main-thread
/// dispatch completes. (tauri-apps/tauri #9798, #11452.) No behavior change on
/// macOS, where sync worked fine.
#[tauri::command]
pub async fn browser_show(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    profile: Option<String>,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        if !browser_lifecycle_is_active(&label) {
            return Ok(());
        }
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)));
        return Ok(());
    }
    let parsed = parse(&url)?;
    if !begin_browser_lifecycle(&label) {
        // A create or close for this label is already in flight. Let the next
        // frontend bounds tick retry after the native child webview settles.
        return Ok(());
    }
    let window = match app.get_window("main") {
        Some(w) => w,
        None => {
            // Fall back to the first window if it isn't labelled "main".
            let alt = app.windows().into_values().next();
            match alt {
                Some(w) => {
                    eprintln!("[aios browser] no 'main' window; using '{}'", w.label());
                    w
                }
                None => {
                    eprintln!("[aios browser] FAIL: no windows at all");
                    end_browser_lifecycle(&label);
                    return Err("no main window".into());
                }
            }
        }
    };
    let popup_app = app.clone();
    let popup_profile = profile.clone();
    // Download handler: capture the chosen destination on `Requested` (on macOS
    // the `Finished` event's `path` is ALWAYS empty due to a WKWebView API
    // limitation — tauri docs note this), then on a successful `Finished` emit
    // `browser-download` with that path so the frontend opens it in a pane.
    let dl_app = app.clone();
    let dl_label = label.clone();
    let dl_dest: std::sync::Arc<std::sync::Mutex<Option<std::path::PathBuf>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let dl_dest_req = dl_dest.clone();
    // Loading state (item 5): a navigation STARTING reflects the destination url
    // to the toolbar immediately (the address bar otherwise lags the 1500ms poll)
    // and flips a spinner on; the page FINISHING flips it off. wry/tauri 2.11 has
    // no load-ERROR callback (`on_page_load` only reports Started/Finished), so a
    // dead-port / DNS-fail never emits Finished — the frontend treats "Started but
    // no Finished within a timeout" as a connection error + offers retry.
    let nav_app = app.clone();
    let nav_label = label.clone();
    let load_app = app.clone();
    let load_label = label.clone();
    #[allow(unused_mut)]
    let mut builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .user_agent(UA)
        .on_navigation(move |url| {
            // Fires on EVERY top-level + sub-frame navigation request. Reflect the
            // url + loading=true; the frontend dedupes/ignores sub-frame noise by
            // only trusting this for the address bar when it's a real page change.
            let _ = nav_app.emit(
                "browser-load",
                serde_json::json!({
                    "label": nav_label,
                    "phase": "started",
                    "url": url.to_string(),
                }),
            );
            // Linux has no KVO observer; feed the Rust-side nav counter here so
            // the toolbar Back button can disable on the first page, and push a
            // `browser-nav-state` snapshot matching the macOS payload shape.
            #[cfg(not(target_os = "macos"))]
            nav_state::record_nav(&nav_app, &nav_label, &url.to_string());
            true // never block navigation
        })
        .on_page_load(move |_webview, payload| {
            use tauri::webview::PageLoadEvent;
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let _ = load_app.emit(
                "browser-load",
                serde_json::json!({
                    "label": load_label,
                    "phase": phase,
                    "url": payload.url().to_string(),
                }),
            );
        })
        .on_download(move |_webview, event| {
            match event {
                tauri::webview::DownloadEvent::Requested { destination, .. } => {
                    if let Ok(mut slot) = dl_dest_req.lock() {
                        *slot = Some(destination.clone());
                    }
                }
                tauri::webview::DownloadEvent::Finished {
                    url, path, success, ..
                } => {
                    if success {
                        // Prefer the event's path; fall back to the captured
                        // destination (macOS path is empty on Finished).
                        let resolved = path.or_else(|| dl_dest.lock().ok().and_then(|s| s.clone()));
                        if let Some(p) = resolved {
                            let name = p
                                .file_name()
                                .and_then(|n| n.to_str())
                                .map(|s| s.to_string());
                            // Persist to the downloads store (survives restart;
                            // the downloads panel reads this back). Best-effort.
                            let _ = crate::browser_store::browser_download_record(
                                p.to_string_lossy().to_string(),
                                name.clone(),
                            );
                            // `label` + `url` ride along so the notification /
                            // open-in-files flow knows which pane downloaded
                            // what without another lookup.
                            let _ = dl_app.emit(
                                "browser-download",
                                serde_json::json!({
                                    "label": dl_label,
                                    "url": url.to_string(),
                                    "path": p.to_string_lossy(),
                                    "name": name,
                                }),
                            );
                        }
                    }
                    if let Ok(mut slot) = dl_dest.lock() {
                        *slot = None;
                    }
                }
                _ => {}
            }
            true
        })
        .on_new_window(move |url, features| {
            // A `window.open` with explicit window features (a size) is the OAuth
            // popup shape; a bare target=_blank / ⌘-click / window.open has none.
            let is_popup = features.size().is_some();
            let _ = popup_app.emit(
                "browser-new-pane",
                browser_new_pane(&url, &popup_profile, is_popup),
            );
            // Always deny the native OS window — every "new window" becomes an
            // in-app browser PANE instead (TAB = PANE, R2a FIX 2). The frontend
            // debounces spawn spam + handles popups as transient children.
            tauri::webview::NewWindowResponse::Deny
        });
    // A named profile gets its own persistent cookie partition on macOS. Other
    // platforms keep the default store for now: Windows WebView2 profile
    // partitioning needs a separate implementation, so don't make pulls fail.
    #[cfg(target_os = "macos")]
    if let Some(name) = profile
        .as_deref()
        .filter(|p| !p.is_empty() && *p != "default")
    {
        builder = builder.data_store_identifier(profile_store_id(name));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = &profile;
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| {
            end_browser_lifecycle(&label);
            e.to_string()
        })?;
    // WKWebView ships with element (HTML) fullscreen DISABLED, so YouTube etc.
    // show "your browser doesn't support full screen". Flip the preference on the
    // freshly-created native webview. macOS-only; best-effort.
    #[cfg(target_os = "macos")]
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.with_webview(|pw| {
            // PlatformWebview::inner() is the raw WKWebView pointer — cast to the
            // objc2-web-kit type (same crate version tauri uses) and flip the pref.
            let ptr = pw.inner() as *mut objc2_web_kit::WKWebView;
            unsafe {
                if let Some(wk) = ptr.as_ref() {
                    wk.configuration()
                        .preferences()
                        .setElementFullscreenEnabled(true);
                    install_standard_adblock(wk);
                }
            }
        });
    }
    // Push-based nav state + load errors (replaces the frontend poll). Queued
    // on the main thread AFTER the pref/adblock closure above, so it sees the
    // fully-configured webview.
    #[cfg(target_os = "macos")]
    nav_state::attach(&app, &label);
    // Linux: initialise the Rust-side nav counter (no KVO; fed by on_navigation).
    #[cfg(not(target_os = "macos"))]
    nav_state::attach(&app, &label);
    Ok(())
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        if !browser_lifecycle_is_active(&label) {
            return Ok(());
        }
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(width.max(0.0), height.max(0.0)));
    }
    Ok(())
}

/// Returns the webview's CURRENT url (reflects in-page navigation the address
/// bar never saw). The frontend polls this to (a) keep the address bar live and
/// (b) remember a pinned site's last location so reopening returns there.
#[tauri::command]
pub fn browser_current_url(app: AppHandle, label: String) -> Option<String> {
    if !browser_lifecycle_is_active(&label) {
        return None;
    }
    app.get_webview(&label)
        .and_then(|wv| wv.url().ok().map(|u| u.to_string()))
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let parsed = parse(&url)?;
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    let wv = app.get_webview(&label).ok_or("browser not open")?;
    wv.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

/// Reads the WKWebView element-fullscreen state (0 = not, 1 = entering, 2 = in,
/// 3 = exiting). A child webview's HTML fullscreen only fills the webview's own
/// rect, so the frontend polls this to drive TRUE fullscreen: when a video goes
/// fullscreen we maximize the pane (webview → full window) + put the OS window
/// in fullscreen (window → full screen). macOS-only; 0 elsewhere.
#[tauri::command]
pub async fn browser_fullscreen_state(app: AppHandle, label: String) -> i64 {
    // `with_webview` needs a Send + 'static closure (dispatched to the main
    // thread), so we ship the read back over a channel. async → this runs off
    // the main thread, so the brief blocking recv can't deadlock the dispatch.
    #[cfg(target_os = "macos")]
    if !browser_lifecycle_is_active(&label) {
        return 0;
    }
    #[cfg(target_os = "macos")]
    if let Some(wv) = app.get_webview(&label) {
        let (tx, rx) = std::sync::mpsc::channel::<i64>();
        let _ = wv.with_webview(move |pw| {
            let ptr = pw.inner() as *mut objc2_web_kit::WKWebView;
            let s = unsafe {
                ptr.as_ref()
                    .map(|wk| wk.fullscreenState().0 as i64)
                    .unwrap_or(0)
            };
            let _ = tx.send(s);
        });
        return rx
            .recv_timeout(std::time::Duration::from_millis(300))
            .unwrap_or(0);
    }
    let _ = (&app, &label);
    0
}

/// Puts the main OS window into (or out of) screen-fill mode — the second half
/// of true video fullscreen (the pane-maximize covers the window, this covers the
/// screen). On macOS we use simple fullscreen instead of native fullscreen so
/// YouTube/WebKit element fullscreen does not race the OS space transition.
#[tauri::command]
pub fn set_window_fullscreen(app: AppHandle, on: bool) -> Result<(), String> {
    if let Some(win) = app.get_window("main") {
        #[cfg(target_os = "macos")]
        win.set_simple_fullscreen(on)
            .or_else(|_| win.set_fullscreen(on))
            .map_err(|e| e.to_string())?;
        #[cfg(not(target_os = "macos"))]
        win.set_fullscreen(on).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Native NAVIGATION via the WKWebView itself (item 2) — replaces the old
/// `eval("history.back()")` hacks that only walked the PAGE's own SPA history
/// (silently no-op cross-origin / under CSP / on about:blank). On macOS we reach
/// the real WKWebView through the same objc2 bridge the fullscreen/adblock code
/// uses (`with_webview` → `PlatformWebview::inner()` → `*mut WKWebView`) and call
/// the genuine `goBack`/`goForward`/`reload`/`reloadFromOrigin` selectors (all
/// present in objc2-web-kit 0.3.2). On Windows (WebView2) we fall back to the
/// previous JS-history behavior since this objc2 path is macOS-only.
#[cfg(target_os = "macos")]
fn with_wk<F: FnOnce(&objc2_web_kit::WKWebView) + Send + 'static>(
    app: &AppHandle,
    label: &str,
    f: F,
) {
    if !browser_lifecycle_is_active(label) {
        return;
    }
    if let Some(wv) = app.get_webview(label) {
        let _ = wv.with_webview(move |pw| {
            let ptr = pw.inner() as *mut objc2_web_kit::WKWebView;
            unsafe {
                if let Some(wk) = ptr.as_ref() {
                    f(wk);
                }
            }
        });
    }
}

#[tauri::command]
pub fn browser_back(app: AppHandle, label: String) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    with_wk(&app, &label, |wk| unsafe {
        let _ = wk.goBack();
    });
    #[cfg(not(target_os = "macos"))]
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval("history.back()");
    }
    Ok(())
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, label: String) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    with_wk(&app, &label, |wk| unsafe {
        let _ = wk.goForward();
    });
    #[cfg(not(target_os = "macos"))]
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval("history.forward()");
    }
    Ok(())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, label: String) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    with_wk(&app, &label, |wk| unsafe {
        let _ = wk.reload();
    });
    #[cfg(not(target_os = "macos"))]
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval("location.reload()");
    }
    Ok(())
}

/// TRUE cache-bypass reload ("Force reload") — `reloadFromOrigin` re-fetches
/// every resource ignoring the cache, unlike `reload`. The old "Force reload"
/// menu item just called `browser_reload` (a lie — identical to normal reload).
#[tauri::command]
pub fn browser_force_reload(app: AppHandle, label: String) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    with_wk(&app, &label, |wk| unsafe {
        let _ = wk.reloadFromOrigin();
    });
    #[cfg(not(target_os = "macos"))]
    if let Some(wv) = app.get_webview(&label) {
        // WebView2 has no reloadFromOrigin via eval; force a no-cache reload.
        let _ = wv.eval("location.reload(true)");
    }
    Ok(())
}

/// Reports `[canGoBack, canGoForward]` so the toolbar Back/Forward buttons can
/// disable when there's no history (they were always-enabled no-op buttons).
/// macOS reads the real WKWebView state; elsewhere we can't cheaply know, so we
/// report `[true, true]` (buttons stay enabled, same as before).
///
/// SUPERSEDED on macOS by the pushed `browser-nav-state` event (see the
/// `nav_state` module) — kept for compatibility while the frontend still
/// polls, and as the only source on non-mac platforms.
#[tauri::command]
pub async fn browser_nav_state(app: AppHandle, label: String) -> [bool; 2] {
    #[cfg(target_os = "macos")]
    if !browser_lifecycle_is_active(&label) {
        return [false, false];
    }
    #[cfg(target_os = "macos")]
    if let Some(wv) = app.get_webview(&label) {
        let (tx, rx) = std::sync::mpsc::channel::<[bool; 2]>();
        let _ = wv.with_webview(move |pw| {
            let ptr = pw.inner() as *mut objc2_web_kit::WKWebView;
            let s = unsafe {
                ptr.as_ref()
                    .map(|wk| [wk.canGoBack(), wk.canGoForward()])
                    .unwrap_or([false, false])
            };
            let _ = tx.send(s);
        });
        return rx
            .recv_timeout(std::time::Duration::from_millis(300))
            .unwrap_or([true, true]);
    }
    // Linux: best-effort from the Rust-side nav counter (no live webkit2gtk
    // introspection). canGoBack is reliable; canGoForward stays enabled.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        return nav_state::nav_pair(&label);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (&app, &label);
        [true, true]
    }
}

/// Opens the WKWebView's Web Inspector (DevTools) for this pane (item 3).
/// Compiled into release because the tauri `devtools` feature is enabled in
/// Cargo.toml — otherwise `open_devtools` only exists under `debug_assertions`.
#[tauri::command]
pub fn browser_open_devtools(app: AppHandle, label: String) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    let wv = app.get_webview(&label).ok_or("browser not open")?;
    wv.open_devtools();
    Ok(())
}

/// Native find-in-page (item 4) via WKWebView `findString:withConfiguration:`.
/// `forward` walks matches in direction; `wraps` (default true) cycles past the
/// last match back to the first. Returns whether a match was found. NOTE:
/// WKFindResult exposes only `matchFound` — the WebKit public API has NO
/// match-COUNT, so the frontend shows found/not-found, not "3 of 12".
/// macOS-only; on Windows this is a no-op returning false.
#[tauri::command]
pub async fn browser_find(
    app: AppHandle,
    label: String,
    query: String,
    forward: bool,
    wraps: Option<bool>,
) -> bool {
    if !browser_lifecycle_is_active(&label) {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2::MainThreadMarker;
        use objc2_foundation::NSString;
        use objc2_web_kit::{WKFindConfiguration, WKFindResult, WKWebView};
        if query.is_empty() {
            return false;
        }
        if let Some(wv) = app.get_webview(&label) {
            let (tx, rx) = std::sync::mpsc::channel::<bool>();
            let _ = wv.with_webview(move |pw| {
                let Some(mtm) = MainThreadMarker::new() else {
                    let _ = tx.send(false);
                    return;
                };
                let ptr = pw.inner() as *mut WKWebView;
                let Some(wk) = (unsafe { ptr.as_ref() }) else {
                    let _ = tx.send(false);
                    return;
                };
                let cfg = unsafe { WKFindConfiguration::new(mtm) };
                unsafe {
                    cfg.setBackwards(!forward);
                    cfg.setWraps(wraps.unwrap_or(true));
                    cfg.setCaseSensitive(false);
                }
                let q = NSString::from_str(&query);
                let tx2 = tx.clone();
                let handler = RcBlock::new(move |result: std::ptr::NonNull<WKFindResult>| {
                    let found = unsafe { result.as_ref().matchFound() };
                    let _ = tx2.send(found);
                });
                unsafe {
                    wk.findString_withConfiguration_completionHandler(&q, Some(&cfg), &handler);
                }
            });
            return rx
                .recv_timeout(std::time::Duration::from_millis(800))
                .unwrap_or(false);
        }
        false
    }
    // Linux (webkit2gtk): no WKWebView find API, but the page-level
    // `window.find(query, caseSensitive, backwards, wraps, wholeWord, searchInFrames)`
    // is supported. `eval` is fire-and-forget (no return value), so we fire the
    // call and report `true` optimistically — the frontend only needs the call
    // to land; if there's no match webkit just leaves the selection unchanged.
    #[cfg(not(target_os = "macos"))]
    {
        if query.is_empty() {
            return false;
        }
        if let Some(wv) = app.get_webview(&label) {
            let q = js_escape(&query);
            let backwards = if forward { "false" } else { "true" };
            let wrap = if wraps.unwrap_or(true) {
                "true"
            } else {
                "false"
            };
            let js = format!(
                "try{{window.find(\"{q}\",false,{backwards},{wrap},false,false);}}catch(e){{}}"
            );
            let _ = wv.eval(&js);
            return true;
        }
        false
    }
}

/// Escapes a string for safe embedding inside a JS double-quoted string literal
/// (backslash, double-quote, and the line/paragraph separators that break JS
/// source). Used by the Linux find-in-page path.
#[cfg(not(target_os = "macos"))]
fn js_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c => out.push(c),
        }
    }
    out
}

/// Hides without destroying (shrinks to 0×0, preserves the page).
#[tauri::command]
pub fn browser_hide(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        if !browser_lifecycle_is_active(&label) {
            return Ok(());
        }
        let _ = wv.set_size(LogicalSize::new(0.0, 0.0));
    }
    Ok(())
}

/// Destroys the webview entirely (pane closed). Before tearing down the wry
/// handle we MUST stop the page's media + navigate to about:blank — on macOS the
/// underlying WKWebView can outlive `close()` under ARC (retained by the audio
/// session / a pending JS task), so without this a closed YouTube pane keeps
/// playing audio from an orphaned native object. Pause+detach all media, drop
/// fullscreen, then blank the document so no background media context survives.
#[tauri::command]
pub fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    end_browser_lifecycle(&label);
    // FIRST: tear down the KVO observers + restore wry's navigation delegate.
    // Must precede the about:blank dance + close() below — a WKWebView that
    // deallocates with observers still registered is a crash, and the detach
    // closure is serialized on the main thread ahead of the close.
    #[cfg(target_os = "macos")]
    nav_state::detach(&app, &label);
    // Linux: drop the per-label nav counter so a re-created pane starts clean.
    #[cfg(not(target_os = "macos"))]
    nav_state::detach(&label);
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval(
            "try{document.querySelectorAll('video,audio').forEach(m=>{try{m.pause();m.removeAttribute('src');m.srcObject=null;m.load();}catch(e){}});if(document.fullscreenElement){try{document.exitFullscreen();}catch(e){}}}catch(e){}",
        );
        let _ =
            wv.eval("try{location.replace('about:blank');}catch(e){location.href='about:blank';}");
        let _ = wv.close();
    }
    Ok(())
}

/// Native PAGE ZOOM that persists across navigation (stretch item). The old impl
/// set `document.body.style.zoom` which WebKit resets on every page load; the
/// real WKWebView `setPageZoom:` survives navigation within the webview. The
/// frontend passes the factor (e.g. 1.25 for 125%). macOS-only native path;
/// elsewhere fall back to the CSS approach.
#[tauri::command]
pub fn browser_zoom(app: AppHandle, label: String, factor: f64) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    with_wk(&app, &label, move |wk| unsafe {
        wk.setPageZoom(factor);
    });
    #[cfg(not(target_os = "macos"))]
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval(&format!("document.body.style.zoom={factor}"));
    }
    Ok(())
}

/// macOS-only: remove all data of the given WKWebsiteDataTypes from THIS pane's
/// website data store (its configured cookie/cache partition). `modifiedSince:
/// distantPast` = everything. This reaches the REAL store — HttpOnly cookies and
/// the on-disk cache the old `document.cookie` eval could never touch.
#[cfg(target_os = "macos")]
fn remove_website_data(app: &AppHandle, label: &str, types: &[&str]) {
    if !browser_lifecycle_is_active(label) {
        return;
    }
    use block2::RcBlock;
    use objc2_foundation::{NSDate, NSSet, NSString};
    let types: Vec<String> = types.iter().map(|s| s.to_string()).collect();
    if let Some(wv) = app.get_webview(label) {
        let _ = wv.with_webview(move |pw| {
            let ptr = pw.inner() as *mut objc2_web_kit::WKWebView;
            let Some(wk) = (unsafe { ptr.as_ref() }) else {
                return;
            };
            let store = unsafe { wk.configuration().websiteDataStore() };
            // Resolve the requested type-name strings to the WebKit constants
            // (these are `&'static NSString`, so we collect refs directly).
            let mut refs: Vec<&NSString> = Vec::new();
            for t in &types {
                let s: &'static NSString = match t.as_str() {
                    "cookies" => unsafe { objc2_web_kit::WKWebsiteDataTypeCookies },
                    "disk-cache" => unsafe { objc2_web_kit::WKWebsiteDataTypeDiskCache },
                    "memory-cache" => unsafe { objc2_web_kit::WKWebsiteDataTypeMemoryCache },
                    "local-storage" => unsafe { objc2_web_kit::WKWebsiteDataTypeLocalStorage },
                    "session-storage" => unsafe { objc2_web_kit::WKWebsiteDataTypeSessionStorage },
                    _ => continue,
                };
                refs.push(s);
            }
            let set = NSSet::from_slice(&refs);
            let since = NSDate::distantPast();
            let done = RcBlock::new(|| {});
            unsafe {
                store.removeDataOfTypes_modifiedSince_completionHandler(&set, &since, &done);
            }
        });
    }
}

/// Real cookie clear (stretch) — wipes cookies + storage from the pane's actual
/// WKWebsiteDataStore via objc2, reaching HttpOnly cookies the old eval couldn't.
/// Then reloads so the page re-runs with cleared state. macOS-only native path;
/// elsewhere fall back to the JS-accessible clears.
#[tauri::command]
pub fn browser_clear_cookies(app: AppHandle, label: String) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        remove_website_data(
            &app,
            &label,
            &["cookies", "local-storage", "session-storage"],
        );
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.eval("setTimeout(function(){try{location.reload();}catch(e){}},120)");
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval(
            "(function(){\
                try{document.cookie.split(';').forEach(function(c){\
                    var n=c.split('=')[0].trim();\
                    if(n){\
                        document.cookie=n+'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';\
                        document.cookie=n+'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain='+location.hostname;\
                    }\
                });}catch(e){}\
                try{localStorage.clear();}catch(e){}\
                try{sessionStorage.clear();}catch(e){}\
                location.reload();\
            })()",
        );
    }
    Ok(())
}

/// Real cache clear (stretch) — wipes disk + memory cache from the pane's actual
/// WKWebsiteDataStore (no eval equivalent existed; the menu item was a duplicate
/// of clear-cookies). macOS-only native path; elsewhere a cache-bypass reload.
#[tauri::command]
pub fn browser_clear_cache(app: AppHandle, label: String) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        remove_website_data(&app, &label, &["disk-cache", "memory-cache"]);
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.eval("setTimeout(function(){try{location.reload();}catch(e){}},120)");
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval("location.reload(true)");
    }
    Ok(())
}

/// Toggles a mobile-viewport approximation. NOTE: real device emulation needs
/// CDP (touch events, DPR, real UA override) which we don't have, so this is a
/// CSS-based approximation — inject a `meta[name=viewport]` + constrain the
/// document width to a phone-ish 420px centered; turning it off resets those.
#[tauri::command]
pub fn browser_device_mode(app: AppHandle, label: String, mobile: bool) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    if let Some(wv) = app.get_webview(&label) {
        if mobile {
            let _ = wv.eval(
                "(function(){\
                    var m=document.querySelector('meta[name=viewport][data-cockpit]');\
                    if(!m){m=document.createElement('meta');m.name='viewport';m.setAttribute('data-cockpit','1');document.head.appendChild(m);}\
                    m.content='width=420, initial-scale=1';\
                    document.documentElement.style.maxWidth='420px';\
                    document.documentElement.style.margin='0 auto';\
                })()",
            );
        } else {
            let _ = wv.eval(
                "(function(){\
                    var m=document.querySelector('meta[name=viewport][data-cockpit]');\
                    if(m){m.remove();}\
                    document.documentElement.style.maxWidth='';\
                    document.documentElement.style.margin='';\
                })()",
            );
        }
    }
    Ok(())
}

/// Captures the browser's on-screen region to a PNG via `screencapture` and
/// returns the saved path. The frontend passes the webview slot's screen rect
/// (its `getBoundingClientRect`). Requires Screen Recording permission — a
/// non-zero exit (denied / failed) surfaces as an error.
#[tauri::command]
pub fn browser_screenshot(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    // Touch `app`/`label` so the call shape matches the other commands and the
    // capture is clearly scoped to a live pane.
    let _ = app.get_webview(&label).ok_or("browser not open")?;
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let (xi, yi, wi, hi) = (
        x.round() as i64,
        y.round() as i64,
        width.round().max(1.0) as i64,
        height.round().max(1.0) as i64,
    );

    // macOS: screencapture region grab. Windows: a tiny PowerShell .NET capture
    // of the same on-screen rect to a temp PNG (no extra crates).
    #[cfg(target_os = "macos")]
    {
        let path = format!("/tmp/cockpit-shot-{epoch}.png");
        let status = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-x")
            .arg(format!("-R{xi},{yi},{wi},{hi}"))
            .arg(&path)
            .status()
            .map_err(|e| format!("screencapture failed to launch: {e}"))?;
        if !status.success() {
            return Err(format!(
                "screencapture exited with {} (check Screen Recording permission)",
                status.code().unwrap_or(-1)
            ));
        }
        Ok(path)
    }

    #[cfg(windows)]
    {
        let path = std::env::temp_dir()
            .join(format!("cockpit-shot-{epoch}.png"))
            .to_string_lossy()
            .into_owned();
        let script = format!(
            "Add-Type -AssemblyName System.Drawing,System.Windows.Forms; \
             $b=New-Object System.Drawing.Bitmap {wi},{hi}; \
             $g=[System.Drawing.Graphics]::FromImage($b); \
             $g.CopyFromScreen({xi},{yi},0,0,(New-Object System.Drawing.Size({wi},{hi}))); \
             $b.Save('{}',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose()",
            path.replace('\\', "\\\\")
        );
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let status = cmd
            .status()
            .map_err(|e| format!("screen capture failed to launch: {e}"))?;
        if !status.success() {
            return Err(format!(
                "screen capture exited with {}",
                status.code().unwrap_or(-1)
            ));
        }
        Ok(path)
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        Err("browser screenshots are macos/windows-only right now".into())
    }
}

// ─── Annotate mode (Codex-style "select-on-page → send to chat") ──────────────
//
// CLIPBOARD-BRIDGE design (read this before touching it):
//
// A native child webview cannot call our Tauri IPC, and `wv.eval()` is
// fire-and-forget — it returns no value to Rust. So neither process can read
// the other's DOM directly. The robust channel that works TODAY with zero new
// deps is the **system clipboard**:
//
//   1. We `eval()` a small annotator into the page. It highlights the hovered
//      element, captures `{selector, tagName, text, rect, url}` on click, shows
//      an inline note box, and on submit writes
//      `"AIOS_ANNOT:" + JSON.stringify(payload)` to the clipboard via
//      `navigator.clipboard.writeText(...)`.
//   2. The FRONTEND (main webview) polls `read_clipboard()` (below), which runs
//      `pbpaste` on macOS. When it sees the `AIOS_ANNOT:` sentinel prefix it
//      parses the JSON, formats a line, fires `onAnnotate`, and exits annotate
//      mode. The sentinel prefix means we never grab unrelated clipboard text.
//
// The same path powers "send selection to chat" (selection → clipboard → read).

/// Injects the annotator overlay + listeners into the page. Idempotent: tears
/// down any prior instance first, so re-entering is safe. On submit the
/// annotation JSON is copied to the clipboard with the `AIOS_ANNOT:` sentinel
/// (the frontend polls `read_clipboard` to pick it up).
#[tauri::command]
pub fn browser_enter_annotate(app: AppHandle, label: String) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    let wv = app.get_webview(&label).ok_or("browser not open")?;
    // Wrapped in an IIFE; all state hangs off `window.__aiosAnnot` so
    // `browser_exit_annotate` can clean up listeners + DOM precisely.
    let _ = wv.eval(
        r#"(function(){
  try{
    if(window.__aiosAnnot&&window.__aiosAnnot.teardown){window.__aiosAnnot.teardown();}
    var SENT='AIOS_ANNOT:';
    var hl=document.createElement('div');
    hl.style.cssText='position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #6ea8fe;background:rgba(110,168,254,.12);border-radius:3px;transition:all .03s linear;display:none;';
    document.documentElement.appendChild(hl);
    var box=null,cur=null;
    function cssPath(el){
      if(!(el instanceof Element))return'';
      if(el.id)return'#'+CSS.escape(el.id);
      var parts=[];
      while(el&&el.nodeType===1&&parts.length<6){
        var sel=el.nodeName.toLowerCase();
        if(el.classList&&el.classList.length){sel+='.'+Array.from(el.classList).slice(0,2).map(function(c){return CSS.escape(c);}).join('.');}
        var p=el.parentNode;
        if(p){
          var sibs=Array.prototype.filter.call(p.children,function(c){return c.nodeName===el.nodeName;});
          if(sibs.length>1){sel+=':nth-of-type('+(Array.prototype.indexOf.call(sibs,el)+1)+')';}
        }
        parts.unshift(sel);
        if(el.id){parts[0]='#'+CSS.escape(el.id);break;}
        el=el.parentElement;
      }
      return parts.join(' > ');
    }
    function move(e){
      if(box)return;
      var el=document.elementFromPoint(e.clientX,e.clientY);
      if(!el||el===hl){hl.style.display='none';cur=null;return;}
      cur=el;
      var r=el.getBoundingClientRect();
      hl.style.display='block';hl.style.left=r.left+'px';hl.style.top=r.top+'px';hl.style.width=r.width+'px';hl.style.height=r.height+'px';
    }
    function buildBox(el){
      var r=el.getBoundingClientRect();
      box=document.createElement('div');
      box.style.cssText='position:fixed;z-index:2147483647;left:'+Math.max(8,Math.min(r.left,window.innerWidth-300))+'px;top:'+Math.min(r.bottom+8,window.innerHeight-130)+'px;width:280px;background:#1b1d22;color:#e6e6e6;border:1px solid #3a3d44;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.45);font:13px/1.4 -apple-system,system-ui,sans-serif;padding:10px;';
      var ta=document.createElement('textarea');
      ta.placeholder='describe these changes…';
      ta.style.cssText='width:100%;box-sizing:border-box;height:60px;resize:none;background:#101216;color:#e6e6e6;border:1px solid #3a3d44;border-radius:5px;padding:6px 8px;font:13px/1.4 inherit;outline:none;';
      var row=document.createElement('div');
      row.style.cssText='display:flex;gap:6px;justify-content:flex-end;margin-top:8px;';
      var cancel=document.createElement('button');
      cancel.textContent='cancel';
      cancel.style.cssText='background:transparent;color:#9aa0a6;border:1px solid #3a3d44;border-radius:5px;padding:4px 10px;cursor:pointer;font:12px inherit;';
      var send=document.createElement('button');
      send.textContent='send to chat';
      send.style.cssText='background:#6ea8fe;color:#0b0c0f;border:none;border-radius:5px;padding:4px 10px;cursor:pointer;font:12px inherit;font-weight:600;';
      row.appendChild(cancel);row.appendChild(send);
      box.appendChild(ta);box.appendChild(row);
      document.documentElement.appendChild(box);
      setTimeout(function(){ta.focus();},0);
      cancel.onclick=function(ev){ev.preventDefault();ev.stopPropagation();closeBox();};
      send.onclick=function(ev){
        ev.preventDefault();ev.stopPropagation();
        var rect=el.getBoundingClientRect();
        var payload={
          selector:cssPath(el),
          tagName:el.tagName?el.tagName.toLowerCase():'',
          text:(el.innerText||el.textContent||'').trim().slice(0,200),
          note:ta.value.trim(),
          rect:{x:Math.round(rect.left),y:Math.round(rect.top),width:Math.round(rect.width),height:Math.round(rect.height)},
          url:location.href
        };
        try{navigator.clipboard.writeText(SENT+JSON.stringify(payload));}catch(_){
          try{window.__aiosAnnotation=payload;}catch(__){}
        }
        window.__aiosAnnotation=payload;
        closeBox();
      };
    }
    function closeBox(){if(box){box.remove();box=null;}hl.style.display='none';}
    function click(e){
      if(box){return;}
      if(!cur)return;
      e.preventDefault();e.stopPropagation();
      buildBox(cur);
    }
    function key(e){if(e.key==='Escape'){closeBox();}}
    document.addEventListener('mousemove',move,true);
    document.addEventListener('click',click,true);
    document.addEventListener('keydown',key,true);
    window.__aiosAnnot={
      teardown:function(){
        try{document.removeEventListener('mousemove',move,true);}catch(_){}
        try{document.removeEventListener('click',click,true);}catch(_){}
        try{document.removeEventListener('keydown',key,true);}catch(_){}
        try{closeBox();}catch(_){}
        try{hl.remove();}catch(_){}
        try{delete window.__aiosAnnot;}catch(_){window.__aiosAnnot=null;}
      }
    };
  }catch(e){}
})()"#,
    );
    Ok(())
}

/// Removes the annotator overlay + listeners injected by
/// `browser_enter_annotate`. Safe to call even if annotate mode isn't active.
#[tauri::command]
pub fn browser_exit_annotate(app: AppHandle, label: String) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval(
            "(function(){try{if(window.__aiosAnnot&&window.__aiosAnnot.teardown){window.__aiosAnnot.teardown();}}catch(e){}})()",
        );
    }
    Ok(())
}

/// Installs the right-click pane-router bridge inside the page. Native child
/// webviews cannot call Tauri IPC directly, so this mirrors the annotation path:
/// capture contextmenu, serialize the useful target data to the clipboard behind
/// an `AIOS_CONTEXT:` sentinel, and let the React chrome poll it.
#[tauri::command]
pub fn browser_install_context_probe(app: AppHandle, label: String) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    let wv = app.get_webview(&label).ok_or("browser not open")?;
    let _ = wv.eval(
        r#"(function(){
  try{
    if(window.__aiosContextProbe&&window.__aiosContextProbe.teardown){window.__aiosContextProbe.teardown();}
    var SENT='AIOS_CONTEXT:';
    function closestLink(el){
      while(el&&el!==document.documentElement){
        if(el.tagName&&el.tagName.toLowerCase()==='a'&&el.href)return el.href;
        el=el.parentElement;
      }
      return '';
    }
    function handler(e){
      try{
        var el=document.elementFromPoint(e.clientX,e.clientY)||e.target;
        var payload={
          x:Math.round(e.clientX),
          y:Math.round(e.clientY),
          url:location.href,
          linkUrl:closestLink(el),
          text:(window.getSelection?window.getSelection().toString():'').trim().slice(0,1000)
        };
        e.preventDefault();
        e.stopPropagation();
        try{navigator.clipboard.writeText(SENT+JSON.stringify(payload));}catch(_){window.__aiosContextPayload=payload;}
        window.__aiosContextPayload=payload;
      }catch(_){}
    }
    document.addEventListener('contextmenu',handler,true);
    window.__aiosContextProbe={
      teardown:function(){
        try{document.removeEventListener('contextmenu',handler,true);}catch(_){}
        try{delete window.__aiosContextProbe;}catch(_){window.__aiosContextProbe=null;}
      }
    };
  }catch(e){}
})()"#,
    );
    Ok(())
}

/// Evals a copy of the current text selection into the clipboard with the
/// `AIOS_ANNOT:` sentinel so the frontend's existing poll picks it up. Used by
/// the "send selection to chat" button. The payload shape mirrors the annotator
/// (note carries the selection, text is empty) so one parser handles both.
#[tauri::command]
pub fn browser_copy_selection(app: AppHandle, label: String) -> Result<(), String> {
    if !browser_lifecycle_is_active(&label) {
        return Ok(());
    }
    let wv = app.get_webview(&label).ok_or("browser not open")?;
    let _ = wv.eval(
        r#"(function(){
  try{
    var SENT='AIOS_ANNOT:';
    var sel=(window.getSelection?window.getSelection().toString():'').trim();
    if(!sel)return;
    var payload={selector:'',tagName:'selection',text:'',note:sel,rect:null,url:location.href};
    try{navigator.clipboard.writeText(SENT+JSON.stringify(payload));}catch(_){window.__aiosAnnotation=payload;}
    window.__aiosAnnotation=payload;
  }catch(e){}
})()"#,
    );
    Ok(())
}

/// Reads the system clipboard as text — the receive end of the clipboard-bridge.
/// The frontend polls this and filters for the `AIOS_ANNOT:` sentinel, so
/// unrelated clipboard contents are ignored.
#[tauri::command]
pub fn read_clipboard() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("/usr/bin/pbpaste");
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("powershell.exe");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Clipboard -Raw",
        ]);
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    let mut cmd = {
        let mut c = std::process::Command::new("sh");
        c.args([
            "-c",
            "command -v wl-paste >/dev/null 2>&1 && wl-paste || xclip -selection clipboard -o",
        ]);
        c
    };
    let out = cmd
        .output()
        .map_err(|e| format!("clipboard read failed to launch: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "clipboard read exited with {}",
            out.status.code().unwrap_or(-1)
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    #[cfg(windows)]
    return Ok(text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(&text)
        .to_string());
    #[cfg(not(windows))]
    Ok(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_browser_pane_keeps_the_source_profile() {
        let url = Url::parse("https://example.com/path").unwrap();
        assert_eq!(
            browser_new_pane(&url, &Some("work".into()), false),
            BrowserNewPane {
                url: "https://example.com/path".into(),
                profile: Some("work".into()),
                is_popup: false,
            }
        );
    }

    #[test]
    fn standard_adblock_rules_are_valid_webkit_content_rules() {
        let rules = standard_adblock_content_rules_json();
        let parsed: serde_json::Value = serde_json::from_str(&rules).unwrap();
        let rules = parsed.as_array().unwrap();

        assert!(rules.iter().any(|rule| {
            rule.pointer("/trigger/url-filter")
                .and_then(|v| v.as_str())
                .is_some_and(|filter| {
                    filter.contains("doubleclick")
                        && filter.contains("googlesyndication")
                        && filter.contains("googletagmanager")
                        && filter.contains("taboola")
                })
        }));
        assert!(rules.iter().any(|rule| {
            rule.pointer("/action/type")
                == Some(&serde_json::Value::String("css-display-none".into()))
                && rule
                    .pointer("/action/selector")
                    .and_then(|v| v.as_str())
                    .is_some_and(|selector| {
                        selector.contains("[id*=\"ad-\"]")
                            && selector.contains(".google-auto-placed")
                    })
        }));
    }

    #[test]
    fn standard_adblock_rules_block_watchseries_pop_ad_network() {
        let rules = standard_adblock_content_rules_json();
        let parsed: serde_json::Value = serde_json::from_str(&rules).unwrap();
        let rules = parsed.as_array().unwrap();

        assert!(rules.iter().any(|rule| {
            rule.pointer("/trigger/url-filter")
                .and_then(|v| v.as_str())
                .is_some_and(|filter| filter.contains("acscdn"))
                && rule.pointer("/action/type") == Some(&serde_json::Value::String("block".into()))
        }));
    }
}
