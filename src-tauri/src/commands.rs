//! Commands invoked from the web UI (`src/platform/tauri.ts` mirrors these names).

use std::sync::atomic::Ordering;

use chrono::Local;
use desktoppet_core::{pomodoro, Alarm, DayStat, PomodoroStatus, Repeat, Score, Todo, TodoPatch};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};
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
    state.store().update_todo(id, &patch).map_err(err)?;
    let _ = app.emit("todos-changed", ());
    Ok(())
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
pub fn add_alarm(app: AppHandle, state: State<AppState>, label: String, at: i64, repeat: Repeat) -> CmdResult<Alarm> {
    let alarm = state.store().add_alarm(&Local, &label, at, repeat).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(alarm)
}

#[tauri::command]
pub fn set_alarm_enabled(app: AppHandle, state: State<AppState>, id: i64, enabled: bool) -> CmdResult<()> {
    state.store().set_alarm_enabled(&Local, id, enabled, now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

#[tauri::command]
pub fn snooze_alarm(app: AppHandle, state: State<AppState>, id: i64, minutes: i64) -> CmdResult<()> {
    state.store().snooze_alarm(id, minutes.clamp(1, 24 * 60), now_ms()).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

#[tauri::command]
pub fn delete_alarm(app: AppHandle, state: State<AppState>, id: i64) -> CmdResult<()> {
    state.store().delete_alarm(id).map_err(err)?;
    let _ = app.emit("alarms-changed", ());
    Ok(())
}

// --- Tomato clock ---------------------------------------------------------------

pub fn start_pomodoro(state: &AppState, now: i64) -> CmdResult<PomodoroStatus> {
    let store = state.store();
    let status = pomodoro::start_focus(now, &store.pomodoro_config().map_err(err)?, 0);
    store.set_pomodoro(&status, now).map_err(err)?;
    Ok(status)
}

fn set_pomodoro(
    app: &AppHandle,
    state: &AppState,
    f: impl FnOnce(&PomodoroStatus, i64, &desktoppet_core::PomodoroConfig) -> PomodoroStatus,
) -> CmdResult<PomodoroStatus> {
    let now = now_ms();
    let status = {
        let store = state.store();
        let next = f(&store.pomodoro_status().map_err(err)?, now, &store.pomodoro_config().map_err(err)?);
        store.set_pomodoro(&next, now).map_err(err)?;
        next
    };
    let _ = app.emit("pomodoro", status);
    Ok(status)
}

#[tauri::command]
pub fn pomodoro_start(app: AppHandle, state: State<AppState>) -> CmdResult<PomodoroStatus> {
    set_pomodoro(&app, &state, |_, now, c| pomodoro::start_focus(now, c, 0))
}

#[tauri::command]
pub fn pomodoro_skip(app: AppHandle, state: State<AppState>) -> CmdResult<PomodoroStatus> {
    set_pomodoro(&app, &state, pomodoro::next_phase)
}

#[tauri::command]
pub fn pomodoro_stop(app: AppHandle, state: State<AppState>) -> CmdResult<PomodoroStatus> {
    set_pomodoro(&app, &state, |_, _, _| PomodoroStatus::default())
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

/// Called every frame: moves the pet window, toggles click-through, returns the cursor.
#[tauri::command]
pub fn pet_frame(
    app: AppHandle,
    state: State<AppState>,
    x: f64,
    y: f64,
    ignore_cursor: bool,
) -> CmdResult<Option<Point>> {
    let pet = app.get_webview_window(PET).ok_or("pet window missing")?;
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
