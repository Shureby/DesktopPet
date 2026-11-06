//! The Chinese lunar calendar (nongli), 1900–2099, for anniversaries kept by it: which
//! Gregorian day a lunar date falls on. The same table and rules as
//! src/features/anniversary/lunar.ts; both are tested against tests/lunar-vectors.json (the
//! Hong Kong Observatory's tables).

use chrono::{Duration, NaiveDate};

/// One number per lunar year from 1900: bits 15…4 say whether months 1…12 have 30 days
/// (else 29); bits 3…0 are the leap month (0: none), and bit 16 whether it has 30 days.
const YEARS: [u32; 200] = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, 0x04ae0, 0x0a5b6,
    0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, 0x04970, 0x0a4b0, 0x0b4b5, 0x06a50,
    0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, 0x06566, 0x0d4a0, 0x0ea50, 0x16a95, 0x05ad0, 0x02b60,
    0x186e3, 0x092e0, 0x1c8d7, 0x0c950, 0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2,
    0x0a950, 0x0b557, 0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, 0x096d0, 0x04dd5,
    0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, 0x095b0, 0x049b0, 0x0a974, 0x0a4b0,
    0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, 0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58,
    0x05ac0, 0x0ab60, 0x096d5, 0x092e0, 0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0,
    0x092d0, 0x0cab5, 0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, 0x05aa0, 0x076a3,
    0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, 0x0b5a0, 0x056d0, 0x055b2, 0x049b0,
    0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, 0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6,
    0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, 0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0,
    0x0a6d0, 0x055d4, 0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
    0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d260, 0x0e968, 0x0d520,
    0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a4d0, 0x0d150, 0x0f252,
];

pub const FIRST_YEAR: i32 = 1900;
pub const LAST_YEAR: i32 = FIRST_YEAR + YEARS.len() as i32 - 1;

fn info(year: i32) -> u32 {
    YEARS[(year - FIRST_YEAR) as usize]
}

/// The leap month of a lunar year (0: none).
pub fn leap_month(year: i32) -> u32 {
    info(year) & 0xf
}

/// Days in a month of a lunar year (29 or 30); `leap` for its leap month.
pub fn month_days(year: i32, month: u32, leap: bool) -> u32 {
    let v = info(year);
    let long = if leap { v & 0x10000 } else { v & (0x10000 >> month) };
    if long != 0 {
        30
    } else {
        29
    }
}

fn year_days(year: i32) -> i64 {
    let months: u32 = (1..=12).map(|m| month_days(year, m, false)).sum();
    let leap = match leap_month(year) {
        0 => 0,
        m => month_days(year, m, true),
    };
    (months + leap) as i64
}

/// The Gregorian day of a lunar date; none if there's no such day (out of 1900–2099, no such
/// leap month that year, or a 30th in a 29-day month).
pub fn lunar_to_date(year: i32, month: u32, day: u32, leap: bool) -> Option<NaiveDate> {
    if !(FIRST_YEAR..=LAST_YEAR).contains(&year) || !(1..=12).contains(&month) || day < 1 {
        return None;
    }
    if (leap && leap_month(year) != month) || day > month_days(year, month, leap) {
        return None;
    }
    let mut n: i64 = (FIRST_YEAR..year).map(year_days).sum();
    for m in 1..month {
        n += month_days(year, m, false) as i64;
        if leap_month(year) == m {
            n += month_days(year, m, true) as i64;
        }
    }
    // The leap month comes after the month it repeats.
    if leap {
        n += month_days(year, month, false) as i64;
    }
    n += day as i64 - 1;
    NaiveDate::from_ymd_opt(1900, 1, 31).map(|epoch| epoch + Duration::days(n))
}

/// Where a yearly lunar date falls in lunar year `year`: a leap-month date falls in the leap
/// month when that year has it, else in the regular month; a 30th falls on the 29th in a
/// 29-day month (so "12/30" is always New Year's Eve).
pub fn lunar_in_year(year: i32, month: u32, day: u32, leap: bool) -> Option<NaiveDate> {
    if !(FIRST_YEAR..=LAST_YEAR).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    let leap = leap && leap_month(year) == month;
    lunar_to_date(year, month, day.min(month_days(year, month, leap)), leap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_date_in_the_reference_tables() {
        let json: serde_json::Value = serde_json::from_str(include_str!("../tests/lunar-vectors.json")).unwrap();
        let vectors = json["vectors"].as_array().unwrap();
        assert!(vectors.len() > 1000);
        for v in vectors {
            let (y, m, d, leap) = (
                v[0].as_i64().unwrap() as i32,
                v[1].as_u64().unwrap() as u32,
                v[2].as_u64().unwrap() as u32,
                v[3].as_bool().unwrap(),
            );
            let want = NaiveDate::parse_from_str(v[4].as_str().unwrap(), "%Y-%m-%d").unwrap();
            assert_eq!(lunar_to_date(y, m, d, leap), Some(want), "{y}/{m}/{d} leap {leap}");
        }
    }

    #[test]
    fn leap_months_short_months_and_days_that_do_not_exist() {
        assert_eq!([2023, 2025, 2028].map(leap_month), [2, 6, 5]);
        assert_eq!(lunar_to_date(2026, 6, 1, true), None);
        assert_eq!(lunar_to_date(1899, 1, 1, false), None);
        assert_eq!(lunar_to_date(2100, 1, 1, false), None);
        // A leap-month date in a year without that leap month: the regular month.
        assert_eq!(lunar_in_year(2026, 6, 10, true), lunar_to_date(2026, 6, 10, false));
        assert_eq!(lunar_in_year(2025, 6, 10, true), lunar_to_date(2025, 6, 10, true));
        // "12/30" is New Year's Eve whatever the month's length.
        for y in 2024..2028 {
            let eve = lunar_in_year(y, 12, 30, false).unwrap();
            assert_eq!(Some(eve + Duration::days(1)), lunar_to_date(y + 1, 1, 1, false));
        }
    }
}
