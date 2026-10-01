//! Background loop that rings alarms, to-do reminders and tomato-clock phase changes.

use std::time::Duration;

use chrono::{Local, TimeZone};
use desktoppet_core::{Reminder, ReminderKind};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::app_windows::peek;
use crate::state::{now_ms, AppState};

pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    std::thread::Builder::new()
        .name("scheduler".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            tick(&app);
        })
        .expect("failed to start scheduler thread");
}

fn tick<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let now = now_ms();
    let (reminders, pomodoro, cleaned) = {
        let store = state.store();
        (store.take_due(&Local, now), store.tick_pomodoro(&Local, now), daily_cleanup(&store, now))
    };
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

/// Settings → Alerts → "When your pet is hidden, it comes out for…" (settings.hiddenAlerts).
struct HiddenAlerts {
    alarms: bool,
    timers: bool,
    todos: bool,
    focus: bool,
}

impl Default for HiddenAlerts {
    fn default() -> Self {
        Self { alarms: true, timers: true, todos: true, focus: false }
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
