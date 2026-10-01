use serde::{Deserialize, Serialize};

/// Milliseconds since the Unix epoch (what the web UI uses).
pub type Millis = i64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: i64,
    pub title: String,
    pub due_at: Option<Millis>,
    pub done: bool,
    pub created_at: Millis,
    /// When it was ticked off (null while open).
    pub done_at: Option<Millis>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoPatch {
    pub title: Option<String>,
    /// `Some(None)` clears the reminder.
    #[serde(default, deserialize_with = "double_option")]
    pub due_at: Option<Option<Millis>>,
    pub done: Option<bool>,
}

fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    None,
    Daily,
    Weekdays,
    /// The days in `Alarm::repeat_days` (e.g. Mon, Wed, Fri).
    Days,
}

/// Days of the week as bits, Sunday = bit 0 … Saturday = bit 6 (like JavaScript's getDay()).
pub type DayMask = u8;
pub const EVERY_DAY: DayMask = 0b111_1111;
pub const WEEKDAYS: DayMask = 0b011_1110;

impl Repeat {
    pub fn as_str(self) -> &'static str {
        match self {
            Repeat::None => "none",
            Repeat::Daily => "daily",
            Repeat::Weekdays => "weekdays",
            Repeat::Days => "days",
        }
    }

    pub fn parse(s: &str) -> Repeat {
        match s {
            "daily" => Repeat::Daily,
            "weekdays" => Repeat::Weekdays,
            "days" => Repeat::Days,
            _ => Repeat::None,
        }
    }

    /// The days it rings on; `custom` is used for `Repeat::Days`.
    pub fn mask(self, custom: DayMask) -> DayMask {
        match self {
            Repeat::None => 0,
            Repeat::Daily => EVERY_DAY,
            Repeat::Weekdays => WEEKDAYS,
            Repeat::Days => custom & EVERY_DAY,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alarm {
    pub id: i64,
    pub label: String,
    pub next_fire: Option<Millis>,
    /// "HH:MM" local time for repeating alarms.
    pub time_hm: Option<String>,
    pub repeat: Repeat,
    pub enabled: bool,
    /// Snoozes in the current ringing cycle (reset by "Done").
    pub snoozes: u32,
    /// Set when it rang and nobody answered (after any auto-snoozes); cleared on acknowledge.
    pub missed_at: Option<Millis>,
    /// When it last rang (the time it was due). Finished one-offs show it ("Done · Today 12:42").
    pub rang_at: Option<Millis>,
    /// When it was set (null for alarms from before v5).
    pub created_at: Option<Millis>,
    /// When the user saw that it was missed (clicked its badge). It stays missed in the history.
    pub missed_seen_at: Option<Millis>,
    /// The ring a repeating alarm skips ("Skip once"); cleared when it rings or is switched.
    pub skipped_fire: Option<Millis>,
    /// The days a `Repeat::Days` alarm rings on (0 otherwise).
    pub repeat_days: DayMask,
    /// It came due while ePet wasn't running and didn't ring (one-offs and timers; the time it
    /// was due). Not missed: there was no one to ring for.
    pub off_at: Option<Millis>,
}

impl Alarm {
    /// The days it rings on (0 for a one-off).
    pub fn days(&self) -> DayMask {
        self.repeat.mask(self.repeat_days)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    Focus,
    ShortBreak,
    LongBreak,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroStatus {
    pub phase: Phase,
    pub round: u32,
    pub ends_at: Option<Millis>,
    /// When this run of focus/break cycles began (work hours stop it at the next end of work).
    #[serde(default)]
    pub run_started_at: Option<Millis>,
}

impl Default for PomodoroStatus {
    fn default() -> Self {
        Self { phase: Phase::Idle, round: 0, ends_at: None, run_started_at: None }
    }
}

/// Focus work hours: on work days the tomato clock starts by itself at `start`, and no new
/// focus begins after `end`. Off = every day is all work (it runs until stopped), except that
/// it never starts by itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkHours {
    pub enabled: bool,
    pub days: DayMask,
    /// "HH:MM"; an `end` at or before `start` is on the next day (a night shift).
    pub start: String,
    pub end: String,
}

impl Default for WorkHours {
    fn default() -> Self {
        Self { enabled: false, days: WEEKDAYS, start: "09:00".into(), end: "17:30".into() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PomodoroConfig {
    pub focus_min: f64,
    pub short_break_min: f64,
    pub long_break_min: f64,
    pub rounds_before_long: u32,
    pub auto_continue: bool,
    pub work_hours: WorkHours,
}

impl Default for PomodoroConfig {
    fn default() -> Self {
        Self {
            focus_min: 25.0,
            short_break_min: 5.0,
            long_break_min: 15.0,
            rounds_before_long: 4,
            auto_continue: true,
            work_hours: WorkHours::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    pub day: String,
    pub completed: u32,
    pub focus_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Score {
    pub game: String,
    pub character: String,
    pub score: i64,
    pub at: Millis,
}

/// Something the pet should announce right now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub kind: ReminderKind,
    pub id: i64,
    pub title: String,
    /// The pet is hidden and comes out just for this (set by the app's scheduler).
    #[serde(default)]
    pub peek: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReminderKind {
    Todo,
    Alarm,
}

/// What the hidden pet rang that nobody answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UnseenKind {
    Alarm,
    Timer,
    Todo,
}

impl UnseenKind {
    pub fn as_str(self) -> &'static str {
        match self {
            UnseenKind::Alarm => "alarm",
            UnseenKind::Timer => "timer",
            UnseenKind::Todo => "todo",
        }
    }

    pub fn parse(s: &str) -> UnseenKind {
        match s {
            "alarm" => UnseenKind::Alarm,
            "timer" => UnseenKind::Timer,
            _ => UnseenKind::Todo,
        }
    }
}

/// "While I was hidden you missed…": one line of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unseen {
    pub id: i64,
    pub kind: UnseenKind,
    /// The alarm, timer or to-do.
    pub ref_id: i64,
    pub title: String,
    /// When it was due (an alarm's own time, a timer's end, a to-do's reminder time).
    pub at: Millis,
    pub snoozes: u32,
}

/// What the pet records (see `Store::record_unseen`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewUnseen {
    pub kind: UnseenKind,
    pub ref_id: i64,
    pub title: String,
    pub at: Millis,
    #[serde(default)]
    pub snoozes: u32,
}
