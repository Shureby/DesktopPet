//! SQLite persistence for to-dos, alarms, focus sessions, scores and settings.

use std::path::Path;

use chrono::{DateTime, Datelike, Duration, NaiveTime, TimeZone, Timelike, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::model::*;
use crate::pomodoro;
use crate::schedule::{anniversary_on_or_after, local_date, local_ms, next_occurrence, next_todo, parse_hm, prep_day};

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

/// Lateness that still counts as on time: the scheduler can run a little late (a busy
/// machine, the first tick after waking). Anything later came due while ePet wasn't running.
const LATE_TOLERANCE_MS: Millis = 60 * 1000;

/// Timers are alarms whose label starts with this (see src/features/alarm/timers.ts).
const TIMER_PREFIX: &str = "Timer: ";

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
    // v7: a repeating alarm skipped once ("Skip once · Sep 30 7:00 PM"): the ring it skips.
    "ALTER TABLE alarms ADD COLUMN skipped_fire INTEGER;",
    // v8: repeating on chosen days (repeat = 'days'): the days as bits, Sunday = bit 0.
    "ALTER TABLE alarms ADD COLUMN repeat_days INTEGER NOT NULL DEFAULT 0;",
    // v9: what came due while ePet wasn't running (it didn't ring), and what the hidden pet
    // rang that nobody answered ("While I was hidden you missed…").
    "ALTER TABLE alarms ADD COLUMN off_at INTEGER;
     CREATE TABLE unseen (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       kind TEXT NOT NULL,
       ref_id INTEGER NOT NULL,
       title TEXT NOT NULL,
       at INTEGER NOT NULL,
       snoozes INTEGER NOT NULL DEFAULT 0,
       recorded_at INTEGER NOT NULL);",
    // v10: to-dos on a day without a time, repeating to-dos (counted from anchor_at, their
    // first date), and "Later" on a day's to-do (remind_at; its day stays).
    "ALTER TABLE todos ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE todos ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none';
     ALTER TABLE todos ADD COLUMN anchor_at INTEGER;
     ALTER TABLE todos ADD COLUMN remind_at INTEGER;",
    // v11: a ticked-off time of a repeating to-do remembers which one it was, so unticking
    // it in Done undoes the tick.
    "ALTER TABLE todos ADD COLUMN repeat_of INTEGER;",
    // v12: anniversaries, the to-dos made from their reminders (once per year each), and the
    // day each was last celebrated.
    "CREATE TABLE anniversaries (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       kind TEXT NOT NULL,
       icon TEXT NOT NULL,
       name TEXT NOT NULL,
       month INTEGER NOT NULL,
       day INTEGER NOT NULL,
       since INTEGER,
       preps TEXT NOT NULL DEFAULT '[]',
       effect INTEGER NOT NULL DEFAULT 1,
       created_at INTEGER NOT NULL,
       changed_at INTEGER NOT NULL,
       celebrated_on TEXT);
     CREATE TABLE anniversary_preps_made (
       anniversary_id INTEGER NOT NULL,
       prep TEXT NOT NULL,
       occurrence TEXT NOT NULL,
       PRIMARY KEY (anniversary_id, prep, occurrence));",
];

const ANNIVERSARY_COLUMNS: &str = "id, kind, icon, name, month, day, since, preps, effect, created_at";

/// How long the celebration lasts if the settings don't say (`celebrate.seconds`, 10–60).
const DEFAULT_CELEBRATE_SECONDS: u32 = 15;

const TODO_COLUMNS: &str = "id, title, due_at, done, created_at, done_at, all_day, repeat";

/// When to-dos without a time remind you, if the settings don't say (`todoDayTime`).
const DEFAULT_TODO_DAY_TIME: &str = "09:00";

/// The work period the tomato clock was last started in (or found running in).
const AUTO_PERIOD_KEY: &str = "pomodoro_auto_period";

const ALARM_COLUMNS: &str =
    "id, label, next_fire, time_hm, repeat, enabled, snoozes, missed_at, rang_at, created_at, missed_seen_at, skipped_fire, repeat_days, off_at";

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
            all_day: r.get(6)?,
            repeat: TodoRepeat::parse(&r.get::<_, String>(7)?),
        })
    }

    pub fn list_todos(&self) -> Result<Vec<Todo>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {TODO_COLUMNS} FROM todos ORDER BY id"))?;
        let rows = stmt.query_map([], Self::todo_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn todo(&self, id: i64) -> Result<Option<Todo>> {
        Ok(self
            .conn
            .query_row(&format!("SELECT {TODO_COLUMNS} FROM todos WHERE id = ?1"), [id], Self::todo_row)
            .optional()?)
    }

    /// A to-do needs a day to be on that day or to repeat: without one it's neither.
    pub fn add_todo(&self, t: &NewTodo, now: Millis) -> Result<Todo> {
        let title = t.title.trim();
        if title.is_empty() {
            return Err(StoreError::Invalid("title is empty".into()));
        }
        let all_day = t.all_day && t.due_at.is_some();
        let repeat = if t.due_at.is_some() { t.repeat } else { TodoRepeat::None };
        self.conn.execute(
            "INSERT INTO todos (title, due_at, created_at, all_day, repeat, anchor_at) VALUES (?1, ?2, ?3, ?4, ?5, ?2)",
            params![title, t.due_at, now, all_day, repeat.as_str()],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(Todo {
            id,
            title: title.to_string(),
            due_at: t.due_at,
            done: false,
            created_at: now,
            done_at: None,
            all_day,
            repeat,
        })
    }

    /// Ticking off a repeating to-do keeps it open on its next day (see `tick_repeating`).
    pub fn update_todo<Tz: TimeZone>(&self, tz: &Tz, id: i64, patch: &TodoPatch, now: Millis) -> Result<()> {
        if let Some(title) = &patch.title {
            self.conn.execute("UPDATE todos SET title = ?2 WHERE id = ?1", params![id, title.trim()])?;
        }
        if let Some(due) = patch.due_at {
            // A new date re-arms the reminder, and a repeating one counts from it.
            self.conn.execute(
                "UPDATE todos SET due_at = ?2, anchor_at = ?2, notified_at = NULL, remind_at = NULL WHERE id = ?1",
                params![id, due],
            )?;
        }
        if let Some(all_day) = patch.all_day {
            self.conn
                .execute("UPDATE todos SET all_day = ?2 AND due_at IS NOT NULL WHERE id = ?1", params![id, all_day])?;
        }
        if let Some(repeat) = patch.repeat {
            self.conn.execute(
                "UPDATE todos SET repeat = CASE WHEN due_at IS NULL THEN 'none' ELSE ?2 END, anchor_at = due_at WHERE id = ?1",
                params![id, repeat.as_str()],
            )?;
        }
        // No date left: nothing to repeat or be on.
        self.conn.execute("UPDATE todos SET all_day = 0, repeat = 'none' WHERE id = ?1 AND due_at IS NULL", [id])?;
        if let Some(at) = patch.remind_at {
            self.conn.execute("UPDATE todos SET remind_at = ?2, notified_at = NULL WHERE id = ?1", params![id, at])?;
        }
        if let Some(done) = patch.done {
            if done && self.tick_repeating(tz, id, now)? {
                return Ok(());
            }
            if !done && self.untick_logged(id, now)? {
                return Ok(());
            }
            let done_at = done.then_some(now);
            self.conn.execute("UPDATE todos SET done = ?2, done_at = ?3 WHERE id = ?1", params![id, done, done_at])?;
        }
        Ok(())
    }

    /// Ticking off a repeating to-do: this time goes to Done as its own entry, and the to-do
    /// moves on to its next day after both this one and today (several missed times don't
    /// pile up). False if it isn't an open repeating to-do.
    fn tick_repeating<Tz: TimeZone>(&self, tz: &Tz, id: i64, now: Millis) -> Result<bool> {
        let Some(t) = self.todo(id)? else {
            return Ok(false);
        };
        let (Some(due), false, true) = (t.due_at, t.done, t.repeat != TodoRepeat::None) else {
            return Ok(false);
        };
        let anchor: Millis =
            self.conn.query_row("SELECT COALESCE(anchor_at, due_at) FROM todos WHERE id = ?1", [id], |r| r.get(0))?;
        // A day's to-do is next on a later day than today; one with a time, after now.
        let today_end = if t.all_day {
            local_date(tz, now)
                .and_then(|d| d.succ_opt())
                .and_then(|d| local_ms(tz, d, NaiveTime::MIN))
                .map_or(now, |m| m - 1)
        } else {
            now
        };
        let Some(next) = next_todo(tz, anchor, t.repeat, due.max(today_end)) else {
            return Ok(false);
        };
        self.conn.execute(
            "INSERT INTO todos (title, due_at, created_at, done, done_at, notified_at, all_day, repeat, repeat_of)
             VALUES (?1, ?2, ?3, 1, ?3, ?3, ?4, 'none', ?5)",
            params![t.title, due, now, t.all_day, id],
        )?;
        self.conn.execute(
            "UPDATE todos SET due_at = ?2, notified_at = NULL, remind_at = NULL WHERE id = ?1",
            params![id, next],
        )?;
        Ok(true)
    }

    /// Unticking a logged time of a repeating to-do in Done undoes that tick: the entry goes
    /// and the to-do is back on that day (not reminded again for a day already reached).
    /// False if it isn't such an entry, or its to-do is gone (then it's just an open to-do).
    fn untick_logged(&self, id: i64, now: Millis) -> Result<bool> {
        let logged: Option<(Option<i64>, Option<Millis>)> = self
            .conn
            .query_row("SELECT repeat_of, due_at FROM todos WHERE id = ?1 AND done = 1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let Some((Some(parent), Some(due))) = logged else {
            return Ok(false);
        };
        let back = self.conn.execute(
            "UPDATE todos SET due_at = ?2, remind_at = NULL,
               notified_at = CASE WHEN ?2 <= ?3 THEN ?3 ELSE NULL END
             WHERE id = ?1 AND done = 0 AND repeat != 'none'",
            params![parent, due, now],
        )?;
        if back == 0 {
            self.conn.execute("UPDATE todos SET repeat_of = NULL WHERE id = ?1", [id])?;
            return Ok(false);
        }
        self.conn.execute("DELETE FROM todos WHERE id = ?1", [id])?;
        Ok(true)
    }

    /// The "to-dos without a time" reminder time from the settings.
    fn todo_day_time(&self) -> Result<NaiveTime> {
        let settings = self.settings()?;
        let hm = settings.get("todoDayTime").and_then(Value::as_str).unwrap_or(DEFAULT_TODO_DAY_TIME);
        Ok(parse_hm(hm).or_else(|| parse_hm(DEFAULT_TODO_DAY_TIME)).unwrap_or_default())
    }

    pub fn delete_todo(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM todos WHERE id = ?1", [id])?;
        Ok(())
    }

    // --- Anniversaries -------------------------------------------------------

    fn anniversary_row(r: &rusqlite::Row) -> rusqlite::Result<Anniversary> {
        let preps: String = r.get(7)?;
        Ok(Anniversary {
            id: r.get(0)?,
            kind: r.get(1)?,
            icon: r.get(2)?,
            name: r.get(3)?,
            month: r.get(4)?,
            day: r.get(5)?,
            since: r.get(6)?,
            preps: serde_json::from_str(&preps).unwrap_or_default(),
            effect: r.get(8)?,
            created_at: r.get(9)?,
        })
    }

    pub fn list_anniversaries(&self) -> Result<Vec<Anniversary>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {ANNIVERSARY_COLUMNS} FROM anniversaries ORDER BY id"))?;
        let rows = stmt.query_map([], Self::anniversary_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn anniversary(&self, id: i64) -> Result<Option<Anniversary>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {ANNIVERSARY_COLUMNS} FROM anniversaries WHERE id = ?1"),
                [id],
                Self::anniversary_row,
            )
            .optional()?)
    }

    /// The name and a real day of the year (Feb 29 is allowed) are needed; at most 3 reminders.
    fn check_anniversary(a: &NewAnniversary) -> Result<(String, Vec<AnniversaryPrep>)> {
        let name = a.name.trim();
        if name.is_empty() {
            return Err(StoreError::Invalid("name is empty".into()));
        }
        // 2000 is a leap year, so Feb 29 is a day of the year.
        if chrono::NaiveDate::from_ymd_opt(2000, a.month, a.day).is_none() {
            return Err(StoreError::Invalid("no such day".into()));
        }
        let preps: Vec<AnniversaryPrep> = a
            .preps
            .iter()
            .filter(|p| !p.label.trim().is_empty())
            .take(3)
            .map(|p| AnniversaryPrep { lead: p.lead.clone(), label: p.label.trim().to_string() })
            .collect();
        Ok((name.to_string(), preps))
    }

    pub fn add_anniversary(&self, a: &NewAnniversary, now: Millis) -> Result<Anniversary> {
        let (name, preps) = Self::check_anniversary(a)?;
        self.conn.execute(
            "INSERT INTO anniversaries (kind, icon, name, month, day, since, preps, effect, created_at, changed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![a.kind, a.icon, name, a.month, a.day, a.since, serde_json::to_string(&preps)?, a.effect, now],
        )?;
        let id = self.conn.last_insert_rowid();
        self.anniversary(id)?.ok_or_else(|| StoreError::Invalid("not saved".into()))
    }

    /// Editing: reminders whose day has already passed when it's changed aren't made late.
    pub fn update_anniversary(&self, id: i64, a: &NewAnniversary, now: Millis) -> Result<Anniversary> {
        let (name, preps) = Self::check_anniversary(a)?;
        let changed = self.conn.execute(
            "UPDATE anniversaries SET kind = ?2, icon = ?3, name = ?4, month = ?5, day = ?6, since = ?7, preps = ?8,
               effect = ?9, changed_at = ?10 WHERE id = ?1",
            params![id, a.kind, a.icon, name, a.month, a.day, a.since, serde_json::to_string(&preps)?, a.effect, now],
        )?;
        if changed == 0 {
            return Err(StoreError::Invalid("that anniversary no longer exists".into()));
        }
        self.anniversary(id)?.ok_or_else(|| StoreError::Invalid("not saved".into()))
    }

    /// The to-dos it already made stay (you may be halfway through them).
    pub fn delete_anniversary(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM anniversaries WHERE id = ?1", [id])?;
        self.conn.execute("DELETE FROM anniversary_preps_made WHERE anniversary_id = ?1", [id])?;
        Ok(())
    }

    /// Makes the to-do for each anniversary reminder whose day has come ("🎂 Mum - Order a
    /// cake", a day's to-do on the reminder's day), once per year. A day missed while ePet
    /// wasn't running is made late (it shows as overdue) up to the anniversary itself; one
    /// already past when the anniversary was added or changed isn't. Returns whether any was made.
    pub fn tick_anniversaries<Tz: TimeZone>(&self, tz: &Tz, now: Millis) -> Result<bool> {
        let Some(today) = local_date(tz, now) else {
            return Ok(false);
        };
        let mut made = false;
        let changed: Vec<(i64, Millis)> = {
            let mut stmt = self.conn.prepare("SELECT id, changed_at FROM anniversaries")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for (id, changed_at) in changed {
            let Some(a) = self.anniversary(id)? else { continue };
            let Some(on) = anniversary_on_or_after(a.month, a.day, today) else { continue };
            let since_day = local_date(tz, changed_at).unwrap_or(today);
            for p in &a.preps {
                let Some(day) = prep_day(on, &p.lead) else { continue };
                if day > today || day < since_day {
                    continue;
                }
                let key = format!("{}|{}", p.lead, p.label);
                let occurrence = on.format("%Y-%m-%d").to_string();
                let fresh = self.conn.execute(
                    "INSERT OR IGNORE INTO anniversary_preps_made (anniversary_id, prep, occurrence) VALUES (?1, ?2, ?3)",
                    params![id, key, occurrence],
                )?;
                if fresh == 0 {
                    continue;
                }
                let due = local_ms(tz, day, NaiveTime::MIN);
                let todo = NewTodo {
                    title: format!("{} {} - {}", a.icon, a.name, p.label),
                    due_at: due,
                    all_day: true,
                    repeat: TodoRepeat::None,
                };
                self.add_todo(&todo, now)?;
                made = true;
            }
        }
        Ok(made)
    }

    /// Anniversaries that are today and not yet celebrated today.
    pub fn celebrations_due<Tz: TimeZone>(&self, tz: &Tz, now: Millis) -> Result<Vec<Celebration>> {
        let Some(today) = local_date(tz, now) else {
            return Ok(vec![]);
        };
        let today_text = today.format("%Y-%m-%d").to_string();
        let settings = self.settings()?;
        let celebrate = settings.get("celebrate");
        let enabled = celebrate.and_then(|c| c.get("enabled")).and_then(Value::as_bool).unwrap_or(true);
        let seconds = celebrate
            .and_then(|c| c.get("seconds"))
            .and_then(Value::as_u64)
            .map_or(DEFAULT_CELEBRATE_SECONDS, |s| s.clamp(10, 60) as u32);
        let mut out = vec![];
        for a in self.list_anniversaries()? {
            if anniversary_on_or_after(a.month, a.day, today) != Some(today) {
                continue;
            }
            let done: Option<String> =
                self.conn.query_row("SELECT celebrated_on FROM anniversaries WHERE id = ?1", [a.id], |r| r.get(0))?;
            if done.as_deref() == Some(today_text.as_str()) {
                continue;
            }
            let years = a.since.map(|y| today.year() - y).filter(|&n| n > 0);
            let effect = enabled && a.effect;
            out.push(Celebration { anniversary: a, years, effect, seconds, peek: false });
        }
        Ok(out)
    }

    /// The pet celebrated it today: not again until next year.
    pub fn mark_celebrated<Tz: TimeZone>(&self, tz: &Tz, id: i64, now: Millis) -> Result<()> {
        if let Some(today) = local_date(tz, now) {
            self.conn.execute(
                "UPDATE anniversaries SET celebrated_on = ?2 WHERE id = ?1",
                params![id, today.format("%Y-%m-%d").to_string()],
            )?;
        }
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
            skipped_fire: r.get(11)?,
            repeat_days: r.get(12)?,
            off_at: r.get(13)?,
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

    /// When an alarm set for `at` first rings, the local time of day a repeating one keeps, and
    /// its days (only for `Repeat::Days`).
    fn alarm_times<Tz: TimeZone>(
        tz: &Tz,
        at: Millis,
        repeat: Repeat,
        days: DayMask,
    ) -> Result<(Option<String>, Millis, DayMask)> {
        let repeat_days = if repeat == Repeat::Days { days & EVERY_DAY } else { 0 };
        if repeat == Repeat::Days && repeat_days == 0 {
            return Err(StoreError::Invalid("pick at least one day".into()));
        }
        let (time_hm, first) = match repeat {
            Repeat::None => (None, at),
            _ => {
                let local = DateTime::<Utc>::from_timestamp_millis(at)
                    .ok_or_else(|| StoreError::Invalid("bad time".into()))?
                    .with_timezone(tz);
                let t = NaiveTime::from_hms_opt(local.hour(), local.minute(), 0).unwrap_or_default();
                let first = next_occurrence(tz, at - 1, t, repeat.mask(repeat_days)).unwrap_or(at);
                (Some(format!("{:02}:{:02}", local.hour(), local.minute())), first)
            }
        };
        Ok((time_hm, first, repeat_days))
    }

    /// Editing an alarm: a new label, time and repeat, as if it were set again. It switches on,
    /// and a snooze cycle, skipped ring or "didn't ring" from its old time is forgotten.
    pub fn update_alarm<Tz: TimeZone>(
        &self,
        tz: &Tz,
        id: i64,
        label: &str,
        at: Millis,
        repeat: Repeat,
        days: DayMask,
    ) -> Result<Alarm> {
        let (time_hm, first, repeat_days) = Self::alarm_times(tz, at, repeat, days)?;
        let changed = self.conn.execute(
            "UPDATE alarms SET label = ?2, next_fire = ?3, time_hm = ?4, repeat = ?5, enabled = 1,
               repeat_days = ?6, snoozes = 0, rang_at = NULL, skipped_fire = NULL, off_at = NULL
             WHERE id = ?1",
            params![id, label.trim(), first, time_hm, repeat.as_str(), repeat_days],
        )?;
        if changed == 0 {
            return Err(StoreError::Invalid("that alarm no longer exists".into()));
        }
        self.alarm(id)?.ok_or_else(|| StoreError::Invalid("that alarm no longer exists".into()))
    }

    /// `at` is the first ring; repeating alarms remember its local time of day and ring first
    /// on the first of their days at or after `at`. `days` is only for `Repeat::Days`.
    pub fn add_alarm<Tz: TimeZone>(
        &self,
        tz: &Tz,
        label: &str,
        at: Millis,
        repeat: Repeat,
        days: DayMask,
        now: Millis,
    ) -> Result<Alarm> {
        let (time_hm, first, repeat_days) = Self::alarm_times(tz, at, repeat, days)?;
        self.conn.execute(
            "INSERT INTO alarms (label, next_fire, time_hm, repeat, enabled, created_at, repeat_days)
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
            params![label.trim(), first, time_hm, repeat.as_str(), now, repeat_days],
        )?;
        Ok(Alarm {
            id: self.conn.last_insert_rowid(),
            label: label.trim().into(),
            next_fire: Some(first),
            time_hm,
            repeat,
            enabled: true,
            snoozes: 0,
            missed_at: None,
            rang_at: None,
            created_at: Some(now),
            missed_seen_at: None,
            skipped_fire: None,
            repeat_days,
            off_at: None,
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
            next_occurrence(tz, now, t, alarm.days())
        } else {
            // One-shot alarms re-enabled after they rang have nothing to ring for.
            alarm.next_fire.filter(|&n| n > now)
        };
        // Switching a repeating alarm off or on ends any snooze cycle, so its next ring starts a
        // new one, and forgets a skipped ring.
        self.conn.execute(
            "UPDATE alarms SET enabled = ?2, next_fire = ?3, skipped_fire = NULL,
               snoozes = CASE WHEN repeat = 'none' THEN snoozes ELSE 0 END WHERE id = ?1",
            params![id, enabled && next.is_some_and(|n| n > now), next],
        )?;
        Ok(())
    }

    /// "Skip once" on a repeating alarm: its next ring (or the rest of a snooze cycle) is
    /// skipped and remembered in `skipped_fire`; it rings again at the occurrence after.
    pub fn skip_alarm_once<Tz: TimeZone>(&self, tz: &Tz, id: i64, now: Millis) -> Result<()> {
        let Some(alarm) = self.alarm(id)? else {
            return Ok(());
        };
        let (Some(skipped), Some(t), true) =
            (alarm.next_fire, alarm.time_hm.as_deref().and_then(parse_hm), alarm.enabled)
        else {
            return Err(StoreError::Invalid("only a repeating alarm that is on can skip a ring".into()));
        };
        if alarm.repeat == Repeat::None {
            return Err(StoreError::Invalid("only a repeating alarm can skip a ring".into()));
        }
        let next = next_occurrence(tz, skipped.max(now), t, alarm.days());
        self.conn.execute(
            "UPDATE alarms SET next_fire = ?2, skipped_fire = ?3, snoozes = 0 WHERE id = ?1",
            params![id, next, skipped],
        )?;
        Ok(())
    }

    /// "Undo" a skipped ring: the alarm rings at its next regular time again.
    pub fn unskip_alarm<Tz: TimeZone>(&self, tz: &Tz, id: i64, now: Millis) -> Result<()> {
        let Some(alarm) = self.alarm(id)? else {
            return Ok(());
        };
        let Some(t) = alarm.time_hm.as_deref().and_then(parse_hm) else {
            return Ok(());
        };
        let next = if alarm.enabled { next_occurrence(tz, now, t, alarm.days()) } else { alarm.next_fire };
        self.conn.execute("UPDATE alarms SET next_fire = ?2, skipped_fire = NULL WHERE id = ?1", params![id, next])?;
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
            (_, Some(t)) => next_occurrence(tz, now, t, alarm.days()),
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

    /// Returns everything that should ring now and marks it handled (to-dos are notified
    /// once; alarms are rescheduled or disabled).
    ///
    /// What came due while ePet wasn't running doesn't ring late (docs/INTERACTIONS.md, "When
    /// ePet wasn't running"), except an alarm that snoozes itself: it still rings within its
    /// snooze time (snooze length × automatic snoozes, 5 × 3 = 15 min by default), with the
    /// snoozes that time would have used already counted.
    pub fn take_due<Tz: TimeZone>(&self, tz: &Tz, now: Millis) -> Result<Vec<Reminder>> {
        let mut out = vec![];
        let day_time = self.todo_day_time()?;
        let mut todos: Vec<(i64, String, Millis, bool, Option<Millis>)> = vec![];
        {
            let mut stmt = self.conn.prepare(
                "SELECT id, title, due_at, all_day, remind_at FROM todos
                 WHERE done = 0 AND due_at IS NOT NULL AND due_at <= ?1 AND notified_at IS NULL",
            )?;
            let rows = stmt.query_map([now], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
            for row in rows {
                todos.push(row?);
            }
        }
        for (id, title, due, all_day, remind_at) in todos {
            let ring = if all_day {
                // A day's to-do reminds at the day's reminder time (or its "Later"), and any time
                // later that day if ePet wasn't running then. From the next day it's just overdue.
                let day = local_date(tz, due);
                let at = remind_at.or_else(|| day.and_then(|d| local_ms(tz, d, day_time))).unwrap_or(due);
                if at > now {
                    continue;
                }
                let day_end = day.and_then(|d| d.succ_opt()).and_then(|d| local_ms(tz, d, NaiveTime::MIN));
                day_end.is_some_and(|end| now < end)
            } else {
                let at = remind_at.unwrap_or(due);
                if at > now {
                    continue;
                }
                // Late (ePet wasn't running): no ring; the to-do shows as overdue.
                now - at <= LATE_TOLERANCE_MS
            };
            if ring {
                out.push(Reminder { kind: ReminderKind::Todo, id, title, peek: false, all_day });
            }
            self.conn.execute("UPDATE todos SET notified_at = ?2, remind_at = NULL WHERE id = ?1", params![id, now])?;
        }

        let (snooze_ms, auto_snoozes) = self.snooze_rules()?;
        let due: Vec<Alarm> =
            self.list_alarms()?.into_iter().filter(|a| a.enabled && a.next_fire.is_some_and(|n| n <= now)).collect();
        for a in due {
            let fire_at = a.next_fire.unwrap_or(now);
            let next = a.time_hm.as_deref().and_then(parse_hm).and_then(|t| match a.repeat {
                Repeat::None => None,
                _ => next_occurrence(tz, now, t, a.days()),
            });
            // The ringing cycle began at its first ring; a snoozed ring keeps that time.
            let cycle_start = if a.snoozes > 0 { a.rang_at.unwrap_or(fire_at) } else { fire_at };
            let snoozes_itself = !a.label.starts_with(TIMER_PREFIX) && auto_snoozes > 0 && snooze_ms > 0;
            let on_time = now - fire_at <= LATE_TOLERANCE_MS;
            let within_snoozes = snoozes_itself && now - cycle_start <= snooze_ms * auto_snoozes as Millis;
            if on_time || within_snoozes {
                // Rung late within its snooze time: the snoozes that time used are counted, so
                // it gives up when it would have anyway (9:00 rung at 9:12 → 2 used, 1 left).
                let snoozes = if on_time {
                    a.snoozes
                } else {
                    (((now - cycle_start) / snooze_ms) as u32).min(auto_snoozes).max(a.snoozes)
                };
                out.push(Reminder {
                    kind: ReminderKind::Alarm,
                    id: a.id,
                    title: a.label.clone(),
                    peek: false,
                    all_day: false,
                });
                // Rung alarms and timers stay (disabled) so the user can still snooze them, and
                // finished ones stay in the history until the daily clean-up.
                // `rang_at` is when this ringing cycle began, so "Alarm 9:40 PM" stays 9:40
                // however often it was snoozed. A new cycle (no snoozes before) also forgets the
                // previous cycle's missed state. A ring means any skipped one is behind it.
                self.conn.execute(
                    "UPDATE alarms SET next_fire = ?2, enabled = ?3, skipped_fire = NULL, off_at = NULL,
                       rang_at = ?4, snoozes = ?5,
                       missed_at = CASE WHEN snoozes = 0 THEN NULL ELSE missed_at END,
                       missed_seen_at = CASE WHEN snoozes = 0 THEN NULL ELSE missed_seen_at END
                     WHERE id = ?1",
                    params![a.id, next, next.is_some(), cycle_start, snoozes],
                )?;
            } else if next.is_some() {
                // Came due while ePet wasn't running: a repeating alarm just waits for its next day.
                self.conn.execute(
                    "UPDATE alarms SET next_fire = ?2, enabled = 1, skipped_fire = NULL, snoozes = 0 WHERE id = ?1",
                    params![a.id, next],
                )?;
            } else {
                // A one-off alarm or a timer: finished without ringing ("ePet wasn't running"),
                // not missed.
                self.conn.execute(
                    "UPDATE alarms SET next_fire = NULL, enabled = 0, skipped_fire = NULL, off_at = ?2 WHERE id = ?1",
                    params![a.id, cycle_start],
                )?;
            }
        }
        Ok(out)
    }

    /// Snooze length (ms) and automatic snoozes for alarms (Settings → Alerts; 5 min × 3).
    fn snooze_rules(&self) -> Result<(Millis, u32)> {
        let settings = self.settings()?;
        let alarm = settings.get("alerts").and_then(|a| a.get("alarm"));
        let minutes = alarm.and_then(|a| a.get("snoozeMinutes")).and_then(Value::as_f64).unwrap_or(5.0);
        let max = alarm.and_then(|a| a.get("autoSnoozeMax")).and_then(Value::as_u64).unwrap_or(3);
        Ok(((minutes * 60_000.0) as Millis, max as u32))
    }

    // --- What the hidden pet couldn't tell you ----------------------------------

    /// Something the hidden pet rang that nobody answered. Shown when the pet is shown again.
    pub fn record_unseen(&self, u: &NewUnseen, now: Millis) -> Result<()> {
        // Once per thing (an alarm's cycle, a timer, a to-do's reminder).
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM unseen WHERE kind = ?1 AND ref_id = ?2 AND at = ?3)",
            params![u.kind.as_str(), u.ref_id, u.at],
            |r| r.get(0),
        )?;
        if !exists {
            self.conn.execute(
                "INSERT INTO unseen (kind, ref_id, title, at, snoozes, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![u.kind.as_str(), u.ref_id, u.title, u.at, u.snoozes, now],
            )?;
        }
        Ok(())
    }

    /// Oldest first.
    pub fn list_unseen(&self) -> Result<Vec<Unseen>> {
        let mut stmt = self.conn.prepare("SELECT id, kind, ref_id, title, at, snoozes FROM unseen ORDER BY at, id")?;
        let rows = stmt.query_map([], |r| {
            Ok(Unseen {
                id: r.get(0)?,
                kind: UnseenKind::parse(&r.get::<_, String>(1)?),
                ref_id: r.get(2)?,
                title: r.get(3)?,
                at: r.get(4)?,
                snoozes: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// "Done" on the list: it's seen. Missed alarms in it count as seen too (their badge goes;
    /// the history still says Missed).
    pub fn clear_unseen(&self, now: Millis) -> Result<()> {
        for u in self.list_unseen()? {
            if u.kind == UnseenKind::Alarm {
                self.acknowledge_missed(u.ref_id, now)?;
            }
        }
        self.conn.execute("DELETE FROM unseen", [])?;
        Ok(())
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

    /// Advances the tomato clock if its phase ended, and starts it at the start of work hours.
    /// Returns the new status on change.
    pub fn tick_pomodoro<Tz: TimeZone>(&self, tz: &Tz, now: Millis) -> Result<Option<PomodoroStatus>> {
        let status = self.pomodoro_status()?;
        let config = self.pomodoro_config()?;
        // Work hours: once per work period, start it if it isn't running. A period that began
        // with it running counts too, so stopping it by hand keeps it stopped until the next.
        if let Some(period) = pomodoro::current_work_period(tz, &config.work_hours, now) {
            let seen = self.get_kv(AUTO_PERIOD_KEY)?.and_then(|v| v.parse::<Millis>().ok());
            if seen != Some(period) {
                self.set_kv(AUTO_PERIOD_KEY, &period.to_string())?;
                if status.phase == Phase::Idle {
                    let next = pomodoro::start_focus(now, &config, 0);
                    self.set_pomodoro(&next, now)?;
                    return Ok(Some(next));
                }
            }
        }
        let cutoff = self.pomodoro_cutoff(tz, &status, &config);
        match pomodoro::tick(&status, now, &config, cutoff) {
            Some(next) => {
                self.set_pomodoro(&next, status.ends_at.unwrap_or(now))?;
                Ok(Some(next))
            }
            None => Ok(None),
        }
    }

    /// When the current run must stop (work hours), if it must.
    pub fn pomodoro_cutoff<Tz: TimeZone>(&self, tz: &Tz, s: &PomodoroStatus, c: &PomodoroConfig) -> Option<Millis> {
        pomodoro::run_cutoff(tz, &c.work_hours, s.run_started_at?)
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
    fn todo(title: &str, due_at: Option<Millis>) -> NewTodo {
        NewTodo { title: title.into(), due_at, ..Default::default() }
    }

    fn at(h: u32, m: u32) -> Millis {
        London.with_ymd_and_hms(2026, 1, 7, h, m, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn todo_reminders_fire_once_and_rearm_on_new_due_time() {
        let s = Store::open_in_memory().unwrap();
        let t = s.add_todo(&todo("  call mom ", Some(at(15, 0))), at(9, 0)).unwrap();
        assert_eq!(t.title, "call mom");
        assert!(s.take_due(&London, at(14, 59)).unwrap().is_empty());
        let due = s.take_due(&London, at(15, 0)).unwrap();
        assert_eq!(
            due,
            vec![Reminder {
                kind: ReminderKind::Todo,
                id: t.id,
                title: "call mom".into(),
                peek: false,
                all_day: false
            }]
        );
        assert!(s.take_due(&London, at(15, 1)).unwrap().is_empty());

        s.update_todo(&London, t.id, &TodoPatch { due_at: Some(Some(at(15, 10))), ..Default::default() }, at(15, 5))
            .unwrap();
        assert_eq!(s.take_due(&London, at(15, 10)).unwrap().len(), 1);

        s.update_todo(
            &London,
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
        let a = s.add_alarm(&London, "Dentist", at(10, 5), Repeat::None, 0, at(6, 0)).unwrap();
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
        let t = s.add_alarm(&London, "Timer: 12 min", at(10, 12), Repeat::None, 0, at(10, 0)).unwrap();
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
        // Later columns (v7, v8) get their defaults.
        assert_eq!((alarms[0].skipped_fire, alarms[0].repeat_days), (None, 0));
        drop(s);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn daily_alarm_reschedules_and_snooze_works() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Wake up", at(7, 30), Repeat::Daily, 0, at(6, 0)).unwrap();
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
        s.add_alarm(&London, "Wake up", at(7, 30), Repeat::Daily, 0, at(6, 0)).unwrap();
        assert!(s.take_due(&London, at(12, 0)).unwrap().is_empty());
        assert!(s.list_alarms().unwrap()[0].enabled);
    }

    #[test]
    fn pomodoro_logs_sessions_into_daily_stats() {
        let s = Store::open_in_memory().unwrap();
        let config = s.pomodoro_config().unwrap();
        s.set_pomodoro(&pomodoro::start_focus(at(9, 0), &config, 0), at(9, 0)).unwrap();
        let change = s.tick_pomodoro(&London, at(9, 25)).unwrap().unwrap();
        assert_eq!(change.phase, Phase::ShortBreak);
        // Stop a second session early (10 of 25 minutes).
        s.set_pomodoro(&pomodoro::start_focus(at(10, 0), &config, 1), at(10, 0)).unwrap();
        s.set_pomodoro(&PomodoroStatus::default(), at(10, 10)).unwrap();

        let stats = s.pomodoro_stats(&London, 2, at(18, 0)).unwrap();
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[1], DayStat { day: "2026-01-07".into(), completed: 1, focus_minutes: 35 });
        assert_eq!(stats[0].completed, 0);
    }

    /// Work hours Mon–Fri 09:00–17:30 (plus overrides), short sessions to keep the maths easy.
    fn work_store(extra: serde_json::Value) -> Store {
        let s = Store::open_in_memory().unwrap();
        let mut wh = serde_json::json!({"enabled": true, "days": 0b011_1110, "start": "09:00", "end": "17:30"});
        if let (Some(w), Some(e)) = (wh.as_object_mut(), extra.as_object()) {
            w.extend(e.clone());
        }
        s.set_settings(&serde_json::json!({"pomodoro": {"focusMin": 25, "shortBreakMin": 5, "workHours": wh}}))
            .unwrap();
        s
    }

    #[test]
    fn work_hours_start_it_once_a_day() {
        // 2026-01-07 is a Wednesday.
        let s = work_store(serde_json::json!({}));
        assert_eq!(s.tick_pomodoro(&London, at(8, 59)).unwrap(), None);
        let started = s.tick_pomodoro(&London, at(9, 0)).unwrap().unwrap();
        assert_eq!((started.phase, started.run_started_at), (Phase::Focus, Some(at(9, 0))));
        // Stopped by hand: it stays stopped for the rest of the day…
        s.set_pomodoro(&PomodoroStatus::default(), at(9, 10)).unwrap();
        assert_eq!(s.tick_pomodoro(&London, at(9, 11)).unwrap(), None);
        assert_eq!(s.tick_pomodoro(&London, at(12, 0)).unwrap(), None);
        // …and starts again the next work day (a computer switched on at 10:00 counts).
        let thu = at(10, 0) + DAY;
        assert_eq!(s.tick_pomodoro(&London, thu).unwrap().map(|p| p.phase), Some(Phase::Focus));
        // Not at the weekend.
        s.set_pomodoro(&PomodoroStatus::default(), thu).unwrap();
        assert_eq!(s.tick_pomodoro(&London, at(9, 0) + 3 * DAY).unwrap(), None);
    }

    #[test]
    fn a_period_that_began_with_it_running_counts_as_started() {
        let s = work_store(serde_json::json!({}));
        let c = s.pomodoro_config().unwrap();
        s.set_pomodoro(&pomodoro::start_focus(at(8, 50), &c, 0), at(8, 50)).unwrap();
        s.tick_pomodoro(&London, at(9, 0)).unwrap();
        s.set_pomodoro(&PomodoroStatus::default(), at(9, 5)).unwrap();
        assert_eq!(s.tick_pomodoro(&London, at(9, 6)).unwrap(), None);
    }

    #[test]
    fn no_new_focus_after_the_end_of_work() {
        let s = work_store(serde_json::json!({}));
        let c = s.pomodoro_config().unwrap();
        // A focus ending after 17:30 skips its break.
        let run = PomodoroStatus { run_started_at: Some(at(9, 0)), ..pomodoro::start_focus(at(17, 20), &c, 3) };
        s.set_pomodoro(&run, at(17, 20)).unwrap();
        s.set_kv(AUTO_PERIOD_KEY, &at(9, 0).to_string()).unwrap();
        assert_eq!(s.tick_pomodoro(&London, at(17, 45)).unwrap().map(|p| p.phase), Some(Phase::Idle));
        // A break ending after 17:30 doesn't start another focus.
        let brk = PomodoroStatus {
            phase: Phase::ShortBreak,
            round: 1,
            ends_at: Some(at(17, 32)),
            run_started_at: Some(at(9, 0)),
        };
        s.set_pomodoro(&brk, at(17, 27)).unwrap();
        assert_eq!(s.tick_pomodoro(&London, at(17, 32)).unwrap().map(|p| p.phase), Some(Phase::Idle));
        // Before 17:30 it carries on.
        let early = PomodoroStatus { ends_at: Some(at(12, 0)), ..brk };
        s.set_pomodoro(&early, at(11, 55)).unwrap();
        assert_eq!(s.tick_pomodoro(&London, at(12, 0)).unwrap().map(|p| p.phase), Some(Phase::Focus));
    }

    #[test]
    fn a_run_started_in_the_evening_stops_at_the_next_days_end_of_work() {
        let s = work_store(serde_json::json!({}));
        let c = s.pomodoro_config().unwrap();
        let evening = pomodoro::start_focus(at(20, 0), &c, 0);
        assert_eq!(s.pomodoro_cutoff(&London, &evening, &c), Some(at(17, 30) + DAY));
        // Friday evening: Monday's end of work.
        let fri = pomodoro::start_focus(at(20, 0) + 2 * DAY, &c, 0);
        assert_eq!(s.pomodoro_cutoff(&London, &fri, &c), Some(at(17, 30) + 5 * DAY));
    }

    #[test]
    fn night_shift_hours_end_the_next_morning() {
        let s = work_store(serde_json::json!({"start": "22:00", "end": "06:00"}));
        let c = s.pomodoro_config().unwrap();
        let run = pomodoro::start_focus(at(23, 0), &c, 0);
        assert_eq!(s.pomodoro_cutoff(&London, &run, &c), Some(at(6, 0) + DAY));
        // 01:00 Thursday is inside Wednesday's shift.
        assert_eq!(pomodoro::current_work_period(&London, &c.work_hours, at(1, 0) + DAY), Some(at(22, 0)));
    }

    #[test]
    fn work_hours_off_changes_nothing() {
        let s = work_store(serde_json::json!({"enabled": false}));
        let c = s.pomodoro_config().unwrap();
        assert_eq!(s.tick_pomodoro(&London, at(9, 0)).unwrap(), None);
        let run = pomodoro::start_focus(at(17, 20), &c, 0);
        assert_eq!(s.pomodoro_cutoff(&London, &run, &c), None);
        s.set_pomodoro(&run, at(17, 20)).unwrap();
        assert_eq!(s.tick_pomodoro(&London, at(17, 45)).unwrap().map(|p| p.phase), Some(Phase::ShortBreak));
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
        let t = s.add_alarm(&London, "Timer: 1 min", at(10, 1), Repeat::None, 0, at(6, 0)).unwrap();
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
        let a = s.add_alarm(&London, "Wake up", at(7, 0), Repeat::Daily, 0, at(6, 0)).unwrap();
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
        let a = s.add_alarm(&London, "Dentist", at(15, 0), Repeat::None, 0, at(6, 0)).unwrap();
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
        let a = s.add_alarm(&London, "Alarm", at(21, 40), Repeat::None, 0, at(6, 0)).unwrap();
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
        let a = s.add_alarm(&London, "Wake up", at(7, 0), Repeat::Daily, 0, at(6, 0)).unwrap();
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

    const DAY: Millis = 24 * 60 * MIN;

    #[test]
    fn skip_once_skips_the_next_ring_and_undo_brings_it_back() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Wake up", at(7, 0), Repeat::Daily, 0, at(6, 0)).unwrap();
        s.skip_alarm_once(&London, a.id, at(6, 10)).unwrap();
        let skipped = &s.list_alarms().unwrap()[0];
        assert_eq!(
            (skipped.next_fire, skipped.skipped_fire, skipped.enabled),
            (Some(at(7, 0) + DAY), Some(at(7, 0)), true)
        );
        // Today's ring doesn't come.
        assert!(s.take_due(&London, at(7, 0)).unwrap().is_empty());
        // Undo: it rings today again.
        s.unskip_alarm(&London, a.id, at(6, 20)).unwrap();
        let back = &s.list_alarms().unwrap()[0];
        assert_eq!((back.next_fire, back.skipped_fire), (Some(at(7, 0)), None));
        // Skipped again, then tomorrow's ring clears the skip.
        s.skip_alarm_once(&London, a.id, at(6, 30)).unwrap();
        assert_eq!(s.take_due(&London, at(7, 0) + DAY).unwrap().len(), 1);
        assert_eq!(s.list_alarms().unwrap()[0].skipped_fire, None);
    }

    #[test]
    fn a_weekday_alarm_skipped_on_friday_rings_on_monday() {
        let s = Store::open_in_memory().unwrap();
        // 2026-01-07 is a Wednesday; Friday is two days on.
        let friday = at(7, 0) + 2 * DAY;
        let a = s.add_alarm(&London, "Work", friday, Repeat::Weekdays, 0, at(6, 0) + 2 * DAY).unwrap();
        s.skip_alarm_once(&London, a.id, at(6, 0) + 2 * DAY).unwrap();
        assert_eq!(s.list_alarms().unwrap()[0].next_fire, Some(friday + 3 * DAY));
    }

    #[test]
    fn an_alarm_on_chosen_days_rings_only_on_them() {
        let s = Store::open_in_memory().unwrap();
        let mon_wed_fri = 0b010_1010;
        // Set on Thursday for 7:00: the first ring is Friday.
        let thu = at(6, 0) + DAY;
        let a = s.add_alarm(&London, "Gym", at(7, 0) + DAY, Repeat::Days, mon_wed_fri, thu).unwrap();
        let fri = at(7, 0) + 2 * DAY;
        assert_eq!((a.next_fire, a.repeat_days, a.days()), (Some(fri), mon_wed_fri, mon_wed_fri));
        // Friday's ring: next is Monday.
        assert_eq!(s.take_due(&London, fri).unwrap().len(), 1);
        let mon = fri + 3 * DAY;
        assert_eq!(s.list_alarms().unwrap()[0].next_fire, Some(mon));
        // Skipping Monday: Wednesday.
        s.skip_alarm_once(&London, a.id, fri + DAY).unwrap();
        assert_eq!(s.list_alarms().unwrap()[0].next_fire, Some(mon + 2 * DAY));
        // No days: refused.
        assert!(s.add_alarm(&London, "None", at(7, 0), Repeat::Days, 0, at(6, 0)).is_err());
    }

    #[test]
    fn editing_an_alarm_sets_it_again_and_switches_it_on() {
        let s = Store::open_in_memory().unwrap();
        let mon_wed_fri = 0b010_1010;
        let tue_thu = 0b001_0100;
        // Wednesday's 7:00 Mon/Wed/Fri alarm (Jan 7 2026 is a Wednesday), snoozed, then off.
        let a = s.add_alarm(&London, "Gym", at(7, 0), Repeat::Days, mon_wed_fri, at(6, 0)).unwrap();
        s.take_due(&London, at(7, 0)).unwrap();
        s.snooze_alarm(a.id, 5, at(7, 1)).unwrap();
        s.set_alarm_enabled(&London, a.id, false, at(7, 2)).unwrap();
        // Edited on Wednesday evening to Tue/Thu 6:30: on, first ring Thursday, no snooze left.
        let thu = at(6, 30) + DAY;
        let e = s.update_alarm(&London, a.id, " Swim ", thu, Repeat::Days, tue_thu).unwrap();
        assert_eq!(
            (e.label.as_str(), e.enabled, e.next_fire, e.time_hm.as_deref(), e.repeat_days),
            ("Swim", true, Some(thu), Some("06:30"), tue_thu)
        );
        assert_eq!((e.snoozes, e.rang_at, e.skipped_fire), (0, None, None));
        assert_eq!(s.list_alarms().unwrap().len(), 1);
        // Made a one-off: no time of day or days kept.
        let once = s.update_alarm(&London, a.id, "Swim", at(8, 0), Repeat::None, tue_thu).unwrap();
        assert_eq!((once.next_fire, once.time_hm, once.repeat_days), (Some(at(8, 0)), None, 0));
        // No days, or an alarm that's gone: refused.
        assert!(s.update_alarm(&London, a.id, "Swim", at(8, 0), Repeat::Days, 0).is_err());
        s.delete_alarm(a.id).unwrap();
        assert!(s.update_alarm(&London, a.id, "Swim", at(8, 0), Repeat::Daily, 0).is_err());
    }

    #[test]
    fn nothing_rings_or_counts_as_missed_for_the_time_epet_was_off() {
        // Off at 8:30, a daily 9:00 alarm, back on at 10:00 the next day.
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Wake up", at(9, 0), Repeat::Daily, 0, at(8, 0)).unwrap();
        assert!(s.take_due(&London, at(10, 0) + DAY).unwrap().is_empty());
        let after = s.list_alarms().unwrap().into_iter().find(|x| x.id == a.id).unwrap();
        assert_eq!((after.next_fire, after.missed_at, after.snoozes), (Some(at(9, 0) + 2 * DAY), None, 0));
        // A one-off and a timer finish without ringing, marked as "ePet wasn't running".
        let once = s.add_alarm(&London, "Once", at(9, 0), Repeat::None, 0, at(8, 0)).unwrap();
        let timer = s.add_alarm(&London, "Timer: 5 min", at(9, 5), Repeat::None, 0, at(9, 0)).unwrap();
        assert!(s.take_due(&London, at(12, 0)).unwrap().is_empty());
        for id in [once.id, timer.id] {
            let x = s.list_alarms().unwrap().into_iter().find(|x| x.id == id).unwrap();
            assert_eq!((x.enabled, x.next_fire, x.missed_at, x.rang_at), (false, None, None, None));
            assert!(x.off_at.is_some());
        }
    }

    #[test]
    fn an_alarm_that_snoozes_itself_still_rings_within_its_snooze_time() {
        // 5 min × 3 by default: 9:00 rung at 9:12 has used 2 snoozes; at 9:16 it doesn't ring.
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Alarm", at(9, 0), Repeat::None, 0, at(8, 0)).unwrap();
        let rung = s.take_due(&London, at(9, 12)).unwrap();
        assert_eq!(rung.iter().map(|r| r.id).collect::<Vec<_>>(), vec![a.id]);
        let x = s.list_alarms().unwrap()[0].clone();
        assert_eq!((x.snoozes, x.rang_at), (2, Some(at(9, 0))));

        let b = s.add_alarm(&London, "Alarm", at(9, 0) + DAY, Repeat::None, 0, at(8, 0)).unwrap();
        assert!(s.take_due(&London, at(9, 16) + DAY).unwrap().is_empty());
        let y = s.list_alarms().unwrap().into_iter().find(|x| x.id == b.id).unwrap();
        assert_eq!((y.off_at, y.missed_at), (Some(at(9, 0) + DAY), None));
    }

    #[test]
    fn the_snooze_time_follows_the_settings() {
        let s = Store::open_in_memory().unwrap();
        s.set_settings(&serde_json::json!({"alerts": {"alarm": {"snoozeMinutes": 10, "autoSnoozeMax": 3}}})).unwrap();
        s.add_alarm(&London, "Alarm", at(9, 0), Repeat::None, 0, at(8, 0)).unwrap();
        assert_eq!(s.take_due(&London, at(9, 25)).unwrap().len(), 1);
        assert_eq!(s.list_alarms().unwrap()[0].snoozes, 2);
        // "Stop and mark as missed": no snooze time, so late is late.
        s.set_settings(&serde_json::json!({"alerts": {"alarm": {"snoozeMinutes": 5, "autoSnoozeMax": 0}}})).unwrap();
        s.add_alarm(&London, "Alarm", at(9, 0) + DAY, Repeat::None, 0, at(8, 0)).unwrap();
        assert!(s.take_due(&London, at(9, 2) + DAY).unwrap().is_empty());
    }

    #[test]
    fn timers_and_to_dos_have_no_grace_but_a_late_scheduler_tick_is_fine() {
        let s = Store::open_in_memory().unwrap();
        s.add_alarm(&London, "Timer: 1 min", at(9, 1), Repeat::None, 0, at(9, 0)).unwrap();
        let call = s.add_todo(&todo("Call mom", Some(at(9, 1))), at(9, 0)).unwrap();
        // 50 s late: still on time.
        assert_eq!(s.take_due(&London, at(9, 1) + 50_000).unwrap().len(), 2);
        s.add_alarm(&London, "Timer: 1 min", at(10, 1), Repeat::None, 0, at(10, 0)).unwrap();
        s.update_todo(&London, call.id, &TodoPatch { due_at: Some(Some(at(10, 1))), ..Default::default() }, at(10, 0))
            .unwrap();
        // 2 min late: neither rings; the to-do keeps its time (it shows as overdue).
        assert!(s.take_due(&London, at(10, 3)).unwrap().is_empty());
        let t = s.list_todos().unwrap()[0].clone();
        assert_eq!((t.done, t.due_at), (false, Some(at(10, 1))));
    }

    fn day_todo(title: &str, day: Millis, repeat: TodoRepeat) -> NewTodo {
        NewTodo { title: title.into(), due_at: Some(day), all_day: true, repeat }
    }

    #[test]
    fn a_days_to_do_reminds_at_the_day_time_and_any_time_later_that_day() {
        let s = Store::open_in_memory().unwrap();
        let midnight = at(0, 0);
        let bins = s.add_todo(&day_todo("bins", midnight, TodoRepeat::None), at(8, 0) - DAY).unwrap();
        let bills = s.add_todo(&day_todo("bills", midnight, TodoRepeat::None), at(8, 0) - DAY).unwrap();
        // Not before 9:00 (the default), then both at once, marked as a day's to-dos.
        assert!(s.take_due(&London, at(8, 59)).unwrap().is_empty());
        let due = s.take_due(&London, at(9, 0)).unwrap();
        assert_eq!(due.iter().map(|r| (r.id, r.all_day)).collect::<Vec<_>>(), vec![(bins.id, true), (bills.id, true)]);
        // "Later" keeps the day and reminds again then.
        s.update_todo(&London, bins.id, &TodoPatch { remind_at: Some(at(9, 10)), ..Default::default() }, at(9, 0))
            .unwrap();
        assert!(s.take_due(&London, at(9, 9)).unwrap().is_empty());
        assert_eq!(s.take_due(&London, at(9, 10)).unwrap().len(), 1);
        assert_eq!(s.list_todos().unwrap()[0].due_at, Some(midnight));
        // ePet started at 4 pm: still reminds that day; started the next day: overdue, no ring.
        s.add_todo(&day_todo("late start", midnight, TodoRepeat::None), 0).unwrap();
        assert_eq!(s.take_due(&London, at(16, 0)).unwrap().len(), 1);
        s.add_todo(&day_todo("next day", midnight, TodoRepeat::None), 0).unwrap();
        assert!(s.take_due(&London, at(0, 30) + DAY).unwrap().is_empty());
        // The time comes from the settings.
        s.set_settings(&serde_json::json!({ "todoDayTime": "07:15" })).unwrap();
        s.add_todo(&day_todo("early", midnight + DAY, TodoRepeat::None), 0).unwrap();
        assert_eq!(s.take_due(&London, at(7, 15) + DAY).unwrap().len(), 1);
    }

    #[test]
    fn ticking_a_repeating_to_do_logs_it_and_moves_it_on() {
        let s = Store::open_in_memory().unwrap();
        // Weekly bins on Wednesday Jan 7 2026 (a day's to-do), ticked that evening.
        let wed = at(0, 0);
        let bins = s.add_todo(&day_todo("bins", wed, TodoRepeat::Weekly), wed).unwrap();
        let done = TodoPatch { done: Some(true), ..Default::default() };
        s.update_todo(&London, bins.id, &done, at(19, 0)).unwrap();
        let all = s.list_todos().unwrap();
        assert_eq!(all.len(), 2);
        let open = all.iter().find(|t| t.id == bins.id).unwrap();
        assert_eq!((open.done, open.due_at, open.repeat), (false, Some(wed + 7 * DAY), TodoRepeat::Weekly));
        let logged = all.iter().find(|t| t.id != bins.id).unwrap();
        assert_eq!(
            (logged.done, logged.due_at, logged.done_at, logged.repeat),
            (true, Some(wed), Some(at(19, 0)), TodoRepeat::None)
        );
        // Three weeks behind, ticked on a Thursday: next is the coming Wednesday, not a missed one.
        s.update_todo(&London, bins.id, &done, at(10, 0) + 29 * DAY).unwrap();
        let open = s.list_todos().unwrap().into_iter().find(|t| t.id == bins.id).unwrap();
        assert_eq!(open.due_at, Some(wed + 35 * DAY));
        // Ticked early (Monday before its Wednesday): the Wednesday after.
        s.update_todo(&London, bins.id, &done, at(10, 0) + 33 * DAY).unwrap();
        let open = s.list_todos().unwrap().into_iter().find(|t| t.id == bins.id).unwrap();
        assert_eq!(open.due_at, Some(wed + 42 * DAY));
        // A daily day's to-do ticked today is next tomorrow; a monthly one with a time, next month.
        let daily = s.add_todo(&day_todo("meds", wed, TodoRepeat::Daily), wed).unwrap();
        s.update_todo(&London, daily.id, &done, at(8, 0)).unwrap();
        assert_eq!(s.list_todos().unwrap().into_iter().find(|t| t.id == daily.id).unwrap().due_at, Some(wed + DAY));
        let rent = s
            .add_todo(
                &NewTodo {
                    title: "rent".into(),
                    due_at: Some(at(9, 0)),
                    repeat: TodoRepeat::Monthly,
                    ..Default::default()
                },
                wed,
            )
            .unwrap();
        s.update_todo(&London, rent.id, &done, at(9, 5)).unwrap();
        let next = London.with_ymd_and_hms(2026, 2, 7, 9, 0, 0).unwrap().timestamp_millis();
        assert_eq!(s.list_todos().unwrap().into_iter().find(|t| t.id == rent.id).unwrap().due_at, Some(next));
        // Unticking the first logged time undoes that tick: bins is back on its first day.
        s.update_todo(&London, logged.id, &TodoPatch { done: Some(false), ..Default::default() }, at(20, 0)).unwrap();
        let all = s.list_todos().unwrap();
        assert!(all.iter().all(|t| t.id != logged.id));
        assert_eq!(all.iter().find(|t| t.id == bins.id).unwrap().due_at, Some(wed));
    }

    #[test]
    fn unticking_a_logged_time_undoes_the_tick() {
        let s = Store::open_in_memory().unwrap();
        // Fortnightly bins on Tuesday Jan 13 (a day's to-do), ticked early on Wednesday the 7th.
        let tue = at(0, 0) + 6 * DAY;
        let bins = s.add_todo(&day_todo("bins", tue, TodoRepeat::Fortnightly), at(9, 0)).unwrap();
        let tick = TodoPatch { done: Some(true), ..Default::default() };
        let untick = TodoPatch { done: Some(false), ..Default::default() };
        s.update_todo(&London, bins.id, &tick, at(10, 0)).unwrap();
        let logged = s.list_todos().unwrap().into_iter().find(|t| t.id != bins.id).unwrap();
        // Unticked in Done: the entry goes and bins is back on the 13th, reminded as usual.
        s.update_todo(&London, logged.id, &untick, at(10, 5)).unwrap();
        let all = s.list_todos().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!((all[0].id, all[0].due_at, all[0].done), (bins.id, Some(tue), false));
        assert_eq!(s.take_due(&London, tue + 9 * 60 * MIN).unwrap().len(), 1);
        // Back on a day already reached: no second reminder for it.
        let wed = at(0, 0);
        let daily = s.add_todo(&day_todo("meds", wed, TodoRepeat::Daily), wed).unwrap();
        assert_eq!(s.take_due(&London, at(9, 0)).unwrap().len(), 1);
        s.update_todo(&London, daily.id, &tick, at(9, 30)).unwrap();
        let logged = s.list_todos().unwrap().into_iter().find(|t| t.done).unwrap();
        s.update_todo(&London, logged.id, &untick, at(9, 40)).unwrap();
        assert!(s.take_due(&London, at(9, 45)).unwrap().is_empty());
        assert_eq!(s.list_todos().unwrap().into_iter().find(|t| t.id == daily.id).unwrap().due_at, Some(wed));
        // Its to-do deleted: the entry just becomes an open to-do.
        s.update_todo(&London, daily.id, &tick, at(9, 50)).unwrap();
        let logged = s.list_todos().unwrap().into_iter().find(|t| t.done).unwrap();
        s.delete_todo(daily.id).unwrap();
        s.update_todo(&London, logged.id, &untick, at(10, 0)).unwrap();
        let left = s.list_todos().unwrap().into_iter().find(|t| t.id == logged.id).unwrap();
        assert_eq!((left.done, left.repeat), (false, TodoRepeat::None));
    }

    #[test]
    fn a_to_do_without_a_day_doesnt_repeat_and_a_new_day_restarts_the_count() {
        let s = Store::open_in_memory().unwrap();
        let t = s
            .add_todo(
                &NewTodo { title: "x".into(), repeat: TodoRepeat::Weekly, all_day: true, ..Default::default() },
                0,
            )
            .unwrap();
        assert_eq!((t.repeat, t.all_day), (TodoRepeat::None, false));
        // Edited to a monthly day's to-do on the 31st, then its day cleared.
        let jan31 = London.with_ymd_and_hms(2026, 1, 31, 0, 0, 0).unwrap().timestamp_millis();
        let patch = TodoPatch {
            due_at: Some(Some(jan31)),
            all_day: Some(true),
            repeat: Some(TodoRepeat::Monthly),
            ..Default::default()
        };
        s.update_todo(&London, t.id, &patch, 0).unwrap();
        let x = &s.list_todos().unwrap()[0];
        assert_eq!((x.due_at, x.all_day, x.repeat), (Some(jan31), true, TodoRepeat::Monthly));
        s.update_todo(&London, t.id, &TodoPatch { done: Some(true), ..Default::default() }, jan31 + DAY).unwrap();
        let feb28 = London.with_ymd_and_hms(2026, 2, 28, 0, 0, 0).unwrap().timestamp_millis();
        assert_eq!(s.list_todos().unwrap().into_iter().find(|x| x.id == t.id).unwrap().due_at, Some(feb28));
        s.update_todo(&London, t.id, &TodoPatch { due_at: Some(None), ..Default::default() }, 0).unwrap();
        let x = s.list_todos().unwrap().into_iter().find(|x| x.id == t.id).unwrap();
        assert_eq!((x.due_at, x.all_day, x.repeat), (None, false, TodoRepeat::None));
    }

    fn birthday(day: u32) -> NewAnniversary {
        NewAnniversary {
            kind: "birthday".into(),
            icon: "🎂".into(),
            name: " Mum ".into(),
            month: 1,
            day,
            since: Some(1990),
            preps: vec![
                AnniversaryPrep { lead: "1d".into(), label: "Order a cake".into() },
                AnniversaryPrep { lead: "1w".into(), label: "Buy a gift".into() },
                AnniversaryPrep { lead: "2d".into(), label: "  ".into() },
            ],
            effect: true,
        }
    }

    #[test]
    fn anniversary_reminders_become_day_to_dos_once() {
        let s = Store::open_in_memory().unwrap();
        // Added on Wednesday Jan 7 for Saturday Jan 10: "1 week before" (Jan 3) has passed.
        let a = s.add_anniversary(&birthday(10), at(9, 0)).unwrap();
        assert_eq!((a.name.as_str(), a.preps.len()), ("Mum", 2));
        assert!(!s.tick_anniversaries(&London, at(9, 0)).unwrap());
        // Friday the 9th: the cake, on its day, without a time. Only once.
        assert!(s.tick_anniversaries(&London, at(8, 0) + 2 * DAY).unwrap());
        assert!(!s.tick_anniversaries(&London, at(18, 0) + 2 * DAY).unwrap());
        let todos = s.list_todos().unwrap();
        assert_eq!(todos.len(), 1);
        assert_eq!(
            (todos[0].title.as_str(), todos[0].due_at, todos[0].all_day),
            ("🎂 Mum - Order a cake", Some(at(0, 0) + 2 * DAY), true)
        );
        // Deleting the anniversary keeps its to-do.
        s.delete_anniversary(a.id).unwrap();
        assert_eq!(s.list_todos().unwrap().len(), 1);
        assert!(s.list_anniversaries().unwrap().is_empty());
    }

    #[test]
    fn an_anniversary_reminder_missed_while_off_is_made_late() {
        let s = Store::open_in_memory().unwrap();
        s.add_anniversary(&birthday(10), at(9, 0)).unwrap();
        // Off on the 9th, on again on the 10th: the cake to-do is made, due (overdue) on the 9th.
        assert!(s.tick_anniversaries(&London, at(9, 0) + 3 * DAY).unwrap());
        assert_eq!(s.list_todos().unwrap()[0].due_at, Some(at(0, 0) + 2 * DAY));
    }

    #[test]
    fn an_anniversary_is_celebrated_once_on_its_day() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_anniversary(&birthday(10), at(9, 0)).unwrap();
        assert!(s.celebrations_due(&London, at(9, 0)).unwrap().is_empty());
        let sat = at(10, 0) + 3 * DAY;
        let due = s.celebrations_due(&London, sat).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!((due[0].anniversary.id, due[0].years, due[0].effect, due[0].seconds), (a.id, Some(36), true, 15));
        s.mark_celebrated(&London, a.id, sat).unwrap();
        assert!(s.celebrations_due(&London, sat + 60 * MIN).unwrap().is_empty());
        // Next year again; the settings turn the effect off and set its length (10–60 s).
        s.set_settings(&serde_json::json!({ "celebrate": { "enabled": false, "seconds": 90 } })).unwrap();
        let next = London.with_ymd_and_hms(2027, 1, 10, 9, 0, 0).unwrap().timestamp_millis();
        let due = s.celebrations_due(&London, next).unwrap();
        assert_eq!((due[0].years, due[0].effect, due[0].seconds), (Some(37), false, 60));
    }

    #[test]
    fn anniversaries_need_a_name_and_a_real_day() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.add_anniversary(&NewAnniversary { name: " ".into(), ..birthday(10) }, 0).is_err());
        assert!(s.add_anniversary(&NewAnniversary { month: 2, day: 30, ..birthday(10) }, 0).is_err());
        let leap = s.add_anniversary(&NewAnniversary { month: 2, day: 29, ..birthday(10) }, 0).unwrap();
        let edited = s
            .update_anniversary(leap.id, &NewAnniversary { name: "Dad".into(), effect: false, ..birthday(3) }, 5)
            .unwrap();
        assert_eq!((edited.name.as_str(), edited.month, edited.day, edited.effect), ("Dad", 1, 3, false));
        assert!(s.update_anniversary(999, &birthday(3), 5).is_err());
    }

    #[test]
    fn what_the_hidden_pet_rang_unanswered_waits_until_done() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Alarm", at(9, 0), Repeat::None, 0, at(8, 0)).unwrap();
        s.take_due(&London, at(9, 0)).unwrap();
        s.mark_alarm_missed(a.id, at(9, 16)).unwrap();
        let alarm =
            NewUnseen { kind: UnseenKind::Alarm, ref_id: a.id, title: "Alarm".into(), at: at(9, 0), snoozes: 3 };
        let todo = NewUnseen { kind: UnseenKind::Todo, ref_id: 7, title: "Call mom".into(), at: at(8, 30), snoozes: 0 };
        s.record_unseen(&alarm, at(9, 16)).unwrap();
        s.record_unseen(&alarm, at(9, 17)).unwrap(); // once
        s.record_unseen(&todo, at(8, 31)).unwrap();
        let list = s.list_unseen().unwrap();
        assert_eq!(list.iter().map(|u| u.title.as_str()).collect::<Vec<_>>(), vec!["Call mom", "Alarm"]);
        // Done: the list goes; the missed alarm is seen but still missed.
        s.clear_unseen(at(12, 0)).unwrap();
        assert!(s.list_unseen().unwrap().is_empty());
        let x = s.list_alarms().unwrap()[0].clone();
        assert_eq!((x.missed_at, x.missed_seen_at), (Some(at(9, 16)), Some(at(12, 0))));
    }

    #[test]
    fn skipping_a_snoozed_alarm_ends_todays_cycle() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Wake up", at(7, 0), Repeat::Daily, 0, at(6, 0)).unwrap();
        s.take_due(&London, at(7, 0)).unwrap();
        s.snooze_alarm(a.id, 5, at(7, 1)).unwrap();
        s.skip_alarm_once(&London, a.id, at(7, 2)).unwrap();
        let x = &s.list_alarms().unwrap()[0];
        assert_eq!((x.next_fire, x.skipped_fire, x.snoozes), (Some(at(7, 0) + DAY), Some(at(7, 6)), 0));
    }

    #[test]
    fn only_repeating_alarms_that_are_on_can_skip() {
        let s = Store::open_in_memory().unwrap();
        let once = s.add_alarm(&London, "Once", at(9, 0), Repeat::None, 0, at(6, 0)).unwrap();
        assert!(s.skip_alarm_once(&London, once.id, at(6, 0)).is_err());
        let daily = s.add_alarm(&London, "Daily", at(9, 0), Repeat::Daily, 0, at(6, 0)).unwrap();
        s.skip_alarm_once(&London, daily.id, at(6, 0)).unwrap();
        // Switching it off (or on) forgets the skip.
        s.set_alarm_enabled(&London, daily.id, false, at(6, 1)).unwrap();
        let off = s.list_alarms().unwrap().into_iter().find(|a| a.id == daily.id).unwrap();
        assert_eq!(off.skipped_fire, None);
        assert!(s.skip_alarm_once(&London, daily.id, at(6, 2)).is_err());
    }

    #[test]
    fn snoozing_a_deleted_alarm_is_an_error_not_a_silent_no_op() {
        let s = Store::open_in_memory().unwrap();
        let t = s.add_alarm(&London, "Timer: 1 min", at(10, 1), Repeat::None, 0, at(6, 0)).unwrap();
        s.delete_alarm(t.id).unwrap();
        assert!(s.snooze_alarm(t.id, 5, at(10, 2)).is_err());
    }

    #[test]
    fn switching_a_one_shot_alarm_off_and_on_keeps_its_time() {
        let s = Store::open_in_memory().unwrap();
        let a = s.add_alarm(&London, "Dentist", at(15, 0), Repeat::None, 0, at(6, 0)).unwrap();
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
        s.add_alarm(&London, "Rang", at(8, 0), Repeat::None, 0, at(6, 0)).unwrap();
        s.add_alarm(&London, "Later", at(18, 0), Repeat::None, 0, at(6, 0)).unwrap();
        let off = s.add_alarm(&London, "Switched off, still ahead", at(19, 0), Repeat::None, 0, at(6, 0)).unwrap();
        s.set_alarm_enabled(&London, off.id, false, at(9, 0)).unwrap();
        s.add_alarm(&London, "Daily", at(7, 0), Repeat::Daily, 0, at(6, 0)).unwrap();
        s.take_due(&London, at(9, 0)).unwrap();
        assert_eq!(s.clear_finished_alarms(at(9, 0)).unwrap(), 1);
        let labels: Vec<_> = s.list_alarms().unwrap().into_iter().map(|a| a.label).collect();
        assert_eq!(labels, vec!["Later", "Switched off, still ahead", "Daily"]);
    }

    #[test]
    fn daily_cleanup_removes_yesterdays_done_todos_once_a_day() {
        let s = Store::open_in_memory().unwrap();
        let old = s.add_todo(&todo("yesterday", None), 0).unwrap();
        let new = s.add_todo(&todo("today", None), 0).unwrap();
        s.add_todo(&todo("open", None), 0).unwrap();
        let done = TodoPatch { done: Some(true), ..Default::default() };
        s.update_todo(&London, old.id, &done, at(9, 0) - 24 * 60 * MIN).unwrap();
        s.update_todo(&London, new.id, &done, at(9, 0)).unwrap();
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
        Store::open(&path).unwrap().add_todo(&todo("persist me", None), 0).unwrap();
        assert_eq!(Store::open(&path).unwrap().list_todos().unwrap()[0].title, "persist me");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
