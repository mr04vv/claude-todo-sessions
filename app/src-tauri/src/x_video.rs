// X's videos played where they are on the page. They are H.264, which the
// Chromium here cannot play, so a WebKit view (which can) is laid over the
// video in the middle of X's view, inside the tab's own view: it hides and
// goes with the tab. browser_page.js tells where the video is (and again as
// the page scrolls, the player following it) and which videos are coming
// (their files found ahead); cts_core's x_video finds a post's file.
// Everything here runs on the main thread.
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::NSObject;
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSEvent, NSEventType, NSResponder, NSView};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use objc2_web_kit::{WKAudiovisualMediaTypes, WKWebView, WKWebViewConfiguration};
use tauri::AppHandle;

use crate::cef_browser;

/// The player's page: `play(src)` swaps the video and keeps its sound as the
/// user set it (muted at first, so a video scrolled to plays without asking).
const PAGE: &str = r#"<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%}</style>
<video id="v" controls autoplay muted loop playsinline src=SRC></video>
<script>const v = document.getElementById("v"); window.play = (src) => { if (v.src !== src) v.src = src; v.play().catch(() => {}); };</script>"#;

/// Where the video is: CSS pixels from the top left of the page's view, whose
/// width is `viewport_width` (CSS pixels too: the page's zoom is in the
/// ratio). The page shows above `top` only what stays there (X's header).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spot {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub viewport_width: f64,
    pub top: f64,
}

define_class!(
    /// A WebKit view the trackpad scrolls through: a scroll over it goes to
    /// the page under it, as if it were part of that page.
    #[unsafe(super(WKWebView, NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    struct PlayerView;

    impl PlayerView {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let app = NSApplication::sharedApplication(self.mtm());
            // Not a `Retained` getter (see cef_browser's content_view).
            let event: *mut NSEvent = unsafe { msg_send![&*app, currentEvent] };
            if unsafe { event.as_ref() }.is_some_and(|e| e.r#type() == NSEventType::ScrollWheel) {
                return std::ptr::null_mut();
            }
            unsafe { msg_send![super(self), hitTest: point] }
        }
    }
);

define_class!(
    /// The part of the tab's view the player may show in (below X's header):
    /// it cuts the player off there, and lets everything else through to the page.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    struct ClipView;

    impl ClipView {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let hit: *mut NSView = unsafe { msg_send![super(self), hitTest: point] };
            if std::ptr::eq(hit, &**self as *const NSView) { std::ptr::null_mut() } else { hit }
        }
    }
);

struct Player {
    clip: Retained<ClipView>,
    view: Retained<PlayerView>,
    /// The post whose video it has.
    id: String,
    /// The tab (a key) whose view it is in, if one.
    tab: String,
}

/// The video asked for: post `id`'s, in `tab` at `spot`.
struct Want {
    tab: String,
    id: String,
    spot: Spot,
}

thread_local! {
    static PLAYER: RefCell<Option<Player>> = const { RefCell::new(None) };
    static WANT: RefCell<Option<Want>> = const { RefCell::new(None) };
}

// ponytail: never emptied; a post's file is a short URL, so it only matters after very long scrolling.
static MP4S: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn cached(id: &str) -> Option<String> {
    MP4S.lock().ok().and_then(|m| m.as_ref()?.get(id).cloned())
}

/// Finds post `id`'s file (once), then runs `then` with it on the main thread.
fn fetch(app: &AppHandle, id: String, then: impl FnOnce(String) + Send + 'static) {
    let app = app.clone();
    std::thread::spawn(move || match cts_core::x_video::mp4_of_post(&id) {
        Ok(Some(mp4)) => {
            if let Ok(mut m) = MP4S.lock() {
                m.get_or_insert_with(HashMap::new).insert(id, mp4.clone());
            }
            let _ = app.run_on_main_thread(move || then(mp4));
        }
        Ok(None) => eprintln!("x-video: no video in post {id}"),
        Err(e) => eprintln!("x-video: {e}"),
    });
}

/// Finds post `id`'s file ahead, so its video starts at once when it comes to the middle.
pub fn prefetch(app: &AppHandle, id: String) {
    if !id.is_empty() && cached(&id).is_none() {
        fetch(app, id, |_| {});
    }
}

/// Plays post `id`'s video over it in `tab` (or moves the player with it).
pub fn show(app: &AppHandle, tab: &str, id: String, spot: Spot) {
    let Some(_) = MainThreadMarker::new() else { return };
    WANT.with(|w| *w.borrow_mut() = Some(Want { tab: tab.to_string(), id: id.clone(), spot }));
    if PLAYER.with(|p| p.borrow().as_ref().is_some_and(|p| p.id == id)) {
        return present();
    }
    set_shown(false);
    match cached(&id) {
        Some(mp4) => load(&id, &mp4),
        None => {
            let wanted = id.clone();
            fetch(app, id, move |mp4| load(&wanted, &mp4));
        }
    }
}

/// Puts the player away, if it is `tab`'s (its video left the view, or the page did).
pub fn hide(tab: &str) {
    let Some(_) = MainThreadMarker::new() else { return };
    WANT.with(|w| {
        let mut w = w.borrow_mut();
        if w.as_ref().is_some_and(|w| w.tab == tab) {
            *w = None;
        }
    });
    if PLAYER.with(|p| p.borrow().as_ref().is_some_and(|p| p.tab == tab)) {
        set_shown(false);
    }
}

/// Takes the player out of `tab`'s view before the view goes.
pub fn tab_closed(tab: &str) {
    hide(tab);
    PLAYER.with(|p| {
        if let Some(player) = p.borrow_mut().as_mut().filter(|p| p.tab == tab) {
            player.clip.removeFromSuperview();
            player.tab.clear();
        }
    });
}

/// Post `id`'s file `mp4` in the player (made if not yet), if it is still the one asked for.
fn load(id: &str, mp4: &str) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    if !WANT.with(|w| w.borrow().as_ref().is_some_and(|w| w.id == id)) {
        return;
    }
    let src = serde_json::to_string(mp4).unwrap_or_default();
    PLAYER.with(|p| {
        let mut p = p.borrow_mut();
        match p.as_mut() {
            Some(player) => {
                eval(&player.view, &format!("play({src})"));
                player.id = id.to_string();
            }
            None => {
                let (clip, view) = new_views(mtm, &src);
                *p = Some(Player { clip, view, id: id.to_string(), tab: String::new() });
            }
        }
    });
    present();
}

/// The player over the video asked for, playing.
fn present() {
    let Some((tab, spot)) = WANT.with(|w| w.borrow().as_ref().map(|w| (w.tab.clone(), w.spot))) else { return };
    let placed = PLAYER.with(|p| {
        let mut p = p.borrow_mut();
        let player = p.as_mut()?;
        cef_browser::with_view(&tab, |view| {
            if player.tab != tab {
                player.clip.removeFromSuperview();
                view.addSubview(&player.clip);
            }
            let size = view.frame().size;
            let (clip, video) = frames((size.width, size.height), view.isFlipped(), spot);
            player.clip.setFrame(rect(clip));
            player.view.setFrame(rect(video));
            if player.clip.isHidden() {
                player.clip.setHidden(false);
                eval(&player.view, "v.play().catch(() => {})");
            }
        })?;
        player.tab = tab.clone();
        Some(())
    });
    if placed.is_none() {
        set_shown(false);
    }
}

fn set_shown(shown: bool) {
    PLAYER.with(|p| {
        if let Some(player) = p.borrow().as_ref() {
            player.clip.setHidden(!shown);
            if !shown {
                eval(&player.view, "v.pause()");
            }
        }
    });
}

fn new_views(mtm: MainThreadMarker, src: &str) -> (Retained<ClipView>, Retained<PlayerView>) {
    // SAFETY: on the main thread; the configuration is copied by the view.
    unsafe {
        let clip: Retained<ClipView> = msg_send![super(ClipView::alloc(mtm).set_ivars(())), initWithFrame: NSRect::ZERO];
        clip.setClipsToBounds(true);
        let config = WKWebViewConfiguration::new(mtm);
        // Plays a new video with its sound on, once the user turned it on.
        config.setMediaTypesRequiringUserActionForPlayback(WKAudiovisualMediaTypes::None);
        let view: Retained<PlayerView> = msg_send![super(PlayerView::alloc(mtm).set_ivars(())), initWithFrame: NSRect::ZERO, configuration: &*config];
        view.loadHTMLString_baseURL(&NSString::from_str(&PAGE.replace("SRC", src)), None);
        clip.addSubview(&view);
        (clip, view)
    }
}

fn eval(view: &PlayerView, script: &str) {
    // SAFETY: on the main thread; no completion handler.
    unsafe { view.evaluateJavaScript_completionHandler(&NSString::from_str(script), None) };
}

type Frame = (f64, f64, f64, f64);

fn rect((x, y, width, height): Frame) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

/// In a tab's view of `size` (points; from the bottom unless `flipped`), for
/// the video at `spot`: the clip's frame (x, y, width, height: the view below
/// `spot.top`) and the player's in it (from its bottom).
fn frames(size: (f64, f64), flipped: bool, spot: Spot) -> (Frame, Frame) {
    let k = if spot.viewport_width > 0.0 { size.0 / spot.viewport_width } else { 1.0 };
    let top = (spot.top * k).clamp(0.0, size.1);
    let clip_height = size.1 - top;
    let clip = (0.0, if flipped { top } else { 0.0 }, size.0, clip_height);
    let height = spot.height * k;
    let video = (spot.x * k, clip_height - (spot.y * k - top) - height, spot.width * k, height);
    (clip, video)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPOT: Spot = Spot { x: 100.0, y: 150.0, width: 400.0, height: 300.0, viewport_width: 1000.0, top: 0.0 };

    #[test]
    fn the_player_is_where_the_video_is_from_the_view_s_bottom() {
        assert_eq!(frames((1000.0, 800.0), false, SPOT), ((0.0, 0.0, 1000.0, 800.0), (100.0, 350.0, 400.0, 300.0)));
    }

    #[test]
    fn under_x_s_header_it_is_cut_off() {
        let (clip, video) = frames((1000.0, 800.0), false, Spot { top: 50.0, ..SPOT });
        assert_eq!(clip, (0.0, 0.0, 1000.0, 750.0));
        assert_eq!(video, (100.0, 350.0, 400.0, 300.0), "where it was in the view");
        assert_eq!(frames((1000.0, 800.0), true, Spot { top: 50.0, ..SPOT }).0, (0.0, 50.0, 1000.0, 750.0));
    }

    #[test]
    fn the_page_s_zoom_scales_it() {
        // Zoomed to 125%: the page is 800 CSS pixels wide in a 1000-point view.
        let zoomed = Spot { viewport_width: 800.0, ..SPOT };
        assert_eq!(frames((1000.0, 800.0), false, zoomed).1, (125.0, 237.5, 500.0, 375.0));
    }
}
