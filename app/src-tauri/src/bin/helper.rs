// The in-app browser's other processes (renderer, GPU, ...): Chromium starts
// this binary, copied into the .app as its "Helper" apps (scripts/bundle-cef.sh).
// The renderer runs the browser pane's script in every page and frame as its
// context is made, before the page's own scripts.
use cef::{args::Args, *};

const PAGE_SCRIPT: &str = include_str!("../browser_page.js");

wrap_render_process_handler! {
    struct PageScript;

    impl RenderProcessHandler {
        fn on_context_created(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _context: Option<&mut V8Context>) {
            if let Some(frame) = frame {
                frame.execute_java_script(Some(&CefString::from(PAGE_SCRIPT)), None, 0);
            }
        }
    }
}

wrap_app! {
    struct HelperApp;

    impl App {
        // As in the browser process (cef_browser.rs): no Keychain.
        fn on_before_command_line_processing(&self, _process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            if let Some(command_line) = command_line {
                command_line.append_switch(Some(&CefString::from("use-mock-keychain")));
            }
        }

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
