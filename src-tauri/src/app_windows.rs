//! The pet, panel and game windows.

use serde::Serialize;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::state::AppState;

pub const PET: &str = "pet";
pub const PANEL: &str = "panel";
pub const GAME: &str = "game";

#[derive(Clone, Serialize)]
pub struct GameEvent<'a> {
    pub state: &'a str,
    pub game: &'a str,
}

pub fn product_name<R: Runtime>(app: &AppHandle<R>) -> String {
    app.config().product_name.clone().unwrap_or_else(|| "Desktop Pet".into())
}

pub fn open_panel<R: Runtime>(app: &AppHandle<R>, tab: Option<&str>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(PANEL) {
        w.show()?;
        w.unminimize()?;
        w.set_focus()?;
        if let Some(tab) = tab {
            app.emit_to(PANEL, "panel-tab", tab)?;
        }
        return Ok(());
    }
    let url = match tab {
        Some(t) => format!("panel.html#{t}"),
        None => "panel.html".into(),
    };
    WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App(url.into()))
        .title(product_name(app))
        .inner_size(460.0, 640.0)
        .min_inner_size(380.0, 420.0)
        .center()
        .build()?;
    Ok(())
}

/// Opens a mini-game as a transparent overlay over the work area the pet is on.
pub fn open_game<R: Runtime>(app: &AppHandle<R>, game: &str) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(GAME) {
        w.destroy()?;
    }
    let pet = app.get_webview_window(PET);
    let monitor = match &pet {
        Some(p) => p.current_monitor()?,
        None => None,
    }
    .or(app.primary_monitor()?);
    let mut builder = WebviewWindowBuilder::new(app, GAME, WebviewUrl::App(format!("game.html#{game}").into()))
        .title(product_name(app))
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(true);
    if let Some(m) = monitor {
        let wa = m.work_area();
        let s = m.scale_factor();
        builder = builder
            .position(wa.position.x as f64 / s, wa.position.y as f64 / s)
            .inner_size(wa.size.width as f64 / s, wa.size.height as f64 / s);
    } else {
        builder = builder.inner_size(1280.0, 720.0).center();
    }
    let window = builder.build()?;
    window.set_focus()?;
    app.emit("game", GameEvent { state: "started", game })?;
    Ok(())
}

pub fn close_game<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(GAME) {
        // The Destroyed window event announces that the game ended.
        w.destroy()?;
    }
    Ok(())
}

/// Shows or hides the pet and announces it ("pet-visibility"), so the tray menu can offer
/// the opposite. Showing it also makes the pet say hello.
pub fn set_pet_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    state.pet_hidden.store(!visible, Ordering::Relaxed);
    // Shown while out for a reminder: it stays out.
    state.peeking.store(false, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window(PET) {
        if visible {
            w.show()?;
            app.emit_to(PET, "pet-command", "greet")?;
        } else {
            w.hide()?;
        }
        app.emit("pet-visibility", visible)?;
    }
    Ok(())
}

/// The hidden pet comes out for a reminder: the window is shown natively (the hidden
/// window's script may be throttled), without announcing a visibility change, so the tray
/// still offers "Show pet". Returns whether the pet is hidden (and so now peeking).
pub fn peek<R: Runtime>(app: &AppHandle<R>) -> bool {
    let state = app.state::<AppState>();
    if !state.pet_hidden.load(Ordering::Relaxed) {
        return false;
    }
    if !state.peeking.swap(true, Ordering::Relaxed) {
        if let Some(w) = app.get_webview_window(PET) {
            if let Err(e) = w.show() {
                log::warn!("could not show the pet for a reminder: {e}");
            }
        }
    }
    true
}

/// The reminder is answered and the pet has walked off: hide it again, unless the user
/// showed it meanwhile.
pub fn end_peek<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    if state.peeking.swap(false, Ordering::Relaxed) && state.pet_hidden.load(Ordering::Relaxed) {
        if let Some(w) = app.get_webview_window(PET) {
            w.hide()?;
        }
    }
    Ok(())
}
