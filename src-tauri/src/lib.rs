mod audio;
mod display;
mod spotify;
mod tray;

use tauri::Manager;

/// Compact island size used before the frontend reports its own layout.
const INITIAL_SIZE: (f64, f64) = (420.0, 32.0);

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Dev-only: `NOTCHBEAT_DEMO=island|game` makes the frontend animate by itself,
/// so animation smoothness can be recorded and measured.
#[tauri::command]
fn demo_mode() -> Option<String> {
    std::env::var("NOTCHBEAT_DEMO").ok()
}

/// Dev-only: frame-timing lines from demo mode, printed to stdout.
#[tauri::command]
fn demo_log(line: String) {
    if std::env::var_os("NOTCHBEAT_DEMO").is_some() {
        println!("[demo] {line}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Never take focus from the app the user is in when NotchBeat launches.
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    builder
        .manage(display::IslandState::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let window = app.get_webview_window("main").expect("main window is declared in tauri.conf.json");
            display::init_window(&window, INITIAL_SIZE.0, INITIAL_SIZE.1);
            display::watch_screen_changes(app.handle());
            display::track_click_through(app.handle());
            tray::install(app.handle())?;
            spotify::start(app.handle());
            audio::service::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            demo_mode,
            demo_log,
            display::get_notch_geometry,
            display::set_island_size,
            display::focus_island,
            display::set_hit_area,
            display::release_focus,
            display::debug_window_frame,
            spotify::spotify_snapshot,
            spotify::spotify_connect,
            spotify::spotify_control,
            audio::service::audio_status,
            audio::service::audio_set_enabled,
            audio::service::audio_new_song,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NotchBeat");
}
