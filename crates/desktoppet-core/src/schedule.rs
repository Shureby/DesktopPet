//! Alarm and to-do recurrence in the user's local time zone.

use chrono::{DateTime, Datelike, Duration, LocalResult, Months, NaiveDate, NaiveTime, TimeZone, Utc};

use crate::lunar::lunar_in_year;
use crate::model::{Calendar, DateRule, DayMask, Millis, TodoRepeat};

/// Parses "HH:MM".
pub fn parse_hm(hm: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(hm, "%H:%M").ok()
}

/// Next time strictly after `after` that the local clock in `tz` reads `time`, on one of
/// `days` (see `DayMask`; `Repeat::mask`). Handles DST gaps by moving forward.
pub fn next_occurrence<Tz: TimeZone>(tz: &Tz, after: Millis, time: NaiveTime, days: DayMask) -> Option<Millis> {
    let after_utc = DateTime::<Utc>::from_timestamp_millis(after)?;
    let mut date = after_utc.with_timezone(tz).date_naive();
    for _ in 0..16 {
        if days & (1 << date.weekday().num_days_from_sunday()) != 0 {
            let local = date.and_time(time);
            let resolved = match tz.from_local_datetime(&local) {
                LocalResult::Single(t) => Some(t),
                LocalResult::Ambiguous(first, _) => Some(first),
                // Skipped by a DST jump: ring an hour later instead.
                LocalResult::None => tz.from_local_datetime(&(local + Duration::hours(1))).earliest(),
            };
            if let Some(t) = resolved {
                let ms = t.timestamp_millis();
                if ms > after {
                    return Some(ms);
                }
            }
        }
        date = date.succ_opt()?;
    }
    None
}

/// A local date and time in `tz` as milliseconds. A time skipped by a DST jump moves an hour
/// later; a repeated one takes the first.
pub fn local_ms<Tz: TimeZone>(tz: &Tz, date: NaiveDate, time: NaiveTime) -> Option<Millis> {
    let local = date.and_time(time);
    match tz.from_local_datetime(&local) {
        LocalResult::Single(t) => Some(t.timestamp_millis()),
        LocalResult::Ambiguous(first, _) => Some(first.timestamp_millis()),
        LocalResult::None => {
            tz.from_local_datetime(&(local + Duration::hours(1))).earliest().map(|t| t.timestamp_millis())
        }
    }
}

/// The local date in `tz` at `ms`.
pub fn local_date<Tz: TimeZone>(tz: &Tz, ms: Millis) -> Option<NaiveDate> {
    Some(DateTime::<Utc>::from_timestamp_millis(ms)?.with_timezone(tz).date_naive())
}

/// The `n`th time a repeating to-do comes round after its first (`anchor`, n = 0), at the
/// same local time of day. Months are counted from the anchor, so the 31st stays the 31st
/// where a month has one (and is the month's last day where it doesn't).
pub fn todo_occurrence<Tz: TimeZone>(tz: &Tz, anchor: Millis, repeat: TodoRepeat, n: u32) -> Option<Millis> {
    let start = DateTime::<Utc>::from_timestamp_millis(anchor)?.with_timezone(tz).naive_local();
    let (date, time) = (start.date(), start.time());
    let date = match repeat {
        TodoRepeat::None => return (n == 0).then_some(anchor),
        TodoRepeat::Daily => date.checked_add_days(chrono::Days::new(n as u64))?,
        TodoRepeat::Weekly => date.checked_add_days(chrono::Days::new(7 * n as u64))?,
        TodoRepeat::Fortnightly => date.checked_add_days(chrono::Days::new(14 * n as u64))?,
        TodoRepeat::Monthly => date.checked_add_months(Months::new(n))?,
        TodoRepeat::Quarterly => date.checked_add_months(Months::new(3 * n))?,
        TodoRepeat::Yearly => date.checked_add_months(Months::new(12 * n))?,
    };
    local_ms(tz, date, time)
}

/// The first time a repeating to-do comes round strictly after `after`.
pub fn next_todo<Tz: TimeZone>(tz: &Tz, anchor: Millis, repeat: TodoRepeat, after: Millis) -> Option<Millis> {
    // Start a little before the answer (each step is at most this long) instead of at the anchor.
    let longest_step: Millis = match repeat {
        TodoRepeat::None => return (anchor > after).then_some(anchor),
        TodoRepeat::Daily => 25,
        TodoRepeat::Weekly => 7 * 24 + 1,
        TodoRepeat::Fortnightly => 14 * 24 + 1,
        TodoRepeat::Monthly => 31 * 24 + 1,
        TodoRepeat::Quarterly => 92 * 24 + 1,
        TodoRepeat::Yearly => 366 * 24 + 1,
    } * 3_600_000;
    let first = ((after - anchor).max(0) / longest_step) as u32;
    for n in (first..).take(10_000) {
        let t = todo_occurrence(tz, anchor, repeat, n)?;
        if t > after {
            return Some(t);
        }
    }
    None
}

/// The day of the `nth` (1–4, or -1: the last) `weekday` (0 = Sunday) of a month.
pub fn nth_weekday(year: i32, month: u32, nth: i32, weekday: u32) -> Option<NaiveDate> {
    if nth < 0 {
        let last = NaiveDate::from_ymd_opt(year, month + 1, 1)
            .or_else(|| NaiveDate::from_ymd_opt(year + 1, 1, 1))?
            .pred_opt()?;
        let back = (last.weekday().num_days_from_sunday() + 7 - weekday) % 7;
        return last.checked_sub_days(chrono::Days::new(back as u64));
    }
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let ahead = (weekday + 7 - first.weekday().num_days_from_sunday()) % 7;
    first.checked_add_days(chrono::Days::new((ahead + (nth.max(1) as u32 - 1) * 7) as u64))
}

/// Where an anniversary falls in a year: Gregorian `year` for a date or a day of the week,
/// lunar `year` for a lunar date. Feb 29 is Feb 28 in other years.
fn anniversary_in(rule: &DateRule, year: i32) -> Option<NaiveDate> {
    match rule.calendar {
        Calendar::Lunar => lunar_in_year(year, rule.month, rule.day, rule.leap),
        Calendar::Weekday => nth_weekday(year, rule.month, rule.nth, rule.weekday),
        Calendar::Solar => NaiveDate::from_ymd_opt(year, rule.month, rule.day)
            .or_else(|| NaiveDate::from_ymd_opt(year, rule.month, rule.day - 1)),
    }
}

/// The anniversary on or after `date`: this year's, or next year's once it has passed (none
/// past the lunar table, 2099). Mirrors `nextAnniversary` in src/features/anniversary/templates.ts.
pub fn anniversary_on_or_after(rule: &DateRule, date: NaiveDate) -> Option<NaiveDate> {
    // A lunar year starts in January or February: last lunar year's end may still be ahead.
    let first = if rule.calendar == Calendar::Lunar { date.year() - 1 } else { date.year() };
    (first..=date.year() + 1).find_map(|y| anniversary_in(rule, y).filter(|d| *d >= date))
}

/// The day of a reminder `lead` ("1d", "2d", "3d", "1w", "2w", "1m") before `on`.
pub fn prep_day(on: NaiveDate, lead: &str) -> Option<NaiveDate> {
    let days = match lead {
        "1d" => 1,
        "2d" => 2,
        "3d" => 3,
        "1w" => 7,
        "2w" => 14,
        "1m" => return on.checked_sub_months(Months::new(1)),
        _ => return None,
    };
    on.checked_sub_days(chrono::Days::new(days))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Repeat, EVERY_DAY, WEEKDAYS};
    use chrono_tz::Europe::London;

    fn ms(tz: &chrono_tz::Tz, y: i32, mo: u32, d: u32, h: u32, mi: u32) -> Millis {
        tz.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn daily_rolls_to_tomorrow_once_passed() {
        let t = parse_hm("07:30").unwrap();
        let now = ms(&London, 2026, 1, 7, 9, 0);
        assert_eq!(next_occurrence(&London, now, t, EVERY_DAY), Some(ms(&London, 2026, 1, 8, 7, 30)));
        let early = ms(&London, 2026, 1, 7, 6, 0);
        assert_eq!(next_occurrence(&London, early, t, EVERY_DAY), Some(ms(&London, 2026, 1, 7, 7, 30)));
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        let t = parse_hm("08:00").unwrap();
        // Friday 2026-01-09 09:00 → Monday 2026-01-12 08:00
        let fri = ms(&London, 2026, 1, 9, 9, 0);
        assert_eq!(next_occurrence(&London, fri, t, WEEKDAYS), Some(ms(&London, 2026, 1, 12, 8, 0)));
    }

    #[test]
    fn chosen_days_ring_only_on_those_days() {
        let t = parse_hm("08:00").unwrap();
        let mon_wed_fri = Repeat::Days.mask(0b010_1010);
        // Friday 2026-01-09 09:00 → Monday 12th; Monday 09:00 → Wednesday 14th.
        let fri = ms(&London, 2026, 1, 9, 9, 0);
        assert_eq!(next_occurrence(&London, fri, t, mon_wed_fri), Some(ms(&London, 2026, 1, 12, 8, 0)));
        let mon = ms(&London, 2026, 1, 12, 9, 0);
        assert_eq!(next_occurrence(&London, mon, t, mon_wed_fri), Some(ms(&London, 2026, 1, 14, 8, 0)));
        // No days: never.
        assert_eq!(next_occurrence(&London, mon, t, 0), None);
    }

    #[test]
    fn dst_gap_rings_an_hour_later() {
        // UK clocks jump 01:00 → 02:00 on 2026-03-29.
        let t = parse_hm("01:30").unwrap();
        let before = ms(&London, 2026, 3, 28, 12, 0);
        let got = next_occurrence(&London, before, t, EVERY_DAY).unwrap();
        assert_eq!(got, ms(&London, 2026, 3, 29, 2, 30));
    }

    #[test]
    fn repeating_todos_keep_their_day() {
        // Weekly from Tue 2026-10-06 19:00: after Wed the 7th it's Tue the 13th.
        let anchor = ms(&London, 2026, 10, 6, 19, 0);
        let wed = ms(&London, 2026, 10, 7, 9, 0);
        assert_eq!(next_todo(&London, anchor, TodoRepeat::Weekly, wed), Some(ms(&London, 2026, 10, 13, 19, 0)));
        // Fortnightly keeps to the same alternate weeks, even months later.
        let later = ms(&London, 2027, 1, 1, 0, 0);
        assert_eq!(next_todo(&London, anchor, TodoRepeat::Fortnightly, later), Some(ms(&London, 2027, 1, 12, 19, 0)));
        // Monthly on the 31st: Nov 30, then Dec 31 again.
        let jan31 = ms(&London, 2026, 1, 31, 0, 0);
        let nov1 = ms(&London, 2026, 11, 1, 0, 0);
        assert_eq!(next_todo(&London, jan31, TodoRepeat::Monthly, nov1), Some(ms(&London, 2026, 11, 30, 0, 0)));
        let dec1 = ms(&London, 2026, 12, 1, 0, 0);
        assert_eq!(next_todo(&London, jan31, TodoRepeat::Monthly, dec1), Some(ms(&London, 2026, 12, 31, 0, 0)));
        // Quarterly and yearly (Feb 29 → Feb 28 in other years).
        assert_eq!(next_todo(&London, jan31, TodoRepeat::Quarterly, jan31), Some(ms(&London, 2026, 4, 30, 0, 0)));
        let leap = ms(&London, 2028, 2, 29, 0, 0);
        assert_eq!(next_todo(&London, leap, TodoRepeat::Yearly, leap), Some(ms(&London, 2029, 2, 28, 0, 0)));
        // Daily keeps its local time across the clocks going forward (2026-03-29 in the UK).
        let d = ms(&London, 2026, 3, 28, 9, 0);
        assert_eq!(next_todo(&London, d, TodoRepeat::Daily, d), Some(ms(&London, 2026, 3, 29, 9, 0)));
        // Not repeating: only its own time.
        assert_eq!(next_todo(&London, d, TodoRepeat::None, d), None);
    }

    #[test]
    fn anniversaries_fall_on_their_day_each_year() {
        let d = |y, m, dd| NaiveDate::from_ymd_opt(y, m, dd).unwrap();
        assert_eq!(anniversary_on_or_after(&DateRule::date(10, 25), d(2026, 10, 2)), Some(d(2026, 10, 25)));
        assert_eq!(anniversary_on_or_after(&DateRule::date(10, 25), d(2026, 10, 25)), Some(d(2026, 10, 25)));
        assert_eq!(anniversary_on_or_after(&DateRule::date(3, 3), d(2026, 10, 2)), Some(d(2027, 3, 3)));
        // Feb 29: Feb 28 in other years, Feb 29 in leap years.
        assert_eq!(anniversary_on_or_after(&DateRule::date(2, 29), d(2026, 10, 2)), Some(d(2027, 2, 28)));
        assert_eq!(anniversary_on_or_after(&DateRule::date(2, 29), d(2027, 10, 2)), Some(d(2028, 2, 29)));
        assert_eq!(prep_day(d(2026, 10, 25), "1d"), Some(d(2026, 10, 24)));
        assert_eq!(prep_day(d(2026, 10, 25), "2w"), Some(d(2026, 10, 11)));
        assert_eq!(prep_day(d(2026, 3, 31), "1m"), Some(d(2026, 2, 28)));
        assert_eq!(prep_day(d(2026, 3, 31), "soon"), None);
    }

    #[test]
    fn lunar_and_weekday_anniversaries() {
        let d = |y, m, dd| NaiveDate::from_ymd_opt(y, m, dd).unwrap();
        let lunar = |month, day, leap| DateRule { calendar: Calendar::Lunar, month, day, leap, nth: 1, weekday: 0 };
        // Mid-Autumn: 2026-09-25, then 2027-09-15.
        assert_eq!(anniversary_on_or_after(&lunar(8, 15, false), d(2026, 9, 1)), Some(d(2026, 9, 25)));
        assert_eq!(anniversary_on_or_after(&lunar(8, 15, false), d(2026, 9, 25)), Some(d(2026, 9, 25)));
        assert_eq!(anniversary_on_or_after(&lunar(8, 15, false), d(2026, 9, 26)), Some(d(2027, 9, 15)));
        // Late in the lunar year: in January of the next Gregorian one.
        assert_eq!(
            anniversary_on_or_after(&lunar(12, 1, false), d(2026, 12, 20)),
            crate::lunar::lunar_to_date(2026, 12, 1, false)
        );
        // New Year's Eve 2026 (lunar 12/30 in a short 12th month) is 2027-02-05.
        assert_eq!(anniversary_on_or_after(&lunar(12, 30, false), d(2026, 10, 10)), Some(d(2027, 2, 5)));
        assert_eq!(anniversary_on_or_after(&lunar(8, 15, false), d(2100, 10, 1)), None);
        let weekday =
            |month, nth, weekday| DateRule { calendar: Calendar::Weekday, month, day: 1, leap: false, nth, weekday };
        assert_eq!(anniversary_on_or_after(&weekday(5, 2, 0), d(2026, 5, 1)), Some(d(2026, 5, 10)));
        assert_eq!(anniversary_on_or_after(&weekday(5, 2, 0), d(2026, 5, 11)), Some(d(2027, 5, 9)));
        assert_eq!(nth_weekday(2026, 11, 4, 4), Some(d(2026, 11, 26)));
        assert_eq!(nth_weekday(2026, 2, 1, 0), Some(d(2026, 2, 1)));
        assert_eq!(nth_weekday(2026, 5, -1, 1), Some(d(2026, 5, 25)));
        assert_eq!(nth_weekday(2026, 1, -1, 6), Some(d(2026, 1, 31)));
        assert_eq!(nth_weekday(2026, 12, -1, 4), Some(d(2026, 12, 31)));
    }
}
