//! Background loop that rings alarms, to-do reminders and tomato-clock phase changes.

use std::time::Duration;

use chrono::{Local, TimeZone};
use desktoppet_core::{Phase, PomodoroStatus, Reminder, ReminderKind};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::app_windows::{product_name, PET};
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
        (store.take_due(&Local, now), store.tick_pomodoro(now), daily_cleanup(&store, now))
    };
    if cleaned {
        let _ = app.emit("todos-changed", ());
        let _ = app.emit("alarms-changed", ());
    }
    state.storefront.run_callbacks();

    let pet_visible = app.get_webview_window(PET).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    match reminders {
        Ok(list) if !list.is_empty() => {
            for r in &list {
                let _ = app.emit("reminder", r);
                // The pet announces reminders itself; the OS notification is the fallback
                // (always used for alarms, which must not be missed).
                if !pet_visible || r.kind == ReminderKind::Alarm {
                    notify(app, &reminder_title(r), &r.title);
                }
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
            if !pet_visible {
                notify(app, &product_name(app), phase_message(&status));
            }
        }
        Ok(None) => {}
        Err(e) => log::error!("tomato clock tick failed: {e}"),
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

fn reminder_title(r: &Reminder) -> String {
    match r.kind {
        ReminderKind::Alarm => "⏰ Alarm".into(),
        ReminderKind::Todo => "📝 Reminder".into(),
    }
}

fn phase_message(s: &PomodoroStatus) -> &'static str {
    match s.phase {
        Phase::Focus => "🍅 Focus time! Let's go.",
        Phase::ShortBreak => "☕ Short break — stretch a little.",
        Phase::LongBreak => "🌿 Long break — you earned it.",
        Phase::Idle => "Tomato clock finished.",
    }
}

fn notify<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("notification failed: {e}");
    }
}
