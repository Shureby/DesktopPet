//! Sending alarms, to-dos and anniversaries to another ePet, or as a calendar file
//! (docs/INTERACTIONS.md, "Sending reminders and anniversaries").
//!
//! What's sent is a copy (`Shared`): the other side sees it first and adds it or not, and once
//! added it's theirs to change or delete. Each carries the sender's uid, so the same one sent
//! again is told apart: the same (nothing to add), changed (update?), or changed there and
//! here too (which one?). The receiver remembers where what it took came from
//! (`share_origins`); what waits for an answer is in `share_inbox`. The file format is ics.rs.

use chrono::{Duration, NaiveDate, NaiveTime, TimeZone, Timelike};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::ics::offset_minutes;
use crate::model::*;
use crate::schedule::{local_date, local_ms, next_occurrence, parse_hm};
use crate::store::{Result, Store, StoreError, SYNCED, TIMER_PREFIX};

/// How many invitations are kept waiting (the oldest go).
const INBOX_MAX: i64 = 100;

/// Something sent: the sender's uid for it and what it is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Shared {
    pub uid: String,
    pub item: Item,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Item {
    Alarm(SharedAlarm),
    Todo(SharedTodo),
    Anniversary(NewAnniversary),
}

/// An alarm: a one-off at a moment (`at`), or a time of day (`time`) on its days, which is
/// the same clock time wherever it rings.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SharedAlarm {
    pub label: String,
    pub repeat: Repeat,
    /// The days of a `Repeat::Days` one (0 otherwise).
    pub days: DayMask,
    /// "HH:MM", for a repeating one.
    pub time: Option<String>,
    /// The moment a one-off rings (ms).
    pub at: Option<Millis>,
    pub important: bool,
    pub auto_snooze: bool,
}

/// A to-do: at a moment (`at`), on a day without a time (`day`, "YYYY-MM-DD"), or neither.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SharedTodo {
    pub title: String,
    pub at: Option<Millis>,
    pub day: Option<String>,
    pub repeat: TodoRepeat,
}

fn clip(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

impl Item {
    /// "alarm" | "todo" | "anniversary" (as the tombstones file them).
    pub fn kind(&self) -> &'static str {
        match self {
            Item::Alarm(_) => "alarm",
            Item::Todo(_) => "todo",
            Item::Anniversary(_) => "anniversary",
        }
    }

    pub fn title(&self) -> &str {
        match self {
            Item::Alarm(a) => &a.label,
            Item::Todo(t) => &t.title,
            Item::Anniversary(a) => &a.name,
        }
    }

    /// As it would be saved: trimmed, and only the fields its kind of repeat uses. Two that
    /// are the same thing compare equal once normalized.
    pub fn normalized(&self) -> Item {
        match self {
            Item::Alarm(a) => {
                let label = clip(&a.label, 200);
                match (a.repeat, a.time.as_deref().and_then(parse_hm)) {
                    (Repeat::None, _) | (_, None) => Item::Alarm(SharedAlarm {
                        label,
                        repeat: Repeat::None,
                        days: 0,
                        time: None,
                        at: a.at,
                        important: a.important,
                        auto_snooze: a.auto_snooze,
                    }),
                    (repeat, Some(t)) => Item::Alarm(SharedAlarm {
                        label,
                        repeat,
                        days: if repeat == Repeat::Days { a.days & EVERY_DAY } else { 0 },
                        time: Some(format!("{:02}:{:02}", t.hour(), t.minute())),
                        at: None,
                        important: a.important,
                        auto_snooze: a.auto_snooze,
                    }),
                }
            }
            Item::Todo(t) => {
                let day = t
                    .day
                    .as_deref()
                    .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
                    .map(|d| d.format("%Y-%m-%d").to_string());
                let (at, day) = if t.at.is_some() { (t.at, None) } else { (None, day) };
                let repeat = if at.is_some() || day.is_some() { t.repeat } else { TodoRepeat::None };
                Item::Todo(SharedTodo { title: clip(&t.title, 200), at, day, repeat })
            }
            Item::Anniversary(a) => Item::Anniversary(NewAnniversary {
                kind: clip(&a.kind, 32),
                icon: clip(&a.icon, 16),
                name: clip(&a.name, 200),
                preps: a
                    .preps
                    .iter()
                    .filter(|p| !p.label.trim().is_empty())
                    .take(3)
                    .map(|p| AnniversaryPrep { lead: clip(&p.lead, 4), label: clip(&p.label, 200) })
                    .collect(),
                music: a.music.as_deref().map(|m| clip(m, 64)),
                leap: a.leap && a.calendar == Calendar::Lunar,
                nth: a.nth.filter(|_| matches!(a.calendar, Calendar::Weekday | Calendar::Easter)),
                weekday: a.weekday.filter(|_| a.calendar == Calendar::Weekday),
                ..a.clone()
            }),
        }
    }
}

/// Whether what's here is still what was taken. A repeating to-do moves on to its next day
/// each time it's ticked off: that isn't a change (only its time of day counts).
fn unchanged<Tz: TimeZone>(tz: &Tz, taken: &Item, now: &Item) -> bool {
    match (taken, now) {
        (Item::Todo(a), Item::Todo(b)) if a.repeat != TodoRepeat::None && a.repeat == b.repeat => {
            let time = |t: &SharedTodo| {
                t.at.and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
                    .map(|d| d.with_timezone(tz).time())
            };
            a.title == b.title && a.day.is_some() == b.day.is_some() && time(a) == time(b)
        }
        _ => taken == now,
    }
}

/// What a sent item is to what's here.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Match {
    /// Not here.
    New,
    /// Here, the same (or sent again unchanged).
    Same { id: i64 },
    /// Here, and the sender changed it. `edited`: it was changed here too since it was taken.
    /// `local`: what's here now. `changed`: the parts the sender changed (see `parts`);
    /// `skipped`: ones it changed that weren't taken here before (not asked about again).
    #[serde(rename_all = "camelCase")]
    Changed { id: i64, edited: bool, local: Box<Item>, changed: Vec<String>, skipped: Vec<String> },
}

// --- Parts: what's taken can be chosen part by part -----------------------------------

/// The parts of an item of `kind`, as an update lists them, and the fields of each.
fn part_fields(kind: &str) -> &'static [(&'static str, &'static [&'static str])] {
    match kind {
        "alarm" => &[
            ("label", &["label"]),
            ("when", &["time", "at", "repeat", "days"]),
            ("important", &["important"]),
            ("autoSnooze", &["autoSnooze"]),
        ],
        "todo" => &[("title", &["title"]), ("when", &["at", "day", "repeat"])],
        _ => &[
            ("name", &["name", "icon", "kind"]),
            ("date", &["calendar", "month", "day", "leap", "nth", "weekday"]),
            ("since", &["since"]),
            ("preps", &["preps"]),
            ("effect", &["effect"]),
            ("music", &["music"]),
        ],
    }
}

/// An update's parts, in order: "label", "when"… (an alarm); "name", "date", "since",
/// "preps", "effect", "music" (an anniversary).
pub fn parts(kind: &str) -> Vec<&'static str> {
    part_fields(kind).iter().map(|(p, _)| *p).collect()
}

fn as_object(item: &Item) -> serde_json::Map<String, serde_json::Value> {
    match serde_json::to_value(item) {
        Ok(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    }
}

fn from_object(m: serde_json::Map<String, serde_json::Value>, fallback: &Item) -> Item {
    serde_json::from_value::<Item>(serde_json::Value::Object(m)).map_or_else(|_| fallback.clone(), |i| i.normalized())
}

/// The parts in which `a` and `b` differ.
pub fn parts_changed(a: &Item, b: &Item) -> Vec<String> {
    let (x, y) = (as_object(a), as_object(b));
    part_fields(b.kind())
        .iter()
        .filter(|(_, fields)| fields.iter().any(|f| x.get(*f) != y.get(*f)))
        .map(|(p, _)| p.to_string())
        .collect()
}

/// `base` with `from`'s `parts`.
pub fn with_parts(base: &Item, from: &Item, parts: &[String]) -> Item {
    let mut m = as_object(base);
    let src = as_object(from);
    for (p, fields) in part_fields(from.kind()) {
        if parts.iter().any(|x| x == p) {
            for f in *fields {
                match src.get(*f) {
                    Some(v) => m.insert(f.to_string(), v.clone()),
                    None => m.remove(*f),
                };
            }
        }
    }
    from_object(m, base)
}

/// What a new one has that can be left out: "since", each reminder before ("prep:0"…),
/// "effect" and "music" (an anniversary); "important" and "autoSnooze" (an alarm). The
/// rest is the item itself.
pub fn optional_parts(item: &Item) -> Vec<String> {
    match item {
        Item::Alarm(a) => [("important", a.important), ("autoSnooze", a.auto_snooze)]
            .into_iter()
            .filter(|(_, on)| *on)
            .map(|(p, _)| p.to_string())
            .collect(),
        Item::Todo(_) => vec![],
        Item::Anniversary(a) => {
            let mut out = vec![];
            if a.since.is_some() {
                out.push("since".to_string());
            }
            out.extend((0..a.preps.len()).map(|i| format!("prep:{i}")));
            if a.effect {
                out.push("effect".into());
            }
            if a.music.is_some() {
                out.push("music".into());
            }
            out
        }
    }
}

/// A new one without the optional parts in `leave` (as if they were never set).
pub fn without(item: &Item, leave: &[String]) -> Item {
    let left = |p: &str| leave.iter().any(|x| x == p);
    match item {
        Item::Alarm(a) => Item::Alarm(SharedAlarm {
            important: a.important && !left("important"),
            auto_snooze: a.auto_snooze && !left("autoSnooze"),
            ..a.clone()
        }),
        Item::Todo(_) => item.clone(),
        Item::Anniversary(a) => Item::Anniversary(NewAnniversary {
            since: a.since.filter(|_| !left("since")),
            preps: a
                .preps
                .iter()
                .enumerate()
                .filter(|(i, _)| !left(&format!("prep:{i}")))
                .map(|(_, p)| p.clone())
                .collect(),
            effect: a.effect && !left("effect"),
            music: a.music.clone().filter(|_| !left("music")),
            ..a.clone()
        }),
    }
}

/// The update's part an optional part belongs to ("prep:1" → "preps").
fn part_of(optional: &str) -> String {
    if optional.starts_with("prep:") {
        "preps".into()
    } else {
        optional.to_string()
    }
}

/// A repeating alarm moved to the sender's clock time (`shift` minutes).
fn shifted(item: &Item, shift: i32) -> Item {
    match item {
        Item::Alarm(a) if shift != 0 && a.repeat != Repeat::None => {
            let time = a.time.as_deref().and_then(parse_hm).map(|t| {
                let t = t.overflowing_add_signed(Duration::minutes(shift as i64)).0;
                format!("{:02}:{:02}", t.hour(), t.minute())
            });
            Item::Alarm(SharedAlarm { time: time.or_else(|| a.time.clone()), ..a.clone() })
        }
        _ => item.clone(),
    }
}

/// What the receiver decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Take {
    /// Add it (new), or update it (changed).
    Add,
    /// Don't: a new one isn't added, a changed one keeps what's here.
    Keep,
}

/// What came of it, as told to the sender: "added" | "updated" | "have" | "kept" | "declined".
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Taken {
    pub answer: &'static str,
    /// The item here (none when declined).
    pub id: Option<i64>,
}

/// Where something here came from.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub kind: String,
    pub id: i64,
    /// The sender's fingerprint ("" for a file).
    pub from: String,
}

/// Something sent that waits for an answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    pub id: i64,
    /// The sender's fingerprint ("" for a file).
    pub from: String,
    /// Its name then (or the file's).
    pub name: String,
    pub shared: Shared,
    /// The sender's time zone (IANA name, "" if unknown) and its offset (minutes).
    pub tz: String,
    pub offset: Option<i32>,
    pub at: Millis,
}

fn table(kind: &str) -> Result<&'static str> {
    SYNCED
        .iter()
        .find(|(_, k)| *k == kind)
        .map(|(t, _)| *t)
        .ok_or_else(|| StoreError::Invalid(format!("no such kind: {kind}")))
}

impl Store {
    fn local_uid(&self, kind: &str, id: i64) -> Result<Option<String>> {
        let sql = format!("SELECT uid FROM {} WHERE id = ?1", table(kind)?);
        Ok(self.conn.query_row(&sql, [id], |r| r.get(0)).optional()?)
    }

    fn local_id(&self, kind: &str, uid: &str) -> Result<Option<i64>> {
        let sql = format!("SELECT id FROM {} WHERE uid = ?1", table(kind)?);
        Ok(self.conn.query_row(&sql, [uid], |r| r.get(0)).optional()?)
    }

    /// An alarm, to-do or anniversary here as it would be sent (none: no such one, a timer, or
    /// a one-off without a time).
    pub fn shared<Tz: TimeZone>(&self, tz: &Tz, kind: &str, id: i64) -> Result<Option<Shared>> {
        let Some(uid) = self.local_uid(kind, id)? else { return Ok(None) };
        let item = match kind {
            "alarm" => {
                let Some(a) = self.alarm(id)? else { return Ok(None) };
                if a.label.starts_with(TIMER_PREFIX) {
                    return Ok(None);
                }
                let at = if a.repeat == Repeat::None {
                    // The time it was set for, not a later snoozed ring.
                    match a.rang_at.or(a.next_fire) {
                        Some(at) => Some(at),
                        None => return Ok(None),
                    }
                } else {
                    None
                };
                Item::Alarm(SharedAlarm {
                    label: a.label,
                    repeat: a.repeat,
                    days: a.repeat_days,
                    time: a.time_hm,
                    at,
                    important: a.important,
                    auto_snooze: a.auto_snooze,
                })
            }
            "todo" => {
                let Some(t) = self.todo(id)? else { return Ok(None) };
                let (at, day) = match t.due_at {
                    None => (None, None),
                    Some(d) if t.all_day => (None, local_date(tz, d).map(|d| d.format("%Y-%m-%d").to_string())),
                    Some(d) => (Some(d), None),
                };
                Item::Todo(SharedTodo { title: t.title, at, day, repeat: t.repeat })
            }
            _ => {
                let Some(a) = self.anniversary(id)? else { return Ok(None) };
                Item::Anniversary(NewAnniversary {
                    kind: a.kind,
                    icon: a.icon,
                    name: a.name,
                    month: a.month,
                    day: a.day,
                    since: a.since,
                    preps: a.preps,
                    effect: a.effect,
                    music: a.music,
                    calendar: a.calendar,
                    leap: a.leap,
                    nth: a.nth,
                    weekday: a.weekday,
                })
            }
        };
        Ok(Some(Shared { uid, item: item.normalized() }))
    }

    /// Where `from`'s item `uid` went here: its local uid, what was sent then, what it was
    /// here then, and whether it was taken at the sender's time.
    fn origin(&self, kind: &str, from: &str, uid: &str) -> Result<Option<(String, String, String, bool)>> {
        Ok(self
            .conn
            .query_row(
                "SELECT uid, sent, taken, their_time FROM share_origins WHERE kind = ?1 AND from_fp = ?2 AND from_uid = ?3",
                params![kind, from, uid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?)
    }

    /// The parts of `from`'s item that weren't taken here (not asked about again).
    fn skipped_parts(&self, kind: &str, from: &str, uid: &str) -> Result<Vec<String>> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT skipped FROM share_origins WHERE kind = ?1 AND from_fp = ?2 AND from_uid = ?3",
                params![kind, from, uid],
                |r| r.get(0),
            )
            .optional()?;
        Ok(raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default())
    }

    /// What `from`'s item is to what's here.
    pub fn share_match<Tz: TimeZone>(&self, tz: &Tz, from: &str, s: &Shared) -> Result<Match> {
        let kind = s.item.kind();
        let incoming = s.item.normalized();
        if let Some((local_uid, sent, taken, _)) = self.origin(kind, from, &s.uid)? {
            match self.local_id(kind, &local_uid)? {
                Some(id) => {
                    if let Some(local) = self.shared(tz, kind, id)?.map(|x| x.item) {
                        let sent = serde_json::from_str::<Item>(&sent).ok();
                        if sent.as_ref() == Some(&incoming) || local == incoming {
                            return Ok(Match::Same { id });
                        }
                        // What the sender changed (against what it sent before): those
                        // not taken here before aren't asked about again.
                        let all = parts_changed(sent.as_ref().unwrap_or(&local), &incoming);
                        let before = self.skipped_parts(kind, from, &s.uid)?;
                        let (skipped, changed): (Vec<String>, Vec<String>) =
                            all.into_iter().partition(|p| before.contains(p));
                        // (Only a part it doesn't want changed, or what's here already is it.)
                        let changed: Vec<String> =
                            changed.into_iter().filter(|p| parts_changed(&local, &incoming).contains(p)).collect();
                        if changed.is_empty() {
                            return Ok(Match::Same { id });
                        }
                        let edited = serde_json::from_str::<Item>(&taken).map_or(true, |t| !unchanged(tz, &t, &local));
                        return Ok(Match::Changed { id, edited, local: Box::new(local), changed, skipped });
                    }
                }
                // Deleted here since: as if new.
                None => {
                    self.conn
                        .execute("DELETE FROM share_origins WHERE kind = ?1 AND uid = ?2", params![kind, local_uid])?;
                }
            }
        }
        // Not taken from it before, but the same thing is here (typed in, or from a file).
        let ids: Vec<i64> = {
            let mut stmt = self.conn.prepare(&format!("SELECT id FROM {} ORDER BY id", table(kind)?))?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for id in ids {
            if self.shared(tz, kind, id)?.is_some_and(|x| x.item == incoming) {
                return Ok(Match::Same { id });
            }
        }
        Ok(Match::New)
    }

    /// Takes `from`'s item as decided, and remembers where it came from. `their_time`: a
    /// repeating alarm rings at the sender's clock time (moved by the difference from
    /// `sender_offset`); None keeps what was chosen before (else: at this clock time).
    #[allow(clippy::too_many_arguments)]
    pub fn share_take<Tz: TimeZone>(
        &self,
        tz: &Tz,
        from: &str,
        s: &Shared,
        how: Take,
        their_time: Option<bool>,
        sender_offset: Option<i32>,
        now: Millis,
    ) -> Result<Taken> {
        self.share_take_parts(tz, from, s, how, their_time, sender_offset, None, now)
    }

    /// As `share_take`, choosing what's taken: of a new one, the optional parts kept (see
    /// `optional_parts`; the others are left out); of an update, the parts taken (see
    /// `parts`; the others stay as they are here). None: all of a new one, and of an update
    /// what the sender changed (but what wasn't taken before).
    #[allow(clippy::too_many_arguments)]
    pub fn share_take_parts<Tz: TimeZone>(
        &self,
        tz: &Tz,
        from: &str,
        s: &Shared,
        how: Take,
        their_time: Option<bool>,
        sender_offset: Option<i32>,
        chosen: Option<&[String]>,
        now: Millis,
    ) -> Result<Taken> {
        let kind = s.item.kind();
        let incoming = s.item.normalized();
        let before = self.origin(kind, from, &s.uid)?;
        let mut skipped = self.skipped_parts(kind, from, &s.uid)?;
        let their = their_time.unwrap_or_else(|| before.as_ref().is_some_and(|b| b.3));
        let shift = match (their, sender_offset) {
            (true, Some(o)) => offset_minutes(tz, now) - o,
            _ => 0,
        };
        let theirs = shifted(&incoming, shift);
        let (answer, id) = match (self.share_match(tz, from, s)?, how) {
            (Match::Same { id }, _) => ("have", id),
            (Match::New, Take::Keep) => return Ok(Taken { answer: "declined", id: None }),
            (Match::New, Take::Add) => {
                let leave: Vec<String> = match chosen {
                    Some(keep) => optional_parts(&incoming).into_iter().filter(|p| !keep.contains(p)).collect(),
                    None => vec![],
                };
                skipped = leave.iter().map(|p| part_of(p)).collect();
                skipped.dedup();
                ("added", self.apply(tz, None, &without(&theirs, &leave), now)?)
            }
            (Match::Changed { id, local, changed, skipped: was, .. }, Take::Add) => {
                let take: Vec<String> = chosen.map_or_else(|| changed.clone(), <[String]>::to_vec);
                // Not taken now (of those shown, and those not taken before): remembered.
                skipped.retain(|p| !take.contains(p));
                let more: Vec<String> =
                    changed.iter().chain(&was).filter(|p| !take.contains(p) && !skipped.contains(p)).cloned().collect();
                skipped.extend(more);
                ("updated", self.apply(tz, Some(id), &with_parts(&local, &theirs, &take), now)?)
            }
            (Match::Changed { id, .. }, Take::Keep) => ("kept", id),
        };
        let Some(local_uid) = self.local_uid(kind, id)? else { return Ok(Taken { answer, id: Some(id) }) };
        let here = self.shared(tz, kind, id)?.map(|x| x.item).unwrap_or_else(|| incoming.clone());
        // What it was here when taken: now, if it was just written; otherwise as before (so a
        // change made here still counts as one).
        let taken = match (answer, &before) {
            ("added" | "updated", _) | (_, None) => serde_json::to_string(&here)?,
            (_, Some(b)) => b.2.clone(),
        };
        self.conn.execute(
            "INSERT OR REPLACE INTO share_origins (kind, uid, from_fp, from_uid, sent, taken, their_time, at, skipped)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                kind,
                local_uid,
                from,
                s.uid,
                serde_json::to_string(&incoming)?,
                taken,
                their,
                now,
                serde_json::to_string(&skipped)?
            ],
        )?;
        Ok(Taken { answer, id: Some(id) })
    }

    /// Writes an item here: a new one, or over `id`.
    fn apply<Tz: TimeZone>(&self, tz: &Tz, id: Option<i64>, item: &Item, now: Millis) -> Result<i64> {
        match item {
            Item::Alarm(a) => {
                let (at, repeat, days) = if a.repeat == Repeat::None {
                    let at = a.at.ok_or_else(|| StoreError::Invalid("no time".into()))?;
                    if at <= now {
                        return Err(StoreError::Invalid("that time has passed".into()));
                    }
                    (at, Repeat::None, 0)
                } else {
                    let t =
                        a.time.as_deref().and_then(parse_hm).ok_or_else(|| StoreError::Invalid("no time".into()))?;
                    let at = next_occurrence(tz, now, t, a.repeat.mask(a.days))
                        .ok_or_else(|| StoreError::Invalid("pick at least one day".into()))?;
                    (at, a.repeat, a.days)
                };
                let alarm = match id {
                    Some(id) => self.update_alarm(tz, id, &a.label, at, repeat, days)?,
                    None => self.add_alarm(tz, &a.label, at, repeat, days, now)?,
                };
                self.set_alarm_important(alarm.id, a.important)?;
                self.set_alarm_auto_snooze(alarm.id, a.auto_snooze)?;
                Ok(alarm.id)
            }
            Item::Todo(t) => {
                let (due, all_day) = match (t.at, t.day.as_deref()) {
                    (Some(at), _) => (Some(at), false),
                    (None, Some(d)) => {
                        let d = NaiveDate::parse_from_str(d, "%Y-%m-%d")
                            .map_err(|_| StoreError::Invalid("bad day".into()))?;
                        (local_ms(tz, d, NaiveTime::MIN), true)
                    }
                    _ => (None, false),
                };
                match id {
                    Some(id) => {
                        let patch = TodoPatch {
                            title: Some(t.title.clone()),
                            due_at: Some(due),
                            all_day: Some(all_day),
                            repeat: Some(t.repeat),
                            ..TodoPatch::default()
                        };
                        self.update_todo(tz, id, &patch, now)?;
                        Ok(id)
                    }
                    None => {
                        let new = NewTodo { title: t.title.clone(), due_at: due, all_day, repeat: t.repeat };
                        Ok(self.add_todo(&new, now)?.id)
                    }
                }
            }
            Item::Anniversary(a) => Ok(match id {
                Some(id) => self.update_anniversary(id, a, now)?.id,
                None => self.add_anniversary(a, now)?.id,
            }),
        }
    }

    /// Undoes taking one ("Undo" after it was added without asking): it goes, and so does
    /// where it came from.
    pub fn share_forget(&self, kind: &str, id: i64) -> Result<()> {
        if let Some(uid) = self.local_uid(kind, id)? {
            self.conn.execute("DELETE FROM share_origins WHERE kind = ?1 AND uid = ?2", params![kind, uid])?;
        }
        match kind {
            "alarm" => self.delete_alarm(id),
            "todo" => self.delete_todo(id),
            _ => self.delete_anniversary(id),
        }
    }

    /// Where one here came from: the sender's fingerprint and its uid for it.
    pub fn share_origin_of(&self, kind: &str, id: i64) -> Result<Option<(String, String)>> {
        let Some(uid) = self.local_uid(kind, id)? else { return Ok(None) };
        Ok(self
            .conn
            .query_row(
                "SELECT from_fp, from_uid FROM share_origins WHERE kind = ?1 AND uid = ?2",
                params![kind, uid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }

    /// Where what's here came from (only what was taken from another ePet or a file).
    pub fn share_origins(&self) -> Result<Vec<Origin>> {
        let mut out = vec![];
        for (table, kind) in SYNCED {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT t.id, o.from_fp FROM share_origins o JOIN {table} t ON t.uid = o.uid WHERE o.kind = ?1 ORDER BY t.id"
            ))?;
            let rows =
                stmt.query_map([kind], |r| Ok(Origin { kind: kind.to_string(), id: r.get(0)?, from: r.get(1)? }))?;
            out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        Ok(out)
    }

    // --- Waiting for an answer ------------------------------------------------------------

    /// Keeps an invitation; the same item from the same sender replaces the one before.
    pub fn inbox_add(
        &self,
        from: &str,
        name: &str,
        s: &Shared,
        tz: &str,
        offset: Option<i32>,
        now: Millis,
    ) -> Result<i64> {
        self.conn.execute("DELETE FROM share_inbox WHERE from_fp = ?1 AND uid = ?2", params![from, s.uid])?;
        self.conn.execute(
            "INSERT INTO share_inbox (from_fp, from_name, uid, item, tz, offset_min, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![from, clip(name, 64), s.uid, serde_json::to_string(&s.item)?, tz, offset, now],
        )?;
        let id = self.conn.last_insert_rowid();
        self.conn.execute(
            "DELETE FROM share_inbox WHERE id NOT IN (SELECT id FROM share_inbox ORDER BY id DESC LIMIT ?1)",
            [INBOX_MAX],
        )?;
        Ok(id)
    }

    fn inbox_row(r: &rusqlite::Row) -> rusqlite::Result<(InboxEntry, String)> {
        Ok((
            InboxEntry {
                id: r.get(0)?,
                from: r.get(1)?,
                name: r.get(2)?,
                shared: Shared { uid: r.get(3)?, item: Item::Todo(SharedTodo::default()) },
                tz: r.get(5)?,
                offset: r.get(6)?,
                at: r.get(7)?,
            },
            r.get(4)?,
        ))
    }

    /// What waits for an answer, the oldest first.
    pub fn inbox(&self) -> Result<Vec<InboxEntry>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, from_fp, from_name, uid, item, tz, offset_min, at FROM share_inbox ORDER BY id")?;
        let rows = stmt.query_map([], Self::inbox_row)?;
        let mut out = vec![];
        for row in rows {
            let (mut e, item) = row?;
            // One this version can't read (from a newer ePet) is left out.
            if let Ok(item) = serde_json::from_str::<Item>(&item) {
                e.shared.item = item;
                out.push(e);
            }
        }
        Ok(out)
    }

    pub fn inbox_entry(&self, id: i64) -> Result<Option<InboxEntry>> {
        Ok(self.inbox()?.into_iter().find(|e| e.id == id))
    }

    pub fn inbox_remove(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM share_inbox WHERE id = ?1", [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Asia::Tokyo;
    use chrono_tz::Europe::London;

    fn at(h: u32, m: u32) -> Millis {
        London.with_ymd_and_hms(2026, 10, 27, h, m, 0).unwrap().timestamp_millis()
    }

    fn alarm(label: &str, time: &str) -> Shared {
        Shared {
            uid: format!("u-{label}"),
            item: Item::Alarm(SharedAlarm {
                label: label.into(),
                repeat: Repeat::Weekdays,
                time: Some(time.into()),
                important: true,
                ..SharedAlarm::default()
            }),
        }
    }

    #[test]
    fn what_is_here_is_sent_as_it_is_and_timers_are_not() {
        let s = Store::open_in_memory().unwrap();
        let now = at(9, 0);
        let a = s.add_alarm(&London, "Get up", at(7, 30), Repeat::Weekdays, 0, now).unwrap();
        s.set_alarm_important(a.id, true).unwrap();
        let sent = s.shared(&London, "alarm", a.id).unwrap().unwrap();
        assert_eq!(sent.item, alarm("Get up", "07:30").item);
        let timer = s.add_alarm(&London, "Timer: 5 min", now + 300_000, Repeat::None, 0, now).unwrap();
        assert_eq!(s.shared(&London, "alarm", timer.id).unwrap(), None);
        let t = s
            .add_todo(
                &NewTodo { title: "Bins".into(), due_at: Some(at(0, 0)), all_day: true, repeat: TodoRepeat::Weekly },
                now,
            )
            .unwrap();
        assert_eq!(
            s.shared(&London, "todo", t.id).unwrap().unwrap().item,
            Item::Todo(SharedTodo {
                title: "Bins".into(),
                at: None,
                day: Some("2026-10-27".into()),
                repeat: TodoRepeat::Weekly
            })
        );
    }

    #[test]
    fn new_then_the_same_then_changed_then_changed_here_too() {
        let s = Store::open_in_memory().unwrap();
        let now = at(9, 0);
        let sent = alarm("Get up", "07:30");
        assert_eq!(s.share_match(&London, "DAD", &sent).unwrap(), Match::New);
        let taken = s.share_take(&London, "DAD", &sent, Take::Add, None, None, now).unwrap();
        assert_eq!(taken.answer, "added");
        let id = taken.id.unwrap();
        let a = s.list_alarms().unwrap().into_iter().find(|a| a.id == id).unwrap();
        assert_eq!((a.time_hm.as_deref(), a.repeat, a.important), (Some("07:30"), Repeat::Weekdays, true));
        assert_eq!(s.share_origins().unwrap(), vec![Origin { kind: "alarm".into(), id, from: "DAD".into() }]);

        // Sent again as it was: nothing to add.
        assert_eq!(s.share_match(&London, "DAD", &sent).unwrap(), Match::Same { id });
        assert_eq!(s.share_take(&London, "DAD", &sent, Take::Add, None, None, now).unwrap().answer, "have");

        // Changed there: update?
        let later = alarm("Get up", "07:45");
        let Match::Changed { edited: false, local, .. } = s.share_match(&London, "DAD", &later).unwrap() else {
            panic!()
        };
        assert_eq!(*local, sent.item);
        assert_eq!(s.share_take(&London, "DAD", &later, Take::Add, None, None, now).unwrap().answer, "updated");
        assert_eq!(s.list_alarms().unwrap()[0].time_hm.as_deref(), Some("07:45"));

        // Changed here, then there again: which one?
        s.update_alarm(&London, id, "Get up!!", at(7, 15), Repeat::Weekdays, 0).unwrap();
        let again = alarm("Get up", "08:00");
        let Match::Changed { edited: true, .. } = s.share_match(&London, "DAD", &again).unwrap() else { panic!() };
        // Kept: still mine, and the same one sent again isn't asked about again.
        assert_eq!(s.share_take(&London, "DAD", &again, Take::Keep, None, None, now).unwrap().answer, "kept");
        assert_eq!(s.list_alarms().unwrap()[0].label, "Get up!!");
        assert_eq!(s.share_match(&London, "DAD", &again).unwrap(), Match::Same { id });
        // A later change still counts mine as changed.
        let Match::Changed { edited: true, .. } = s.share_match(&London, "DAD", &alarm("Get up", "08:10")).unwrap()
        else {
            panic!()
        };
    }

    #[test]
    fn deleted_here_it_is_new_again_and_the_same_thing_typed_in_is_already_here() {
        let s = Store::open_in_memory().unwrap();
        let now = at(9, 0);
        let sent = alarm("Get up", "07:30");
        let id = s.share_take(&London, "DAD", &sent, Take::Add, None, None, now).unwrap().id.unwrap();
        s.delete_alarm(id).unwrap();
        assert_eq!(s.share_match(&London, "DAD", &sent).unwrap(), Match::New);
        assert!(s.share_origins().unwrap().is_empty());

        let mine = s.add_alarm(&London, "Get up", at(7, 30), Repeat::Weekdays, 0, now).unwrap();
        s.set_alarm_important(mine.id, true).unwrap();
        assert_eq!(s.share_match(&London, "MUM", &sent).unwrap(), Match::Same { id: mine.id });
    }

    #[test]
    fn declining_a_new_one_adds_nothing() {
        let s = Store::open_in_memory().unwrap();
        let t = s.share_take(&London, "DAD", &alarm("Get up", "07:30"), Take::Keep, None, None, at(9, 0)).unwrap();
        assert_eq!(t, Taken { answer: "declined", id: None });
        assert!(s.list_alarms().unwrap().is_empty());
    }

    #[test]
    fn at_their_time_a_repeating_alarm_moves_by_the_difference() {
        let s = Store::open_in_memory().unwrap();
        let now = Tokyo.with_ymd_and_hms(2026, 10, 27, 9, 0, 0).unwrap().timestamp_millis();
        // Sent from Shanghai (UTC+8) to Tokyo (UTC+9): their 8:00 is 9:00 here.
        let id = s
            .share_take(&Tokyo, "DAD", &alarm("Pills", "08:00"), Take::Add, Some(true), Some(480), now)
            .unwrap()
            .id
            .unwrap();
        assert_eq!(s.list_alarms().unwrap().iter().find(|a| a.id == id).unwrap().time_hm.as_deref(), Some("09:00"));
        // Updated later: the same choice.
        s.share_take(&Tokyo, "DAD", &alarm("Pills", "08:30"), Take::Add, None, Some(480), now).unwrap();
        assert_eq!(s.list_alarms().unwrap()[0].time_hm.as_deref(), Some("09:30"));
    }

    #[test]
    fn a_one_off_in_the_past_isnt_added() {
        let s = Store::open_in_memory().unwrap();
        let past = Shared {
            uid: "x".into(),
            item: Item::Alarm(SharedAlarm { label: "Call".into(), at: Some(at(8, 0)), ..Default::default() }),
        };
        assert!(s.share_take(&London, "DAD", &past, Take::Add, None, None, at(9, 0)).is_err());
    }

    #[test]
    fn a_repeating_to_do_ticked_off_here_isnt_a_change() {
        let s = Store::open_in_memory().unwrap();
        let now = at(9, 0);
        let sent = Shared {
            uid: "bins".into(),
            item: Item::Todo(SharedTodo {
                title: "Bins".into(),
                at: Some(at(19, 0)),
                day: None,
                repeat: TodoRepeat::Weekly,
            }),
        };
        let id = s.share_take(&London, "DAD", &sent, Take::Add, None, None, now).unwrap().id.unwrap();
        s.update_todo(&London, id, &TodoPatch { done: Some(true), ..TodoPatch::default() }, at(20, 0)).unwrap();
        let renamed = Shared {
            uid: "bins".into(),
            item: Item::Todo(SharedTodo {
                title: "Bins out".into(),
                ..match &sent.item {
                    Item::Todo(t) => t.clone(),
                    _ => unreachable!(),
                }
            }),
        };
        let Match::Changed { edited: false, .. } = s.share_match(&London, "DAD", &renamed).unwrap() else { panic!() };
    }

    #[test]
    fn anniversaries_and_to_dos_round_trip() {
        let s = Store::open_in_memory().unwrap();
        let now = at(9, 0);
        let ann = Shared {
            uid: "w".into(),
            item: Item::Anniversary(NewAnniversary {
                kind: "wedding".into(),
                icon: "💍".into(),
                name: "Wedding".into(),
                month: 8,
                day: 15,
                since: Some(2012),
                preps: vec![AnniversaryPrep { lead: "1w".into(), label: "Book a table".into() }],
                effect: true,
                calendar: Calendar::Lunar,
                ..NewAnniversary::default()
            }),
        };
        let id = s.share_take(&London, "MUM", &ann, Take::Add, None, None, now).unwrap().id.unwrap();
        assert_eq!(s.shared(&London, "anniversary", id).unwrap().unwrap().item, ann.item.normalized());
        let good_friday = Shared {
            uid: "gf".into(),
            item: Item::Anniversary(NewAnniversary {
                kind: "holiday".into(),
                icon: "✝️".into(),
                name: "Good Friday".into(),
                month: 1,
                day: 1,
                nth: Some(-2),
                calendar: Calendar::Easter,
                ..NewAnniversary::default()
            }),
        };
        let id = s.share_take(&London, "MUM", &good_friday, Take::Add, None, None, now).unwrap().id.unwrap();
        let Item::Anniversary(back) = s.shared(&London, "anniversary", id).unwrap().unwrap().item else { panic!() };
        assert_eq!(back.nth, Some(-2), "Easter's offset is kept");
        assert_eq!(s.share_take(&London, "MUM", &good_friday, Take::Add, None, None, now).unwrap().answer, "have");
    }

    #[test]
    fn the_inbox_keeps_one_per_item_and_sender() {
        let s = Store::open_in_memory().unwrap();
        s.inbox_add("DAD", "Dad's Rooster", &alarm("Get up", "07:30"), "Asia/Shanghai", Some(480), 1).unwrap();
        let id = s.inbox_add("DAD", "Dad's Rooster", &alarm("Get up", "07:30"), "Asia/Shanghai", Some(480), 2).unwrap();
        s.inbox_add("MUM", "Mum's Cat", &alarm("Get up", "07:30"), "", None, 3).unwrap();
        let list = s.inbox().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].id, list[0].name.as_str(), list[0].offset), (id, "Dad's Rooster", Some(480)));
        assert_eq!(list[0].shared, alarm("Get up", "07:30"));
        s.inbox_remove(id).unwrap();
        assert_eq!(s.inbox().unwrap().len(), 1);
    }

    #[test]
    fn forgetting_one_deletes_it_and_where_it_came_from() {
        let s = Store::open_in_memory().unwrap();
        let id = s
            .share_take(&London, "DAD", &alarm("Get up", "07:30"), Take::Add, None, None, at(9, 0))
            .unwrap()
            .id
            .unwrap();
        s.share_forget("alarm", id).unwrap();
        assert!(s.list_alarms().unwrap().is_empty());
        assert!(s.share_origins().unwrap().is_empty());
    }

    fn sabrina(day: u32, preps: &[(&str, &str)], effect: bool) -> Shared {
        Shared {
            uid: "sab".into(),
            item: Item::Anniversary(NewAnniversary {
                kind: "birthday".into(),
                icon: "🎂".into(),
                name: "Sabrina".into(),
                month: 9,
                day,
                since: Some(1986),
                preps: preps.iter().map(|(l, x)| AnniversaryPrep { lead: (*l).into(), label: (*x).into() }).collect(),
                effect,
                music: Some("birthday".into()),
                ..NewAnniversary::default()
            }),
        }
    }

    fn ann(s: &Store, id: i64) -> NewAnniversary {
        match s.shared(&London, "anniversary", id).unwrap().unwrap().item {
            Item::Anniversary(a) => a,
            _ => unreachable!(),
        }
    }

    #[test]
    fn a_new_one_is_taken_part_by_part_and_what_was_left_isnt_asked_again() {
        let s = Store::open_in_memory().unwrap();
        let now = at(9, 0);
        let sent = sabrina(17, &[("1w", "Buy a gift"), ("1d", "Order a cake")], true);
        assert_eq!(optional_parts(&sent.item), ["since", "prep:0", "prep:1", "effect", "music"]);
        // The date and the fireworks, not the gift.
        let keep: Vec<String> = ["since", "prep:1", "effect", "music"].map(String::from).to_vec();
        let id =
            s.share_take_parts(&London, "DAD", &sent, Take::Add, None, None, Some(&keep), now).unwrap().id.unwrap();
        let a = ann(&s, id);
        assert_eq!(
            (a.preps.len(), a.preps[0].label.as_str(), a.effect, a.since),
            (1, "Order a cake", true, Some(1986))
        );
        // Sent again unchanged: nothing to ask, though it differs here.
        assert_eq!(s.share_match(&London, "DAD", &sent).unwrap(), Match::Same { id });
        // Its reminders changed there: not asked (they weren't taken); its day: asked.
        let preps_only = sabrina(17, &[("3d", "Order a cake")], true);
        assert_eq!(s.share_match(&London, "DAD", &preps_only).unwrap(), Match::Same { id });
        let moved = sabrina(18, &[("3d", "Order a cake")], true);
        let Match::Changed { changed, skipped, edited: false, .. } = s.share_match(&London, "DAD", &moved).unwrap()
        else {
            panic!()
        };
        assert_eq!((changed, skipped), (vec!["date".to_string()], vec!["preps".to_string()]));
        s.share_take(&London, "DAD", &moved, Take::Add, None, None, now).unwrap();
        let a = ann(&s, id);
        assert_eq!((a.day, a.preps[0].lead.as_str()), (18, "1d"), "the day moved, my reminders stayed");
    }

    #[test]
    fn an_update_is_taken_part_by_part() {
        let s = Store::open_in_memory().unwrap();
        let now = at(9, 0);
        let id = s
            .share_take(&London, "DAD", &sabrina(17, &[("1d", "Order a cake")], true), Take::Add, None, None, now)
            .unwrap()
            .id
            .unwrap();
        let update = sabrina(18, &[("3d", "Order a cake")], false);
        let Match::Changed { changed, .. } = s.share_match(&London, "DAD", &update).unwrap() else { panic!() };
        assert_eq!(changed, ["date", "preps", "effect"]);
        let take = vec!["date".to_string(), "effect".to_string()];
        let t = s.share_take_parts(&London, "DAD", &update, Take::Add, None, None, Some(&take), now).unwrap();
        assert_eq!(t.answer, "updated");
        let a = ann(&s, id);
        assert_eq!((a.day, a.effect, a.preps[0].lead.as_str()), (18, false, "1d"));
        // The reminders, left: a later change to them alone isn't asked about.
        assert_eq!(s.share_match(&London, "DAD", &sabrina(18, &[("1w", "Cake")], false)).unwrap(), Match::Same { id });
    }

    #[test]
    fn an_alarm_can_leave_out_important() {
        let s = Store::open_in_memory().unwrap();
        let mut sent = alarm("Get up", "07:30");
        if let Item::Alarm(a) = &mut sent.item {
            a.auto_snooze = true;
        }
        assert_eq!(optional_parts(&sent.item), ["important", "autoSnooze"]);
        let keep = vec!["autoSnooze".to_string()];
        let id = s
            .share_take_parts(&London, "DAD", &sent, Take::Add, None, None, Some(&keep), at(9, 0))
            .unwrap()
            .id
            .unwrap();
        let a = s.list_alarms().unwrap().into_iter().find(|a| a.id == id).unwrap();
        assert_eq!((a.important, a.auto_snooze), (false, true));
    }
}
