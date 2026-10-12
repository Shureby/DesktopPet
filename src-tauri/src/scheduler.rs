//! Background loop that rings alarms, to-do reminders and tomato-clock phase changes.

use std::time::{Duration, SystemTime};

use chrono::{Local, TimeZone};
use desktoppet_core::{Celebration, LateReason, Millis, Reminder, ReminderKind};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::app_windows::peek;
use crate::state::{now_ms, AppState};

pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    std::thread::Builder::new()
        .name("scheduler".into())
        .spawn(move || {
            let mut presence = Presence::default();
            let mut watch = Watch { started: now_ms(), last_look: None };
            // Today's backup, once the app has settled (beside the loop, never delaying it).
            let backup_app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(10));
                crate::backup::auto_backup(&backup_app);
            });
            loop {
                std::thread::sleep(Duration::from_secs(1));
                // Nothing is taken before the pet can show it (a slow start would lose it).
                if !app.state::<AppState>().pet_ready.load(std::sync::atomic::Ordering::Relaxed) {
                    continue;
                }
                tick(&app, &mut watch);
                celebrate(&app, &mut presence);
            }
        })
        .expect("failed to start scheduler thread");
}

/// What the scheduler knows about its own running, to say why a reminder rings late.
struct Watch {
    /// When ePet started (the app's clock).
    started: Millis,
    /// When it last looked (the computer's own clock, not the test clock).
    last_look: Option<SystemTime>,
}

/// How long the scheduler (which looks every second) must have been stopped for the computer
/// to have been asleep.
const ASLEEP_AFTER: Duration = Duration::from_secs(30);

/// Rung more than a minute late (a look is due every second): why, if the app knows. Due
/// before ePet started: it wasn't running; due during a long gap between looks: the computer
/// was asleep. Otherwise (the test clock set ahead) it doesn't say.
fn late_reason(due_at: Millis, now: Millis, started: Millis, gap: Option<Duration>) -> Option<LateReason> {
    if now - due_at <= 60_000 {
        None
    } else if due_at < started {
        Some(LateReason::NotRunning)
    } else if gap.is_some_and(|g| g > ASLEEP_AFTER) {
        Some(LateReason::Asleep)
    } else {
        None
    }
}

fn tick<R: Runtime>(app: &AppHandle<R>, watch: &mut Watch) {
    let state = app.state::<AppState>();
    let now = now_ms();
    let real = SystemTime::now();
    let gap = watch.last_look.and_then(|t| real.duration_since(t).ok());
    watch.last_look = Some(real);
    let (reminders, pomodoro, cleaned, prepped) = {
        let store = state.store();
        (
            store.take_due(&Local, now),
            store.tick_pomodoro(&Local, now),
            daily_cleanup(&store, now),
            store.tick_anniversaries(&Local, now),
        )
    };
    match prepped {
        Ok(true) => {
            let _ = app.emit("todos-changed", ());
        }
        Ok(false) => {}
        Err(e) => log::error!("anniversary reminders failed: {e}"),
    }
    if cleaned {
        let _ = app.emit("todos-changed", ());
        let _ = app.emit("alarms-changed", ());
    }
    state.storefront.run_callbacks();

    // The pet announces everything itself. Hidden, it comes out for what Settings → Alerts
    // ticks ("When your pet is hidden, it comes out for…"); there are no OS notifications.
    let comes_out = state.store().settings().map(|s| HiddenAlerts::from(&s)).unwrap_or_default();
    match reminders {
        Ok(list) if !list.is_empty() => {
            // Stepped aside (avoid.rs): only an important alarm brings the pet out.
            let away = crate::avoid::away(app).is_some();
            for r in list {
                let comes = if away { r.important && r.kind == ReminderKind::Alarm } else { comes_out.covers(&r) };
                let peeks = comes && peek(app);
                let late = late_reason(r.due_at, now, watch.started, gap);
                let _ = app.emit("reminder", Reminder { peek: peeks, late, ..r });
            }
            let _ = app.emit("todos-changed", ());
            let _ = app.emit("alarms-changed", ());
        }
        Ok(_) => {}
        Err(e) => log::error!("reminder check failed: {e}"),
    }
    match pomodoro {
        Ok(Some(status)) => {
            let _ = app.emit("pomodoro", status);
            if comes_out.focus && crate::avoid::away(app).is_none() && peek(app) {
                let _ = app.emit("pet-peek", "focus");
            }
        }
        Ok(None) => {}
        Err(e) => log::error!("tomato clock tick failed: {e}"),
    }
}

/// Whether you're at the computer: the cursor moved since the last look.
#[derive(Default)]
struct Presence {
    cursor: Option<(f64, f64)>,
}

impl Presence {
    fn moved<R: Runtime>(&mut self, app: &AppHandle<R>) -> bool {
        // The end-to-end tests stand in for a mouse move (e2e_present).
        if app.state::<AppState>().e2e_present.swap(false, std::sync::atomic::Ordering::Relaxed) {
            return true;
        }
        let Ok(p) = app.cursor_position() else {
            return false;
        };
        let moved = self.cursor.is_some_and(|(x, y)| (p.x - x).abs() + (p.y - y).abs() > 2.0);
        self.cursor = Some((p.x, p.y));
        moved
    }
}

/// An anniversary today: celebrated the first time you're at the computer that day (the
/// cursor moves), once. Hidden, the pet comes out for it if Settings say so; otherwise it
/// waits until the pet is shown.
fn celebrate<R: Runtime>(app: &AppHandle<R>, presence: &mut Presence) {
    let state = app.state::<AppState>();
    let now = now_ms();
    let due = match state.store().celebrations_due(&Local, now) {
        Ok(list) if !list.is_empty() => list,
        Ok(_) => {
            presence.cursor = None;
            return;
        }
        Err(e) => {
            log::error!("anniversary check failed: {e}");
            return;
        }
    };
    // Stepped aside: it waits until the pet is back (and you move the mouse).
    if crate::avoid::away(app).is_some() {
        presence.cursor = None;
        return;
    }
    if !presence.moved(app) {
        return;
    }
    let comes_out = state.store().settings().map(|s| HiddenAlerts::from(&s)).unwrap_or_default();
    let hidden = state.pet_hidden.load(std::sync::atomic::Ordering::Relaxed);
    if hidden && !comes_out.anniversaries {
        return;
    }
    // Several on the same day (remembrances first) are played one after another by the
    // pet, which asks for each one's effect window when its turn comes (show_celebration).
    for c in due {
        if let Err(e) = state.store().mark_celebrated(&Local, c.anniversary.id, now) {
            log::error!("could not mark an anniversary celebrated: {e}");
            continue;
        }
        let peeks = hidden && peek(app);
        let _ = app.emit("celebrate", Celebration { peek: peeks, ..c });
    }
}

/// Settings → Alerts → "When your pet is hidden, it comes out for…" (settings.hiddenAlerts).
struct HiddenAlerts {
    alarms: bool,
    timers: bool,
    todos: bool,
    focus: bool,
    anniversaries: bool,
}

impl Default for HiddenAlerts {
    fn default() -> Self {
        Self { alarms: true, timers: true, todos: true, focus: false, anniversaries: true }
    }
}

impl From<&Value> for HiddenAlerts {
    fn from(settings: &Value) -> Self {
        let d = Self::default();
        let h = settings.get("hiddenAlerts");
        let flag = |key: &str, default: bool| h.and_then(|h| h.get(key)).and_then(Value::as_bool).unwrap_or(default);
        Self {
            alarms: flag("alarms", d.alarms),
            timers: flag("timers", d.timers),
            todos: flag("todos", d.todos),
            focus: flag("focus", d.focus),
            anniversaries: flag("anniversaries", d.anniversaries),
        }
    }
}

impl HiddenAlerts {
    fn covers(&self, r: &Reminder) -> bool {
        self.covers_kind(r.kind == ReminderKind::Todo, &r.title)
    }

    fn covers_kind(&self, todo: bool, title: &str) -> bool {
        if todo {
            self.todos
        } else if title.starts_with(desktoppet_core::TIMER_PREFIX) {
            // Timers are alarms labelled "Timer: …" (src/features/alarm/timers.ts).
            self.timers
        } else {
            self.alarms
        }
    }
}

/// Back after stepping aside (avoid.rs), a reminder held meanwhile rings now: with the pet
/// hidden it comes out for it if Settings say so (as when it came due). Whether it did.
#[tauri::command]
pub fn peek_for_held<R: Runtime>(app: AppHandle<R>, todo: bool, title: String) -> bool {
    let state = app.state::<AppState>();
    let comes_out = state.store().settings().map(|s| HiddenAlerts::from(&s)).unwrap_or_default();
    comes_out.covers_kind(todo, &title) && peek(&app)
}

/// Once per local day: clear finished alarms/timers and to-dos ticked off before today.
fn daily_cleanup(store: &desktoppet_core::Store, now: i64) -> bool {
    // The app's day (the test clock may be ahead of the computer's).
    let today =
        Local.timestamp_millis_opt(now).earliest().map_or_else(|| Local::now().date_naive(), |t| t.date_naive());
    let midnight = today.and_hms_opt(0, 0, 0).and_then(|t| Local.from_local_datetime(&t).earliest());
    let start = midnight.map_or(now, |t| t.timestamp_millis());
    match store.daily_cleanup(&today.format("%Y-%m-%d").to_string(), start, now) {
        Ok(ran) => ran,
        Err(e) => {
            log::error!("daily clean-up failed: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: Millis = 60_000;

    #[test]
    fn says_why_a_reminder_rings_late_when_it_knows() {
        let start = 100 * MIN;
        let look = Some(Duration::from_secs(1));
        // On time (a look a second late is still on time).
        assert_eq!(late_reason(200 * MIN, 200 * MIN + 59_000, start, look), None);
        // Due before ePet started.
        assert_eq!(late_reason(90 * MIN, start + 2 * MIN, start, look), Some(LateReason::NotRunning));
        // Due while the computer slept (no look for 10 minutes).
        let slept = Some(Duration::from_secs(600));
        assert_eq!(late_reason(200 * MIN, 207 * MIN, start, slept), Some(LateReason::Asleep));
        // Late without either (the test clock set ahead): no reason given.
        assert_eq!(late_reason(200 * MIN, 207 * MIN, start, look), None);
    }
}
