use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};

use crate::app_windows::{self, product_name};

/// Creates the tray icon. The pet window replaces this menu with the full one, built from
/// the same definition as the pet's right-click menu (src/pet/menu.ts), so both always
/// match. This minimal menu only shows until then, or if the pet window fails to load.
///
/// The full menu reuses the ids handled below for show/hide, the panel and Quit, so those
/// never depend on the pet window's script; its other items run their actions there.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let menu = Menu::with_items(
        app,
        &[
            &item("show", "Show pet")?,
            &PredefinedMenuItem::separator(app)?,
            &item("panel", "Open panel…")?,
            &PredefinedMenuItem::separator(app)?,
            &item("quit", "Quit")?,
        ],
    )?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(product_name(app))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                "show" => app_windows::set_pet_visible(app, true),
                "hide" => app_windows::set_pet_visible(app, false),
                "panel" => app_windows::open_panel(app, None),
                "quit" => {
                    app.exit(0);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(e) = result {
                log::error!("tray action failed: {e}");
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
