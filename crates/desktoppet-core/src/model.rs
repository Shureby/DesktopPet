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
}

impl Repeat {
    pub fn as_str(self) -> &'static str {
        match self {
            Repeat::None => "none",
            Repeat::Daily => "daily",
            Repeat::Weekdays => "weekdays",
        }
    }

    pub fn parse(s: &str) -> Repeat {
        match s {
            "daily" => Repeat::Daily,
            "weekdays" => Repeat::Weekdays,
            _ => Repeat::None,
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
}

impl Default for PomodoroStatus {
    fn default() -> Self {
        Self { phase: Phase::Idle, round: 0, ends_at: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PomodoroConfig {
    pub focus_min: f64,
    pub short_break_min: f64,
    pub long_break_min: f64,
    pub rounds_before_long: u32,
    pub auto_continue: bool,
}

impl Default for PomodoroConfig {
    fn default() -> Self {
        Self { focus_min: 25.0, short_break_min: 5.0, long_break_min: 15.0, rounds_before_long: 4, auto_continue: true }
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReminderKind {
    Todo,
    Alarm,
}
