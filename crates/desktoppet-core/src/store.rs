//! SQLite persistence for to-dos, alarms, focus sessions, scores and settings.

use std::path::Path;

use chrono::{DateTime, Duration, TimeZone, Timelike, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::model::*;
use crate::pomodoro;
use crate::schedule::{next_occurrence, parse_hm};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("invalid data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// Repeating alarms missed by more than this while the app was closed are skipped, not rung late.
const MISSED_ALARM_GRACE_MS: Millis = 60 * 60 * 1000;

const MIGRATIONS: &[&str] = &[
    // v1
    "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE todos (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       title TEXT NOT NULL,
       due_at INTEGER,
       notified_at INTEGER,
       done INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL);
     CREATE TABLE alarms (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       label TEXT NOT NULL,
       next_fire INTEGER,
       time_hm TEXT,
       repeat TEXT NOT NULL DEFAULT 'none',
       enabled INTEGER NOT NULL DEFAULT 1);
     CREATE TABLE focus_sessions (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       ended_at INTEGER NOT NULL,
       minutes REAL NOT NULL,
       completed INTEGER NOT NULL);
     CREATE TABLE scores (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       game TEXT NOT NULL,
       character TEXT NOT NULL,
       score INTEGER NOT NULL,
       at INTEGER NOT NULL);
     CREATE INDEX scores_game ON scores(game, score DESC);
     CREATE TABLE achievements (id TEXT PRIMARY KEY, unlocked_at INTEGER NOT NULL);",
    // v2: when a to-do was ticked off, for the daily clean-up.
    "ALTER TABLE todos ADD COLUMN done_at INTEGER;",
    // v3: snooze cycles and missed alarms.
    "ALTER TABLE alarms ADD COLUMN snoozes INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE alarms ADD COLUMN missed_at INTEGER;",
    // v4: when an alarm or timer last rang (one-offs lose next_fire then, so "Done at …" needs it).
    "ALTER TABLE alarms ADD COLUMN rang_at INTEGER;",
    // v5: when it was set (timers show "started 4:29 pm").
    "ALTER TABLE alarms ADD COLUMN created_at INTEGER;",
    // v6: a missed alarm you have seen (clicked its badge) stays missed in the history.
    // Labels no longer carry the time ("Alarm 21:40" mixed 24-hour text into 12-hour UIs).
    "ALTER TABLE alarms ADD COLUMN missed_seen_at INTEGER;
     UPDATE alarms SET label = 'Alarm' WHERE label GLOB 'Alarm [0-9][0-9]:[0-9][0-9]';",
];

const ALARM_COLUMNS: &str =
    "id, label, next_fire, time_hm, repeat, enabled, snoozes, missed_at, rang_at, created_at, missed_seen_at";

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<()> {
        let version: usize = self.conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
            self.conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", i + 1))?;
        }
        Ok(())
    }

    // --- Key/value, settings -------------------------------------------------

    pub fn get_kv(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_kv(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    /// Settings are owned by the UI; the core only reads the parts it needs.
    pub fn settings(&self) -> Result<Value> {
        Ok(match self.get_kv("settings")? {
            Some(s) => serde_json::from_str(&s)?,
            None => Value::Object(Default::default()),
        })
    }

    pub fn set_settings(&self, settings: &Value) -> Result<()> {
        if !settings.is_object() {
            return Err(StoreError::Invalid("settings must be an object".into()));
        }
        self.set_kv("settings", &settings.to_string())
    }

    pub fn pomodoro_config(&self) -> Result<PomodoroConfig> {
        Ok(self.settings()?.get("pomodoro").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default())
    }

    // --- To-dos ---------------------------------------------------------------

    fn todo_row(r: &rusqlite::Row) -> rusqlite::Result<Todo> {
        Ok(Todo {
            id: r.get(0)?,
            title: r.get(1)?,
            due_at: r.get(2)?,
            done: r.get(3)?,
            created_at: r.get(4)?,
            done_at: r.get(5)?,
        })
    }

    pub fn list_todos(&self) -> Result<Vec<Todo>> {
        let mut stmt =
            self.conn.prepare("SELECT id, title, due_at, done, created_at, done_at FROM todos ORDER BY id")?;
        let rows = stmt.query_map([], Self::todo_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn add_todo(&self, title: &str, due_at: Option<Millis>, now: Millis) -> Result<Todo> {
        let title = title.trim();
        if title.is_empty() {
            return Err(StoreError::Invalid("title is empty".into()));
        }
        self.conn.execute(
            "INSERT INTO todos (title, due_at, created_at) VALUES (?1, ?2, ?3)",
            params![title, due_at, now],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(Todo { id, title: title.to_string(), due_at, done: false, created_at: now, done_at: None })
    }

    pub fn update_todo(&self, id: i64, patch: &TodoPatch, now: Millis) -> Result<()> {
        if let Some(title) = &patch.title {
            self.conn.execute("UPDATE todos SET title = ?2 WHERE id = ?1", params![id, title.trim()])?;
        }
        if let Some(due) = patch.due_at {
            // A new due time re-arms the reminder.
            self.conn.execute("UPDATE todos SET due_at = ?2, notified_at = NULL WHERE id = ?1", params![id, due])?;
        }
        if let Some(done) = patch.done {
            let done_at = done.then_some(now);
            self.conn.execute("UPDATE todos SET done = ?2, done_at = ?3 WHERE id = ?1", params![id, done, done_at])?;
        }
        Ok(())
    }

    pub fn delete_todo(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM todos WHERE id = ?1", [id])?;
        Ok(())
    }

    // --- Alarms ---------------------------------------------------------------

    fn alarm_row(r: &rusqlite::Row) -> rusqlite::Result<Alarm> {
        Ok(Alarm {
            id: r.get(0)?,
            label: r.get(1)?,
            next_fire: r.get(2)?,
            time_hm: r.get(3)?,
            repeat: Repeat::parse(&r.get::<_, String>(4)?),
            enabled: r.get(5)?,
            snoozes: r.get(6)?,
            missed_at: r.get(7)?,
            rang_at: r.get(8)?,
            created_at: r.get(9)?,
            missed_seen_at: r.get(10)?,
        })
    }

    pub fn list_alarms(&self) -> Result<Vec<Alarm>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {ALARM_COLUMNS} FROM alarms ORDER BY id"))?;
        let rows = stmt.query_map([], Self::alarm_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn alarm(&self, id: i64) -> Result<Option<Alarm>> {
        Ok(self
            .conn
            .query_row(&format!("SELECT {ALARM_COLUMNS} FROM alarms WHERE id = ?1"), [id], Self::alarm_row)
            .optional()?)
    }

    /// `at` is the first ring; repeating alarms remember its local time of day.
    pub fn add_alarm<Tz: TimeZone>(
        &self,
        tz: &Tz,
        label: &str,
        at: Millis,
        repeat: Repeat,
        now: Millis,
    ) -> Result<Alarm> {
        let time_hm = match repeat {
            Repeat::None => None,
            _ => {
                let local = DateTime::<Utc>::from_timestamp_millis(at)
                    .ok_or_else(|| StoreError::Invalid("bad time".into()))?
                    .with_timezone(tz);
                Some(format!("{:02}:{:02}", local.hour(), local.minute()))
            }
        };
        self.conn.execute(
            "INSERT INTO alarms (label, next_fire, time_hm, repeat, enabled, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
            params![label.trim(), at, time_hm, repeat.as_str(), now],
        )?;
        Ok(Alarm {
            id: self.conn.last_insert_rowid(),
            label: label.trim().into(),
            next_fire: Some(at),
            time_hm,
            repeat,
            enabled: true,
            snoozes: 0,
            missed_at: None,
            rang_at: None,
            created_at: Some(now),
            missed_seen_at: None,
        })
    }

    pub fn set_alarm_enabled<Tz: TimeZone>(&self, tz: &Tz, id: i64, enabled: bool, now: Millis) -> Result<()> {
        let Some(alarm) = self.alarm(id)? else {
            return Ok(());
        };
        let next = if !enabled {
            // Keep a one-shot alarm's time so it can be switched back on.
            if alarm.repeat == Repeat::None {
                alarm.next_fire
            } else {
                None
            }
        } else if let Some(t) = alarm.time_hm.as_deref().and_then(parse_hm) {
            next_occurrence(tz, now, t, alarm.repeat)
        } else {
            // One-shot alarms re-enabled after they rang have nothing to ring for.
            alarm.next_fire.filter(|&n| n > now)
        };
        // Switching a repeating alarm off or on ends any snooze cycle, so its next ring starts a new one.
        self.conn.execute(
            "UPDATE alarms SET enabled = ?2, next_fire = ?3,
               snoozes = CASE WHEN repeat = 'none' THEN snoozes ELSE 0 END WHERE id = ?1",
            params![id, enabled && next.is_some_and(|n| n > now), next],
        )?;
        Ok(())
    }

    /// Deletes one-shot alarms and timers that can no longer ring. Returns how many.
    pub fn clear_finished_alarms(&self, now: Millis) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM alarms WHERE repeat = 'none' AND (next_fire IS NULL OR (enabled = 0 AND next_fire <= ?1))",
            [now],
        )?)
    }

    /// Deletes to-dos ticked off before `before` (use `Millis::MAX` for all). Returns how many.
    pub fn clear_done_todos(&self, before: Millis) -> Result<usize> {
        Ok(self.conn.execute("DELETE FROM todos WHERE done = 1 AND (done_at IS NULL OR done_at < ?1)", [before])?)
    }

    /// Daily clean-up: finished alarms/timers and to-dos done before `start_of_today`.
    /// Runs at most once per `day` (a local date string); returns true if it ran.
    pub fn daily_cleanup(&self, day: &str, start_of_today: Millis, now: Millis) -> Result<bool> {
        if self.get_kv("last_cleanup")?.as_deref() == Some(day) {
            return Ok(false);
        }
        self.clear_finished_alarms(now)?;
        self.clear_done_todos(start_of_today)?;
        self.set_kv("last_cleanup", day)?;
        Ok(true)
    }

    /// Rings the alarm again in `minutes` and counts the snooze. Errors if it no longer
    /// exists (a snooze is never silently dropped).
    pub fn snooze_alarm(&self, id: i64, minutes: i64, now: Millis) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE alarms SET enabled = 1, next_fire = ?2, snoozes = snoozes + 1 WHERE id = ?1",
            params![id, now + minutes * 60_000],
        )?;
        if changed == 0 {
            return Err(StoreError::Invalid("that alarm no longer exists".into()));
        }
        Ok(())
    }

    /// "Done": ends the current ringing/snooze cycle. One-shot alarms and timers finish
    /// (and keep their history: when they rang, how often they were snoozed, whether they
    /// were missed); repeating ones go back to their normal schedule. Also counts as having
    /// seen a missed alarm.
    pub fn dismiss_alarm<Tz: TimeZone>(&self, tz: &Tz, id: i64, now: Millis) -> Result<()> {
        let Some(alarm) = self.alarm(id)? else {
            return Ok(());
        };
        let next = match (alarm.repeat, alarm.time_hm.as_deref().and_then(parse_hm)) {
            (Repeat::None, _) | (_, None) => None,
            (repeat, Some(t)) => next_occurrence(tz, now, t, repeat),
        };
        self.conn.execute(
            "UPDATE alarms SET next_fire = ?2, enabled = ?3,
               snoozes = CASE WHEN repeat = 'none' THEN snoozes ELSE 0 END,
               missed_seen_at = CASE WHEN missed_at IS NULL THEN NULL ELSE COALESCE(missed_seen_at, ?4) END
             WHERE id = ?1",
            params![id, next, next.is_some(), now],
        )?;
        Ok(())
    }

    /// Nobody answered (after any auto-snoozes). It stays missed in the history; the pet's
    /// badge shows it until it is seen (`acknowledge_missed`). Repeating alarms keep their
    /// schedule and start a fresh snooze count. Returns the alarm, if it exists.
    pub fn mark_alarm_missed(&self, id: i64, now: Millis) -> Result<Option<Alarm>> {
        self.conn.execute(
            "UPDATE alarms SET missed_at = ?2, missed_seen_at = NULL,
               snoozes = CASE WHEN repeat = 'none' THEN snoozes ELSE 0 END WHERE id = ?1",
            params![id, now],
        )?;
        self.alarm(id)
    }

    /// The user has seen a missed alarm (clicked its badge): the badge goes, the history stays.
    pub fn acknowledge_missed(&self, id: i64, now: Millis) -> Result<()> {
        self.conn.execute(
            "UPDATE alarms SET missed_seen_at = COALESCE(missed_seen_at, ?2) WHERE id = ?1 AND missed_at IS NOT NULL",
            params![id, now],
        )?;
        Ok(())
    }

    pub fn delete_alarm(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM alarms WHERE id = ?1", [id])?;
        Ok(())
    }

    // --- Due reminders --------------------------------------------------------

    /// Returns everything that should ring now and marks it handled
    /// (to-dos are notified once; alarms are rescheduled or disabled).
    pub fn take_due<Tz: TimeZone>(&self, tz: &Tz, now: Millis) -> Result<Vec<Reminder>> {
        let mut out = vec![];
        {
            let mut stmt = self.conn.prepare(
                "SELECT id, title FROM todos WHERE done = 0 AND due_at IS NOT NULL AND due_at <= ?1 AND notified_at IS NULL",
            )?;
            let rows = stmt.query_map([now], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (id, title) = row?;
                out.push(Reminder { kind: ReminderKind::Todo, id, title });
            }
        }
        for r in &out {
            self.conn.execute("UPDATE todos SET notified_at = ?2 WHERE id = ?1", params![r.id, now])?;
        }

        let due: Vec<Alarm> =
            self.list_alarms()?.into_iter().filter(|a| a.enabled && a.next_fire.is_some_and(|n| n <= now)).collect();
        for a in due {
            let fire_at = a.next_fire.unwrap_or(now);
            let next = a.time_hm.as_deref().and_then(parse_hm).and_then(|t| match a.repeat {
                Repeat::None => None,
                r => next_occurrence(tz, now, t, r),
            });
            let stale = next.is_some() && now - fire_at > MISSED_ALARM_GRACE_MS;
            if !stale {
                out.push(Reminder { kind: ReminderKind::Alarm, id: a.id, title: a.label.clone() });
            }
            // Rung alarms and timers stay (disabled) so the user can still snooze them, and
            // finished ones stay in the history until the daily clean-up.
            // `rang_at` is when this ringing cycle began: a ring after a snooze keeps it, so
            // "Alarm 9:40 PM" stays 9:40 however often it was snoozed. A new cycle (no
            // snoozes yet) also forgets the previous cycle's missed state.
            self.conn.execute(
                "UPDATE alarms SET next_fire = ?2, enabled = ?3,
                   rang_at = CASE WHEN snoozes = 0 THEN ?4 ELSE COALESCE(rang_at, ?4) END,
                   missed_at = CASE WHEN snoozes = 0 THEN NULL ELSE missed_at END,
                   missed_seen_at = CASE WHEN snoozes = 0 THEN NULL ELSE missed_seen_at END
                 WHERE id = ?1",
                params![a.id, next, next.is_some(), fire_at],
            )?;
        }
        Ok(out)
    }

    // --- Tomato clock ---------------------------------------------------------

    pub fn pomodoro_status(&self) -> Result<PomodoroStatus> {
        Ok(match self.get_kv("pomodoro")? {
            Some(s) => serde_json::from_str(&s)?,
            None => PomodoroStatus::default(),
        })
    }

    /// Stores the new status, logging the focus session that just ended (if any).
    pub fn set_pomodoro(&self, next: &PomodoroStatus, now: Millis) -> Result<()> {
        let prev = self.pomodoro_status()?;
        if prev.phase == Phase::Focus {
            if let Some(end) = prev.ends_at {
                let planned = self.pomodoro_config()?.focus_min;
                let completed = now >= end;
                let minutes = if completed { planned } else { (planned - (end - now) as f64 / 60_000.0).max(0.0) };
                self.conn.execute(
                    "INSERT INTO focus_sessions (ended_at, minutes, completed) VALUES (?1, ?2, ?3)",
                    params![now.min(end), minutes, completed],
                )?;
            }
        }
        self.set_kv("pomodoro", &serde_json::to_string(next)?)
    }

    /// Advances the tomato clock if its phase ended. Returns the new status on change.
    pub fn tick_pomodoro(&self, now: Millis) -> Result<Option<PomodoroStatus>> {
        let status = self.pomodoro_status()?;
        let config = self.pomodoro_config()?;
        match pomodoro::tick(&status, now, &config) {
            Some(next) => {
                self.set_pomodoro(&next, status.ends_at.unwrap_or(now))?;
                Ok(Some(next))
            }
            None => Ok(None),
        }
    }

    pub fn pomodoro_stats<Tz: TimeZone>(&self, tz: &Tz, days: u32, now: Millis) -> Result<Vec<DayStat>> {
        let today = DateTime::<Utc>::from_timestamp_millis(now).unwrap_or_default().with_timezone(tz).date_naive();
        let mut out = vec![];
        for i in (0..days as i64).rev() {
            let day = today - Duration::days(i);
            let start = tz.from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap()).earliest();
            let end = tz.from_local_datetime(&(day + Duration::days(1)).and_hms_opt(0, 0, 0).unwrap()).earliest();
            let (Some(start), Some(end)) = (start, end) else {
                continue;
            };
            let (completed, minutes): (u32, f64) = self.conn.query_row(
                "SELECT COALESCE(SUM(completed), 0), COALESCE(SUM(minutes), 0) FROM focus_sessions WHERE ended_at >= ?1 AND ended_at < ?2",
                [start.timestamp_millis(), end.timestamp_millis()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            out.push(DayStat {
                day: day.format("%Y-%m-%d").to_string(),
                completed,
                focus_minutes: minutes.round() as u32,
            });
        }
        Ok(out)
    }

    // --- Scores & achievements -----------------------------------------------

    pub fn record_score(&self, game: &str, character: &str, score: i64, now: Millis) -> Result<()> {
        self.conn.execute(
            "INSERT INTO scores (game, character, score, at) VALUES (?1, ?2, ?3, ?4)",
            params![game, character, score, now],
        )?;
        Ok(())
    }

    pub fn top_scores(&self, game: &str, limit: u32) -> Result<Vec<Score>> {
        let mut stmt = self.conn.prepare(
            "SELECT game, character, score, at FROM scores WHERE game = ?1 ORDER BY score DESC, at ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![game, limit], |r| {
            Ok(Score { game: r.get(0)?, character: r.get(1)?, score: r.get(2)?, at: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Returns true if newly unlocked.
    pub fn unlock_achievement(&self, id: &str, now: Millis) -> Result<bool> {
        Ok(self
            .conn
            .execute("INSERT OR IGNORE INTO achievements (id, unlocked_at) VALUES (?1, ?2)", params![id, now])?
            > 0)
    }

    pub fn achievements(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT id FROM achievements ORDER BY unlocked_at")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Europe::London;

    const MIN: Millis = 60_000;
    fn at(h: u32, m: u32) -> Millis {
        London.with_ymd_and_hms(2026, 1, 7, h, m, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn todo_reminders_fire_once_and_rearm_on_new_due_time() {
        let s = Store::open_in_memory().unwrap();
        let t = s.add_todo("  call mom ", Some(at(15, 0)), at(9, 0)).unwrap();
        assert_eq!(t.title, "call mom");
        assert!(s.take_due(&London, at(14, 59)).unwrap().is_empty());
        let due = s.take_due(&London, at(15, 0)).unwrap();
        assert_eq!(due, vec![Reminder { kind: ReminderKind::Todo, id: t.id, title: "call mom".into() }]);
        assert!(s.take_due(&London, at(15, 1)).unwrap().is_empty());

        s.update_todo(t.id, &TodoPatch { due_at: Some(Some(at(15, 10))), ..Default::default() }, at(15, 5)).unwrap();
        assert_eq!(s.take_due(&London, at(15, 10)).unwrap().len(), 1);

        s.update_todo(
            t.id,
            &TodoPatch { due_at: Some(Some(at(16, 0))), done: Some(true), ..Default::default() },
            at(15, 30),
        )
        .unwrap();
        assert!(s.take_due(&London, at(16, 0)).unwrap().is_empty());
        let done = &s.list_todos().unwrap()[0];
        assert!(done.done);
        assert_eq!(done.done_at, Some(at(15, 30)));
    }

    #[test]
    fn todo_patch_json_distinguishes_missing_and_null() {
        let p: TodoPatch = serde_json::from_str(r#"{"dueAt": null}"#).unwrap();
        assert_eq!(p.due_at, Some(None));
        let p: TodoPatch = serde_json::from_str(r#"{"done": true}"#).unwrap();
        assert_eq!(p.due_at, None);
    }

    #[test]
    fn one_shot_alarm_rings_then_disables() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Dentist", at(10, 5), Repeat::None, at(6, 0)).unwrap();
        assert_eq!(s.take_due(&London, at(10, 5)).unwrap()[0].id, a.id);
        let saved = &s.list_alarms().unwrap()[0];
        assert!(!saved.enabled);
        assert_eq!(saved.next_fire, None);
        assert_eq!(saved.created_at, Some(at(6, 0)));
        // Finished, but it still knows when it rang ("Rang · Today 10:05").
        assert_eq!(saved.rang_at, Some(at(10, 5)));
        // Snoozed and rung again: still the time the cycle began ("Alarm 10:05", not 10:11).
        s.snooze_alarm(a.id, 5, at(10, 6)).unwrap();
        s.take_due(&London, at(10, 11)).unwrap();
        assert_eq!(s.list_alarms().unwrap()[0].rang_at, Some(at(10, 5)));
    }

    #[test]
    fn alarms_serialize_with_the_fields_the_ui_reads() {
        let s = Store::open_in_memory().unwrap();
        let t = s.add_alarm(&London, "Timer: 12 min", at(10, 12), Repeat::None, at(10, 0)).unwrap();
        let json = serde_json::to_value(&s.list_alarms().unwrap()[0]).unwrap();
        assert_eq!(json["createdAt"], serde_json::json!(at(10, 0)));
        assert_eq!(json["id"], serde_json::json!(t.id));
        for key in ["nextFire", "rangAt", "missedAt", "missedSeenAt", "snoozes", "timeHm"] {
            assert!(json.get(key).is_some(), "{key} missing");
        }
    }

    #[test]
    fn upgrading_drops_the_time_from_default_labels_and_keeps_created_at() {
        let dir = std::env::temp_dir().join(format!("desktoppet-upgrade-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.db");
        let _ = std::fs::remove_file(&path);
        {
            // A 0.14 database (schema v5) with an old-style label.
            let conn = Connection::open(&path).unwrap();
            for (i, sql) in MIGRATIONS.iter().take(5).enumerate() {
                conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", i + 1)).unwrap();
            }
            conn.execute(
                "INSERT INTO alarms (label, next_fire, repeat, enabled, created_at) VALUES ('Alarm 21:40', 1, 'none', 1, 7)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO alarms (label, next_fire, repeat, enabled) VALUES ('Alarm for the 21:40 train', 1, 'none', 1)",
                [],
            )
            .unwrap();
        }
        let s = Store::open(&path).unwrap();
        let alarms = s.list_alarms().unwrap();
        assert_eq!(alarms[0].label, "Alarm");
        assert_eq!(alarms[0].created_at, Some(7));
        assert_eq!(alarms[1].label, "Alarm for the 21:40 train");
        drop(s);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn daily_alarm_reschedules_and_snooze_works() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Wake up", at(7, 30), Repeat::Daily, at(6, 0)).unwrap();
        assert_eq!(a.time_hm.as_deref(), Some("07:30"));
        assert_eq!(s.take_due(&London, at(7, 30)).unwrap().len(), 1);
        let next = s.list_alarms().unwrap()[0].next_fire.unwrap();
        assert_eq!(next, at(7, 30) + 24 * 60 * MIN);

        s.snooze_alarm(a.id, 5, at(7, 31)).unwrap();
        assert_eq!(s.take_due(&London, at(7, 36)).unwrap().len(), 1);
        // After the snooze rings, it goes back to its daily schedule.
        assert_eq!(s.list_alarms().unwrap()[0].next_fire, Some(next));
    }

    #[test]
    fn stale_repeating_alarms_are_skipped_not_rung_late() {
        let s = Store::open_in_memory().unwrap();
        s.add_alarm(&London, "Wake up", at(7, 30), Repeat::Daily, at(6, 0)).unwrap();
        assert!(s.take_due(&London, at(12, 0)).unwrap().is_empty());
        assert!(s.list_alarms().unwrap()[0].enabled);
    }

    #[test]
    fn pomodoro_logs_sessions_into_daily_stats() {
        let s = Store::open_in_memory().unwrap();
        let config = s.pomodoro_config().unwrap();
        s.set_pomodoro(&pomodoro::start_focus(at(9, 0), &config, 0), at(9, 0)).unwrap();
        let change = s.tick_pomodoro(at(9, 25)).unwrap().unwrap();
        assert_eq!(change.phase, Phase::ShortBreak);
        // Stop a second session early (10 of 25 minutes).
        s.set_pomodoro(&pomodoro::start_focus(at(10, 0), &config, 1), at(10, 0)).unwrap();
        s.set_pomodoro(&PomodoroStatus::default(), at(10, 10)).unwrap();

        let stats = s.pomodoro_stats(&London, 2, at(18, 0)).unwrap();
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[1], DayStat { day: "2026-01-07".into(), completed: 1, focus_minutes: 35 });
        assert_eq!(stats[0].completed, 0);
    }

    #[test]
    fn pomodoro_config_comes_from_ui_settings() {
        let s = Store::open_in_memory().unwrap();
        s.set_settings(&serde_json::json!({"character": "cat", "pomodoro": {"focusMin": 50, "autoContinue": false}}))
            .unwrap();
        let c = s.pomodoro_config().unwrap();
        assert_eq!(c.focus_min, 50.0);
        assert!(!c.auto_continue);
        assert_eq!(c.short_break_min, 5.0);
    }

    #[test]
    fn a_rung_timer_can_still_be_snoozed_and_stays_visible() {
        let s = Store::open_in_memory().unwrap();
        let t = s.add_alarm(&London, "Timer: 1 min", at(10, 1), Repeat::None, at(6, 0)).unwrap();
        assert_eq!(s.take_due(&London, at(10, 1)).unwrap().len(), 1);
        // Still there (finished) while the user decides.
        assert!(!s.list_alarms().unwrap()[0].enabled);
        s.snooze_alarm(t.id, 5, at(10, 2)).unwrap();
        let snoozed = &s.list_alarms().unwrap()[0];
        assert!(snoozed.enabled);
        assert_eq!(snoozed.next_fire, Some(at(10, 7)));
        // It rings again after the snooze.
        assert_eq!(s.take_due(&London, at(10, 7)).unwrap().len(), 1);
    }

    #[test]
    fn snoozes_are_counted_and_done_ends_the_cycle() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Wake up", at(7, 0), Repeat::Daily, at(6, 0)).unwrap();
        s.take_due(&London, at(7, 0)).unwrap();
        s.snooze_alarm(a.id, 5, at(7, 1)).unwrap();
        s.take_due(&London, at(7, 6)).unwrap();
        s.snooze_alarm(a.id, 5, at(7, 7)).unwrap();
        let snoozed = &s.list_alarms().unwrap()[0];
        assert_eq!(snoozed.snoozes, 2);
        assert_eq!(snoozed.next_fire, Some(at(7, 12)));
        // "Done" while waiting for the next snooze: back to tomorrow 07:00, count reset.
        s.dismiss_alarm(&London, a.id, at(7, 8)).unwrap();
        let back = &s.list_alarms().unwrap()[0];
        assert_eq!((back.snoozes, back.enabled), (0, true));
        assert_eq!(back.next_fire, Some(at(7, 0) + 24 * 60 * MIN));
    }

    #[test]
    fn missed_alarms_are_remembered_until_acknowledged() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Dentist", at(15, 0), Repeat::None, at(6, 0)).unwrap();
        s.take_due(&London, at(15, 0)).unwrap();
        let missed = s.mark_alarm_missed(a.id, at(15, 1)).unwrap().unwrap();
        assert_eq!(missed.missed_at, Some(at(15, 1)));
        assert_eq!(missed.missed_seen_at, None);
        assert!(!missed.enabled);
        // Clicking the badge: seen, but it stays missed in the history.
        s.acknowledge_missed(a.id, at(15, 30)).unwrap();
        s.dismiss_alarm(&London, a.id, at(16, 0)).unwrap();
        let done = &s.list_alarms().unwrap()[0];
        assert_eq!(done.missed_at, Some(at(15, 1)));
        assert_eq!(done.missed_seen_at, Some(at(15, 30)));
        assert_eq!(done.rang_at, Some(at(15, 0)));
        assert!(!done.enabled);
    }

    #[test]
    fn a_missed_one_off_keeps_its_snooze_count_and_first_ring() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Alarm", at(21, 40), Repeat::None, at(6, 0)).unwrap();
        s.take_due(&London, at(21, 40)).unwrap();
        for i in 0..3 {
            s.snooze_alarm(a.id, 5, at(21, 41 + 6 * i)).unwrap();
            s.take_due(&London, at(21, 46 + 6 * i)).unwrap();
        }
        s.mark_alarm_missed(a.id, at(21, 59)).unwrap();
        let m = &s.list_alarms().unwrap()[0];
        assert_eq!((m.rang_at, m.snoozes, m.missed_at), (Some(at(21, 40)), 3, Some(at(21, 59))));
    }

    #[test]
    fn a_repeating_alarm_starts_each_day_afresh() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Wake up", at(7, 0), Repeat::Daily, at(6, 0)).unwrap();
        s.take_due(&London, at(7, 0)).unwrap();
        s.snooze_alarm(a.id, 5, at(7, 1)).unwrap();
        s.take_due(&London, at(7, 6)).unwrap();
        s.mark_alarm_missed(a.id, at(7, 7)).unwrap();
        let missed = &s.list_alarms().unwrap()[0];
        assert_eq!((missed.snoozes, missed.missed_at), (0, Some(at(7, 7))));
        // Tomorrow's ring is a new cycle: yesterday's miss is forgotten.
        let tomorrow = at(7, 0) + 24 * 60 * MIN;
        s.take_due(&London, tomorrow).unwrap();
        let next = &s.list_alarms().unwrap()[0];
        assert_eq!((next.missed_at, next.rang_at), (None, Some(tomorrow)));
    }

    #[test]
    fn snoozing_a_deleted_alarm_is_an_error_not_a_silent_no_op() {
        let s = Store::open_in_memory().unwrap();
        let t = s.add_alarm(&London, "Timer: 1 min", at(10, 1), Repeat::None, at(6, 0)).unwrap();
        s.delete_alarm(t.id).unwrap();
        assert!(s.snooze_alarm(t.id, 5, at(10, 2)).is_err());
    }

    #[test]
    fn switching_a_one_shot_alarm_off_and_on_keeps_its_time() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Dentist", at(15, 0), Repeat::None, at(6, 0)).unwrap();
        s.set_alarm_enabled(&London, a.id, false, at(9, 0)).unwrap();
        assert!(!s.list_alarms().unwrap()[0].enabled);
        assert!(s.take_due(&London, at(15, 0)).unwrap().is_empty());
        s.set_alarm_enabled(&London, a.id, true, at(9, 0)).unwrap();
        let back = &s.list_alarms().unwrap()[0];
        assert!(back.enabled);
        assert_eq!(back.next_fire, Some(at(15, 0)));
    }

    #[test]
    fn clear_finished_keeps_upcoming_and_repeating() {
        let s = Store::open_in_memory().unwrap();
        s.add_alarm(&London, "Rang", at(8, 0), Repeat::None, at(6, 0)).unwrap();
        s.add_alarm(&London, "Later", at(18, 0), Repeat::None, at(6, 0)).unwrap();
        let off = s.add_alarm(&London, "Switched off, still ahead", at(19, 0), Repeat::None, at(6, 0)).unwrap();
        s.set_alarm_enabled(&London, off.id, false, at(9, 0)).unwrap();
        s.add_alarm(&London, "Daily", at(7, 0), Repeat::Daily, at(6, 0)).unwrap();
        s.take_due(&London, at(9, 0)).unwrap();
        assert_eq!(s.clear_finished_alarms(at(9, 0)).unwrap(), 1);
        let labels: Vec<_> = s.list_alarms().unwrap().into_iter().map(|a| a.label).collect();
        assert_eq!(labels, vec!["Later", "Switched off, still ahead", "Daily"]);
    }

    #[test]
    fn daily_cleanup_removes_yesterdays_done_todos_once_a_day() {
        let s = Store::open_in_memory().unwrap();
        let old = s.add_todo("yesterday", None, 0).unwrap();
        let new = s.add_todo("today", None, 0).unwrap();
        s.add_todo("open", None, 0).unwrap();
        let done = TodoPatch { done: Some(true), ..Default::default() };
        s.update_todo(old.id, &done, at(9, 0) - 24 * 60 * MIN).unwrap();
        s.update_todo(new.id, &done, at(9, 0)).unwrap();
        let midnight = at(0, 0);
        assert!(s.daily_cleanup("2026-01-07", midnight, at(10, 0)).unwrap());
        assert!(!s.daily_cleanup("2026-01-07", midnight, at(11, 0)).unwrap());
        let titles: Vec<_> = s.list_todos().unwrap().into_iter().map(|t| t.title).collect();
        assert_eq!(titles, vec!["today", "open"]);
        assert_eq!(s.clear_done_todos(Millis::MAX).unwrap(), 1);
    }

    #[test]
    fn scores_and_achievements() {
        let s = Store::open_in_memory().unwrap();
        s.record_score("safe-landing", "cat", 1200, 1).unwrap();
        s.record_score("safe-landing", "rooster", 1500, 2).unwrap();
        s.record_score("jump-up", "cat", 9000, 3).unwrap();
        let top = s.top_scores("safe-landing", 5).unwrap();
        assert_eq!(top.iter().map(|x| x.score).collect::<Vec<_>>(), vec![1500, 1200]);
        assert!(s.unlock_achievement("safe_landing_win", 1).unwrap());
        assert!(!s.unlock_achievement("safe_landing_win", 2).unwrap());
        assert_eq!(s.achievements().unwrap(), vec!["safe_landing_win".to_string()]);
    }

    #[test]
    fn reopening_keeps_data() {
        let dir = std::env::temp_dir().join(format!("desktoppet-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pet.db");
        let _ = std::fs::remove_file(&path);
        Store::open(&path).unwrap().add_todo("persist me", None, 0).unwrap();
        assert_eq!(Store::open(&path).unwrap().list_todos().unwrap()[0].title, "persist me");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
