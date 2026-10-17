//! The Mac going to sleep and waking, from NSWorkspace's notifications.

use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol};
use objc2::{define_class, msg_send, sel, AllocAnyThread};
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification};
use objc2_foundation::NSNotification;

type Hook = Box<dyn Fn() + Send + Sync>;

/// What to do before the Mac sleeps, and after it wakes.
static HOOKS: OnceLock<(Hook, Hook)> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    struct PowerWatch;

    unsafe impl NSObjectProtocol for PowerWatch {}

    impl PowerWatch {
        #[unsafe(method(willSleep:))]
        fn will_sleep(&self, _: &NSNotification) {
            if let Some((sleep, _)) = HOOKS.get() {
                sleep();
            }
        }

        #[unsafe(method(didWake:))]
        fn did_wake(&self, _: &NSNotification) {
            if let Some((_, wake)) = HOOKS.get() {
                wake();
            }
        }
    }
);

/// Runs `sleep` before the Mac sleeps (on the main thread; the Mac waits for
/// it up to 30 seconds) and `wake` after it wakes. Called once, on the main thread.
pub fn watch(sleep: impl Fn() + Send + Sync + 'static, wake: impl Fn() + Send + Sync + 'static) {
    if HOOKS.set((Box::new(sleep), Box::new(wake))).is_err() {
        return;
    }
    let watch: Retained<PowerWatch> = unsafe { msg_send![PowerWatch::alloc(), init] };
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    unsafe {
        center.addObserver_selector_name_object(&watch, sel!(willSleep:), Some(NSWorkspaceWillSleepNotification), None);
        center.addObserver_selector_name_object(&watch, sel!(didWake:), Some(NSWorkspaceDidWakeNotification), None);
    }
    // The center does not retain its observers; this one lives as long as the app.
    std::mem::forget(watch);
}
