//! Menu bar item: the always-available way to hide the island or quit.

use tauri::{
    AppHandle, Manager,
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Hide Island", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit NotchBeat", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(app, &[&toggle, &PredefinedMenuItem::separator(app)?, &quit])?;

    let icon = Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("NotchBeat")
        .menu(&menu)
        .on_menu_event(move |app, event| {
            let Some(window) = app.get_webview_window("main") else { return };
            match event.id.as_ref() {
                "toggle" => {
                    if window.is_visible().unwrap_or(true) {
                        let _ = window.hide();
                        let _ = toggle.set_text("Show Island");
                    } else {
                        crate::display::show_island(&window);
                        let _ = toggle.set_text("Hide Island");
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}
