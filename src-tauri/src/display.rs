//! Notch geometry and native window placement.
//!
//! Tauri's window API can't put a window above the menu bar or describe the
//! notch, so on macOS this module talks to AppKit directly (documented APIs only:
//! `NSScreen.safeAreaInsets`, `auxiliaryTopLeftArea`/`auxiliaryTopRightArea`,
//! `NSWindow.level`, `collectionBehavior`). Other platforms get a top-centre
//! fallback through Tauri's own API so the frontend can still be exercised.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub const GEOMETRY_EVENT: &str = "notch-geometry-changed";

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotchGeometry {
    /// True when the target screen reports a camera housing.
    pub has_notch: bool,
    /// Width of the physical notch in points (0 without a notch).
    pub notch_width: f64,
    /// Height of the notch or, without one, the menu bar.
    pub notch_height: f64,
    pub screen_width: f64,
    pub screen_height: f64,
    pub scale_factor: f64,
}

impl NotchGeometry {
    pub const FALLBACK: NotchGeometry = NotchGeometry {
        has_notch: false,
        notch_width: 0.0,
        notch_height: 32.0,
        screen_width: 1440.0,
        screen_height: 900.0,
        scale_factor: 2.0,
    };
}

/// The window's size (fixed for the session) and the island's clickable area within it.
#[derive(Default)]
pub struct IslandState {
    size: Mutex<Option<(f64, f64)>>,
    /// Clickable width/height, centred horizontally at the top of the window.
    /// Everywhere else the window lets clicks through.
    hit_area: Mutex<(f64, f64)>,
}

/// Points added to the notch height, for fine-tuning the fit on a particular Mac:
/// `defaults write com.notchbeat.app NotchHeightAdjust -float 0.5` (then relaunch).
const HEIGHT_ADJUST_KEY: &str = "NotchHeightAdjust";

#[cfg(target_os = "macos")]
mod mac {
    use super::NotchGeometry;
    use objc2::{MainThreadMarker, rc::Retained};
    use objc2_app_kit::{
        NSApplication, NSScreen, NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    /// Prefer the screen with a notch (the built-in display); otherwise the main screen.
    pub fn target_screen(mtm: MainThreadMarker) -> Option<Retained<NSScreen>> {
        let screens = NSScreen::screens(mtm);
        screens
            .iter()
            .find(|s| s.safeAreaInsets().top > 0.0)
            .or_else(|| NSScreen::mainScreen(mtm))
    }

    pub fn geometry(screen: &NSScreen) -> NotchGeometry {
        let frame = screen.frame();
        let top_inset = screen.safeAreaInsets().top;
        let left = screen.auxiliaryTopLeftArea();
        let right = screen.auxiliaryTopRightArea();
        let has_notch = top_inset > 0.0 && left.size.width > 0.0 && right.size.width > 0.0;

        // The camera housing can sit a hair lower than the reported safe area; the
        // menu bar (when shown) is drawn to the housing's bottom edge, so use the taller.
        let visible = screen.visibleFrame();
        let menu_bar = (frame.origin.y + frame.size.height) - (visible.origin.y + visible.size.height);
        let (notch_width, base_height) = if has_notch {
            (frame.size.width - left.size.width - right.size.width, top_inset.max(menu_bar))
        } else {
            (0.0, if menu_bar > 0.0 { menu_bar } else { 24.0 })
        };
        let adjust = objc2_foundation::NSUserDefaults::standardUserDefaults()
            .doubleForKey(&objc2_foundation::NSString::from_str(super::HEIGHT_ADJUST_KEY));
        let notch_height = (base_height + adjust.clamp(-8.0, 8.0)).max(1.0);

        NotchGeometry {
            has_notch,
            notch_width,
            notch_height,
            screen_width: frame.size.width,
            screen_height: frame.size.height,
            scale_factor: screen.backingScaleFactor(),
        }
    }

    /// # Safety
    /// `ptr` must be the live `NSWindow` returned by Tauri for this window.
    unsafe fn ns_window<'a>(ptr: *mut std::ffi::c_void) -> &'a NSWindow {
        unsafe { &*(ptr as *const NSWindow) }
    }

    pub fn configure(window: &tauri::WebviewWindow) {
        let Ok(ptr) = window.ns_window() else { return };
        let w = unsafe { ns_window(ptr) };
        // Above the menu bar (24) so the island can sit flush with the notch.
        // Menus (popUpMenu level 101) still draw over it.
        w.setLevel(NSStatusWindowLevel);
        w.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        w.setHasShadow(false);
    }

    /// Size the window and pin its top edge to the top of the screen, centred on the notch.
    pub fn place(window: &tauri::WebviewWindow, mtm: MainThreadMarker, width: f64, height: f64) {
        let Ok(ptr) = window.ns_window() else { return };
        let Some(screen) = target_screen(mtm) else { return };
        let w = unsafe { ns_window(ptr) };
        let frame = screen.frame();
        let origin = NSPoint::new(
            (frame.origin.x + frame.size.width / 2.0 - width / 2.0).round(),
            frame.origin.y + frame.size.height - height,
        );
        w.setFrame_display(NSRect::new(origin, NSSize::new(width, height)), true);
    }

    /// Show without activating the app, so launching never steals focus.
    pub fn show_passive(window: &tauri::WebviewWindow) {
        let Ok(ptr) = window.ns_window() else { return };
        unsafe { ns_window(ptr) }.orderFrontRegardless();
    }

    /// Hand keyboard focus back to whichever app was active before.
    pub fn release_focus(mtm: MainThreadMarker) {
        NSApplication::sharedApplication(mtm).deactivate();
    }

    /// Let clicks through unless the cursor is over the island's hit area.
    /// Returns the new "ignoring" state.
    pub fn update_click_through(window: &tauri::WebviewWindow, hit: (f64, f64)) -> Option<bool> {
        let ptr = window.ns_window().ok()?;
        let w = unsafe { ns_window(ptr) };
        let f = w.frame();
        let m = objc2_app_kit::NSEvent::mouseLocation();
        // Window-local, top-left origin.
        let x = m.x - f.origin.x;
        let y = (f.origin.y + f.size.height) - m.y;
        let left = (f.size.width - hit.0) / 2.0;
        let inside = x >= left && x <= left + hit.0 && y >= 0.0 && y <= hit.1;
        if w.ignoresMouseEvents() == inside {
            w.setIgnoresMouseEvents(!inside);
        }
        Some(!inside)
    }

    pub fn window_frame(window: &tauri::WebviewWindow) -> Option<NSRect> {
        let ptr = window.ns_window().ok()?;
        Some(unsafe { ns_window(ptr) }.frame())
    }
}

#[cfg(target_os = "macos")]
fn main_thread() -> objc2::MainThreadMarker {
    objc2::MainThreadMarker::new().expect("display functions must run on the main thread")
}

pub fn current_geometry() -> NotchGeometry {
    #[cfg(target_os = "macos")]
    {
        mac::target_screen(main_thread())
            .map(|s| mac::geometry(&s))
            .unwrap_or(NotchGeometry::FALLBACK)
    }
    #[cfg(not(target_os = "macos"))]
    {
        NotchGeometry::FALLBACK
    }
}

pub fn place_island(window: &WebviewWindow, width: f64, height: f64) {
    window.state::<IslandState>().size.lock().unwrap().replace((width, height));
    #[cfg(target_os = "macos")]
    mac::place(window, main_thread(), width, height);
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::{LogicalPosition, LogicalSize};
        let _ = window.set_size(LogicalSize::new(width, height));
        if let Ok(Some(m)) = window.current_monitor() {
            let s = m.size().to_logical::<f64>(m.scale_factor());
            let _ = window.set_position(LogicalPosition::new((s.width - width) / 2.0, 0.0));
        }
    }
}

/// One-time native setup, then show the compact island without taking focus.
pub fn init_window(window: &WebviewWindow, width: f64, height: f64) {
    #[cfg(target_os = "macos")]
    mac::configure(window);
    place_island(window, width, height);
    show_island(window);
}

/// Bring the island on screen without activating the app.
pub fn show_island(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    mac::show_passive(window);
    #[cfg(not(target_os = "macos"))]
    let _ = window.show();
}

/// Poll the cursor (~25 Hz, main thread) and make the window click-through
/// everywhere except the island. No permissions needed: this only reads the
/// cursor position, it doesn't observe events.
pub fn track_click_through(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(40));
        let Some(window) = app.get_webview_window("main") else { continue };
        if !window.is_visible().unwrap_or(false) {
            continue;
        }
        let hit = *window.state::<IslandState>().hit_area.lock().unwrap();
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            #[cfg(target_os = "macos")]
            mac::update_click_through(&w, hit);
            #[cfg(not(target_os = "macos"))]
            let _ = (w, hit);
        });
    });
}

/// Re-place the island and tell the frontend whenever displays change.
pub fn watch_screen_changes(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2_app_kit::NSApplicationDidChangeScreenParametersNotification;
        use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};
        use std::ptr::NonNull;

        let app = app.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            if let Some(window) = app.get_webview_window("main") {
                let size = *window.state::<IslandState>().size.lock().unwrap();
                if let Some((w, h)) = size {
                    place_island(&window, w, h);
                }
            }
            let _ = app.emit(GEOMETRY_EVENT, current_geometry());
        });
        let observer = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(NSApplicationDidChangeScreenParametersNotification),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        };
        // The observer lives for the whole process.
        std::mem::forget(observer);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

// ---- Commands (sync commands run on the main thread, which AppKit requires) ----

#[tauri::command]
pub fn get_notch_geometry() -> NotchGeometry {
    current_geometry()
}

#[tauri::command]
pub fn set_island_size(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    if !(width.is_finite() && height.is_finite()) || width < 1.0 || height < 1.0 || width > 2000.0 || height > 1200.0 {
        return Err(format!("invalid island size {width}x{height}"));
    }
    place_island(&window, width, height);
    Ok(())
}

/// The clickable part of the window: `width` × `height`, centred at the top.
#[tauri::command]
pub fn set_hit_area(window: WebviewWindow, width: f64, height: f64) {
    *window.state::<IslandState>().hit_area.lock().unwrap() = (width.max(0.0), height.max(0.0));
}

#[tauri::command]
pub fn focus_island(window: WebviewWindow) -> Result<(), String> {
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn release_focus() {
    #[cfg(target_os = "macos")]
    mac::release_focus(main_thread());
}

/// Debug aid: the window's actual AppKit frame (bottom-left origin), to verify placement.
#[tauri::command]
pub fn debug_window_frame(window: WebviewWindow) -> Option<[f64; 4]> {
    #[cfg(target_os = "macos")]
    {
        mac::window_frame(&window).map(|f| [f.origin.x, f.origin.y, f.size.width, f.size.height])
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        None
    }
}
