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
    /// Due on a day, not at a time: `due_at` is that day's local midnight, and it reminds at
    /// the "to-dos without a time" time (settings `todoDayTime`, 9:00 by default).
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub repeat: TodoRepeat,
}

/// How a to-do comes back after it's ticked off. Counted from its first date, so a monthly
/// one on the 31st is on the 30th in a 30-day month and back on the 31st after.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TodoRepeat {
    #[default]
    None,
    Daily,
    Weekly,
    Fortnightly,
    Monthly,
    Quarterly,
    Yearly,
}

impl TodoRepeat {
    pub fn as_str(self) -> &'static str {
        match self {
            TodoRepeat::None => "none",
            TodoRepeat::Daily => "daily",
            TodoRepeat::Weekly => "weekly",
            TodoRepeat::Fortnightly => "fortnightly",
            TodoRepeat::Monthly => "monthly",
            TodoRepeat::Quarterly => "quarterly",
            TodoRepeat::Yearly => "yearly",
        }
    }

    pub fn parse(s: &str) -> TodoRepeat {
        match s {
            "daily" => TodoRepeat::Daily,
            "weekly" => TodoRepeat::Weekly,
            "fortnightly" => TodoRepeat::Fortnightly,
            "monthly" => TodoRepeat::Monthly,
            "quarterly" => TodoRepeat::Quarterly,
            "yearly" => TodoRepeat::Yearly,
            _ => TodoRepeat::None,
        }
    }
}

/// A new to-do (the panel's form). `due_at` is local midnight when `all_day`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTodo {
    pub title: String,
    pub due_at: Option<Millis>,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub repeat: TodoRepeat,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoPatch {
    pub title: Option<String>,
    /// `Some(None)` clears the reminder.
    #[serde(default, deserialize_with = "double_option")]
    pub due_at: Option<Option<Millis>>,
    pub done: Option<bool>,
    pub all_day: Option<bool>,
    pub repeat: Option<TodoRepeat>,
    /// "Later" on a to-do without a time: remind again then, keeping its day.
    pub remind_at: Option<Millis>,
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
    /// A to-do without a time ("Today: …"); the pet tells several of these in one bubble.
    #[serde(default)]
    pub all_day: bool,
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

/// A day to remember every year (docs/INTERACTIONS.md, "Anniversaries"). `kind` is the
/// template it was made from ("birthday", "remembrance"…, see
/// src/features/anniversary/templates.ts); the app only needs it for the pet's words.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anniversary {
    pub id: i64,
    pub kind: String,
    pub icon: String,
    pub name: String,
    pub month: u32,
    pub day: u32,
    /// The year it began (for "36th"), if given.
    pub since: Option<i32>,
    /// Reminders before the day, each made into a to-do on its day.
    pub preps: Vec<AnniversaryPrep>,
    /// Fireworks (or, for a remembrance, a candle and flowers) on the day.
    pub effect: bool,
    pub created_at: Millis,
}

/// "1 day before: Order a cake". `lead` is "1d", "2d", "3d", "1w", "2w" or "1m".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnniversaryPrep {
    pub lead: String,
    pub label: String,
}

/// An anniversary from the panel's form (new or edited).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAnniversary {
    pub kind: String,
    pub icon: String,
    pub name: String,
    pub month: u32,
    pub day: u32,
    pub since: Option<i32>,
    #[serde(default)]
    pub preps: Vec<AnniversaryPrep>,
    #[serde(default)]
    pub effect: bool,
}

/// Today is an anniversary: the pet celebrates it (and the app may play the effect).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Celebration {
    pub anniversary: Anniversary,
    /// How many years since `since` (none without one, or in its first year).
    pub years: Option<i32>,
    /// Play the fireworks / candle on screen (the setting and the anniversary's own switch).
    pub effect: bool,
    /// How long it lasts, in seconds (settings, 10–60).
    pub seconds: u32,
    /// The pet is hidden and comes out just for this (set by the app).
    #[serde(default)]
    pub peek: bool,
}
