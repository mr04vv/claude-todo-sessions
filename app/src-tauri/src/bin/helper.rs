// The in-app browser's other processes (renderer, GPU, ...): Chromium starts
// this binary, copied into the .app as its "Helper" apps (scripts/bundle-cef.sh).
// The renderer runs the browser pane's script in every page and frame as its
// context is made, before the page's own scripts.
use cef::{args::Args, *};

const PAGE_SCRIPT: &str = include_str!("../browser_page.js");
/// Where the script takes this run's token, which its messages to the app carry.
const TOKEN_PLACEHOLDER: &str = "__TODO_SESSIONS_TOKEN__";
/// The switch the browser process passes the token with (cef_browser.rs's PAGE_TOKEN_SWITCH).
const TOKEN_SWITCH: &str = "--todo-sessions-token=";

/// The script with the token in, made once from this process's command line.
static SCRIPT: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn script() -> &'static str {
    SCRIPT.get_or_init(|| {
        let token = std::env::args().find_map(|a| a.strip_prefix(TOKEN_SWITCH).map(String::from)).unwrap_or_default();
        PAGE_SCRIPT.replace(TOKEN_PLACEHOLDER, &token)
    })
}

wrap_render_process_handler! {
    struct PageScript;

    impl RenderProcessHandler {
        fn on_context_created(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _context: Option<&mut V8Context>) {
            if let Some(frame) = frame {
                frame.execute_java_script(Some(&CefString::from(script())), None, 0);
            }
        }
    }
}

wrap_app! {
    struct HelperApp;

    impl App {
        fn render_process_handler(&self) -> Option<RenderProcessHandler> {
            Some(PageScript::new())
        }
    }
}

fn main() {
    let args = Args::new();
    let loader = library_loader::LibraryLoader::new(&std::env::current_exe().expect("current exe"), true);
    assert!(loader.load(), "cannot load the Chromium framework");
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let mut app = HelperApp::new();
    execute_process(Some(args.as_main_args()), Some(&mut app), std::ptr::null_mut());
}
