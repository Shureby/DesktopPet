use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::app_windows::{self, product_name};
use crate::state::{now_ms, AppState};

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let menu = Menu::with_items(
        app,
        &[
            &item("toggle", "Show / hide pet")?,
            &item("panel", "Open panel…")?,
            &PredefinedMenuItem::separator(app)?,
            &item("focus", "Start focus session 🍅")?,
            &item("game", "Play Safe Landing")?,
            &item("characters", "Switch character…")?,
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
                "toggle" => app_windows::toggle_pet(app),
                "panel" => app_windows::open_panel(app, None),
                "characters" => app_windows::open_panel(app, Some("characters")),
                "game" => app_windows::open_game(app, "safe-landing"),
                "focus" => start_focus(app),
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

fn start_focus<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let status = crate::commands::start_pomodoro(&state, now_ms()).map_err(std::io::Error::other)?;
    app.emit("pomodoro", status)
}
