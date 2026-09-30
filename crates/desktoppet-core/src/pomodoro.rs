//! Tomato clock state machine (mirrored in `src/features/pomodoro/logic.ts` for the UI mock).

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};

use crate::model::{Millis, Phase, PomodoroConfig, PomodoroStatus, WorkHours};
use crate::schedule::parse_hm;

const MINUTE: f64 = 60_000.0;

pub fn phase_minutes(phase: Phase, c: &PomodoroConfig) -> f64 {
    match phase {
        Phase::Focus => c.focus_min,
        Phase::ShortBreak => c.short_break_min,
        Phase::LongBreak => c.long_break_min,
        Phase::Idle => 0.0,
    }
}

fn ends(now: Millis, minutes: f64) -> Option<Millis> {
    Some(now + (minutes * MINUTE).round() as Millis)
}

/// A new run: the first focus.
pub fn start_focus(now: Millis, c: &PomodoroConfig, round: u32) -> PomodoroStatus {
    PomodoroStatus { phase: Phase::Focus, round, ends_at: ends(now, c.focus_min), run_started_at: Some(now) }
}

/// The phase after the current one (when it ends or is skipped). `cutoff` is when this run
/// must stop (work hours, see `run_cutoff`): no new focus begins at or after it, and a focus
/// that ends after it skips its break.
pub fn next_phase(s: &PomodoroStatus, now: Millis, c: &PomodoroConfig, cutoff: Option<Millis>) -> PomodoroStatus {
    let past_cutoff = cutoff.is_some_and(|t| now >= t);
    let run_started_at = s.run_started_at.or(Some(now));
    match s.phase {
        Phase::Focus if past_cutoff => PomodoroStatus::default(),
        Phase::Focus => {
            let round = s.round + 1;
            let phase =
                if round.is_multiple_of(c.rounds_before_long.max(1)) { Phase::LongBreak } else { Phase::ShortBreak };
            PomodoroStatus { phase, round, ends_at: ends(now, phase_minutes(phase, c)), run_started_at }
        }
        Phase::Idle => start_focus(now, c, 0),
        Phase::ShortBreak | Phase::LongBreak if c.auto_continue && !past_cutoff => PomodoroStatus {
            run_started_at,
            ..start_focus(now, c, if s.phase == Phase::LongBreak { 0 } else { s.round })
        },
        _ => PomodoroStatus::default(),
    }
}

/// Returns the new status if the current phase has ended.
pub fn tick(s: &PomodoroStatus, now: Millis, c: &PomodoroConfig, cutoff: Option<Millis>) -> Option<PomodoroStatus> {
    match s.ends_at {
        Some(end) if now >= end => Some(next_phase(s, end, c, cutoff)),
        _ => None,
    }
}

// --- Work hours ---------------------------------------------------------------

fn at_local<Tz: TimeZone>(tz: &Tz, date: NaiveDate, time: NaiveTime) -> Option<Millis> {
    let local = date.and_time(time);
    let t = match tz.from_local_datetime(&local) {
        LocalResult::Single(t) => Some(t),
        LocalResult::Ambiguous(first, _) => Some(first),
        LocalResult::None => tz.from_local_datetime(&(local + Duration::hours(1))).earliest(),
    };
    t.map(|t| t.timestamp_millis())
}

/// Work periods (start, end) that begin on the work days from the day before `t` on, in
/// order. An end at or before the start is on the next day.
fn work_periods<Tz: TimeZone>(tz: &Tz, w: &WorkHours, t: Millis) -> Vec<(Millis, Millis)> {
    let (Some(start), Some(end)) = (parse_hm(&w.start), parse_hm(&w.end)) else {
        return vec![];
    };
    let Some(first) =
        DateTime::<Utc>::from_timestamp_millis(t).map(|d| d.with_timezone(tz).date_naive() - Duration::days(1))
    else {
        return vec![];
    };
    (0..16)
        .filter_map(|i| {
            let date = first + Duration::days(i);
            if w.days & (1 << date.weekday().num_days_from_sunday()) == 0 {
                return None;
            }
            let end_date = if end <= start { date + Duration::days(1) } else { date };
            Some((at_local(tz, date, start)?, at_local(tz, end_date, end)?))
        })
        .collect()
}

/// When a run that started at `started` must stop: the end of the first work period that
/// ends after it (today's end for a run started during or before today's hours, the next
/// work day's end for one started in the evening). None with work hours off.
pub fn run_cutoff<Tz: TimeZone>(tz: &Tz, w: &WorkHours, started: Millis) -> Option<Millis> {
    if !w.enabled {
        return None;
    }
    work_periods(tz, w, started).into_iter().map(|(_, end)| end).find(|&end| end > started)
}

/// The start of the work period `now` is in, if any (with work hours on).
pub fn current_work_period<Tz: TimeZone>(tz: &Tz, w: &WorkHours, now: Millis) -> Option<Millis> {
    if !w.enabled {
        return None;
    }
    work_periods(tz, w, now).into_iter().find(|&(s, e)| s <= now && now < e).map(|(s, _)| s)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: Millis = 60_000;

    #[test]
    fn cycles_with_long_break_every_n_rounds() {
        let c = PomodoroConfig::default();
        let mut s = start_focus(0, &c, 0);
        let mut phases = vec![];
        let mut now = 0;
        for _ in 0..8 {
            now = s.ends_at.unwrap();
            s = tick(&s, now, &c, None).unwrap();
            phases.push(s.phase);
        }
        use Phase::*;
        assert_eq!(phases, vec![ShortBreak, Focus, ShortBreak, Focus, ShortBreak, Focus, LongBreak, Focus]);
        assert_eq!(now, (25 * 4 + 5 * 3 + 15) * MIN);
    }

    #[test]
    fn waits_until_phase_ends() {
        let c = PomodoroConfig::default();
        assert!(tick(&start_focus(0, &c, 0), 24 * MIN, &c, None).is_none());
    }

    #[test]
    fn goes_idle_after_break_without_auto_continue() {
        let c = PomodoroConfig { auto_continue: false, ..Default::default() };
        let s = PomodoroStatus { phase: Phase::ShortBreak, round: 1, ends_at: Some(0), run_started_at: None };
        assert_eq!(next_phase(&s, 0, &c, None), PomodoroStatus::default());
    }
}
