// The in-app browser pane: Chromium (CEF) views laid over the main window, one
// per tab. WKWebView (Safari's engine) jumped back while scrolling claude.ai.
//
// CEF is driven from Tauri's main thread: its message loop is pumped from a
// thread that asks the main thread to run `do_message_loop_work` (see
// `start_pump`). Calls from other threads go through `on_main`. The page's own
// script (browser_page.js) is injected by the helper binary (src/bin/helper.rs)
// and talks to the app through the console (see `PageHandler`).
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use cef::application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol};
use cef::*;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{define_class, extern_methods, msg_send, DefinedClass, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSEvent, NSView};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::{AppHandle, Manager};

use crate::err;

/// Where the browser keeps its cookies and storage, so a site's login survives a restart.
const CACHE_DIR: &str = "cef";
/// A page's message to the app is the console message that starts like this (see browser_page.js).
const PAGE_MESSAGE_PREFIX: &str = "todo-sessions://";
/// Chromium's own scale: one zoom level is 1.2 times.
const ZOOM_LEVEL_BASE: f64 = 1.2;
/// CEF asks for work to be done after a delay; it is also done this often, as CEF's own samples do.
const PUMP_EVERY: Duration = Duration::from_millis(1000 / 30);
/// How long closing the browsers at quit may take.
const SHUTDOWN_WAIT: Duration = Duration::from_millis(1500);
/// How long the main thread may take to run what another thread asked of it.
const MAIN_THREAD_WAIT: Duration = Duration::from_secs(10);
/// How long the browser may take to start.
const READY_WAIT: Duration = Duration::from_secs(20);
/// How long a page's text is waited for.
const TEXT_WAIT: Duration = Duration::from_secs(15);

/// Where the framework is in the .app, from the folder of the executable.
const FRAMEWORK: &str = "../Frameworks/Chromium Embedded Framework.framework";

/// Set once Chromium is up; without it (not run from the .app, so no framework) the pane says so.
static LOADER: OnceLock<library_loader::LibraryLoader> = OnceLock::new();
static PUMP: OnceLock<Sender<i64>> = OnceLock::new();
/// For `terminate:` (⌘Q, the Dock's Quit), which must leave through Tauri's exit so `shutdown` runs.
static APP: OnceLock<AppHandle> = OnceLock::new();
static PUMP_RX: Mutex<Option<Receiver<i64>>> = Mutex::new(None);
/// Browsers (tabs and popups) not closed yet.
static LIVE: AtomicUsize = AtomicUsize::new(0);
/// Set when Chromium's context is up, before which a browser made never loads its page.
static READY: AtomicBool = AtomicBool::new(false);
/// Set once Chromium is shut down, after which it must not be called.
static DOWN: AtomicBool = AtomicBool::new(false);
/// Ids for what a page asks the user (a dialog, a site permission), answered from the app.
static NEXT_ASK: AtomicU64 = AtomicU64::new(1);
/// This run's token, which the pages' messages carry (see `page_token`).
static PAGE_TOKEN: OnceLock<String> = OnceLock::new();
/// The switch the helpers get the token with (src/bin/helper.rs).
pub const PAGE_TOKEN_SWITCH: &str = "todo-sessions-token";

thread_local! {
    /// The tabs' browsers, touched on the main thread only.
    static TABS: RefCell<HashMap<String, Browser>> = RefCell::new(HashMap::new());
    /// Pages' dialogs (alert, confirm, prompt) waiting for the app's answer, by id.
    static DIALOGS: RefCell<HashMap<u64, JsdialogCallback>> = RefCell::new(HashMap::new());
    /// Sites' asks for the microphone or camera waiting for the user, by id, with what they asked for.
    static MEDIA_ASKS: RefCell<HashMap<u64, (MediaAccessCallback, u32)>> = RefCell::new(HashMap::new());
    /// Downloads already told about.
    static DOWNLOADED: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
}

/// The token a page's message to the app must carry: the pages' script gets it
/// from the helper (on its command line), which a page's own scripts cannot
/// read, so a page cannot pass itself off as the app's script.
pub fn page_token() -> &'static str {
    PAGE_TOKEN.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

/// A tab's rectangle in logical pixels from the top left of the window's content.
#[derive(Clone, Copy)]
pub struct PageRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Default)]
pub struct AppIvars {
    handling_send_event: std::cell::Cell<Bool>,
}

define_class!(
    /// The application class Chromium requires on macOS (it must be the first NSApplication made).
    #[unsafe(super(NSApplication))]
    #[ivars = AppIvars]
    pub struct CefApplication;

    impl CefApplication {
        #[unsafe(method(sendEvent:))]
        unsafe fn send_event(&self, event: &NSEvent) {
            let was = self.is_handling();
            if !was {
                self.set_handling(true);
            }
            let _: () = msg_send![super(self), sendEvent: event];
            if !was {
                self.set_handling(false);
            }
        }

        // The default ends the process at once, before Chromium has written its cookies.
        #[unsafe(method(terminate:))]
        unsafe fn terminate(&self, _sender: &AnyObject) {
            match APP.get() {
                Some(app) => app.exit(0),
                None => std::process::exit(0),
            }
        }
    }

    unsafe impl CrAppControlProtocol for CefApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        unsafe fn _set_handling_send_event(&self, v: Bool) {
            self.ivars().handling_send_event.set(v);
        }
    }

    unsafe impl CrAppProtocol for CefApplication {
        #[unsafe(method(isHandlingSendEvent))]
        unsafe fn _is_handling_send_event(&self) -> Bool {
            self.ivars().handling_send_event.get()
        }
    }

    unsafe impl CefAppProtocol for CefApplication {}
);

impl CefApplication {
    extern_methods! {
        #[unsafe(method(sharedApplication))]
        fn shared_application() -> Retained<Self>;
        #[unsafe(method(setHandlingSendEvent:))]
        fn set_handling(&self, v: bool);
        #[unsafe(method(isHandlingSendEvent))]
        fn is_handling(&self) -> bool;
    }
}

wrap_app! {
    struct BrowserApp;

    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(PumpScheduler::new())
        }
    }
}

wrap_browser_process_handler! {
    struct PumpScheduler;

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            READY.store(true, Ordering::SeqCst);
        }

        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            if let Some(tx) = PUMP.get() {
                let _ = tx.send(delay_ms);
            }
        }

        // The renderers put the token in the pages' script (see `page_token`).
        fn on_before_child_process_launch(&self, command_line: Option<&mut CommandLine>) {
            if let Some(command_line) = command_line {
                command_line.append_switch_with_value(Some(&CefString::from(PAGE_TOKEN_SWITCH)), Some(&CefString::from(page_token())));
            }
        }
    }
}

/// The folder Chromium keeps its profile in.
fn cache_dir() -> PathBuf {
    crate::db_path().parent().map(|p| p.join(CACHE_DIR)).unwrap_or_else(|| PathBuf::from(CACHE_DIR))
}

/// Starts Chromium. Before Tauri (whose event loop makes the NSApplication) is
/// built, on the main thread. False when the .app has no framework (a plain
/// `cargo run`): the rest of the app works, the browser pane does not.
pub fn init() -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    if !exe.parent().is_some_and(|dir| dir.join(FRAMEWORK).exists()) {
        return false;
    }
    let loader = library_loader::LibraryLoader::new(&exe, false);
    if !loader.load() {
        eprintln!("cef: cannot load the Chromium framework");
        return false;
    }
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    // Kept, not released (see `content_view`): the application lives as long as the process.
    std::mem::forget(CefApplication::shared_application());
    // Chromium keeps its cookie key in the Keychain ("Chromium Safe Storage"). The app
    // is signed the same way at every build (scripts/bundle-cef.sh), so allowed once,
    // it is not asked again; without that signature every rebuild would ask.
    let argv: &'static [*mut std::os::raw::c_char] = Box::leak(
        std::env::args()
            .map(|a| std::ffi::CString::new(a).unwrap().into_raw())
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );
    let main_args = MainArgs { argc: argv.len() as i32, argv: argv.as_ptr() as *mut *mut _ };
    // The browser process: -1, so it goes on (the helper binary is the others).
    let ran = execute_process(Some(&main_args), None::<&mut App>, std::ptr::null_mut());
    if ran != -1 {
        std::process::exit(ran);
    }
    let cache = cache_dir();
    let cache = cache.to_string_lossy();
    let settings = Settings {
        // ponytail: Chromium's sandbox is off (it needs the helpers signed with entitlements this ad hoc build lacks); sign them and drop this to turn it on.
        no_sandbox: 1,
        external_message_pump: 1,
        persist_session_cookies: 1,
        // Pages' messages (logins among them) pass through the console; none of it goes to a log.
        log_severity: LogSeverity::DISABLE,
        cache_path: CefString::from(&*cache),
        root_cache_path: CefString::from(&*cache),
        ..Default::default()
    };
    let (tx, rx) = channel();
    let _ = PUMP.set(tx);
    *PUMP_RX.lock().unwrap() = Some(rx);
    let mut app = BrowserApp::new();
    if initialize(Some(&main_args), Some(&settings), Some(&mut app), std::ptr::null_mut()) != 1 {
        eprintln!("cef: initialize failed");
        return false;
    }
    let _ = LOADER.set(loader);
    true
}

pub fn available() -> bool {
    LOADER.get().is_some()
}

/// Runs Chromium's work on the main thread, when it asks and every `PUMP_EVERY`.
pub fn start_pump(app: &AppHandle) {
    let Some(rx) = PUMP_RX.lock().ok().and_then(|mut r| r.take()) else { return };
    let app = app.clone();
    let _ = APP.set(app.clone());
    // ponytail: wakes every PUMP_EVERY even when idle; pump only on schedule (plus CEF's own re-entrancy timer) if the idle CPU matters.
    std::thread::spawn(move || loop {
        let delay = rx.recv_timeout(PUMP_EVERY).map(|d| d.max(0) as u64).unwrap_or(0);
        std::thread::sleep(Duration::from_millis(delay).min(PUMP_EVERY));
        if app.run_on_main_thread(|| if !DOWN.load(Ordering::SeqCst) { do_message_loop_work() }).is_err() {
            return;
        }
    });
}

/// Runs `f` on the main thread (where CEF lives) and gives back what it returns.
fn on_main<R: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
    if MainThreadMarker::new().is_some() {
        return Ok(f());
    }
    let (tx, rx) = channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(err)?;
    rx.recv_timeout(MAIN_THREAD_WAIT).map_err(|_| "ブラウザが応答しません".to_string())
}

fn with_tab<R>(tab: &str, f: impl FnOnce(&Browser) -> R) -> Option<R> {
    TABS.with(|t| t.borrow().get(tab).map(f))
}

fn view_of(browser: &Browser) -> Option<&NSView> {
    // SAFETY: the handle of a windowed browser on macOS is its NSView, which lives as long as the browser.
    unsafe { browser.host()?.window_handle().cast::<NSView>().as_ref() }
}

/// The frame of a view `rect` from the top of the window's content, as Cocoa (from the bottom).
fn cocoa_frame(content: &NSView, rect: PageRect) -> NSRect {
    let top = content.frame().size.height;
    NSRect::new(NSPoint::new(rect.x, top - rect.y - rect.height), NSSize::new(rect.width, rect.height))
}

/// The main window's content view. Not a `Retained`: objc2's getters over-release
/// when optimised on macOS 14+ (madsmtm/objc2#861), which freed the view tao's
/// mouse events still go to (a crash on the first mouse move). The window owns it.
fn content_view(app: &AppHandle) -> Result<&'static NSView, String> {
    let window = app.get_window("main").ok_or("main window not found")?;
    let ns_window = window.ns_window().map_err(err)? as *mut AnyObject;
    // SAFETY: Tauri's window handle is its NSWindow, alive with the window; this runs on the main thread.
    let content: *mut NSView = unsafe { msg_send![ns_window, contentView] };
    // SAFETY: the content view lives as long as the window, which outlives every tab.
    unsafe { content.as_ref() }.ok_or_else(|| "no content view".to_string())
}

fn cef_string(s: &str) -> CefString {
    CefString::from(s)
}

fn frame_url(frame: &Frame) -> String {
    CefString::from(&frame.url()).to_string()
}

wrap_client! {
    struct TabClient {
        app: AppHandle,
        tab: String,
    }

    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(PageDisplay::new(self.app.clone(), self.tab.clone()))
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(PageLifeSpan::new(self.app.clone(), self.tab.clone()))
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(PageLoad::new(self.app.clone(), self.tab.clone()))
        }

        fn permission_handler(&self) -> Option<PermissionHandler> {
            Some(PagePermission::new(self.app.clone()))
        }

        fn keyboard_handler(&self) -> Option<KeyboardHandler> {
            Some(SwallowCloseKey::new())
        }

        fn focus_handler(&self) -> Option<FocusHandler> {
            Some(NoLoadFocus::new())
        }

        fn download_handler(&self) -> Option<DownloadHandler> {
            Some(PageDownload::new(self.app.clone()))
        }

        fn jsdialog_handler(&self) -> Option<JsdialogHandler> {
            Some(PageDialogs::new(self.app.clone(), self.tab.clone()))
        }

        fn request_handler(&self) -> Option<RequestHandler> {
            Some(LinkClicks::new(self.app.clone(), self.tab.clone()))
        }
    }
}

wrap_request_handler! {
    struct LinkClicks {
        app: AppHandle,
        tab: String,
    }

    impl RequestHandler {
        // A link clicked with ⌘ (behind) or ⌘⇧ (in front), or a middle click: a
        // new tab, as in a browser (left to CEF, the link would load in this tab).
        fn on_open_urlfrom_tab(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            target_url: Option<&CefString>,
            target_disposition: WindowOpenDisposition,
            _user_gesture: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int {
            let new_tab = [WindowOpenDisposition::NEW_BACKGROUND_TAB, WindowOpenDisposition::NEW_FOREGROUND_TAB, WindowOpenDisposition::NEW_WINDOW];
            if !new_tab.contains(&target_disposition) {
                return 0;
            }
            let url = target_url.map(CefString::to_string).unwrap_or_default();
            crate::tab_new_window(&self.app, &self.tab, url, false, target_disposition == WindowOpenDisposition::NEW_BACKGROUND_TAB);
            1
        }
    }
}

wrap_focus_handler! {
    struct NoLoadFocus;

    impl FocusHandler {
        // A page loading (a tab made, the app sending it somewhere) does not take the
        // keyboard: it moves only with the user's own clicks and keys (see `focus`).
        fn on_set_focus(&self, _browser: Option<&mut Browser>, source: FocusSource) -> ::std::os::raw::c_int {
            i32::from(source == FocusSource::NAVIGATION)
        }
    }
}

wrap_download_handler! {
    struct PageDownload {
        app: AppHandle,
    }

    impl DownloadHandler {
        fn can_download(&self, _browser: Option<&mut Browser>, _url: Option<&CefString>, _request_method: Option<&CefString>) -> ::std::os::raw::c_int {
            1
        }

        // Saved to the Downloads folder without asking, as a browser does.
        fn on_before_download(
            &self,
            _browser: Option<&mut Browser>,
            _download_item: Option<&mut DownloadItem>,
            suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> ::std::os::raw::c_int {
            let Some(callback) = callback else { return 0 };
            let name = suggested_name.map(CefString::to_string).filter(|n| !n.is_empty()).unwrap_or_else(|| "download".into());
            let path = crate::download_path(&name);
            callback.cont(Some(&CefString::from(path.to_string_lossy().as_ref())), 0);
            1
        }

        fn on_download_updated(&self, _browser: Option<&mut Browser>, download_item: Option<&mut DownloadItem>, _callback: Option<&mut DownloadItemCallback>) {
            let Some(item) = download_item else { return };
            if item.is_complete() == 0 || !DOWNLOADED.with(|d| d.borrow_mut().insert(item.id())) {
                return;
            }
            crate::download_finished(&self.app, CefString::from(&item.full_path()).to_string());
        }
    }
}

wrap_jsdialog_handler! {
    struct PageDialogs {
        app: AppHandle,
        tab: String,
    }

    impl JsdialogHandler {
        // A page's alert, confirm and prompt show as the app's dialog (see `answer_dialog`).
        fn on_jsdialog(
            &self,
            _browser: Option<&mut Browser>,
            _origin_url: Option<&CefString>,
            dialog_type: JsdialogType,
            message_text: Option<&CefString>,
            default_prompt_text: Option<&CefString>,
            callback: Option<&mut JsdialogCallback>,
            _suppress_message: Option<&mut ::std::os::raw::c_int>,
        ) -> ::std::os::raw::c_int {
            let Some(callback) = callback else { return 0 };
            let id = NEXT_ASK.fetch_add(1, Ordering::SeqCst);
            DIALOGS.with(|d| d.borrow_mut().insert(id, callback.clone()));
            let kind = if dialog_type == JsdialogType::CONFIRM {
                "confirm"
            } else if dialog_type == JsdialogType::PROMPT {
                "prompt"
            } else {
                "alert"
            };
            let text = |s: Option<&CefString>| s.map(CefString::to_string).unwrap_or_default();
            crate::page_dialog(&self.app, &self.tab, id, kind, text(message_text), text(default_prompt_text));
            1
        }

        // Leaving a page is not asked about: tabs close and move on when the user says so.
        fn on_before_unload_dialog(
            &self,
            _browser: Option<&mut Browser>,
            _message_text: Option<&CefString>,
            _is_reload: ::std::os::raw::c_int,
            callback: Option<&mut JsdialogCallback>,
        ) -> ::std::os::raw::c_int {
            match callback {
                Some(callback) => {
                    callback.cont(1, None);
                    1
                }
                None => 0,
            }
        }
    }
}

/// CEF's `EVENTFLAG_COMMAND_DOWN` and the Windows key code of W.
const COMMAND_DOWN: u32 = 1 << 7;
const KEY_W: i32 = 0x57;

wrap_keyboard_handler! {
    struct SwallowCloseKey;

    impl KeyboardHandler {
        // A ⌘W the page did not take (its script answers first) goes on to macOS
        // as Close Window and hides the app's window; closing a tab is the app's job.
        fn on_key_event(&self, _browser: Option<&mut Browser>, event: Option<&KeyEvent>, _os_event: *mut u8) -> ::std::os::raw::c_int {
            i32::from(event.is_some_and(|e| e.modifiers & COMMAND_DOWN != 0 && e.windows_key_code == KEY_W))
        }
    }
}

wrap_display_handler! {
    struct PageDisplay {
        app: AppHandle,
        tab: String,
    }

    impl DisplayHandler {
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            crate::tab_title_changed(&self.app, &self.tab, title.map(CefString::to_string).unwrap_or_default());
        }

        fn on_address_change(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            if frame.is_some_and(|f| f.is_main() == 1) {
                crate::tab_address_changed(&self.app, &self.tab, url.map(CefString::to_string).unwrap_or_default());
            }
        }

        // A page's message to the app is a console message that is one of the app's URLs.
        fn on_console_message(&self, _browser: Option<&mut Browser>, _level: LogSeverity, message: Option<&CefString>, _source: Option<&CefString>, _line: i32) -> i32 {
            let message = message.map(CefString::to_string).unwrap_or_default();
            if !message.starts_with(PAGE_MESSAGE_PREFIX) {
                return 0;
            }
            match message.parse::<tauri::Url>() {
                Ok(url) => crate::page_message(&self.app, &self.tab, &url),
                Err(e) => eprintln!("cef: bad page message: {e}"),
            }
            1
        }
    }
}

wrap_load_handler! {
    struct PageLoad {
        app: AppHandle,
        tab: String,
    }

    impl LoadHandler {
        fn on_load_start(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _transition: TransitionType) {
            if let Some(frame) = frame.filter(|f| f.is_main() == 1) {
                crate::tab_load(&self.app, &self.tab, frame_url(frame), true);
            }
        }

        fn on_load_end(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _status: i32) {
            let Some(frame) = frame else { return };
            if frame.is_main() == 1 {
                crate::tab_load(&self.app, &self.tab, frame_url(frame), false);
                return;
            }
            // A frame (an artifact, a doc's editor) gets the app's keys as the page does.
            for script in crate::page_setup_scripts(&self.app) {
                frame.execute_java_script(Some(&cef_string(&script)), None, 0);
            }
        }
    }
}

wrap_life_span_handler! {
    struct PageLifeSpan {
        app: AppHandle,
        tab: String,
    }

    impl LifeSpanHandler {
        // A sized window is a popup (sign-in pages rely on those) and opens as one;
        // a plain "open in new window" link becomes a tab instead.
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            let sized = popup_features.is_some_and(|f| f.width_set != 0 || f.height_set != 0);
            // The popup is not the tab: its loads and titles must not reach the tab's page.
            if let Some(client) = client {
                *client = Some(PopupClient::new(self.app.clone()));
            }
            let url = target_url.map(CefString::to_string).unwrap_or_default();
            // ⌘-click opens behind, as in a browser.
            let behind = target_disposition == WindowOpenDisposition::NEW_BACKGROUND_TAB;
            i32::from(!crate::tab_new_window(&self.app, &self.tab, url, sized, behind))
        }

        fn on_after_created(&self, _browser: Option<&mut Browser>) {
            LIVE.fetch_add(1, Ordering::SeqCst);
        }

        // Left to CEF, closing a browser also sends performClose to its parent
        // window, which hides the app's window. The pages are views in it, so
        // taking the view out is the close (its release ends the browser).
        fn do_close(&self, browser: Option<&mut Browser>) -> ::std::os::raw::c_int {
            if let Some(view) = browser.and_then(|b| view_of(b)) {
                view.removeFromSuperview();
            }
            1
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            LIVE.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

wrap_client! {
    struct PopupClient {
        app: AppHandle,
    }

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(PopupLifeSpan::new())
        }

        fn permission_handler(&self) -> Option<PermissionHandler> {
            Some(PagePermission::new(self.app.clone()))
        }
    }
}

wrap_life_span_handler! {
    struct PopupLifeSpan;

    impl LifeSpanHandler {
        fn on_after_created(&self, _browser: Option<&mut Browser>) {
            LIVE.fetch_add(1, Ordering::SeqCst);
        }

        // Left to CEF (no `do_close`), a popup's close closes its own window with it.

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            LIVE.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

wrap_permission_handler! {
    struct PagePermission {
        app: AppHandle,
    }

    impl PermissionHandler {
        // A site's ask for the microphone or camera: the answer kept for the site,
        // else the user's (asked in the app, then kept); macOS asks in turn.
        fn on_request_media_access_permission(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            requesting_origin: Option<&CefString>,
            requested_permissions: u32,
            callback: Option<&mut MediaAccessCallback>,
        ) -> i32 {
            let Some(callback) = callback else { return 0 };
            let origin = requesting_origin.map(CefString::to_string).unwrap_or_default();
            let site = origin.parse::<tauri::Url>().ok().and_then(|u| u.host_str().map(String::from)).unwrap_or(origin);
            match crate::site_permission(&self.app, &site) {
                Some(allowed) => callback.cont(if allowed { requested_permissions } else { 0 }),
                None => {
                    let id = NEXT_ASK.fetch_add(1, Ordering::SeqCst);
                    MEDIA_ASKS.with(|m| m.borrow_mut().insert(id, (callback.clone(), requested_permissions)));
                    crate::ask_site_permission(&self.app, id, site, requested_permissions);
                }
            }
            1
        }
    }
}

/// The user's answer to a page's dialog (`ok` false: cancel), with what was typed for a prompt.
pub fn answer_dialog(app: &AppHandle, id: u64, ok: bool, text: Option<String>) -> Result<(), String> {
    on_main(app, move || {
        if let Some(callback) = DIALOGS.with(|d| d.borrow_mut().remove(&id)) {
            callback.cont(i32::from(ok), text.map(|t| CefString::from(t.as_str())).as_ref());
        }
    })
}

/// The user's answer to a site's ask for the microphone or camera.
pub fn answer_media(app: &AppHandle, id: u64, allow: bool) -> Result<(), String> {
    on_main(app, move || {
        if let Some((callback, asked)) = MEDIA_ASKS.with(|m| m.borrow_mut().remove(&id)) {
            callback.cont(if allow { asked } else { 0 });
        }
    })
}

wrap_string_visitor! {
    struct TextVisitor {
        out: Sender<String>,
    }

    impl CefStringVisitor {
        fn visit(&self, string: Option<&CefString>) {
            let _ = self.out.send(string.map(CefString::to_string).unwrap_or_default());
        }
    }
}

/// Runs Chromium's work until its context is up, which a browser needs to be made (a tab
/// restored right after launch would come first).
fn wait_ready() -> Result<(), String> {
    let until = Instant::now() + READY_WAIT;
    while !READY.load(Ordering::SeqCst) {
        if Instant::now() > until {
            return Err("ブラウザの準備が終わりません".into());
        }
        do_message_loop_work();
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

pub fn exists(app: &AppHandle, tab: &str) -> bool {
    let tab = tab.to_string();
    on_main(app, move || with_tab(&tab, |_| ()).is_some()).unwrap_or(false)
}

/// Opens tab `tab` on `url` at `rect`, over the main window's content.
pub fn create(app: &AppHandle, tab: &str, url: &str, rect: PageRect) -> Result<(), String> {
    if !available() {
        return Err("ブラウザ（Chromium）が入っていません。.app として起動してください".into());
    }
    let (tab, url, handle) = (tab.to_string(), url.to_string(), app.clone());
    on_main(app, move || {
        wait_ready()?;
        let content = content_view(&handle)?;
        let frame = cocoa_frame(content, rect);
        let bounds = Rect { x: frame.origin.x as i32, y: frame.origin.y as i32, width: frame.size.width as i32, height: frame.size.height as i32 };
        let info = WindowInfo { runtime_style: RuntimeStyle::ALLOY, ..Default::default() }.set_as_child(content as *const NSView as *mut AnyObject as _, &bounds);
        let mut client = TabClient::new(handle.clone(), tab.clone());
        let browser = browser_host_create_browser_sync(Some(&info), Some(&mut client), Some(&cef_string(&url)), Some(&BrowserSettings::default()), None, None)
            .ok_or("ブラウザを作れませんでした")?;
        TABS.with(|t| t.borrow_mut().insert(tab, browser));
        Ok(())
    })?
}

pub fn navigate(app: &AppHandle, tab: &str, url: &str) -> Result<(), String> {
    let (tab, url) = (tab.to_string(), url.to_string());
    on_main(app, move || {
        with_tab(&tab, |b| b.main_frame().map(|f| f.load_url(Some(&cef_string(&url)))));
    })
}

/// The tab's address right now.
pub fn url(app: &AppHandle, tab: &str) -> Option<String> {
    let tab = tab.to_string();
    on_main(app, move || with_tab(&tab, |b| b.main_frame().map(|f| frame_url(&f))).flatten()).ok().flatten()
}

pub fn set_rect(app: &AppHandle, tab: &str, rect: PageRect) -> Result<(), String> {
    let (tab, handle) = (tab.to_string(), app.clone());
    on_main(app, move || {
        let content = content_view(&handle)?;
        with_tab(&tab, |b| view_of(b).map(|v| v.setFrame(cocoa_frame(content, rect))));
        Ok(())
    })?
}

/// Shows or hides tab `tab`, or every tab but those in `except`.
pub fn set_hidden(app: &AppHandle, only: Option<&str>, except: &[String], hidden: bool) -> Result<(), String> {
    let (only, except) = (only.map(String::from), except.to_vec());
    on_main(app, move || {
        TABS.with(|t| {
            for (tab, browser) in t.borrow().iter() {
                if only.as_ref().is_some_and(|o| o != tab) || except.contains(tab) {
                    continue;
                }
                if let Some(view) = view_of(browser) {
                    view.setHidden(hidden);
                }
            }
        });
    })
}

pub fn close(app: &AppHandle, tab: &str) -> Result<(), String> {
    let tab = tab.to_string();
    on_main(app, move || {
        if let Some(browser) = TABS.with(|t| t.borrow_mut().remove(&tab)) {
            if let Some(host) = browser.host() {
                host.close_browser(1);
            }
        }
    })
}

/// Gives the page the keyboard.
pub fn focus(app: &AppHandle, tab: &str) -> Result<(), String> {
    let tab = tab.to_string();
    on_main(app, move || {
        with_tab(&tab, |b| b.host().map(|h| h.set_focus(1)));
    })
}

/// Runs `script` in the tab's page (its main frame).
pub fn eval(app: &AppHandle, tab: &str, script: &str) -> Result<(), String> {
    let (tab, script) = (tab.to_string(), script.to_string());
    on_main(app, move || {
        with_tab(&tab, |b| b.main_frame().map(|f| f.execute_java_script(Some(&cef_string(&script)), None, 0)));
    })
}

/// Runs `script` in every tab's page.
pub fn eval_all(app: &AppHandle, script: &str) {
    let script = script.to_string();
    let _ = on_main(app, move || {
        TABS.with(|t| {
            for browser in t.borrow().values() {
                if let Some(frame) = browser.main_frame() {
                    frame.execute_java_script(Some(&cef_string(&script)), None, 0);
                }
            }
        })
    });
}

/// "back", "forward" or "reload".
pub fn go(app: &AppHandle, tab: &str, action: &str) -> Result<(), String> {
    let (tab, action) = (tab.to_string(), action.to_string());
    on_main(app, move || {
        let found = with_tab(&tab, |b| match action.as_str() {
            "back" => Ok(b.go_back()),
            "forward" => Ok(b.go_forward()),
            "reload" => Ok(b.reload()),
            other => Err(format!("unknown browser action {other}")),
        });
        found.unwrap_or_else(|| Err("このタブは開いていません".into()))
    })?
}

/// Zooms the tab's page to `factor` (1.0 is none).
pub fn set_zoom(app: &AppHandle, tab: &str, factor: f64) -> Result<(), String> {
    let tab = tab.to_string();
    on_main(app, move || {
        with_tab(&tab, |b| b.host().map(|h| h.set_zoom_level(factor.ln() / ZOOM_LEVEL_BASE.ln())))
            .map(|_| ())
            .ok_or_else(|| "このタブは開いていません".to_string())
    })?
}

/// The tab's zoom now (1.0 is none), which Chromium keeps per site, so it can be other than the app set.
pub fn zoom(app: &AppHandle, tab: &str) -> Option<f64> {
    let tab = tab.to_string();
    let level = on_main(app, move || with_tab(&tab, |b| b.host().map(|h| h.zoom_level())).flatten()).ok().flatten()?;
    // Rounded: the steps (1.1, 1.25, ...) are compared with it.
    Some((ZOOM_LEVEL_BASE.powf(level) * 100.0).round() / 100.0)
}

/// The text of the tab's page, or None when the tab has no page open.
pub fn text(app: &AppHandle, tab: &str) -> Result<Option<String>, String> {
    let tab = tab.to_string();
    let (tx, rx) = channel();
    let asked = on_main(app, move || {
        with_tab(&tab, |b| b.main_frame().map(|f| f.text(Some(&mut TextVisitor::new(tx))))).flatten().is_some()
    })?;
    if !asked {
        return Ok(None);
    }
    rx.recv_timeout(TEXT_WAIT).map(Some).map_err(|_| "ページの本文を読めませんでした".to_string())
}

/// At quit: closes the pages and lets Chromium write what it keeps (cookies among it).
pub fn shutdown(app: &AppHandle) {
    if !available() {
        return;
    }
    let _ = on_main(app, || {
        TABS.with(|t| {
            for (_, browser) in t.borrow_mut().drain() {
                if let Some(host) = browser.host() {
                    host.close_browser(1);
                }
            }
        });
        if let Some(cookies) = cookie_manager_get_global_manager(None) {
            cookies.flush_store(None);
        }
        let until = Instant::now() + SHUTDOWN_WAIT;
        while LIVE.load(Ordering::SeqCst) > 0 && Instant::now() < until {
            do_message_loop_work();
            std::thread::sleep(Duration::from_millis(10));
        }
        // Cookies are written on another thread; give it a moment.
        for _ in 0..10 {
            do_message_loop_work();
            std::thread::sleep(Duration::from_millis(10));
        }
        DOWN.store(true, Ordering::SeqCst);
        cef::shutdown();
    });
}
