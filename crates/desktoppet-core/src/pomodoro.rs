//! Tomato clock state machine (mirrored in `src/features/pomodoro/logic.ts` for the UI mock).

use crate::model::{Millis, Phase, PomodoroConfig, PomodoroStatus};

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

pub fn start_focus(now: Millis, c: &PomodoroConfig, round: u32) -> PomodoroStatus {
    PomodoroStatus { phase: Phase::Focus, round, ends_at: ends(now, c.focus_min) }
}

/// The phase after the current one (when it ends or is skipped).
pub fn next_phase(s: &PomodoroStatus, now: Millis, c: &PomodoroConfig) -> PomodoroStatus {
    match s.phase {
        Phase::Focus => {
            let round = s.round + 1;
            let phase =
                if round.is_multiple_of(c.rounds_before_long.max(1)) { Phase::LongBreak } else { Phase::ShortBreak };
            PomodoroStatus { phase, round, ends_at: ends(now, phase_minutes(phase, c)) }
        }
        Phase::Idle => start_focus(now, c, 0),
        Phase::ShortBreak | Phase::LongBreak if c.auto_continue => {
            start_focus(now, c, if s.phase == Phase::LongBreak { 0 } else { s.round })
        }
        _ => PomodoroStatus::default(),
    }
}

/// Returns the new status if the current phase has ended.
pub fn tick(s: &PomodoroStatus, now: Millis, c: &PomodoroConfig) -> Option<PomodoroStatus> {
    match s.ends_at {
        Some(end) if now >= end => Some(next_phase(s, end, c)),
        _ => None,
    }
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
            s = tick(&s, now, &c).unwrap();
            phases.push(s.phase);
        }
        use Phase::*;
        assert_eq!(phases, vec![ShortBreak, Focus, ShortBreak, Focus, ShortBreak, Focus, LongBreak, Focus]);
        assert_eq!(now, (25 * 4 + 5 * 3 + 15) * MIN);
    }

    #[test]
    fn waits_until_phase_ends() {
        let c = PomodoroConfig::default();
        assert!(tick(&start_focus(0, &c, 0), 24 * MIN, &c).is_none());
    }

    #[test]
    fn goes_idle_after_break_without_auto_continue() {
        let c = PomodoroConfig { auto_continue: false, ..Default::default() };
        let s = PomodoroStatus { phase: Phase::ShortBreak, round: 1, ends_at: Some(0) };
        assert_eq!(next_phase(&s, 0, &c), PomodoroStatus::default());
    }
}
