//! Alarm recurrence in the user's local time zone.

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveTime, TimeZone, Utc, Weekday};

use crate::model::{Millis, Repeat};

/// Parses "HH:MM".
pub fn parse_hm(hm: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(hm, "%H:%M").ok()
}

/// Next time strictly after `after` that the local clock in `tz` reads `time`,
/// skipping weekends for `Repeat::Weekdays`. Handles DST gaps by moving forward.
pub fn next_occurrence<Tz: TimeZone>(tz: &Tz, after: Millis, time: NaiveTime, repeat: Repeat) -> Option<Millis> {
    let after_utc = DateTime::<Utc>::from_timestamp_millis(after)?;
    let mut date = after_utc.with_timezone(tz).date_naive();
    for _ in 0..16 {
        let weekend = matches!(date.weekday(), Weekday::Sat | Weekday::Sun);
        if !(repeat == Repeat::Weekdays && weekend) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Europe::London;

    fn ms(tz: &chrono_tz::Tz, y: i32, mo: u32, d: u32, h: u32, mi: u32) -> Millis {
        tz.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn daily_rolls_to_tomorrow_once_passed() {
        let t = parse_hm("07:30").unwrap();
        let now = ms(&London, 2026, 1, 7, 9, 0);
        assert_eq!(next_occurrence(&London, now, t, Repeat::Daily), Some(ms(&London, 2026, 1, 8, 7, 30)));
        let early = ms(&London, 2026, 1, 7, 6, 0);
        assert_eq!(next_occurrence(&London, early, t, Repeat::Daily), Some(ms(&London, 2026, 1, 7, 7, 30)));
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        let t = parse_hm("08:00").unwrap();
        // Friday 2026-01-09 09:00 → Monday 2026-01-12 08:00
        let fri = ms(&London, 2026, 1, 9, 9, 0);
        assert_eq!(next_occurrence(&London, fri, t, Repeat::Weekdays), Some(ms(&London, 2026, 1, 12, 8, 0)));
    }

    #[test]
    fn dst_gap_rings_an_hour_later() {
        // UK clocks jump 01:00 → 02:00 on 2026-03-29.
        let t = parse_hm("01:30").unwrap();
        let before = ms(&London, 2026, 3, 28, 12, 0);
        let got = next_occurrence(&London, before, t, Repeat::Daily).unwrap();
        assert_eq!(got, ms(&London, 2026, 3, 29, 2, 30));
    }
}
