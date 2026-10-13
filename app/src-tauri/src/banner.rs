//! macOS notifications, with one delegate for the clicks.
//! mac-notification-sys, used before, kept a thread for each notification and,
//! until the notification left Notification Center, asked for every delivered
//! one on the main thread twice a second: after a day of them the app hardly
//! answered.
// NSUserNotification: UNUserNotificationCenter would ask the user for permission again.
#![allow(deprecated)]

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, ClassType};
use objc2_foundation::{NSString, NSUserNotification, NSUserNotificationCenter, NSUserNotificationCenterDelegate};

type OnClick = Box<dyn FnOnce() + Send>;

/// What clicking each notification posted since launch does, by its identifier.
/// ponytail: one never clicked stays until the app quits.
static ON_CLICK: LazyLock<Mutex<HashMap<String, OnClick>>> = LazyLock::new(Default::default);

define_class!(
    #[unsafe(super(NSObject))]
    struct BannerClicks;

    unsafe impl NSObjectProtocol for BannerClicks {}

    unsafe impl NSUserNotificationCenterDelegate for BannerClicks {
        #[unsafe(method(userNotificationCenter:didActivateNotification:))]
        fn did_activate(&self, center: &NSUserNotificationCenter, notification: &NSUserNotification) {
            center.removeDeliveredNotification(notification);
            let id = notification.identifier().map(|id| id.to_string());
            let on_click = id.and_then(|id| ON_CLICK.lock().ok()?.remove(&id));
            // Off the main thread, as what it opens may wait on it.
            if let Some(on_click) = on_click {
                std::thread::spawn(on_click);
            }
        }
    }
);

/// None without a bundle identifier (`cargo run`, `pnpm tauri dev`).
fn center() -> Option<Retained<NSUserNotificationCenter>> {
    unsafe { msg_send![NSUserNotificationCenter::class(), defaultUserNotificationCenter] }
}

/// Takes the clicks. Called once, on the main thread.
pub fn init() {
    let Some(center) = center() else { return };
    let clicks: Retained<BannerClicks> = unsafe { msg_send![BannerClicks::alloc(), init] };
    unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&*clicks))) };
    // The center does not retain its delegate; this one lives as long as the app.
    std::mem::forget(clicks);
}

/// Posts a notification; clicking it runs `on_click` on a thread of its own.
pub fn post(title: &str, message: &str, on_click: impl FnOnce() + Send + 'static) {
    let Some(center) = center() else { return };
    let id = uuid::Uuid::new_v4().to_string();
    let notification = NSUserNotification::new();
    notification.setIdentifier(Some(&NSString::from_str(&id)));
    notification.setTitle(Some(&NSString::from_str(title)));
    notification.setInformativeText(Some(&NSString::from_str(message)));
    notification.setHasActionButton(false);
    if let Ok(mut clicks) = ON_CLICK.lock() {
        clicks.insert(id, Box::new(on_click));
    }
    center.deliverNotification(&notification);
}
