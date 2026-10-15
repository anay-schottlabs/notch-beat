//! Spotify integration for macOS.
//!
//! Two sources, chosen to avoid surprise permission prompts:
//!
//! 1. Spotify posts `com.spotify.client.PlaybackStateChanged` distributed
//!    notifications whenever the track or play state changes. Observing them
//!    needs no permission, so this is the passive, launch-time source.
//! 2. Spotify's AppleScript dictionary (Apple Events) for the initial state, artwork
//!    and transport controls. macOS asks the user before the first Apple Event,
//!    so we only send one if permission is already granted, or when the user
//!    explicitly presses a control / "Connect".
//!
//! Neither source provides audio samples.

use std::{
    process::Command,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const STATE_EVENT: &str = "spotify-state";
const BUNDLE_ID: &str = "com.spotify.client";
const FIELD_SEP: char = '\u{1f}';

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PlayerState {
    Playing,
    Paused,
    Stopped,
    #[default]
    Unknown,
}

impl PlayerState {
    fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "playing" => Self::Playing,
            "paused" => Self::Paused,
            "stopped" => Self::Stopped,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Granted,
    Denied,
    NotDetermined,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: Option<f64>,
    pub artwork_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpotifySnapshot {
    pub installed: bool,
    pub running: bool,
    pub state: PlayerState,
    pub track: Option<Track>,
    pub permission: Permission,
    /// Last integration error, for display; never fatal.
    pub error: Option<String>,
}

#[derive(Default)]
pub struct SpotifyService {
    snapshot: Mutex<SpotifySnapshot>,
}

impl SpotifyService {
    fn update(&self, app: &AppHandle, f: impl FnOnce(&mut SpotifySnapshot)) {
        let changed = {
            let mut snap = self.snapshot.lock().unwrap();
            let before = snap.clone();
            f(&mut snap);
            (*snap != before).then(|| snap.clone())
        };
        if let Some(snap) = changed {
            let _ = app.emit(STATE_EVENT, snap);
        }
    }

    pub fn snapshot(&self) -> SpotifySnapshot {
        self.snapshot.lock().unwrap().clone()
    }
}

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod mac {
    use super::Permission;
    use objc2_app_kit::{NSRunningApplication, NSWorkspace};
    use objc2_foundation::NSString;
    use std::ffi::c_void;

    pub fn is_installed(bundle_id: &str) -> bool {
        NSWorkspace::sharedWorkspace()
            .URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))
            .is_some()
    }

    pub fn is_running(bundle_id: &str) -> bool {
        NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id))
            .count()
            > 0
    }

    #[repr(C)]
    struct AEDesc {
        descriptor_type: u32,
        data_handle: *mut c_void,
    }

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn AECreateDesc(type_code: u32, data: *const c_void, size: isize, result: *mut AEDesc) -> i16;
        fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
        fn AEDeterminePermissionToAutomateTarget(
            target: *const AEDesc,
            event_class: u32,
            event_id: u32,
            ask_user_if_needed: u8,
        ) -> i32;
    }

    const TYPE_APPLICATION_BUNDLE_ID: u32 = u32::from_be_bytes(*b"bund");
    const TYPE_WILDCARD: u32 = u32::from_be_bytes(*b"****");

    /// Query Automation permission for `bundle_id` without ever prompting.
    pub fn automation_permission(bundle_id: &str) -> Permission {
        let mut desc = AEDesc { descriptor_type: 0, data_handle: std::ptr::null_mut() };
        let bytes = bundle_id.as_bytes();
        unsafe {
            if AECreateDesc(TYPE_APPLICATION_BUNDLE_ID, bytes.as_ptr().cast(), bytes.len() as isize, &mut desc) != 0 {
                return Permission::Unknown;
            }
            let status = AEDeterminePermissionToAutomateTarget(&desc, TYPE_WILDCARD, TYPE_WILDCARD, 0);
            AEDisposeDesc(&mut desc);
            match status {
                0 => Permission::Granted,
                -1743 => Permission::Denied,        // errAEEventNotPermitted
                -1744 => Permission::NotDetermined, // errAEEventWouldRequireUserConsent
                _ => Permission::Unknown,           // e.g. procNotFound (-600) when not running
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use super::Permission;
    pub fn is_installed(_: &str) -> bool { false }
    pub fn is_running(_: &str) -> bool { false }
    pub fn automation_permission(_: &str) -> Permission { Permission::Unknown }
}

// ---------------------------------------------------------------------------
// AppleScript
// ---------------------------------------------------------------------------

fn run_applescript(source: &str) -> Result<String, String> {
    let out = Command::new("/usr/bin/osascript")
        .args(["-e", source])
        .output()
        .map_err(|e| format!("osascript failed to start: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("-1743") {
            Err("Automation permission for Spotify was denied".into())
        } else {
            Err(err.trim().to_string())
        }
    }
}

/// Fetch the full state. Guarded so it never launches Spotify.
fn fetch_state_via_applescript() -> Result<(PlayerState, Option<Track>), String> {
    let script = format!(
        r#"if application id "{BUNDLE_ID}" is not running then return "notrunning"
tell application id "{BUNDLE_ID}"
  set s to (player state as string)
  if s is "stopped" then return s
  set t to current track
  set sep to (ASCII character 31)
  return s & sep & (id of t) & sep & (name of t) & sep & (artist of t) & sep & (album of t) & sep & (duration of t) & sep & (artwork url of t)
end tell"#
    );
    let out = run_applescript(&script)?;
    if out == "notrunning" {
        return Ok((PlayerState::Stopped, None));
    }
    let parts: Vec<&str> = out.split(FIELD_SEP).collect();
    let state = PlayerState::parse(parts[0]);
    if parts.len() < 7 {
        return Ok((state, None));
    }
    Ok((
        state,
        Some(Track {
            id: parts[1].into(),
            title: parts[2].into(),
            artist: parts[3].into(),
            album: parts[4].into(),
            duration_ms: parts[5].trim().parse().ok(),
            artwork_url: Some(parts[6].trim().to_string()).filter(|u| u.starts_with("https://")),
        }),
    ))
}

fn refresh_via_applescript(app: &AppHandle) {
    let service = app.state::<Arc<SpotifyService>>();
    match fetch_state_via_applescript() {
        Ok((state, track)) => service.update(app, |s| {
            s.state = state;
            // Keep artwork if the notification-sourced track is the same one.
            s.track = track;
            s.permission = Permission::Granted;
            s.error = None;
        }),
        Err(e) => {
            // A denial shows up in the script error itself; otherwise ask, but never wait forever.
            let permission = if e.contains("denied") { Some(Permission::Denied) } else { permission_with_deadline(Duration::from_millis(800)) };
            service.update(app, |s| {
                s.error = Some(e);
                if let Some(p) = permission {
                    s.permission = p;
                }
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

pub fn start(app: &AppHandle) {
    let service = Arc::new(SpotifyService::default());
    app.manage(service.clone());

    observe_notifications(app);

    // Cheap 2 s presence poll: running state + permission. No Apple Events unless granted.
    let app = app.clone();
    thread::spawn(move || {
        let mut was_running = false;
        loop {
            let installed = mac::is_installed(BUNDLE_ID);
            let running = installed && mac::is_running(BUNDLE_ID);
            service.update(&app, |s| {
                s.installed = installed;
                s.running = running;
                if !running {
                    s.state = PlayerState::Stopped;
                    s.track = None;
                }
            });
            // The silent permission query can block indefinitely, so it never runs on this
            // loop: it gets its own thread and a deadline, and the last answer is kept.
            let permission = if running { permission_with_deadline(Duration::from_millis(800)) } else { None };
            if let Some(p) = permission {
                service.update(&app, |s| s.permission = p);
            }
            let permission = service.snapshot().permission;
            if running && !was_running && permission == Permission::Granted {
                refresh_via_applescript(&app);
            }
            was_running = running;
            thread::sleep(Duration::from_secs(2));
        }
    });
}

/// `AEDeterminePermissionToAutomateTarget` with a deadline. It has been seen to never
/// return, so it runs on a helper thread; while one query is still stuck, no new one
/// starts (None = no answer in time).
fn permission_with_deadline(deadline: Duration) -> Option<Permission> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
    if IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(mac::automation_permission(BUNDLE_ID));
        IN_FLIGHT.store(false, Ordering::Release);
    });
    rx.recv_timeout(deadline).ok()
}

#[cfg(target_os = "macos")]
fn observe_notifications(app: &AppHandle) {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_foundation::{
        NSDistributedNotificationCenter, NSNotification, NSNumber, NSOperationQueue, NSString,
    };
    use std::ptr::NonNull;

    let app = app.clone();
    let block = RcBlock::new(move |note: NonNull<NSNotification>| {
        let note = unsafe { note.as_ref() };
        let Some(info) = note.userInfo() else { return };
        let get = |key: &str| info.objectForKey(&NSString::from_str(key));
        let string = |key: &str| {
            get(key)
                .and_then(|o| o.downcast::<NSString>().ok())
                .map(|s: Retained<NSString>| s.to_string())
                .unwrap_or_default()
        };
        let number = |key: &str| get(key).and_then(|o| o.downcast::<NSNumber>().ok()).map(|n| n.as_f64());

        let state = PlayerState::parse(&string("Player State"));
        let id = string("Track ID");
        let track = (!id.is_empty()).then(|| Track {
            id,
            title: string("Name"),
            artist: string("Artist"),
            album: string("Album"),
            duration_ms: number("Duration"),
            artwork_url: None,
        });

        let service = app.state::<Arc<SpotifyService>>();
        let mut needs_artwork = false;
        service.update(&app, |s| {
            s.running = true;
            s.state = state;
            match (&mut s.track, track) {
                // Same track: keep the artwork we already fetched.
                (Some(old), Some(new)) if old.id == new.id => {}
                (slot, new) => {
                    needs_artwork = new.is_some();
                    *slot = new;
                }
            }
        });
        if needs_artwork && service.snapshot().permission == Permission::Granted {
            let app = app.clone();
            thread::spawn(move || refresh_via_applescript(&app));
        }
    });

    let observer = unsafe {
        NSDistributedNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(&NSString::from_str("com.spotify.client.PlaybackStateChanged")),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    };
    std::mem::forget(observer);
}

#[cfg(not(target_os = "macos"))]
fn observe_notifications(_: &AppHandle) {}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpotifyCommand {
    PlayPause,
    Play,
    Pause,
    Next,
    Previous,
    /// Back to the start of the current track, playing.
    Restart,
}

#[tauri::command]
pub fn spotify_snapshot(service: tauri::State<'_, Arc<SpotifyService>>) -> SpotifySnapshot {
    service.snapshot()
}

/// User-initiated: may trigger the one-time macOS Automation prompt.
#[tauri::command(async)]
pub fn spotify_connect(app: AppHandle) -> SpotifySnapshot {
    refresh_via_applescript(&app);
    app.state::<Arc<SpotifyService>>().snapshot()
}

#[tauri::command(async)]
pub fn spotify_control(app: AppHandle, command: SpotifyCommand) -> Result<(), String> {
    if !mac::is_running(BUNDLE_ID) {
        return Err("Spotify is not running".into());
    }
    let verb = match command {
        SpotifyCommand::PlayPause => "playpause",
        SpotifyCommand::Play => "play",
        SpotifyCommand::Pause => "pause",
        SpotifyCommand::Next => "next track",
        SpotifyCommand::Previous => "previous track",
        SpotifyCommand::Restart => "set player position to 0\n  play",
    };
    let result = run_applescript(&format!("tell application id \"{BUNDLE_ID}\"\n  {verb}\nend tell"));
    // Notifications usually follow, but refresh to pick up artwork and to
    // record a fresh permission grant.
    refresh_via_applescript(&app);
    result.map(|_| ())
}
