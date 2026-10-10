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

// --- Stepping aside (src-tauri/src/avoid.rs) --------------------------------------------

use std::ffi::c_void;

use core_graphics::display::CGDisplay;
use core_graphics::window::kCGWindowOwnerName;

use super::Busy;

/// Apps whose full-screen window is a slide show.
const PRESENTERS: &[&str] = &["Keynote", "Microsoft PowerPoint"];

/// What you're doing on the pet's screen (`pet` is a point on it, in points).
pub fn busy(own_pid: u32, pet: (f64, f64)) -> Busy {
    let mut b = Busy::default();
    if let Some(owner) = fullscreen_front(own_pid, pet) {
        b.fullscreen = true;
        b.presenting = PRESENTERS.contains(&owner.as_str());
    }
    b.call = camera_in_use() || microphone_in_use();
    b
}

/// The frontmost app window on the pet's screen covers all of it (menu bar too): a full-screen
/// app, a video, a slide show. Zoomed windows leave the menu bar, so they don't count.
/// Returns the app's name.
fn fullscreen_front(own_pid: u32, pet: (f64, f64)) -> Option<String> {
    let screen = CGDisplay::active_displays().ok()?.into_iter().map(|id| CGDisplay::new(id).bounds()).find(|r| {
        pet.0 >= r.origin.x
            && pet.0 < r.origin.x + r.size.width
            && pet.1 >= r.origin.y
            && pet.1 < r.origin.y + r.size.height
    })?;
    let info =
        copy_window_info(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)?;
    let info: CFArray<CFDictionary<CFString, CFType>> =
        unsafe { CFArray::wrap_under_get_rule(info.as_concrete_TypeRef()) };
    for dict in info.iter() {
        let num = |key| unsafe { dict.find(CFString::wrap_under_get_rule(key)) }.and_then(|v| v.downcast::<CFNumber>());
        if num(unsafe { kCGWindowLayer }).and_then(|n| n.to_i32()) != Some(0)
            || num(unsafe { kCGWindowAlpha }).and_then(|n| n.to_f64()).is_some_and(|a| a <= 0.01)
        {
            continue;
        }
        let Some(r) = (unsafe { dict.find(CFString::wrap_under_get_rule(kCGWindowBounds)) })
            .and_then(|v| v.downcast::<CFDictionary>())
            .and_then(|d| CGRect::from_dict_representation(&d))
        else {
            continue;
        };
        let (cx, cy) = (r.origin.x + r.size.width / 2.0, r.origin.y + r.size.height / 2.0);
        let on_screen = cx >= screen.origin.x
            && cx < screen.origin.x + screen.size.width
            && cy >= screen.origin.y
            && cy < screen.origin.y + screen.size.height;
        if !on_screen {
            continue;
        }
        // The frontmost window on that screen decides (ours are skipped: the pet, the panel).
        if num(unsafe { kCGWindowOwnerPID }).and_then(|n| n.to_i64()) == Some(own_pid as i64) {
            continue;
        }
        let covers = r.origin.x <= screen.origin.x
            && r.origin.y <= screen.origin.y
            && r.origin.x + r.size.width >= screen.origin.x + screen.size.width
            && r.origin.y + r.size.height >= screen.origin.y + screen.size.height;
        if !covers {
            return None;
        }
        let owner = unsafe { dict.find(CFString::wrap_under_get_rule(kCGWindowOwnerName)) }
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string())
            .unwrap_or_default();
        return Some(owner);
    }
    None
}

// CoreMediaIO and CoreAudio: whether a camera, or the microphone, is running "somewhere"
// (in any app) — what the menu bar's green and orange dots show.

#[repr(C)]
struct PropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

const fn fourcc(s: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*s)
}

const SYSTEM_OBJECT: u32 = 1;
const SCOPE_GLOBAL: u32 = fourcc(b"glob");
const ELEMENT_MAIN: u32 = 0;
const IS_RUNNING_SOMEWHERE: u32 = fourcc(b"gone");
const CMIO_DEVICES: u32 = fourcc(b"dev#");
const AUDIO_DEFAULT_INPUT: u32 = fourcc(b"dIn ");

#[link(name = "CoreMediaIO", kind = "framework")]
extern "C" {
    fn CMIOObjectGetPropertyDataSize(
        object: u32,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
    ) -> i32;
    fn CMIOObjectGetPropertyData(
        object: u32,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: u32,
        used: *mut u32,
        data: *mut c_void,
    ) -> i32;
}

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyData(
        object: u32,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> i32;
}

fn global(selector: u32) -> PropertyAddress {
    PropertyAddress { selector, scope: SCOPE_GLOBAL, element: ELEMENT_MAIN }
}

fn camera_in_use() -> bool {
    unsafe {
        let devices = global(CMIO_DEVICES);
        let mut size = 0u32;
        if CMIOObjectGetPropertyDataSize(SYSTEM_OBJECT, &devices, 0, std::ptr::null(), &mut size) != 0 || size == 0 {
            return false;
        }
        let mut ids = vec![0u32; size as usize / size_of::<u32>()];
        let mut used = 0u32;
        if CMIOObjectGetPropertyData(
            SYSTEM_OBJECT,
            &devices,
            0,
            std::ptr::null(),
            size,
            &mut used,
            ids.as_mut_ptr() as *mut c_void,
        ) != 0
        {
            return false;
        }
        ids.truncate(used as usize / size_of::<u32>());
        let running = global(IS_RUNNING_SOMEWHERE);
        ids.into_iter().any(|id| {
            let mut on = 0u32;
            let mut used = 0u32;
            CMIOObjectGetPropertyData(
                id,
                &running,
                0,
                std::ptr::null(),
                size_of::<u32>() as u32,
                &mut used,
                &mut on as *mut u32 as *mut c_void,
            ) == 0
                && on != 0
        })
    }
}

fn microphone_in_use() -> bool {
    unsafe {
        let mut device = 0u32;
        let mut size = size_of::<u32>() as u32;
        if AudioObjectGetPropertyData(
            SYSTEM_OBJECT,
            &global(AUDIO_DEFAULT_INPUT),
            0,
            std::ptr::null(),
            &mut size,
            &mut device as *mut u32 as *mut c_void,
        ) != 0
            || device == 0
        {
            return false;
        }
        let mut on = 0u32;
        let mut size = size_of::<u32>() as u32;
        AudioObjectGetPropertyData(
            device,
            &global(IS_RUNNING_SOMEWHERE),
            0,
            std::ptr::null(),
            &mut size,
            &mut on as *mut u32 as *mut c_void,
        ) == 0
            && on != 0
    }
}
