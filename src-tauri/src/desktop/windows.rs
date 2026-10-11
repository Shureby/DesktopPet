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

// --- Stepping aside (src-tauri/src/avoid.rs) --------------------------------------------

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{ERROR_SUCCESS, POINT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_QWORD,
};
use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN};
use windows::Win32::UI::WindowsAndMessaging::{IsZoomed, GWL_STYLE, WS_CAPTION, WS_EX_TRANSPARENT};

use super::Busy;

/// What you're doing on the pet's screen (`pet` is a point on it, physical pixels).
pub fn busy(own_pid: u32, pet: (i32, i32)) -> Busy {
    let mut b = Busy::default();
    unsafe {
        // Windows' own "don't disturb" states: a full-screen Direct3D game or presentation
        // mode (PowerPoint and "presentation settings"), wherever they are.
        match SHQueryUserNotificationState() {
            Ok(QUNS_RUNNING_D3D_FULL_SCREEN) => b.fullscreen = true,
            Ok(QUNS_PRESENTATION_MODE) => b.presenting = true,
            _ => {}
        }
        if let Some(class) = fullscreen_front(own_pid, pet) {
            b.fullscreen = true;
            // A PowerPoint slide show.
            if class == "screenClass" {
                b.presenting = true;
            }
        }
    }
    b.call = in_use("webcam") || in_use("microphone");
    b
}

/// The frontmost app window on the pet's screen covers all of it (taskbar too): a game, a
/// video, a browser on F11, a slide show. Walks the windows front to back (super::fullscreen_front)
/// rather than asking which has the focus. Returns its class.
unsafe fn fullscreen_front(own_pid: u32, pet: (i32, i32)) -> Option<String> {
    let pet_screen = MonitorFromPoint(POINT { x: pet.0, y: pet.1 }, MONITOR_DEFAULTTONEAREST);
    let mut ctx = Layers { own_pid, pet_screen, out: Vec::new() };
    // EnumWindows walks top-level windows in z-order, topmost first.
    let _ = EnumWindows(Some(visit_layer), LPARAM(&mut ctx as *mut Layers as isize));
    super::fullscreen_front(ctx.out)
}

struct Layers {
    own_pid: u32,
    pet_screen: windows::Win32::Graphics::Gdi::HMONITOR,
    out: Vec<super::Layer>,
}

unsafe extern "system" fn visit_layer(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut Layers);
    if let Some(layer) = layer(hwnd, ctx) {
        let stop = !layer.own && !layer.shell && layer.on_pet_screen;
        ctx.out.push(layer);
        // The first app window on the pet's screen decides: no need to look further.
        if stop {
            return BOOL(0);
        }
    }
    BOOL(1)
}

/// A window that could be in front of the pet's screen; none for hidden, minimized, cloaked
/// (other virtual desktops, suspended Store apps), untitled, click-through and tool windows
/// (overlays, tooltips).
unsafe fn layer(hwnd: HWND, ctx: &Layers) -> Option<super::Layer> {
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
        return None;
    }
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex & (WS_EX_TOOLWINDOW.0 | WS_EX_TRANSPARENT.0) != 0 {
        return None;
    }
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, size_of::<u32>() as u32)
        .is_ok()
        && cloaked != 0
    {
        return None;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let mut class = [0u16; 64];
    let len = GetClassNameW(hwnd, &mut class) as usize;
    let class = String::from_utf16_lossy(&class[..len]);
    let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    let mut r = RECT::default();
    if !GetMonitorInfoW(monitor, &mut info).as_bool() || GetWindowRect(hwnd, &mut r).is_err() {
        return None;
    }
    let m = info.rcMonitor;
    let titled = (GetWindowLongW(hwnd, GWL_STYLE) as u32) & WS_CAPTION.0 == WS_CAPTION.0;
    Some(super::Layer {
        own: pid == ctx.own_pid,
        shell: IGNORED_CLASSES.contains(&class.as_str()),
        on_pet_screen: monitor == ctx.pet_screen,
        covers: r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom,
        maximized: IsZoomed(hwnd).as_bool() && titled,
        class,
    })
}

/// Some app is using the camera or the microphone now. Windows keeps who used them when
/// (Settings → Privacy, "recent activity"): an app still using one has no stop time yet.
fn in_use(device: &str) -> bool {
    let path: Vec<u16> =
        format!("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\{device}")
            .encode_utf16()
            .chain([0])
            .collect();
    unsafe {
        let Some(store) = open(HKEY_CURRENT_USER, PCWSTR(path.as_ptr())) else {
            return false;
        };
        // Store apps are subkeys of the device's key; desktop apps are under "NonPackaged".
        let mut using = any_in_use(store);
        if let Some(desktop) = open(store, w!("NonPackaged")) {
            using = using || any_in_use(desktop);
            let _ = RegCloseKey(desktop);
        }
        let _ = RegCloseKey(store);
        using
    }
}

unsafe fn open(parent: HKEY, path: PCWSTR) -> Option<HKEY> {
    let mut key = HKEY::default();
    (RegOpenKeyExW(parent, path, None, KEY_READ, &mut key) == ERROR_SUCCESS).then_some(key)
}

unsafe fn any_in_use(key: HKEY) -> bool {
    let mut i = 0;
    loop {
        let mut name = [0u16; 512];
        let mut len = name.len() as u32;
        if RegEnumKeyExW(key, i, Some(windows::core::PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None)
            != ERROR_SUCCESS
        {
            return false;
        }
        i += 1;
        let qword = |value: PCWSTR| {
            let mut v = 0u64;
            let mut size = size_of::<u64>() as u32;
            (RegGetValueW(
                key,
                PCWSTR(name.as_ptr()),
                value,
                RRF_RT_QWORD,
                None,
                Some(&mut v as *mut u64 as *mut c_void),
                Some(&mut size),
            ) == ERROR_SUCCESS)
                .then_some(v)
        };
        if qword(w!("LastUsedTimeStart")).is_some_and(|t| t > 0) && qword(w!("LastUsedTimeStop")) == Some(0) {
            return true;
        }
    }
}
