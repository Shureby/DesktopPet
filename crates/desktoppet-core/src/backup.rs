//! Backups (`.epetbackup`): everything ePet keeps, in one file, to restore on this computer
//! or another. The file is a gzipped JSON snapshot, encrypted with a password if one is given
//! (Argon2id for the key, XChaCha20-Poly1305 for the data).
//!
//! Restoring merges by default: alarms, to-dos and anniversaries are matched by their uid and
//! the one changed last wins; what the backup deleted (its tombstones) goes unless it changed
//! here since. A restore is the user asking for what's in the backup, so this computer's own
//! tombstones don't keep anything out. Timers belong to the computer they were set on: kept in
//! the backup, never restored.

use std::collections::HashMap;
use std::io::{Read, Write};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rusqlite::types::ValueRef;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::model::Millis;
use crate::store::{Result, Store, StoreError, SYNCED, TIMER_PREFIX};

/// The snapshot format this version writes; newer ones are refused.
pub const FORMAT: u32 = 1;

const MAGIC: &[u8; 8] = b"EPETBAK1";
const PLAIN: u8 = 0;
const ENCRYPTED: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;

/// Argon2id cost: memory in KiB, passes, lanes. Stored in each file, so it can change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfCost {
    pub memory_kib: u32,
    pub passes: u32,
    pub lanes: u32,
}

impl Default for KdfCost {
    fn default() -> Self {
        Self { memory_kib: 64 * 1024, passes: 3, lanes: 1 }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BackupError {
    #[error("this isn't an ePet backup")]
    NotABackup,
    #[error("this backup was made by a newer ePet; update ePet to restore it")]
    TooNew,
    #[error("this backup has a password")]
    NeedsPassword,
    #[error("wrong password")]
    WrongPassword,
    #[error("the backup is damaged: {0}")]
    Damaged(String),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub name: String,
    pub os: String,
}

/// A deleted alarm, to-do or anniversary.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub kind: String,
    pub uid: String,
    pub deleted_at: Millis,
}

/// An anniversary reminder's to-do already made for a year (`anniversary_preps_made`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrepMade {
    pub anniversary_uid: String,
    pub prep: String,
    pub occurrence: String,
}

/// Rows are kept as column → value, so a backup outlives schema changes: a restore writes the
/// columns this version has and leaves the rest to their defaults.
pub type Row = Map<String, Value>;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub alarms: Vec<Row>,
    pub todos: Vec<Row>,
    pub anniversaries: Vec<Row>,
    pub preps_made: Vec<PrepMade>,
    pub tombstones: Vec<Tombstone>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pet {
    /// Each character's mood, by character id.
    pub moods: Map<String, Value>,
    pub scores: Vec<Row>,
    pub achievements: Vec<Row>,
    pub focus_sessions: Vec<Row>,
}

/// A file of a character the user added (under the characters folder), base64.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterFile {
    pub path: String,
    pub data: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub format: u32,
    pub app_version: String,
    pub made_at: Millis,
    pub device: Device,
    pub schedule: Schedule,
    /// This computer's settings (each computer keeps its own; restoring them is a choice).
    pub settings: Value,
    pub pet: Pet,
    pub characters: Vec<CharacterFile>,
}

/// What a backup holds, shown before restoring it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub app_version: String,
    pub made_at: Millis,
    pub device: Device,
    pub alarms: usize,
    pub timers: usize,
    pub todos: usize,
    pub anniversaries: usize,
    /// Characters the user added (folders).
    pub characters: usize,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RestoreMode {
    /// Alongside what's here; the newer of each wins.
    #[default]
    Merge,
    /// Instead of what's here (this computer's timers stay).
    Replace,
}

/// What to restore (the characters' files are written by the app, not the store).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreParts {
    pub schedule: bool,
    pub settings: bool,
    pub pet: bool,
    pub characters: bool,
}

// --- The file ------------------------------------------------------------------

/// The backup file's bytes; encrypted when a password is given.
pub fn encode(snapshot: &Snapshot, password: Option<&str>) -> std::result::Result<Vec<u8>, BackupError> {
    encode_with(snapshot, password, KdfCost::default())
}

pub fn encode_with(
    snapshot: &Snapshot,
    password: Option<&str>,
    cost: KdfCost,
) -> std::result::Result<Vec<u8>, BackupError> {
    let json = serde_json::to_vec(snapshot).map_err(|e| BackupError::Damaged(e.to_string()))?;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&json).and_then(|_| gz.flush()).map_err(|e| BackupError::Damaged(e.to_string()))?;
    let packed = gz.finish().map_err(|e| BackupError::Damaged(e.to_string()))?;

    let mut out = MAGIC.to_vec();
    match password.filter(|p| !p.is_empty()) {
        None => {
            out.push(PLAIN);
            out.extend(packed);
        }
        Some(password) => {
            let mut salt = [0u8; SALT_LEN];
            getrandom::getrandom(&mut salt).map_err(|e| BackupError::Damaged(e.to_string()))?;
            let cipher = cipher(password, &salt, cost)?;
            let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
            let sealed = cipher.encrypt(&nonce, packed.as_slice()).map_err(|e| BackupError::Damaged(e.to_string()))?;
            out.push(ENCRYPTED);
            for n in [cost.memory_kib, cost.passes, cost.lanes] {
                out.extend(n.to_le_bytes());
            }
            out.extend(salt);
            out.extend(nonce.as_slice());
            out.extend(sealed);
        }
    }
    Ok(out)
}

/// Whether these bytes are a backup that needs a password (None: not a backup at all).
pub fn is_encrypted(bytes: &[u8]) -> Option<bool> {
    (bytes.len() > MAGIC.len() && bytes.starts_with(MAGIC)).then(|| bytes[MAGIC.len()] == ENCRYPTED)
}

pub fn decode(bytes: &[u8], password: Option<&str>) -> std::result::Result<Snapshot, BackupError> {
    let encrypted = is_encrypted(bytes).ok_or(BackupError::NotABackup)?;
    let body = &bytes[MAGIC.len() + 1..];
    let packed = if encrypted {
        let password = password.filter(|p| !p.is_empty()).ok_or(BackupError::NeedsPassword)?;
        let head = 12 + SALT_LEN + NONCE_LEN;
        if body.len() < head {
            return Err(BackupError::Damaged("too short".into()));
        }
        let n = |i: usize| u32::from_le_bytes(body[i * 4..i * 4 + 4].try_into().unwrap_or_default());
        let cost = KdfCost { memory_kib: n(0), passes: n(1), lanes: n(2) };
        let salt = &body[12..12 + SALT_LEN];
        let nonce = XNonce::from_slice(&body[12 + SALT_LEN..head]);
        cipher(password, salt, cost)?.decrypt(nonce, &body[head..]).map_err(|_| BackupError::WrongPassword)?
    } else {
        body.to_vec()
    };
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(packed.as_slice())
        .read_to_end(&mut json)
        .map_err(|e| BackupError::Damaged(e.to_string()))?;
    let snapshot: Snapshot = serde_json::from_slice(&json).map_err(|e| BackupError::Damaged(e.to_string()))?;
    if snapshot.format > FORMAT {
        return Err(BackupError::TooNew);
    }
    Ok(snapshot)
}

fn cipher(password: &str, salt: &[u8], cost: KdfCost) -> std::result::Result<XChaCha20Poly1305, BackupError> {
    let params = Params::new(cost.memory_kib, cost.passes, cost.lanes, Some(32))
        .map_err(|e| BackupError::Damaged(e.to_string()))?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| BackupError::Damaged(e.to_string()))?;
    Ok(XChaCha20Poly1305::new(&key.into()))
}

/// What a snapshot holds.
pub fn summary(s: &Snapshot) -> Summary {
    let timer = |r: &Row| r.get("label").and_then(Value::as_str).is_some_and(|l| l.starts_with(TIMER_PREFIX));
    let folders: std::collections::BTreeSet<&str> =
        s.characters.iter().filter_map(|f| f.path.split('/').next()).filter(|d| !d.is_empty()).collect();
    Summary {
        app_version: s.app_version.clone(),
        made_at: s.made_at,
        device: s.device.clone(),
        alarms: s.schedule.alarms.iter().filter(|r| !timer(r)).count(),
        timers: s.schedule.alarms.iter().filter(|r| timer(r)).count(),
        todos: s.schedule.todos.iter().filter(|r| r.get("done").and_then(Value::as_i64) != Some(1)).count(),
        anniversaries: s.schedule.anniversaries.len(),
        characters: folders.len(),
    }
}

// --- The store ----------------------------------------------------------------------

/// Moods are kept per character under these keys.
const MOOD_PREFIX: &str = "mood:";

fn to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
    }
}

fn to_sql(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match v {
        Value::Null => V::Null,
        Value::Bool(b) => V::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(V::Integer).unwrap_or_else(|| V::Real(n.as_f64().unwrap_or_default())),
        Value::String(s) => V::Text(s.clone()),
        other => V::Text(other.to_string()),
    }
}

impl Store {
    fn rows(&self, sql: &str) -> Result<Vec<Row>> {
        let mut stmt = self.conn.prepare(sql)?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rows = stmt.query_map([], |r| {
            let mut row = Row::new();
            for (i, name) in names.iter().enumerate() {
                row.insert(name.clone(), to_json(r.get_ref(i)?));
            }
            Ok(row)
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn columns(&self, table: &str) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn uid_of(&self, table: &str, id: i64) -> Result<Option<String>> {
        Ok(self.conn.query_row(&format!("SELECT uid FROM {table} WHERE id = ?1"), [id], |r| r.get(0)).optional()?)
    }

    fn id_of(&self, table: &str, uid: &str) -> Result<Option<i64>> {
        Ok(self.conn.query_row(&format!("SELECT id FROM {table} WHERE uid = ?1"), [uid], |r| r.get(0)).optional()?)
    }

    /// Everything but the characters' files (the app adds those) as a snapshot.
    pub fn snapshot(&self, app_version: &str, device: Device, now: Millis) -> Result<Snapshot> {
        let mut todos = self.rows("SELECT * FROM todos ORDER BY id")?;
        // A ticked-off time of a repeating to-do points at its to-do: by uid across computers.
        for t in &mut todos {
            if let Some(parent) = t.get("repeat_of").and_then(Value::as_i64) {
                if let Some(uid) = self.uid_of("todos", parent)? {
                    t.insert("repeat_of_uid".into(), Value::from(uid));
                }
            }
        }
        let preps_made = {
            let mut stmt = self.conn.prepare(
                "SELECT a.uid, p.prep, p.occurrence FROM anniversary_preps_made p JOIN anniversaries a ON a.id = p.anniversary_id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(PrepMade { anniversary_uid: r.get(0)?, prep: r.get(1)?, occurrence: r.get(2)? })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let tombstones = {
            let mut stmt = self.conn.prepare("SELECT kind, uid, deleted_at FROM tombstones")?;
            let rows =
                stmt.query_map([], |r| Ok(Tombstone { kind: r.get(0)?, uid: r.get(1)?, deleted_at: r.get(2)? }))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut moods = Map::new();
        {
            let mut stmt = self.conn.prepare("SELECT key, value FROM kv WHERE key LIKE 'mood:%'")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (key, value) = row?;
                if let Ok(v) = serde_json::from_str(&value) {
                    moods.insert(key.trim_start_matches(MOOD_PREFIX).to_string(), v);
                }
            }
        }
        Ok(Snapshot {
            format: FORMAT,
            app_version: app_version.to_string(),
            made_at: now,
            device,
            schedule: Schedule {
                alarms: self.rows("SELECT * FROM alarms ORDER BY id")?,
                todos,
                anniversaries: self.rows("SELECT * FROM anniversaries ORDER BY id")?,
                preps_made,
                tombstones,
            },
            settings: self.settings()?,
            pet: Pet {
                moods,
                scores: self.rows("SELECT game, character, score, at FROM scores ORDER BY id")?,
                achievements: self.rows("SELECT id, unlocked_at FROM achievements")?,
                focus_sessions: self.rows("SELECT ended_at, minutes, completed FROM focus_sessions ORDER BY id")?,
            },
            characters: Vec::new(),
        })
    }

    /// Restores the chosen parts of a snapshot, all or nothing.
    pub fn restore(&self, s: &Snapshot, parts: RestoreParts, mode: RestoreMode) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        if parts.schedule {
            self.restore_schedule(&s.schedule, mode)?;
        }
        if parts.settings && s.settings.is_object() {
            // Starting with the computer is this computer's own business.
            let mut settings = s.settings.clone();
            let here = self.settings()?;
            match here.get("autostart") {
                Some(v) => settings["autostart"] = v.clone(),
                None => {
                    settings.as_object_mut().map(|o| o.remove("autostart"));
                }
            }
            self.set_settings(&settings)?;
        }
        if parts.pet {
            self.restore_pet(&s.pet)?;
        }
        tx.commit()?;
        Ok(())
    }

    fn restore_schedule(&self, s: &Schedule, mode: RestoreMode) -> Result<()> {
        if mode == RestoreMode::Replace {
            self.conn.execute_batch(&format!(
                "DELETE FROM alarms WHERE label NOT LIKE '{TIMER_PREFIX}%';
                 DELETE FROM todos; DELETE FROM anniversaries; DELETE FROM anniversary_preps_made;
                 DELETE FROM unseen WHERE kind != 'timer';"
            ))?;
        }
        for (table, kind) in SYNCED {
            let rows = match table {
                "alarms" => &s.alarms,
                "todos" => &s.todos,
                _ => &s.anniversaries,
            };
            let columns = self.columns(table)?;
            for row in rows {
                if table == "alarms"
                    && row.get("label").and_then(Value::as_str).is_some_and(|l| l.starts_with(TIMER_PREFIX))
                {
                    continue;
                }
                self.restore_row(table, &columns, row)?;
            }
            // What the backup deleted goes, unless it changed here after that.
            for t in s.tombstones.iter().filter(|t| t.kind == kind) {
                self.conn.execute(
                    &format!("DELETE FROM {table} WHERE uid = ?1 AND COALESCE(updated_at, 0) < ?2"),
                    params![t.uid, t.deleted_at],
                )?;
            }
        }
        // References by uid back to this computer's ids.
        for t in &s.todos {
            let Some(uid) = t.get("uid").and_then(Value::as_str) else { continue };
            let parent = match t.get("repeat_of_uid").and_then(Value::as_str) {
                Some(p) => self.id_of("todos", p)?,
                None => None,
            };
            // Only rows the backup wrote (a newer one here keeps its own).
            self.conn.execute(
                "UPDATE todos SET repeat_of = ?2 WHERE uid = ?1 AND updated_at = ?3",
                params![uid, parent, t.get("updated_at").and_then(Value::as_i64)],
            )?;
        }
        for p in &s.preps_made {
            if let Some(id) = self.id_of("anniversaries", &p.anniversary_uid)? {
                self.conn.execute(
                    "INSERT OR IGNORE INTO anniversary_preps_made (anniversary_id, prep, occurrence) VALUES (?1, ?2, ?3)",
                    params![id, p.prep, p.occurrence],
                )?;
            }
        }
        Ok(())
    }

    /// One row: inserted if new here, written over this computer's if the backup's is newer.
    fn restore_row(&self, table: &str, columns: &[String], row: &Row) -> Result<()> {
        let Some(uid) = row.get("uid").and_then(Value::as_str) else {
            return Ok(());
        };
        let theirs = row.get("updated_at").and_then(Value::as_i64).unwrap_or(0);
        let ours: Option<(i64, Option<i64>)> = self
            .conn
            .query_row(&format!("SELECT id, updated_at FROM {table} WHERE uid = ?1"), [uid], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        // Only this version's columns; ids are this computer's own.
        // repeat_of points at this computer's ids: set from repeat_of_uid afterwards.
        let cols: Vec<&String> =
            columns.iter().filter(|c| *c != "id" && *c != "repeat_of" && row.contains_key(c.as_str())).collect();
        let values: Vec<rusqlite::types::Value> = cols.iter().map(|c| to_sql(&row[c.as_str()])).collect();
        match ours {
            Some((_, Some(mine))) if mine >= theirs => {}
            Some((id, _)) => {
                let set: Vec<String> = cols.iter().enumerate().map(|(i, c)| format!("{c} = ?{}", i + 2)).collect();
                let mut args: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Integer(id)];
                args.extend(values);
                self.conn.execute(
                    &format!("UPDATE {table} SET {} WHERE id = ?1", set.join(", ")),
                    rusqlite::params_from_iter(args),
                )?;
            }
            None => {
                let names: Vec<&str> = cols.iter().map(|c| c.as_str()).collect();
                let marks: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();
                self.conn.execute(
                    &format!("INSERT INTO {table} ({}) VALUES ({})", names.join(", "), marks.join(", ")),
                    rusqlite::params_from_iter(values),
                )?;
            }
        }
        // Back from the backup: no longer deleted here.
        let kind = SYNCED.iter().find(|(t, _)| *t == table).map(|(_, k)| *k).unwrap_or_default();
        self.conn.execute("DELETE FROM tombstones WHERE kind = ?1 AND uid = ?2", params![kind, uid])?;
        Ok(())
    }

    fn restore_pet(&self, p: &Pet) -> Result<()> {
        for (character, mood) in &p.moods {
            self.set_kv(&format!("{MOOD_PREFIX}{character}"), &mood.to_string())?;
        }
        let int = |r: &Row, k: &str| r.get(k).and_then(Value::as_i64);
        for r in &p.scores {
            let (Some(game), Some(character)) =
                (r.get("game").and_then(Value::as_str), r.get("character").and_then(Value::as_str))
            else {
                continue;
            };
            let (score, at) = (int(r, "score").unwrap_or(0), int(r, "at").unwrap_or(0));
            self.conn.execute(
                "INSERT INTO scores (game, character, score, at) SELECT ?1, ?2, ?3, ?4
                 WHERE NOT EXISTS (SELECT 1 FROM scores WHERE game = ?1 AND character = ?2 AND score = ?3 AND at = ?4)",
                params![game, character, score, at],
            )?;
        }
        for r in &p.achievements {
            if let Some(id) = r.get("id").and_then(Value::as_str) {
                self.conn.execute(
                    "INSERT OR IGNORE INTO achievements (id, unlocked_at) VALUES (?1, ?2)",
                    params![id, int(r, "unlocked_at").unwrap_or(0)],
                )?;
            }
        }
        for r in &p.focus_sessions {
            let Some(ended) = int(r, "ended_at") else { continue };
            let minutes = r.get("minutes").and_then(Value::as_f64).unwrap_or(0.0);
            self.conn.execute(
                "INSERT INTO focus_sessions (ended_at, minutes, completed) SELECT ?1, ?2, ?3
                 WHERE NOT EXISTS (SELECT 1 FROM focus_sessions WHERE ended_at = ?1)",
                params![ended, minutes, int(r, "completed").unwrap_or(0)],
            )?;
        }
        Ok(())
    }

    /// The tombstones, oldest first (for tests and, later, syncing).
    pub fn tombstones(&self) -> Result<Vec<Tombstone>> {
        let mut stmt = self.conn.prepare("SELECT kind, uid, deleted_at FROM tombstones ORDER BY deleted_at")?;
        let rows = stmt.query_map([], |r| Ok(Tombstone { kind: r.get(0)?, uid: r.get(1)?, deleted_at: r.get(2)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Each row's uid by its id, for one of the synced tables.
    pub fn uids(&self, table: &str) -> Result<HashMap<i64, String>> {
        if !SYNCED.iter().any(|(t, _)| *t == table) {
            return Err(StoreError::Invalid(format!("no uids in {table}")));
        }
        let mut stmt = self.conn.prepare(&format!("SELECT id, uid FROM {table}"))?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use chrono::TimeZone;
    use chrono_tz::Europe::London;

    /// Cheap enough for tests (debug builds).
    const CHEAP: KdfCost = KdfCost { memory_kib: 64, passes: 1, lanes: 1 };

    fn at(h: u32, m: u32) -> Millis {
        London.with_ymd_and_hms(2026, 1, 7, h, m, 0).unwrap().timestamp_millis()
    }

    fn todo(title: &str) -> NewTodo {
        NewTodo { title: title.into(), due_at: Some(at(18, 0)), ..Default::default() }
    }

    fn device() -> Device {
        Device { name: "HOME-PC".into(), os: "windows".into() }
    }

    fn titles(s: &Store) -> Vec<String> {
        let mut t: Vec<String> = s.list_todos().unwrap().into_iter().map(|t| t.title).collect();
        t.sort();
        t
    }

    fn all() -> RestoreParts {
        RestoreParts { schedule: true, settings: true, pet: true, characters: true }
    }

    #[test]
    fn rows_get_uids_and_change_times_and_deleting_leaves_a_tombstone() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_todo(&todo("Bins"), at(9, 0)).unwrap();
        let b = s.add_todo(&todo("Milk"), at(9, 0)).unwrap();
        let uids = s.uids("todos").unwrap();
        assert_eq!(uids[&a.id].len(), 32);
        assert_ne!(uids[&a.id], uids[&b.id]);
        let changed = |id| -> Millis {
            s.conn.query_row("SELECT updated_at FROM todos WHERE id = ?1", [id], |r| r.get(0)).unwrap()
        };
        s.conn.execute("UPDATE todos SET updated_at = 1 WHERE id = ?1", [a.id]).unwrap();
        assert_eq!(changed(a.id), 1);
        s.update_todo(&London, a.id, &TodoPatch { title: Some("Bins out".into()), ..Default::default() }, at(9, 5))
            .unwrap();
        assert!(changed(a.id) > 1, "an edit changes updated_at");
        s.delete_todo(b.id).unwrap();
        let gone = s.tombstones().unwrap();
        assert_eq!(gone.len(), 1);
        assert_eq!((gone[0].kind.as_str(), gone[0].uid.as_str()), ("todo", uids[&b.id].as_str()));
    }

    #[test]
    fn upgrading_gives_existing_rows_uids() {
        let dir = std::env::temp_dir().join(format!("desktoppet-v14-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.db");
        let _ = std::fs::remove_file(&path);
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            for (i, sql) in crate::store::MIGRATIONS.iter().take(13).enumerate() {
                conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", i + 1)).unwrap();
            }
            conn.execute("INSERT INTO todos (title, created_at) VALUES ('One', 5), ('Two', 6)", []).unwrap();
            conn.execute("INSERT INTO alarms (label, repeat, enabled) VALUES ('Alarm', 'none', 1)", []).unwrap();
        }
        let s = Store::open(&path).unwrap();
        let uids = s.uids("todos").unwrap();
        assert_eq!(uids.len(), 2);
        assert!(uids.values().all(|u| u.len() == 32));
        let changed: Vec<Millis> = s
            .rows("SELECT updated_at FROM todos ORDER BY id")
            .unwrap()
            .iter()
            .map(|r| r["updated_at"].as_i64().unwrap())
            .collect();
        assert_eq!(changed, vec![5, 6], "an old row's change time is when it was made");
        assert_eq!(s.uids("alarms").unwrap().len(), 1);
        drop(s);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_tombstones_go_in_the_daily_cleanup() {
        let s = Store::open_in_memory().unwrap();
        let t = s.add_todo(&todo("Bins"), at(9, 0)).unwrap();
        s.delete_todo(t.id).unwrap();
        let deleted = s.tombstones().unwrap()[0].deleted_at;
        s.daily_cleanup("a", 0, deleted + 89 * 86_400_000).unwrap();
        assert_eq!(s.tombstones().unwrap().len(), 1);
        s.daily_cleanup("b", 0, deleted + 91 * 86_400_000).unwrap();
        assert!(s.tombstones().unwrap().is_empty());
    }

    #[test]
    fn a_file_reads_back_the_same_and_a_password_is_needed() {
        let s = Store::open_in_memory().unwrap();
        s.add_todo(&todo("Bins"), at(9, 0)).unwrap();
        let snap = s.snapshot("0.35.0", device(), at(10, 0)).unwrap();

        let plain = encode(&snap, None).unwrap();
        assert_eq!(is_encrypted(&plain), Some(false));
        assert_eq!(decode(&plain, None).unwrap(), snap);

        let locked = encode_with(&snap, Some("hunter2"), CHEAP).unwrap();
        assert_eq!(is_encrypted(&locked), Some(true));
        assert!(!locked.windows(4).any(|w| w == b"Bins"), "nothing readable");
        assert_eq!(decode(&locked, None), Err(BackupError::NeedsPassword));
        assert_eq!(decode(&locked, Some("hunter3")), Err(BackupError::WrongPassword));
        assert_eq!(decode(&locked, Some("hunter2")).unwrap(), snap);

        assert_eq!(decode(b"PK\x03\x04 a zip", None), Err(BackupError::NotABackup));
        let mut newer = snap.clone();
        newer.format = FORMAT + 1;
        assert_eq!(decode(&encode(&newer, None).unwrap(), None), Err(BackupError::TooNew));
    }

    #[test]
    fn merging_brings_back_what_was_deleted_and_keeps_the_newer_of_each() {
        let s = Store::open_in_memory().unwrap();
        let bins = s.add_todo(&todo("Bins"), at(9, 0)).unwrap();
        let milk = s.add_todo(&todo("Milk"), at(9, 0)).unwrap();
        s.add_alarm(&London, "Timer: 5 min", at(9, 5), Repeat::None, 0, at(9, 0)).unwrap();
        let snap = s.snapshot("0.35.0", device(), at(10, 0)).unwrap();

        // Since the backup: Milk deleted, Bins renamed, Eggs added, the timer gone.
        s.delete_todo(milk.id).unwrap();
        s.update_todo(&London, bins.id, &TodoPatch { title: Some("Bins out".into()), ..Default::default() }, at(11, 0))
            .unwrap();
        s.add_todo(&todo("Eggs"), at(11, 0)).unwrap();
        let timer = s.list_alarms().unwrap()[0].id;
        s.delete_alarm(timer).unwrap();

        s.restore(&snap, all(), RestoreMode::Merge).unwrap();
        assert_eq!(titles(&s), vec!["Bins out", "Eggs", "Milk"], "newer edit kept, deleted one back, none twice");
        assert!(s.tombstones().unwrap().iter().all(|t| t.kind != "todo"), "Milk is no longer deleted");
        assert!(s.list_alarms().unwrap().is_empty(), "timers aren't restored");

        // Restoring again changes nothing.
        s.restore(&snap, all(), RestoreMode::Merge).unwrap();
        assert_eq!(titles(&s), vec!["Bins out", "Eggs", "Milk"]);
    }

    #[test]
    fn an_older_edit_here_gives_way_to_the_backup() {
        let s = Store::open_in_memory().unwrap();
        let bins = s.add_todo(&todo("Bins"), at(9, 0)).unwrap();
        let mut snap = s.snapshot("0.35.0", device(), at(10, 0)).unwrap();
        snap.schedule.todos[0]["title"] = Value::from("Bins (from home)");
        snap.schedule.todos[0]["updated_at"] = Value::from(i64::MAX / 2);
        s.restore(&snap, all(), RestoreMode::Merge).unwrap();
        assert_eq!(titles(&s), vec!["Bins (from home)"]);
        assert_eq!(s.list_todos().unwrap()[0].id, bins.id, "the same to-do, not a copy");
    }

    #[test]
    fn what_the_backup_deleted_goes_unless_it_changed_here_since() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_todo(&todo("Old"), at(9, 0)).unwrap();
        let b = s.add_todo(&todo("Kept"), at(9, 0)).unwrap();
        let uids = s.uids("todos").unwrap();
        s.conn.execute("UPDATE todos SET updated_at = 100 WHERE id = ?1", [a.id]).unwrap();
        s.conn.execute("UPDATE todos SET updated_at = 300 WHERE id = ?1", [b.id]).unwrap();
        let mut snap = Snapshot { format: FORMAT, ..Default::default() };
        for (id, uid) in [(a.id, &uids[&a.id]), (b.id, &uids[&b.id])] {
            let _ = id;
            snap.schedule.tombstones.push(Tombstone { kind: "todo".into(), uid: uid.clone(), deleted_at: 200 });
        }
        s.restore(&snap, all(), RestoreMode::Merge).unwrap();
        assert_eq!(titles(&s), vec!["Kept"]);
    }

    #[test]
    fn replacing_clears_the_schedule_but_keeps_this_computers_timers() {
        let s = Store::open_in_memory().unwrap();
        s.add_todo(&todo("From backup"), at(9, 0)).unwrap();
        let snap = s.snapshot("0.35.0", device(), at(10, 0)).unwrap();
        let other = Store::open_in_memory().unwrap();
        other.add_todo(&todo("Here only"), at(9, 0)).unwrap();
        other.add_alarm(&London, "Wake up", at(7, 0), Repeat::Daily, 0, at(6, 0)).unwrap();
        other.add_alarm(&London, "Timer: 5 min", at(9, 5), Repeat::None, 0, at(9, 0)).unwrap();
        other.restore(&snap, all(), RestoreMode::Replace).unwrap();
        assert_eq!(titles(&other), vec!["From backup"]);
        let labels: Vec<String> = other.list_alarms().unwrap().into_iter().map(|a| a.label).collect();
        assert_eq!(labels, vec!["Timer: 5 min"]);
    }

    #[test]
    fn references_follow_the_uids() {
        let s = Store::open_in_memory().unwrap();
        // A ticked-off time of a weekly to-do, and an anniversary whose reminder made its to-do.
        let weekly = s
            .add_todo(
                &NewTodo {
                    title: "Bins".into(),
                    due_at: Some(at(18, 0)),
                    repeat: TodoRepeat::Weekly,
                    ..Default::default()
                },
                at(9, 0),
            )
            .unwrap();
        s.update_todo(&London, weekly.id, &TodoPatch { done: Some(true), ..Default::default() }, at(18, 5)).unwrap();
        let ann = s
            .add_anniversary(
                &NewAnniversary {
                    kind: "birthday".into(),
                    icon: "🎂".into(),
                    name: "Mum".into(),
                    month: 1,
                    day: 8,
                    since: None,
                    preps: vec![AnniversaryPrep { lead: "1d".into(), label: "Cake".into() }],
                    effect: true,
                    music: None,
                },
                at(9, 0),
            )
            .unwrap();
        s.tick_anniversaries(&London, at(9, 0)).unwrap();
        let snap = s.snapshot("0.35.0", device(), at(19, 0)).unwrap();
        assert_eq!(snap.schedule.preps_made.len(), 1, "the cake to-do was made");

        // Into an empty computer whose ids start elsewhere.
        let other = Store::open_in_memory().unwrap();
        for i in 0..5 {
            let t = other.add_todo(&todo(&format!("x{i}")), at(9, 0)).unwrap();
            other.delete_todo(t.id).unwrap();
        }
        other
            .add_anniversary(&NewAnniversary { name: "Filler".into(), month: 2, day: 2, ..ann_like() }, at(9, 0))
            .unwrap();
        other.restore(&snap, all(), RestoreMode::Merge).unwrap();
        let logged = other.list_todos().unwrap().into_iter().find(|t| t.done && t.title == "Bins").unwrap();
        let parent: Option<i64> =
            other.conn.query_row("SELECT repeat_of FROM todos WHERE id = ?1", [logged.id], |r| r.get(0)).unwrap();
        let weekly_here = other.list_todos().unwrap().into_iter().find(|t| !t.done && t.title == "Bins").unwrap();
        assert_eq!(parent, Some(weekly_here.id));
        let mum = other.list_anniversaries().unwrap().into_iter().find(|a| a.name == "Mum").unwrap();
        let made: i64 = other
            .conn
            .query_row("SELECT COUNT(*) FROM anniversary_preps_made WHERE anniversary_id = ?1", [mum.id], |r| r.get(0))
            .unwrap();
        assert_eq!(made, 1);
        let _ = ann;
    }

    fn ann_like() -> NewAnniversary {
        NewAnniversary {
            kind: "birthday".into(),
            icon: "🎂".into(),
            name: String::new(),
            month: 1,
            day: 1,
            since: None,
            preps: vec![],
            effect: true,
            music: None,
        }
    }

    #[test]
    fn settings_keep_this_computers_autostart_and_the_pet_merges() {
        let home = Store::open_in_memory().unwrap();
        home.set_settings(&serde_json::json!({ "size": 2, "autostart": true })).unwrap();
        home.set_kv("mood:cat", r#"{"love":80}"#).unwrap();
        home.record_score("catch", "cat", 12, 1).unwrap();
        home.unlock_achievement("first-catch", 1).unwrap();
        let snap = home.snapshot("0.35.0", device(), at(10, 0)).unwrap();

        let work = Store::open_in_memory().unwrap();
        work.set_settings(&serde_json::json!({ "size": 1, "autostart": false })).unwrap();
        work.record_score("catch", "cat", 30, 2).unwrap();
        work.restore(&snap, all(), RestoreMode::Merge).unwrap();
        work.restore(&snap, all(), RestoreMode::Merge).unwrap();
        assert_eq!(work.settings().unwrap(), serde_json::json!({ "size": 2, "autostart": false }));
        assert_eq!(work.get_kv("mood:cat").unwrap().as_deref(), Some(r#"{"love":80}"#));
        let scores: Vec<i64> = work.top_scores("catch", 10).unwrap().into_iter().map(|s| s.score).collect();
        assert_eq!(scores, vec![30, 12], "both, once each");
        assert_eq!(work.achievements().unwrap(), vec!["first-catch"]);

        // Settings not chosen: untouched.
        let other = Store::open_in_memory().unwrap();
        other.set_settings(&serde_json::json!({ "size": 3 })).unwrap();
        other.restore(&snap, RestoreParts { schedule: true, ..Default::default() }, RestoreMode::Merge).unwrap();
        assert_eq!(other.settings().unwrap(), serde_json::json!({ "size": 3 }));
    }

    #[test]
    fn the_summary_counts_what_matters() {
        let s = Store::open_in_memory().unwrap();
        s.add_todo(&todo("Bins"), at(9, 0)).unwrap();
        s.add_alarm(&London, "Wake up", at(7, 0), Repeat::Daily, 0, at(6, 0)).unwrap();
        s.add_alarm(&London, "Timer: 5 min", at(9, 5), Repeat::None, 0, at(9, 0)).unwrap();
        let mut snap = s.snapshot("0.35.0", device(), at(10, 0)).unwrap();
        snap.characters = vec![
            CharacterFile { path: "fox/character.json".into(), data: String::new() },
            CharacterFile { path: "fox/sheet.png".into(), data: String::new() },
        ];
        let sum = summary(&snap);
        assert_eq!((sum.alarms, sum.timers, sum.todos, sum.anniversaries, sum.characters), (1, 1, 1, 0, 1));
        assert_eq!(sum.device.name, "HOME-PC");
    }
}
