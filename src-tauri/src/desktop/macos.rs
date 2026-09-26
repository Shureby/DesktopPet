use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::geometry::CGRect;
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowLayer,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowNumber, kCGWindowOwnerPID,
};

use super::{Area, WindowRect};

const MIN_SIZE: f64 = 60.0;

/// Window bounds don't need Screen Recording permission (only titles do).
pub fn list(own_pid: u32, areas: &[Area]) -> Vec<WindowRect> {
    let Some(info) =
        copy_window_info(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)
    else {
        return Vec::new();
    };
    let info: CFArray<CFDictionary<CFString, CFType>> =
        unsafe { CFArray::wrap_under_get_rule(info.as_concrete_TypeRef()) };
    let mut out = Vec::new();
    // CGWindowList is ordered front-to-back already.
    for dict in info.iter() {
        let num = |key| unsafe { dict.find(CFString::wrap_under_get_rule(key)) }.and_then(|v| v.downcast::<CFNumber>());
        // Layer 0 is normal app windows; the menu bar, dock and overlays live on other layers.
        if num(unsafe { kCGWindowLayer }).and_then(|n| n.to_i32()) != Some(0) {
            continue;
        }
        if num(unsafe { kCGWindowOwnerPID }).and_then(|n| n.to_i64()) == Some(own_pid as i64) {
            continue;
        }
        if num(unsafe { kCGWindowAlpha }).and_then(|n| n.to_f64()).is_some_and(|a| a <= 0.01) {
            continue;
        }
        let Some(bounds) = (unsafe { dict.find(CFString::wrap_under_get_rule(kCGWindowBounds)) })
            .and_then(|v| v.downcast::<CFDictionary>())
            .and_then(|d| CGRect::from_dict_representation(&d))
        else {
            continue;
        };
        if bounds.size.width < MIN_SIZE || bounds.size.height < MIN_SIZE {
            continue;
        }
        let id = num(unsafe { kCGWindowNumber }).and_then(|n| n.to_i64()).unwrap_or_default();
        // Bounds are in points; Tauri monitor rects are points × that monitor's scale.
        let (cx, cy) = (bounds.origin.x + bounds.size.width / 2.0, bounds.origin.y + bounds.size.height / 2.0);
        let scale = areas
            .iter()
            .find(|a| {
                let (x, y, w, h) = (a.rect.x / a.scale, a.rect.y / a.scale, a.rect.w / a.scale, a.rect.h / a.scale);
                cx >= x && cx < x + w && cy >= y - 40.0 && cy < y + h
            })
            .map_or(1.0, |a| a.scale);
        out.push(WindowRect {
            id: id.to_string(),
            x: bounds.origin.x * scale,
            y: bounds.origin.y * scale,
            w: bounds.size.width * scale,
            h: bounds.size.height * scale,
        });
    }
    out
}
