//! Background loop that rings alarms, to-do reminders and tomato-clock phase changes.

use std::time::Duration;

use chrono::{Local, TimeZone};
use desktoppet_core::{Celebration, Reminder, ReminderKind};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::app_windows::peek;
use crate::state::{now_ms, AppState};

pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    std::thread::Builder::new()
        .name("scheduler".into())
        .spawn(move || {
            let mut presence = Presence::default();
            loop {
                std::thread::sleep(Duration::from_secs(1));
                tick(&app);
                celebrate(&app, &mut presence);
            }
        })
        .expect("failed to start scheduler thread");
}

fn tick<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let now = now_ms();
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
            for r in list {
                let peeks = comes_out.covers(&r) && peek(app);
                let _ = app.emit("reminder", Reminder { peek: peeks, ..r });
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
            if comes_out.focus && peek(app) {
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
        match r.kind {
            ReminderKind::Todo => self.todos,
            // Timers are alarms labelled "Timer: …" (src/features/alarm/timers.ts).
            ReminderKind::Alarm if r.title.starts_with("Timer: ") => self.timers,
            ReminderKind::Alarm => self.alarms,
        }
    }
}

/// Once per local day: clear finished alarms/timers and to-dos ticked off before today.
fn daily_cleanup(store: &desktoppet_core::Store, now: i64) -> bool {
    let today = Local::now().date_naive();
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
