//! What the pet can stand on: monitor work areas and other apps' windows.
//! All coordinates are physical pixels in the global desktop space.

use serde::Serialize;
use tauri::{Monitor, Runtime, WebviewWindow};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
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

/// A monitor, for choosing the screens the pet lives on (in the order of `areas`).
#[derive(Debug, Clone, Serialize)]
pub struct Screen {
    /// The same monitor at the same place is the same screen after a restart.
    pub id: String,
    pub name: String,
    pub primary: bool,
    /// The whole monitor (the diagram in Settings), physical px.
    pub frame: Rect,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesktopSnapshot {
    pub areas: Vec<Rect>,
    pub screens: Vec<Screen>,
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

pub fn screen(m: &Monitor, primary: Option<&Monitor>) -> Screen {
    let (p, z) = (m.position(), m.size());
    let name = m.name().cloned().unwrap_or_default();
    Screen {
        id: screen_id(&name, p.x, p.y, z.width, z.height),
        primary: primary.is_some_and(|q| q.name() == m.name() && q.position() == p),
        frame: Rect { x: p.x as f64, y: p.y as f64, w: z.width as f64, h: z.height as f64 },
        name,
    }
}

pub fn screen_id(name: &str, x: i32, y: i32, w: u32, h: u32) -> String {
    format!("{name}|{w}x{h}|{x},{y}")
}

pub fn snapshot<R: Runtime>(pet: &WebviewWindow<R>) -> tauri::Result<DesktopSnapshot> {
    let monitors = pet.available_monitors()?;
    let primary = pet.primary_monitor()?;
    let areas: Vec<Area> = monitors.iter().map(area).collect();
    let screens = monitors.iter().map(|m| screen(m, primary.as_ref())).collect();
    let scale = pet.scale_factor()?;
    Ok(DesktopSnapshot { windows: list_windows(&areas), areas: areas.iter().map(|a| a.rect).collect(), screens, scale })
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

/// What you're doing that the pet steps aside for (see avoid.rs).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Busy {
    /// An app covers the pet's whole screen (a game, a video, a browser on F11).
    pub fullscreen: bool,
    /// A slide show.
    pub presenting: bool,
    /// A camera or the microphone is in use (a video call).
    pub call: bool,
}

/// A window, front to back, as far as stepping aside goes (see `classify`).
#[cfg_attr(not(any(windows, target_os = "macos", test)), allow(dead_code))]
pub struct Layer {
    /// One of ePet's own windows (the pet, its panel): never in the way.
    pub own: bool,
    /// The desktop or the taskbar: never an app.
    pub shell: bool,
    pub rect: Rect,
    /// Maximized with a title bar (with an auto-hiding taskbar it covers the screen too).
    pub maximized: bool,
    /// A slide show's window (PowerPoint's, Keynote's).
    pub slideshow: bool,
}

/// What's on the screens, as far as stepping aside goes.
#[derive(Debug, Default, PartialEq)]
pub struct Scene {
    /// The pet's screen is covered by an app (a game, a video, a slide show or its presenter
    /// view, a browser on F11), also when one window covers several screens (a racing game).
    pub fullscreen: bool,
    /// The screens showing a slide show (an important alarm brings the pet out elsewhere).
    pub slideshows: Vec<Rect>,
}

/// How far a window must reach into a screen to be on it (Windows' maximized windows overlap
/// the next screen by their invisible borders).
const ON_SCREEN: f64 = 16.0;

/// The front app window on each screen decides: the screen is covered when that window covers
/// all of it (taskbar or menu bar too). Front to back, not the window with the focus, so
/// clicking the pet (or a screenshot tool) doesn't end a slide show still on screen.
#[cfg_attr(not(any(windows, target_os = "macos", test)), allow(dead_code))]
pub fn classify(front_to_back: &[Layer], screens: &[Rect], pet_screen: Option<usize>) -> Scene {
    let mut scene = Scene::default();
    for (i, s) in screens.iter().enumerate() {
        let front = front_to_back.iter().find(|l| {
            !l.own
                && !l.shell
                && l.rect.x.max(s.x) + ON_SCREEN < (l.rect.x + l.rect.w).min(s.x + s.w)
                && l.rect.y.max(s.y) + ON_SCREEN < (l.rect.y + l.rect.h).min(s.y + s.h)
        });
        let Some(front) = front else { continue };
        let r = front.rect;
        let covered = !front.maximized && r.x <= s.x && r.y <= s.y && r.x + r.w >= s.x + s.w && r.y + r.h >= s.y + s.h;
        if !covered {
            continue;
        }
        if pet_screen == Some(i) {
            scene.fullscreen = true;
        }
        if front.slideshow {
            scene.slideshows.push(*s);
        }
    }
    scene
}

/// The screen with this point (the nearest if none: the pet just off an edge).
#[cfg_attr(not(any(windows, target_os = "macos", test)), allow(dead_code))]
pub fn screen_at(screens: &[Rect], (x, y): (f64, f64)) -> Option<usize> {
    let dist = |s: &Rect| (x - x.clamp(s.x, s.x + s.w)).hypot(y - y.clamp(s.y, s.y + s.h));
    (0..screens.len()).min_by(|&a, &b| dist(&screens[a]).total_cmp(&dist(&screens[b])))
}

/// Apps whose use of the microphone means a call or a meeting (lowercase, letters and digits
/// only, matched within the app's program or bundle name): an app keeping the microphone open
/// for anything else (a voice chat left open, a voice assistant, a browser tab) doesn't count;
/// with the camera on, any app does.
const MEETING_APPS: &[&str] = &[
    "zoom",           // Zoom.exe, us.zoom.xos
    "teams",          // ms-teams.exe, Teams.exe, com.microsoft.teams2
    "webex",          // com.cisco.webexmeetingsapp, webexmta.exe
    "ciscocollab",    // CiscoCollabHost.exe (Webex)
    "wemeet",         // WeMeetApp.exe (Tencent Meeting)
    "tencentmeeting", // com.tencent.meeting
    "feishu",         // Feishu.exe, com.bytedance.feishu
    "lark",           // Lark.exe
    "dingtalk",       // DingTalk.exe, com.alibaba.DingTalkMac
    "wechat",         // WeChat.exe, com.tencent.xinWeChat
    "weixin",         // Weixin.exe (WeChat 4)
    "skype",
];

/// Whether this app (its program file or bundle id) is a meeting app (see `MEETING_APPS`).
#[cfg_attr(not(any(windows, target_os = "macos", test)), allow(dead_code))]
pub fn is_meeting_app(name: &str) -> bool {
    let name: String = name.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect();
    MEETING_APPS.iter().any(|m| name.contains(m))
}

/// In a call: a camera is in use (by any app), or a meeting app uses the microphone.
#[cfg_attr(not(any(windows, target_os = "macos", test)), allow(dead_code))]
pub fn in_call<'a>(camera: bool, recording: impl IntoIterator<Item = &'a str>) -> bool {
    camera || recording.into_iter().any(is_meeting_app)
}

/// What you're doing (see avoid.rs): on the pet's screen, or a slide show on any.
pub fn busy<R: Runtime>(pet: &WebviewWindow<R>) -> (Busy, Vec<Rect>) {
    let Ok(pos) = pet.outer_position() else {
        return Default::default();
    };
    let size = pet.outer_size().unwrap_or_default();
    let (x, y) = (pos.x as f64 + size.width as f64 / 2.0, pos.y as f64 + size.height as f64 / 2.0);
    #[cfg(windows)]
    {
        let screens: Vec<Rect> = pet
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|m| Rect {
                x: m.position().x as f64,
                y: m.position().y as f64,
                w: m.size().width as f64,
                h: m.size().height as f64,
            })
            .collect();
        return windows::busy(std::process::id(), &screens, (x, y));
    }
    #[cfg(target_os = "macos")]
    {
        let scale = pet.scale_factor().unwrap_or(1.0);
        return macos::busy(std::process::id(), (x / scale, y / scale));
    }
    #[allow(unreachable_code)]
    {
        let _ = (x, y);
        Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEFT: Rect = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 };
    const RIGHT: Rect = Rect { x: 1920.0, y: 0.0, w: 1920.0, h: 1080.0 };

    fn app(rect: Rect) -> Layer {
        Layer { own: false, shell: false, rect, maximized: false, slideshow: false }
    }

    fn show(rect: Rect) -> Layer {
        Layer { slideshow: true, ..app(rect) }
    }

    fn win(x: f64, w: f64) -> Rect {
        Rect { x, y: 100.0, w, h: 600.0 }
    }

    #[test]
    fn the_front_app_window_on_the_pets_screen_decides() {
        let pet = Layer { own: true, ..app(win(100.0, 300.0)) };
        let taskbar = Layer { shell: true, ..app(Rect { y: 1040.0, h: 40.0, ..LEFT }) };
        // The pet clicked (it has the focus, it's in front): the slide show is still on.
        let s = classify(&[pet, taskbar, show(LEFT)], &[LEFT], Some(0));
        assert_eq!(s, Scene { fullscreen: true, slideshows: vec![LEFT] });
        // A window over it (Alt+Tab to the notes): not full screen any more.
        assert_eq!(classify(&[app(win(100.0, 800.0)), show(LEFT)], &[LEFT], Some(0)), Scene::default());
        // A maximized window with a title bar isn't full screen.
        assert_eq!(classify(&[Layer { maximized: true, ..app(LEFT) }], &[LEFT], Some(0)), Scene::default());
        assert_eq!(classify(&[], &[LEFT], Some(0)), Scene::default());
    }

    #[test]
    fn a_slide_show_on_another_screen_counts_a_video_there_doesnt() {
        // Presenter view on the pet's screen, the slides on the other.
        let presenter = app(LEFT);
        let s = classify(&[presenter, show(RIGHT)], &[LEFT, RIGHT], Some(0));
        assert_eq!(s, Scene { fullscreen: true, slideshows: vec![RIGHT] });
        // A video full screen on the other screen.
        let s = classify(&[app(RIGHT), app(win(100.0, 800.0))], &[LEFT, RIGHT], Some(0));
        assert_eq!(s, Scene::default());
        // Windows' maximized windows reach 8 px into the next screen: not on it.
        let maxed = Layer { maximized: true, ..app(Rect { x: 1912.0, y: -8.0, w: 1936.0, h: 1096.0 }) };
        let s = classify(&[maxed, show(LEFT)], &[LEFT, RIGHT], Some(0));
        assert_eq!(s, Scene { fullscreen: true, slideshows: vec![LEFT] });
    }

    #[test]
    fn a_game_across_several_screens_covers_each() {
        let racing = app(Rect { x: 0.0, y: 0.0, w: 3840.0, h: 1080.0 });
        assert!(classify(&[racing], &[LEFT, RIGHT], Some(1)).fullscreen);
        let half = app(Rect { x: 960.0, y: 0.0, w: 1920.0, h: 1080.0 });
        assert!(!classify(&[half], &[LEFT, RIGHT], Some(1)).fullscreen);
    }

    #[test]
    fn a_call_is_a_camera_on_or_a_meeting_app_on_the_microphone() {
        for app in [
            r"C:\Users\me\AppData\Roaming\Zoom\bin\Zoom.exe",
            "ms-teams.exe",
            "CiscoCollabHost.exe",
            "WeMeetApp.exe",
            "Feishu.exe",
            "DingTalk.exe",
            "WeChat.exe",
            "Weixin.exe",
            "us.zoom.xos",
            "com.microsoft.teams2",
            "com.tencent.xinWeChat",
            "com.tencent.meeting",
            "com.alibaba.DingTalkMac",
        ] {
            assert!(is_meeting_app(app), "{app}");
            assert!(in_call(false, [app]), "{app}");
        }
        // A voice chat left open, a voice assistant, a browser: not without the camera.
        for app in ["Discord.exe", "chrome.exe", "com.google.Chrome", "Cortana.exe", "obs64.exe"] {
            assert!(!is_meeting_app(app), "{app}");
            assert!(!in_call(false, [app]), "{app}");
            assert!(in_call(true, [app]), "{app} with the camera on");
        }
        assert!(in_call(true, []));
        assert!(!in_call(false, []));
    }

    #[test]
    fn the_pets_screen_is_the_one_it_stands_on_or_the_nearest() {
        assert_eq!(screen_at(&[LEFT, RIGHT], (2000.0, 500.0)), Some(1));
        assert_eq!(screen_at(&[LEFT, RIGHT], (-50.0, 500.0)), Some(0));
        assert_eq!(screen_at(&[], (0.0, 0.0)), None);
    }
}
