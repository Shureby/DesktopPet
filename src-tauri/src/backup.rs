//! Backup and restore (`desktoppet_core::backup` makes and reads the file): Settings →
//! Backup in the panel, and a backup of its own every day (`<app data>/backups`, the last 7).

use std::path::{Component, Path, PathBuf};

use base64::Engine;
use chrono::{Local, TimeZone};
use desktoppet_core::backup::{self, BackupError, CharacterFile, Device, RestoreMode, RestoreParts, Snapshot, Summary};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::{characters_dir, e2e_enabled};
use crate::state::{now_ms, AppState};

type CmdResult<T> = Result<T, String>;

const EXTENSION: &str = "epetbackup";
/// Daily backups kept, and backups made before a restore.
const KEEP_DAILY: usize = 7;
const KEEP_BEFORE_RESTORE: usize = 3;
/// A character's file bigger than this isn't backed up (images and sounds are small).
const MAX_CHARACTER_FILE: u64 = 20_000_000;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn backups_dir<R: Runtime>(app: &AppHandle<R>) -> CmdResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(err)?.join("backups");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// This computer's name ("HOME-PC") and system, to tell backups apart.
fn device() -> Device {
    let name = std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| {
            #[cfg(target_os = "macos")]
            {
                std::process::Command::new("scutil")
                    .args(["--get", "ComputerName"])
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
            }
            #[cfg(not(target_os = "macos"))]
            {
                std::fs::read_to_string("/etc/hostname").ok()
            }
        })
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "This computer".into());
    Device { name, os: std::env::consts::OS.into() }
}

/// The user's own characters: each folder with a character.json, its JSON, images and sounds.
fn character_files<R: Runtime>(app: &AppHandle<R>) -> Vec<CharacterFile> {
    let Ok(dir) = app.path().app_data_dir().map(|d| d.join("characters")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let Ok(folders) = std::fs::read_dir(&dir) else {
        return out;
    };
    for folder in folders.flatten() {
        let path = folder.path();
        if !path.join("character.json").is_file() {
            continue;
        }
        let name = folder.file_name().to_string_lossy().into_owned();
        let Ok(files) = std::fs::read_dir(&path) else { continue };
        for file in files.flatten() {
            let fp = file.path();
            let ext = fp.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
            let wanted = ["json", "png", "webp", "ogg", "mp3", "wav"].contains(&ext.as_str());
            if !wanted || !fp.metadata().is_ok_and(|m| m.is_file() && m.len() < MAX_CHARACTER_FILE) {
                continue;
            }
            if let Ok(bytes) = std::fs::read(&fp) {
                out.push(CharacterFile {
                    path: format!("{name}/{}", file.file_name().to_string_lossy()),
                    data: base64::engine::general_purpose::STANDARD.encode(bytes),
                });
            }
        }
    }
    out
}

fn snapshot<R: Runtime>(app: &AppHandle<R>) -> CmdResult<Snapshot> {
    let version = app.package_info().version.to_string();
    let mut s = app.state::<AppState>().store().snapshot(&version, device(), now_ms()).map_err(err)?;
    s.characters = character_files(app);
    Ok(s)
}

fn write_backup<R: Runtime>(app: &AppHandle<R>, path: &Path, password: Option<&str>) -> CmdResult<()> {
    let bytes = backup::encode(&snapshot(app)?, password).map_err(err)?;
    // Written beside it first: a failed write never leaves half a backup under the name.
    let part = path.with_extension("part");
    std::fs::write(&part, bytes).map_err(err)?;
    std::fs::rename(&part, path).map_err(err)
}

fn local_stamp(fmt: &str) -> String {
    Local.timestamp_millis_opt(now_ms()).single().map(|t| t.format(fmt).to_string()).unwrap_or_default()
}

/// Keeps the newest `keep` backups whose names start with `prefix`.
fn prune(dir: &Path, prefix: &str, keep: usize) {
    let mut names: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(prefix)))
        .collect();
    // The names carry the date (and time): sorting them sorts by age.
    names.sort();
    for old in names.iter().rev().skip(keep) {
        let _ = std::fs::remove_file(old);
    }
}

/// Today's automatic backup, if there isn't one yet (from the scheduler, once a start).
pub fn auto_backup<R: Runtime>(app: &AppHandle<R>) {
    let run = || -> CmdResult<()> {
        let dir = backups_dir(app)?;
        let path = dir.join(format!("auto-{}.{EXTENSION}", local_stamp("%Y-%m-%d")));
        if path.exists() {
            return Ok(());
        }
        write_backup(app, &path, None)?;
        prune(&dir, "auto-", KEEP_DAILY);
        Ok(())
    };
    if let Err(e) = run() {
        log::error!("automatic backup failed: {e}");
    }
}

/// "Export backup…": asks where to save it (end-to-end tests pass `path`); None if cancelled.
#[tauri::command]
pub async fn backup_export(
    app: AppHandle,
    password: Option<String>,
    path: Option<String>,
) -> CmdResult<Option<String>> {
    let path = match path.filter(|_| e2e_enabled()) {
        Some(p) => PathBuf::from(p),
        None => {
            let picked = app
                .dialog()
                .file()
                .set_title("Export ePet backup")
                .set_file_name(format!("ePet backup {}.{EXTENSION}", local_stamp("%Y-%m-%d")))
                .add_filter("ePet backup", &[EXTENSION])
                .blocking_save_file();
            match picked {
                Some(p) => p.into_path().map_err(err)?,
                None => return Ok(None),
            }
        }
    };
    write_backup(&app, &path, password.as_deref())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOpened {
    /// "ok", "cancelled", "needsPassword" or "wrongPassword".
    status: &'static str,
    path: Option<String>,
    summary: Option<Summary>,
}

/// Reads a backup to restore (asks which, unless `path`): what it holds, or that it needs
/// a (different) password. Kept until restored or another is opened.
#[tauri::command]
pub async fn backup_open(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
    password: Option<String>,
) -> CmdResult<BackupOpened> {
    let path = match path {
        Some(p) => PathBuf::from(p),
        None => {
            let picked = app
                .dialog()
                .file()
                .set_title("Restore ePet backup")
                .add_filter("ePet backup", &[EXTENSION])
                .blocking_pick_file();
            match picked {
                Some(p) => p.into_path().map_err(err)?,
                None => return Ok(BackupOpened { status: "cancelled", path: None, summary: None }),
            }
        }
    };
    let shown = Some(path.to_string_lossy().into_owned());
    let bytes = std::fs::read(&path).map_err(err)?;
    match backup::decode(&bytes, password.as_deref()) {
        Ok(snapshot) => {
            let summary = backup::summary(&snapshot);
            *state.opened_backup.lock().unwrap_or_else(|e| e.into_inner()) = Some(snapshot);
            Ok(BackupOpened { status: "ok", path: shown, summary: Some(summary) })
        }
        Err(BackupError::NeedsPassword) => Ok(BackupOpened { status: "needsPassword", path: shown, summary: None }),
        Err(BackupError::WrongPassword) => Ok(BackupOpened { status: "wrongPassword", path: shown, summary: None }),
        Err(e) => Err(e.to_string()),
    }
}

/// Restores the chosen parts of the backup last opened: first a backup of this computer as
/// it is, then the restore, then ePet starts again (every window reads the data afresh).
/// End-to-end tests pass `restart: false` and start it again themselves.
#[tauri::command]
pub async fn backup_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    parts: RestoreParts,
    mode: RestoreMode,
    restart: Option<bool>,
) -> CmdResult<()> {
    let Some(snapshot) = state.opened_backup.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        return Err("open a backup first".into());
    };
    let dir = backups_dir(&app)?;
    let before = dir.join(format!("before-restore-{}.{EXTENSION}", local_stamp("%Y-%m-%d-%H%M%S")));
    write_backup(&app, &before, None)?;
    prune(&dir, "before-restore-", KEEP_BEFORE_RESTORE);

    state.store().restore(&snapshot, parts, mode).map_err(err)?;
    if parts.characters {
        restore_characters(&app, &snapshot.characters)?;
    }
    if restart.unwrap_or(true) {
        // A moment for the reply to reach the panel.
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            app.restart();
        });
    }
    Ok(())
}

/// Writes the backup's characters; a folder already here of the same name is kept beside
/// it as "<name>.bak" (one, the latest).
fn restore_characters(app: &AppHandle, files: &[CharacterFile]) -> CmdResult<()> {
    let dir = characters_dir(app)?;
    let mut moved = std::collections::HashSet::new();
    for f in files {
        // Only plain "folder/file" paths: nothing outside the characters folder.
        let rel = Path::new(&f.path);
        let parts: Vec<_> = rel.components().collect();
        if parts.len() != 2 || !parts.iter().all(|c| matches!(c, Component::Normal(_))) {
            continue;
        }
        let folder = parts[0].as_os_str().to_string_lossy().into_owned();
        if moved.insert(folder.clone()) {
            let here = dir.join(&folder);
            if here.exists() {
                let bak = dir.join(format!("{folder}.bak"));
                let _ = std::fs::remove_dir_all(&bak);
                std::fs::rename(&here, &bak).map_err(err)?;
            }
            std::fs::create_dir_all(&here).map_err(err)?;
        }
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&f.data) else { continue };
        std::fs::write(dir.join(rel), bytes).map_err(err)?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedBackup {
    path: String,
    /// "auto" (daily) or "beforeRestore".
    kind: &'static str,
    made_at: i64,
    size: u64,
}

/// The backups ePet made itself, newest first.
#[tauri::command]
pub fn backup_list_auto(app: AppHandle) -> CmdResult<Vec<SavedBackup>> {
    let mut out: Vec<SavedBackup> = std::fs::read_dir(backups_dir(&app)?)
        .map_err(err)?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(&format!(".{EXTENSION}")) {
                return None;
            }
            let kind = if name.starts_with("auto-") {
                "auto"
            } else if name.starts_with("before-restore-") {
                "beforeRestore"
            } else {
                return None;
            };
            let meta = e.metadata().ok()?;
            let made_at = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            Some(SavedBackup { path: e.path().to_string_lossy().into_owned(), kind, made_at, size: meta.len() })
        })
        .collect();
    out.sort_by_key(|b| std::cmp::Reverse(b.made_at));
    Ok(out)
}
