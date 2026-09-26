use std::ffi::c_void;
use std::mem::size_of;

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

use super::WindowRect;

/// Shell windows that cover the desktop or sit on the taskbar; never platforms.
const IGNORED_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];
const MIN_SIZE: i32 = 60;

struct Ctx {
    own_pid: u32,
    out: Vec<WindowRect>,
}

pub fn list(own_pid: u32) -> Vec<WindowRect> {
    let mut ctx = Ctx { own_pid, out: Vec::new() };
    // EnumWindows walks top-level windows in z-order, topmost first.
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.out
}

unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut Ctx);
    if let Some(rect) = platform_rect(hwnd, ctx.own_pid) {
        ctx.out.push(rect);
    }
    BOOL(1)
}

unsafe fn platform_rect(hwnd: HWND, own_pid: u32) -> Option<WindowRect> {
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
        return None;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == own_pid {
        return None;
    }
    if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0 {
        return None;
    }
    // UWP apps and windows on other virtual desktops are "cloaked" but still report visible.
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, size_of::<u32>() as u32)
        .is_ok()
        && cloaked != 0
    {
        return None;
    }
    let mut class = [0u16; 64];
    let len = GetClassNameW(hwnd, &mut class) as usize;
    let class = String::from_utf16_lossy(&class[..len]);
    if IGNORED_CLASSES.contains(&class.as_str()) {
        return None;
    }
    // Extended frame bounds exclude the invisible resize borders of Windows 10/11.
    let mut r = RECT::default();
    let ok = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut r as *mut RECT as *mut c_void,
        size_of::<RECT>() as u32,
    )
    .is_ok()
        || GetWindowRect(hwnd, &mut r).is_ok();
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    if !ok || w < MIN_SIZE || h < MIN_SIZE {
        return None;
    }
    Some(WindowRect {
        id: format!("{:x}", hwnd.0 as usize),
        x: r.left as f64,
        y: r.top as f64,
        w: w as f64,
        h: h as f64,
    })
}
