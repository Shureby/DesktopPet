//! Commands invoked from the web UI (`src/platform/tauri.ts` mirrors these names).

use std::sync::atomic::Ordering;

use chrono::Local;
use desktoppet_core::{pomodoro, Alarm, DayStat, NewUnseen, PomodoroStatus, Repeat, Score, Todo, TodoPatch, Unseen};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State};
use tauri_plugin_opener::OpenerExt;

use crate::app_windows::{self, PET};
use crate::desktop::{self, DesktopSnapshot};
use crate::state::{now_ms, AppState};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// --- Settings ------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> CmdResult<Value> {
    state.store().settings().map_err(err)
}

#[tauri::command]
pub fn set_settings(app: AppHandle, state: State<AppState>, settings: Value) -> CmdResult<()> {
    state.store().set_settings(&settings).map_err(err)?;
    app.emit("settings", settings).map_err(err)
}

// --- To-dos ---------------------------------------------------------------------

#[tauri::command]
pub fn list_todos(state: State<AppState>) -> CmdResult<Vec<Todo>> {
    state.store().list_todos().map_err(err)
}

#[tauri::command]
pub fn add_todo(app: AppHandle, state: State<AppState>, title: String, due_at: Option<i64>) -> CmdResult<Todo> {
    let todo = state.store().add_todo(&title, due_at, now_ms()).map_err(err)?;
    let _ = app.emit("todos-changed", ());
    Ok(todo)
}

#[tauri::command]
pub fn update_todo(app: AppHandle, state: State<AppState>, id: i64, patch: TodoPatch) -> CmdResult<()> {
    state.store().update_todo(id, &patch, now_ms()).map_err(err)?;
    let _ = app.emit("todos-changed", ());
    Ok(())
}

/// Removes every ticked-off to-do ("Clear" in the panel).
#[tauri::command]
pub fn clear_done_todos(app: AppHandle, state: State<AppState>) -> CmdResult<usize> {
    let n = state.store().clear_done_todos(i64::MAX).map_err(err)?;
    let _ = app.emit("todos-changed", ());
    Ok(n)
}

#[tauri::command]
pub fn delete_todo(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    state.store().delete_todo(id).map_err(err)?;
    let _ = app.emit("todos-changed", ());
    Ok(())
}

// --- Alarms ---------------------------------------------------------------------

#[tauri::command]
pub fn list_alarms(state: State<AppState>) -> CmdResult<Vec<Alarm>> {
    state.store().list_alarms().map_err(err)
}

#[tauri::command]
pub fn add_alarm(
    app: AppHandle,
    state: State<AppState>,
    label: String,
    at: i64,
    repeat: Repeat,
    days: Option<u8>,
) -> CmdResult<Alarm> {
    let alarm = state.store().add_alarm(&Local, &label, at, repeat, days.unwrap_or(0), now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(alarm)
}

/// Editing an alarm from the panel (✎): set again with a new label, time and repeat.
#[tauri::command]
pub fn update_alarm(
    app: AppHandle,
    state: State<AppState>,
    id: i64,
    label: String,
    at: i64,
    repeat: Repeat,
    days: Option<u8>,
) -> CmdResult<Alarm> {
    let alarm = state.store().update_alarm(&Local, id, &label, at, repeat, days.unwrap_or(0)).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(alarm)
}

#[tauri::command]
pub fn set_alarm_enabled(app: AppHandle, state: State<AppState>, id: i64, enabled: bool) -> CmdResult<()> {
    state.store().set_alarm_enabled(&Local, id, enabled, now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

/// "Skip once" on a repeating alarm (the panel asks when you switch one off).
#[tauri::command]
pub fn skip_alarm_once(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    state.store().skip_alarm_once(&Local, id, now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

#[tauri::command]
pub fn unskip_alarm(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    state.store().unskip_alarm(&Local, id, now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

#[tauri::command]
pub fn snooze_alarm(app: AppHandle, state: State<AppState>, id: i64, minutes: i64) -> CmdResult<()> {
    state.store().snooze_alarm(id, minutes.clamp(1, 24 * 60), now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

/// "Done" on a ringing, snoozed or missed alarm: ends its current cycle.
#[tauri::command]
pub fn dismiss_alarm(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    state.store().dismiss_alarm(&Local, id, now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

/// Nobody answered an alarm after its automatic snoozes: it is missed (the pet shows a badge).
#[tauri::command]
pub fn mark_alarm_missed(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    state.store().mark_alarm_missed(id, now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

/// The hidden pet rang something nobody answered: it tells you when you show it again.
#[tauri::command]
pub fn record_unseen(state: State<AppState>, item: NewUnseen) -> CmdResult<()> {
    state.store().record_unseen(&item, now_ms()).map_err(err)
}

#[tauri::command]
pub fn list_unseen(state: State<AppState>) -> CmdResult<Vec<Unseen>> {
    state.store().list_unseen().map_err(err)
}

/// "Done" on "While I was hidden you missed…".
#[tauri::command]
pub fn clear_unseen(app: AppHandle, state: State<AppState>) -> CmdResult<()> {
    state.store().clear_unseen(now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

/// The hidden pet has answered its reminder and walked off: hide it again.
#[tauri::command]
pub fn end_peek(app: AppHandle) -> CmdResult<()> {
    app_windows::end_peek(&app).map_err(err)
}

/// The user saw a missed alarm (clicked its badge): the badge goes, it stays missed in the history.
#[tauri::command]
pub fn acknowledge_missed(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    state.store().acknowledge_missed(id, now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

/// Removes one-shot alarms and timers that already rang ("Clear" in the panel).
#[tauri::command]
pub fn clear_finished_alarms(app: AppHandle, state: State<AppState>) -> CmdResult<usize> {
    let n = state.store().clear_finished_alarms(now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(n)
}

#[tauri::command]
pub fn delete_alarm(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    state.store().delete_alarm(id).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

// --- Tomato clock ---------------------------------------------------------------

fn set_pomodoro(
    app: &AppHandle,
    state: &AppState,
    f: impl FnOnce(&PomodoroStatus, i64, &desktoppet_core::PomodoroConfig, Option<i64>) -> PomodoroStatus,
) -> CmdResult<PomodoroStatus> {
    let now = now_ms();
    let status = {
        let store = state.store();
        let (status, config) = (store.pomodoro_status().map_err(err)?, store.pomodoro_config().map_err(err)?);
        let cutoff = store.pomodoro_cutoff(&Local, &status, &config);
        let next = f(&status, now, &config, cutoff);
        store.set_pomodoro(&next, now).map_err(err)?;
        next
    };
    let _ = app.emit("pomodoro", status);
    Ok(status)
}

#[tauri::command]
pub fn pomodoro_start(app: AppHandle, state: State<AppState>) -> CmdResult<PomodoroStatus> {
    set_pomodoro(&app, &state, |_, now, c, _| pomodoro::start_focus(now, c, 0))
}

#[tauri::command]
pub fn pomodoro_skip(app: AppHandle, state: State<AppState>) -> CmdResult<PomodoroStatus> {
    set_pomodoro(&app, &state, pomodoro::next_phase)
}

#[tauri::command]
pub fn pomodoro_stop(app: AppHandle, state: State<AppState>) -> CmdResult<PomodoroStatus> {
    set_pomodoro(&app, &state, |_, _, _, _| PomodoroStatus::default())
}

#[tauri::command]
pub fn pomodoro_status(state: State<AppState>) -> CmdResult<PomodoroStatus> {
    state.store().pomodoro_status().map_err(err)
}

#[tauri::command]
pub fn pomodoro_stats(state: State<AppState>, days: u32) -> CmdResult<Vec<DayStat>> {
    state.store().pomodoro_stats(&Local, days.min(366), now_ms()).map_err(err)
}

// --- Games ------------------------------------------------------------------------

#[tauri::command]
pub fn record_score(state: State<AppState>, game: String, character: String, score: i64) -> CmdResult<()> {
    state.store().record_score(&game, &character, score, now_ms()).map_err(err)
}

#[tauri::command]
pub fn top_scores(state: State<AppState>, game: String, limit: u32) -> CmdResult<Vec<Score>> {
    state.store().top_scores(&game, limit.min(100)).map_err(err)
}

#[tauri::command]
pub fn unlock_achievement(state: State<AppState>, id: String) -> CmdResult<()> {
    if state.store().unlock_achievement(&id, now_ms()).map_err(err)? {
        log::info!("achievement unlocked: {id}");
    }
    // Mirror every time: the store may have been offline the first time.
    state.storefront.unlock_achievement(&id);
    Ok(())
}

/// Which build this is ("steam", "epic" or "direct"), shown in the panel for support.
#[tauri::command]
pub fn storefront_name(state: State<AppState>) -> &'static str {
    state.storefront.name()
}

// --- Pet window & desktop ---------------------------------------------------------

#[tauri::command]
pub fn desktop_snapshot(app: AppHandle) -> CmdResult<DesktopSnapshot> {
    let pet = app.get_webview_window(PET).ok_or("pet window missing")?;
    desktop::snapshot(&pet).map_err(err)
}

#[derive(Serialize)]
pub struct Point {
    x: f64,
    y: f64,
}

#[tauri::command]
pub fn set_pet_visible(app: AppHandle, visible: bool) -> CmdResult<()> {
    app_windows::set_pet_visible(&app, visible).map_err(err)
}

/// Called every frame: moves and sizes the pet window, toggles click-through, returns the cursor.
///
/// The size is enforced too, not just set once: when a monitor's scale changes (or the pet
/// crosses to a monitor with another scale) the webview renders at the new scale, but the
/// window's physical size doesn't reliably follow, and the pet ends up drawn outside it.
#[tauri::command]
pub fn pet_frame(
    app: AppHandle,
    state: State<AppState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    ignore_cursor: bool,
) -> CmdResult<Option<Point>> {
    let pet = app.get_webview_window(PET).ok_or("pet window missing")?;
    let size = PhysicalSize::new(w.round().max(1.0) as u32, h.round().max(1.0) as u32);
    if pet.inner_size().map_err(err)? != size {
        pet.set_size(size).map_err(err)?;
    }
    pet.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32)).map_err(err)?;
    if state.ignore_cursor.swap(ignore_cursor, Ordering::Relaxed) != ignore_cursor {
        pet.set_ignore_cursor_events(ignore_cursor).map_err(err)?;
    }
    Ok(app.cursor_position().ok().map(|p| Point { x: p.x, y: p.y }))
}

// --- Mood -----------------------------------------------------------------------------

fn mood_key(character: &str) -> CmdResult<String> {
    if character.is_empty() || !character.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err("invalid character id".into());
    }
    Ok(format!("mood:{character}"))
}

/// Mood (affection, fullness) saved per character; the UI owns its shape.
#[tauri::command]
pub fn load_mood(state: State<AppState>, character: String) -> CmdResult<Option<Value>> {
    let raw = state.store().get_kv(&mood_key(&character)?).map_err(err)?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}

#[tauri::command]
pub fn save_mood(app: AppHandle, state: State<AppState>, character: String, mood: Value) -> CmdResult<()> {
    state.store().set_kv(&mood_key(&character)?, &mood.to_string()).map_err(err)?;
    let _ = app.emit("mood", serde_json::json!({ "character": character, "mood": mood }));
    Ok(())
}

// --- User characters -----------------------------------------------------------------

#[derive(Serialize)]
pub struct UserCharacterFile {
    dir: String,
    json: String,
}

fn characters_dir(app: &AppHandle) -> CmdResult<std::path::PathBuf> {
    let dir = app.path().app_data_dir().map_err(err)?.join("characters");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Data-only characters (character.json + images) from the user's characters folder.
#[tauri::command]
pub fn list_user_characters(app: AppHandle) -> CmdResult<Vec<UserCharacterFile>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(characters_dir(&app)?).map_err(err)?.flatten() {
        let path = entry.path().join("character.json");
        // Cap the size: these files come from the internet (Workshop, forums…).
        if path.metadata().is_ok_and(|m| m.is_file() && m.len() < 2_000_000) {
            if let Ok(json) = std::fs::read_to_string(&path) {
                out.push(UserCharacterFile { dir: entry.path().to_string_lossy().into_owned(), json });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn open_user_characters_folder(app: AppHandle) -> CmdResult<()> {
    let dir = characters_dir(&app)?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(err)
}

// --- Windows ------------------------------------------------------------------------
//
// These MUST stay `async`: Tauri runs sync commands on the main thread, and creating
// a WebView2 window from there deadlocks on Windows (the whole app freezes).

#[tauri::command]
pub async fn open_panel(app: AppHandle, tab: Option<String>) -> CmdResult<()> {
    app_windows::open_panel(&app, tab.as_deref()).map_err(err)
}

#[tauri::command]
pub async fn open_game(app: AppHandle, game: String) -> CmdResult<()> {
    if !game.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid game id".into());
    }
    app_windows::open_game(&app, &game).map_err(err)
}

#[tauri::command]
pub async fn close_game(app: AppHandle) -> CmdResult<()> {
    app_windows::close_game(&app).map_err(err)
}
