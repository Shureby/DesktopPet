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
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_QWORD,
};
use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN};
use windows::Win32::UI::WindowsAndMessaging::{IsZoomed, GWL_STYLE, WS_CAPTION, WS_EX_TRANSPARENT};

use super::Busy;

/// What you're doing (`screens` and `pet`, a point on its screen, in physical pixels), and
/// the screens showing a slide show.
pub fn busy(own_pid: u32, screens: &[super::Rect], pet: (f64, f64)) -> (Busy, Vec<super::Rect>) {
    let mut b = Busy::default();
    let mut ctx = Layers { own_pid, out: Vec::new() };
    unsafe {
        // EnumWindows walks top-level windows in z-order, topmost first.
        let _ = EnumWindows(Some(visit_layer), LPARAM(&mut ctx as *mut Layers as isize));
    }
    let scene = super::classify(&ctx.out, screens, super::screen_at(screens, pet));
    b.fullscreen = scene.fullscreen;
    b.presenting = !scene.slideshows.is_empty();
    // Windows' own "don't disturb" states: a full-screen Direct3D game or presentation mode
    // (PowerPoint, "presentation settings"), wherever they are.
    match unsafe { SHQueryUserNotificationState() } {
        Ok(QUNS_RUNNING_D3D_FULL_SCREEN) => b.fullscreen = true,
        Ok(QUNS_PRESENTATION_MODE) => b.presenting = true,
        _ => {}
    }
    let recording = recording_apps(own_pid);
    b.call = super::in_call(camera_in_use(own_pid), recording.iter().map(String::as_str));
    (b, scene.slideshows)
}

// --- In a call: the camera, and which apps use the microphone ------------------------------
//
// Windows 11 no longer keeps the privacy settings' "recent activity" up to date in the registry
// (ConsentStore's LastUsedTimeStop), which 0.38–0.41 read: the camera is watched with Media
// Foundation's sensor activity monitor instead, and the microphone's users are its recording
// sessions (only meeting apps count, see super::in_call).

use std::sync::{Mutex, OnceLock};

use windows::core::{implement, Interface, Ref};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::Media::MediaFoundation::{
    IMFSensorActivitiesReport, IMFSensorActivitiesReportCallback, IMFSensorActivitiesReportCallback_Impl,
    MFCreateSensorActivityMonitor, MFStartup, MFSTARTUP_LITE, MF_VERSION,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Each camera (its symbolic link) and whether another app streams from it now, as the sensor
/// activity monitor last reported (its first report can come before `start_camera_monitor`
/// returns, so this is ready beforehand).
static CAMERAS: Mutex<Vec<(String, bool)>> = Mutex::new(Vec::new());

/// Whether the sensor activity monitor runs (not before Windows 10 1703).
static MONITOR: OnceLock<bool> = OnceLock::new();

/// A camera is in use by another app.
fn camera_in_use(own_pid: u32) -> bool {
    if *MONITOR.get_or_init(|| start_camera_monitor(own_pid)) {
        CAMERAS.lock().map(|c| c.iter().any(|(_, on)| *on)).unwrap_or(false)
    } else {
        // No monitor: the privacy settings' record (Windows 10 still keeps it).
        in_use("webcam")
    }
}

#[implement(IMFSensorActivitiesReportCallback)]
struct CameraReports {
    own_pid: u32,
}

impl IMFSensorActivitiesReportCallback_Impl for CameraReports_Impl {
    /// Reports come when a camera starts or stops streaming for some app (one per camera).
    fn OnActivitiesReport(&self, reports: Ref<'_, IMFSensorActivitiesReport>) -> windows::core::Result<()> {
        let Some(reports) = reports.as_ref() else { return Ok(()) };
        unsafe {
            for i in 0..reports.GetCount()? {
                let report = reports.GetActivityReport(i)?;
                let mut link = [0u16; 512];
                let mut len = 0u32;
                report.GetSymbolicLink(&mut link, &mut len)?;
                let link = String::from_utf16_lossy(&link[..(len as usize).min(link.len())]);
                let mut streaming = false;
                for p in 0..report.GetProcessCount()? {
                    let activity = report.GetProcessActivity(p)?;
                    if activity.GetProcessId()? != self.own_pid && activity.GetStreamingState()?.as_bool() {
                        streaming = true;
                    }
                }
                if let Ok(mut c) = CAMERAS.lock() {
                    match c.iter_mut().find(|(l, _)| *l == link) {
                        Some(camera) => camera.1 = streaming,
                        None => c.push((link, streaming)),
                    }
                }
            }
        }
        Ok(())
    }
}

/// Starts watching the cameras (on a thread of its own, which keeps the monitor alive).
fn start_camera_monitor(own_pid: u32) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("camera-monitor".into())
        .spawn(move || unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let monitor = MFStartup(MF_VERSION, MFSTARTUP_LITE).and_then(|()| {
                let callback: IMFSensorActivitiesReportCallback = CameraReports { own_pid }.into();
                let monitor = MFCreateSensorActivityMonitor(&callback)?;
                monitor.Start()?;
                Ok(monitor)
            });
            let started = monitor.is_ok();
            if let Err(e) = &monitor {
                log::warn!("no camera activity monitor ({e}); the privacy settings' record is used");
            }
            let _ = tx.send(started);
            if started {
                // The monitor reports from Media Foundation's own threads for as long as it lives.
                loop {
                    std::thread::park();
                }
            }
        })
        .is_ok_and(|_| rx.recv().unwrap_or(false))
}

/// The apps (program files) recording from any microphone now, but this one.
fn recording_apps(own_pid: u32) -> Vec<String> {
    let mut apps = Vec::new();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(devices) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .and_then(|e| e.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE))
        else {
            return apps;
        };
        for d in 0..devices.GetCount().unwrap_or(0) {
            let Ok(sessions) = devices
                .Item(d)
                .and_then(|device| device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None))
                .and_then(|manager| manager.GetSessionEnumerator())
            else {
                continue;
            };
            for s in 0..sessions.GetCount().unwrap_or(0) {
                let Ok(session) = sessions.GetSession(s) else { continue };
                if session.GetState().ok() != Some(AudioSessionStateActive) {
                    continue;
                }
                let Ok(pid) = session.cast::<IAudioSessionControl2>().and_then(|c| c.GetProcessId()) else {
                    continue;
                };
                if pid != 0 && pid != own_pid {
                    if let Some(name) = program_file(pid) {
                        apps.push(name);
                    }
                }
            }
        }
    }
    apps
}

/// A process's program file ("C:\…\Zoom.exe").
unsafe fn program_file(pid: u32) -> Option<String> {
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len);
    let _ = CloseHandle(process);
    ok.ok()?;
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    // The file name only: a folder's name (…\Zoom\bin\) isn't the app.
    Some(path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string())
}

/// A PowerPoint slide show (its presenter view is another window).
const SLIDESHOW_CLASSES: &[&str] = &["screenClass"];

struct Layers {
    own_pid: u32,
    out: Vec<super::Layer>,
}

unsafe extern "system" fn visit_layer(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut Layers);
    if let Some(layer) = layer(hwnd, ctx.own_pid) {
        ctx.out.push(layer);
    }
    BOOL(1)
}

/// A window that could be in front on a screen; none for hidden, minimized, cloaked (other
/// virtual desktops, suspended Store apps), untitled, click-through and tool windows
/// (overlays, tooltips).
unsafe fn layer(hwnd: HWND, own_pid: u32) -> Option<super::Layer> {
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
    let mut r = RECT::default();
    GetWindowRect(hwnd, &mut r).ok()?;
    let titled = (GetWindowLongW(hwnd, GWL_STYLE) as u32) & WS_CAPTION.0 == WS_CAPTION.0;
    Some(super::Layer {
        own: pid == own_pid,
        shell: IGNORED_CLASSES.contains(&class.as_str()),
        rect: super::Rect {
            x: r.left as f64,
            y: r.top as f64,
            w: (r.right - r.left) as f64,
            h: (r.bottom - r.top) as f64,
        },
        maximized: IsZoomed(hwnd).as_bool() && titled,
        slideshow: SLIDESHOW_CLASSES.contains(&class.as_str()),
    })
}

/// Some app is using the camera now, by the privacy settings' "recent activity" record: an app
/// still using it has no stop time yet. Windows 10 only (Windows 11 no longer keeps it there).
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
