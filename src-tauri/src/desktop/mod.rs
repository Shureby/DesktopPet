//! What the pet can stand on: monitor work areas and other apps' windows.
//! All coordinates are physical pixels in the global desktop space.

use serde::Serialize;
use tauri::{Monitor, Runtime, WebviewWindow};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowRect {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesktopSnapshot {
    pub areas: Vec<Rect>,
    /// Front-to-back z-order.
    pub windows: Vec<WindowRect>,
    pub scale: f64,
}

/// A monitor's work area plus its scale factor (needed to convert macOS points).
#[derive(Debug, Clone, Copy)]
pub struct Area {
    pub rect: Rect,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub scale: f64,
}

fn area(m: &Monitor) -> Area {
    let wa = m.work_area();
    Area {
        rect: Rect {
            x: wa.position.x as f64,
            y: wa.position.y as f64,
            w: wa.size.width as f64,
            h: wa.size.height as f64,
        },
        scale: m.scale_factor(),
    }
}

pub fn snapshot<R: Runtime>(pet: &WebviewWindow<R>) -> tauri::Result<DesktopSnapshot> {
    let areas: Vec<Area> = pet.available_monitors()?.iter().map(area).collect();
    let scale = pet.scale_factor()?;
    Ok(DesktopSnapshot { windows: list_windows(&areas), areas: areas.iter().map(|a| a.rect).collect(), scale })
}

/// Other applications' visible windows, front-to-back, excluding our own.
fn list_windows(_areas: &[Area]) -> Vec<WindowRect> {
    #[cfg(windows)]
    return windows::list(std::process::id());
    #[cfg(target_os = "macos")]
    return macos::list(std::process::id(), _areas);
    #[allow(unreachable_code)]
    Vec::new()
}
