//! Stepping aside (docs/INTERACTIONS.md, "Stepping aside"): while an app covers the pet's
//! screen, a slide show runs or a camera or the microphone is in use, the pet leaves the
//! screen and comes back once that's over. With others watching (a call, a presentation)
//! ePet's windows are also left out of screen sharing and recordings.
//!
//! What rings meanwhile is decided by the scheduler (only important alarms bring the pet
//! out) and by the pet window (src/features/avoid/avoid.ts).

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::app_windows::{CELEBRATE, PET};
use crate::desktop::{self, Busy};
use crate::state::AppState;

/// Why the pet stepped aside.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Fullscreen,
    Presenting,
    Call,
}

impl Reason {
    /// Others may see or hear the screen: only important alarms ring, and ePet hides from
    /// screen capture.
    pub fn others_present(self) -> bool {
        !matches!(self, Reason::Fullscreen)
    }
}

/// Settings → Modes → "Step aside automatically" (settings.avoid).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvoidSettings {
    pub fullscreen: bool,
    pub presenting: bool,
    pub calls: bool,
    /// "Always hide ePet from screenshots and recordings".
    pub always_hide: bool,
}

impl Default for AvoidSettings {
    fn default() -> Self {
        Self { fullscreen: true, presenting: true, calls: true, always_hide: false }
    }
}

impl From<&Value> for AvoidSettings {
    fn from(settings: &Value) -> Self {
        let d = Self::default();
        let a = settings.get("avoid");
        let flag = |key: &str, default: bool| a.and_then(|a| a.get(key)).and_then(Value::as_bool).unwrap_or(default);
        Self {
            fullscreen: flag("fullscreen", d.fullscreen),
            presenting: flag("presenting", d.presenting),
            calls: flag("calls", d.calls),
            always_hide: flag("alwaysHide", d.always_hide),
        }
    }
}

impl AvoidSettings {
    /// What the pet steps aside for, of what you're doing (the strictest first).
    pub fn reason(&self, b: Busy) -> Option<Reason> {
        if b.presenting && self.presenting {
            Some(Reason::Presenting)
        } else if b.call && self.calls {
            Some(Reason::Call)
        } else if b.fullscreen && self.fullscreen {
            Some(Reason::Fullscreen)
        } else {
            None
        }
    }
}

/// How long what the pet stepped aside for must be over before it comes back (so a video
/// leaving full screen for a moment doesn't bring it out and send it off again).
pub const RETURN_AFTER: Duration = Duration::from_secs(10);

/// How often it looks.
const POLL: Duration = Duration::from_secs(1);

#[derive(Debug, Default)]
pub struct Avoid {
    /// Why the pet has stepped aside (None: it hasn't).
    pub reason: Option<Reason>,
    /// When what it stepped aside for ended (it comes back RETURN_AFTER later).
    clear_since: Option<Instant>,
    /// "Show pet" while it was aside: it stays out until what it stepped aside for is over.
    dismissed: bool,
    /// What a test build pretends you're doing (tray 🧪, end-to-end tests).
    pub pretend: Option<Busy>,
    /// ePet's windows are left out of screen capture.
    pub protected: bool,
}

impl Avoid {
    /// One look: `want` is what the pet would step aside for now. Returns the reason before.
    fn step(&mut self, want: Option<Reason>, now: Instant) -> Option<Reason> {
        let before = self.reason;
        match want {
            Some(w) => {
                self.clear_since = None;
                if !self.dismissed {
                    self.reason = Some(w);
                }
            }
            None if self.reason.is_none() && !self.dismissed => self.clear_since = None,
            None => {
                let since = *self.clear_since.get_or_insert(now);
                if now.duration_since(since) >= RETURN_AFTER {
                    self.reason = None;
                    self.dismissed = false;
                    self.clear_since = None;
                }
            }
        }
        before
    }

    /// "Show pet" while aside: back now, and it stays until this is over.
    fn dismiss(&mut self) -> bool {
        if self.reason.is_none() {
            return false;
        }
        self.reason = None;
        self.dismissed = true;
        true
    }
}

pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    std::thread::Builder::new()
        .name("avoid".into())
        .spawn(move || loop {
            std::thread::sleep(POLL);
            check(&app);
        })
        .expect("failed to start the step-aside thread");
}

fn check<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let settings = state.store().settings().map(|s| AvoidSettings::from(&s)).unwrap_or_default();
    let pretend = state.avoid().pretend;
    let busy = match pretend {
        Some(b) => b,
        // The end-to-end tests' runner may have anything on screen: only what they pretend.
        None if crate::commands::e2e_enabled() => Busy::default(),
        None => app.get_webview_window(PET).map(|w| desktop::busy(&w)).unwrap_or_default(),
    };
    let want = settings.reason(busy);
    let (before, after, protect) = {
        let mut a = state.avoid();
        let before = a.step(want, Instant::now());
        // Hidden from capture while others may be watching, even with the pet shown anyway.
        let protect = settings.always_hide || want.is_some_and(Reason::others_present);
        let changed = a.protected != protect;
        a.protected = protect;
        (before, a.reason, changed.then_some(protect))
    };
    if let Some(p) = protect {
        set_protected(app, p);
    }
    if before != after {
        apply(app, before, after);
    }
}

/// The pet leaves (or comes back), and every window hears why ("avoid").
fn apply<R: Runtime>(app: &AppHandle<R>, before: Option<Reason>, after: Option<Reason>) {
    let state = app.state::<AppState>();
    if let Some(w) = app.get_webview_window(PET) {
        let result = match (before, after) {
            (None, Some(_)) => {
                // Out for a reminder or not, it goes (an important alarm brings it back).
                state.peeking.store(false, Ordering::Relaxed);
                w.hide()
            }
            (Some(_), None) if !state.pet_hidden.load(Ordering::Relaxed) => w.show(),
            _ => Ok(()),
        };
        if let Err(e) = result {
            log::warn!("could not step the pet aside or back: {e}");
        }
    }
    let _ = app.emit("avoid", after);
}

/// ePet's pet and effect windows are left out of screen sharing, recordings and screenshots.
fn set_protected<R: Runtime>(app: &AppHandle<R>, on: bool) {
    for label in [PET, CELEBRATE] {
        if let Some(w) = app.get_webview_window(label) {
            if let Err(e) = w.set_content_protected(on) {
                log::warn!("could not change screen-capture protection: {e}");
            }
        }
    }
}

/// "Show pet" while it stepped aside: it comes back now (see `Avoid::dismiss`).
pub fn dismiss<R: Runtime>(app: &AppHandle<R>) {
    if app.state::<AppState>().avoid().dismiss() {
        let _ = app.emit("avoid", None::<Reason>);
    }
}

/// Whether the pet has stepped aside.
pub fn away<R: Runtime>(app: &AppHandle<R>) -> Option<Reason> {
    app.state::<AppState>().avoid().reason
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvoidStatus {
    reason: Option<Reason>,
    protected: bool,
    pretend: Option<Busy>,
}

/// Why the pet stepped aside (if it did), and whether ePet is hidden from screen capture.
#[tauri::command]
pub fn avoid_status(state: tauri::State<AppState>) -> AvoidStatus {
    let a = state.avoid();
    AvoidStatus { reason: a.reason, protected: a.protected, pretend: a.pretend }
}

/// Test builds and end-to-end tests: pretend you're doing this (None: look again).
#[tauri::command]
pub fn pretend_busy<R: Runtime>(app: AppHandle<R>, busy: Option<Busy>) -> Result<(), String> {
    if !crate::state::test_clock_enabled() {
        return Err("only in test builds".into());
    }
    app.state::<AppState>().avoid().pretend = busy;
    check(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALL: Busy = Busy { fullscreen: false, presenting: false, call: true };
    const SHOW: Busy = Busy { fullscreen: true, presenting: true, call: false };

    #[test]
    fn the_strictest_reason_counts_and_settings_can_leave_one_out() {
        let s = AvoidSettings::default();
        assert_eq!(s.reason(Busy::default()), None);
        assert_eq!(s.reason(SHOW), Some(Reason::Presenting));
        assert_eq!(s.reason(Busy { call: true, ..SHOW }), Some(Reason::Presenting));
        assert_eq!(s.reason(Busy { fullscreen: true, ..CALL }), Some(Reason::Call));
        let no_shows = AvoidSettings { presenting: false, ..s };
        assert_eq!(no_shows.reason(SHOW), Some(Reason::Fullscreen));
        let nothing = AvoidSettings { fullscreen: false, presenting: false, calls: false, always_hide: false };
        assert_eq!(nothing.reason(Busy { call: true, ..SHOW }), None);
        let v = serde_json::json!({ "avoid": { "calls": false, "alwaysHide": true } });
        assert_eq!(AvoidSettings::from(&v), AvoidSettings { calls: false, always_hide: true, ..s });
    }

    #[test]
    fn steps_aside_at_once_and_comes_back_after_a_while() {
        let t = Instant::now();
        let mut a = Avoid::default();
        a.step(Some(Reason::Fullscreen), t);
        assert_eq!(a.reason, Some(Reason::Fullscreen));
        // A call starts: at once.
        a.step(Some(Reason::Call), t + Duration::from_secs(1));
        assert_eq!(a.reason, Some(Reason::Call));
        // Over: still aside for a while, and a short return (a video leaving full screen for
        // a moment) starts the wait again.
        a.step(None, t + Duration::from_secs(2));
        a.step(None, t + Duration::from_secs(11));
        assert_eq!(a.reason, Some(Reason::Call));
        a.step(Some(Reason::Fullscreen), t + Duration::from_secs(11));
        a.step(None, t + Duration::from_secs(12));
        a.step(None, t + Duration::from_secs(21));
        assert_eq!(a.reason, Some(Reason::Fullscreen));
        assert_eq!(a.step(None, t + Duration::from_secs(22)), Some(Reason::Fullscreen));
        assert_eq!(a.reason, None);
    }

    #[test]
    fn shown_anyway_it_stays_until_that_is_over() {
        let t = Instant::now();
        let mut a = Avoid::default();
        a.step(Some(Reason::Call), t);
        assert!(a.dismiss());
        assert_eq!(a.reason, None);
        a.step(Some(Reason::Call), t + Duration::from_secs(5));
        assert_eq!(a.reason, None, "the same call");
        a.step(None, t + Duration::from_secs(6));
        a.step(None, t + Duration::from_secs(16));
        a.step(Some(Reason::Call), t + Duration::from_secs(17));
        assert_eq!(a.reason, Some(Reason::Call), "the next call");
        assert!(!Avoid::default().dismiss());
    }
}
