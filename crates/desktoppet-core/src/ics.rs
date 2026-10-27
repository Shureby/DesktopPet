//! Calendar files (iCalendar, RFC 5545, `.ics`) for what's sent (share.rs).
//!
//! Written so that phones and calendar apps read the standard part: an alarm is an event with
//! a reminder at its time, a to-do a VTODO, an anniversary a yearly all-day event (a lunar
//! one as its dates for the next 20 years, as calendars can't count lunar years). ePet's own
//! part, `X-EPET-DATA` (the item as JSON), brings back what they can't hold. Files from
//! elsewhere are read from their standard part: what fits becomes an alarm, a to-do or an
//! anniversary, the rest is skipped.

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, NaiveTime, Offset, TimeZone, Timelike, Utc, Weekday};
use sha2::{Digest, Sha256};

use crate::model::{Calendar, DateRule, DayMask, Millis, NewAnniversary, Repeat, TodoRepeat, EVERY_DAY, WEEKDAYS};
use crate::schedule::{anniversary_on_or_after, local_date, local_ms, next_occurrence, parse_hm};
use crate::share::{Item, Shared, SharedAlarm, SharedTodo};

/// The most read from one file.
pub const MAX_ITEMS: usize = 200;
/// Files bigger than this aren't read.
pub const MAX_BYTES: usize = 1024 * 1024;
/// How many years of a lunar (or listed) anniversary's dates are written.
const YEARS_LISTED: i32 = 20;

/// What a file holds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Parsed {
    pub items: Vec<Shared>,
    /// The sender's time zone (an ePet's file: its IANA name) and its offset from UTC then
    /// (minutes), for "their time".
    pub tz: Option<String>,
    pub offset: Option<i32>,
    /// Entries that couldn't be made into anything (or were in the past).
    pub skipped: usize,
}

// --- Writing ---------------------------------------------------------------------------

/// Text as a property value: backslash, semicolon, comma and line breaks escaped.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            c => out.push(c),
        }
    }
    out
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(c) => out.push(c),
            None => {}
        }
    }
    out
}

/// A content line, folded at 75 octets (RFC 5545 3.1), with CRLF.
fn line(out: &mut String, text: &str) {
    let mut width = 0;
    for c in text.chars() {
        let n = c.len_utf8();
        if width + n > 75 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(c);
        width += n;
    }
    out.push_str("\r\n");
}

fn utc(ms: Millis) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string()
}

fn ymd(d: NaiveDate) -> String {
    d.format("%Y%m%d").to_string()
}

const DAY_NAMES: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

fn by_day(mask: DayMask) -> String {
    (0..7).filter(|i| mask & (1 << i) != 0).map(|i| DAY_NAMES[i]).collect::<Vec<_>>().join(",")
}

fn todo_rule(r: TodoRepeat) -> Option<&'static str> {
    Some(match r {
        TodoRepeat::None => return None,
        TodoRepeat::Daily => "FREQ=DAILY",
        TodoRepeat::Weekly => "FREQ=WEEKLY",
        TodoRepeat::Fortnightly => "FREQ=WEEKLY;INTERVAL=2",
        TodoRepeat::Monthly => "FREQ=MONTHLY",
        TodoRepeat::Quarterly => "FREQ=MONTHLY;INTERVAL=3",
        TodoRepeat::Yearly => "FREQ=YEARLY",
    })
}

/// The offset of `tz` from UTC at `ms`, in minutes.
pub fn offset_minutes<Tz: TimeZone>(tz: &Tz, ms: Millis) -> i32 {
    let at = DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default();
    tz.offset_from_utc_datetime(&at.naive_utc()).fix().local_minus_utc() / 60
}

/// The calendar file for `items`. `tz_name` is the IANA name of this computer's time zone
/// (as the system says; "" if unknown).
pub fn write<Tz: TimeZone>(tz: &Tz, tz_name: &str, items: &[Shared], now: Millis) -> String {
    let mut out = String::new();
    for l in ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ePet//ePet//EN", "CALSCALE:GREGORIAN"] {
        line(&mut out, l);
    }
    if !tz_name.is_empty() {
        line(&mut out, &format!("X-EPET-TZ:{}", escape(tz_name)));
    }
    line(&mut out, &format!("X-EPET-OFFSET:{}", offset_minutes(tz, now)));
    let stamp = utc(now);
    let today = local_date(tz, now).unwrap_or_default();
    for s in items {
        let data = serde_json::to_string(&s.item).unwrap_or_default();
        let mut props: Vec<String> = vec![format!("UID:{}", escape(&s.uid)), format!("DTSTAMP:{stamp}")];
        let component = match &s.item {
            Item::Alarm(a) => {
                props.push(format!("SUMMARY:{}", escape(&a.label)));
                match (a.repeat, a.time.as_deref().and_then(parse_hm)) {
                    (Repeat::None, _) | (_, None) => props.push(format!("DTSTART:{}", utc(a.at.unwrap_or(now)))),
                    (repeat, Some(t)) => {
                        // The first ring from now, as the local time of day ("floating": the
                        // same clock time wherever the calendar is).
                        let mask = repeat.mask(a.days);
                        let first = next_occurrence(tz, now, t, mask).unwrap_or(now);
                        let day = local_date(tz, first).unwrap_or(today);
                        props.push(format!("DTSTART:{}", day.and_time(t).format("%Y%m%dT%H%M%S")));
                        props.push(match repeat {
                            Repeat::Daily => "RRULE:FREQ=DAILY".into(),
                            _ => format!("RRULE:FREQ=WEEKLY;BYDAY={}", by_day(mask)),
                        });
                    }
                }
                "VEVENT"
            }
            Item::Todo(t) => {
                props.push(format!("SUMMARY:{}", escape(&t.title)));
                if let Some(at) = t.at {
                    props.push(format!("DUE:{}", utc(at)));
                } else if let Some(d) = t.day.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()) {
                    props.push(format!("DUE;VALUE=DATE:{}", ymd(d)));
                }
                if let Some(rule) = todo_rule(t.repeat).filter(|_| t.at.is_some() || t.day.is_some()) {
                    props.push(format!("RRULE:{rule}"));
                }
                "VTODO"
            }
            Item::Anniversary(a) => {
                props.push(format!("SUMMARY:{}", escape(format!("{} {}", a.icon, a.name).trim())));
                let rule = a.rule();
                let next = anniversary_on_or_after(&rule, today).unwrap_or(today);
                props.push(format!("DTSTART;VALUE=DATE:{}", ymd(next)));
                props.push(format!("DTEND;VALUE=DATE:{}", ymd(next.succ_opt().unwrap_or(next))));
                props.push("TRANSP:TRANSPARENT".into());
                match a.calendar {
                    Calendar::Solar => props.push("RRULE:FREQ=YEARLY".into()),
                    Calendar::Weekday => props.push(format!(
                        "RRULE:FREQ=YEARLY;BYMONTH={};BYDAY={}{}",
                        a.month,
                        a.nth.unwrap_or(1),
                        DAY_NAMES[a.weekday.unwrap_or(0).min(6) as usize]
                    )),
                    // Calendars can't count these: their dates, one by one.
                    _ => {
                        let mut dates = vec![];
                        let mut from = next.succ_opt().unwrap_or(next);
                        while dates.len() < (YEARS_LISTED - 1) as usize {
                            let Some(d) = anniversary_on_or_after(&rule, from) else { break };
                            dates.push(ymd(d));
                            from = d.succ_opt().unwrap_or(d);
                        }
                        if !dates.is_empty() {
                            props.push(format!("RDATE;VALUE=DATE:{}", dates.join(",")));
                        }
                    }
                }
                "VEVENT"
            }
        };
        line(&mut out, &format!("BEGIN:{component}"));
        for p in &props {
            line(&mut out, p);
        }
        line(&mut out, &format!("X-EPET-DATA:{}", escape(&data)));
        if let Item::Alarm(a) = &s.item {
            for l in [
                "BEGIN:VALARM",
                "ACTION:DISPLAY",
                &format!("DESCRIPTION:{}", escape(&a.label)),
                "TRIGGER:PT0S",
                "END:VALARM",
            ] {
                line(&mut out, l);
            }
        }
        line(&mut out, &format!("END:{component}"));
    }
    line(&mut out, "END:VCALENDAR");
    out
}

// --- Reading ---------------------------------------------------------------------------

/// A content line: its name (upper case), parameters and value.
#[derive(Debug, Clone)]
struct Prop {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Prop {
    fn param(&self, key: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

fn parse_line(l: &str) -> Option<Prop> {
    // The value starts after the first ':' that isn't inside a quoted parameter.
    let mut quoted = false;
    let colon = l.char_indices().find(|&(_, c)| {
        if c == '"' {
            quoted = !quoted;
        }
        c == ':' && !quoted
    })?;
    let (head, value) = (&l[..colon.0], &l[colon.0 + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.trim().to_ascii_uppercase();
    let params = parts
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.trim().to_ascii_uppercase(), v.trim_matches('"').to_string()))
        .collect();
    Some(Prop { name, params, value: value.to_string() })
}

/// The lines, unfolded.
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = vec![];
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = raw.strip_prefix([' ', '\t']) {
            if let Some(last) = lines.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        lines.push(raw.to_string());
    }
    lines
}

/// When something is: a day, a local time ("floating", or in a named zone we read as local),
/// or a moment.
#[derive(Debug, Clone, Copy, PartialEq)]
enum When {
    Day(NaiveDate),
    Local(NaiveDateTime),
    Moment(Millis),
}

fn when(p: &Prop) -> Option<When> {
    let v = p.value.trim();
    if p.param("VALUE").is_some_and(|x| x.eq_ignore_ascii_case("DATE")) || v.len() == 8 {
        return NaiveDate::parse_from_str(v, "%Y%m%d").ok().map(When::Day);
    }
    if let Some(z) = v.strip_suffix(['Z', 'z']) {
        let t = NaiveDateTime::parse_from_str(z, "%Y%m%dT%H%M%S").ok()?;
        return Some(When::Moment(t.and_utc().timestamp_millis()));
    }
    NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok().map(When::Local)
}

/// An RRULE's parts.
#[derive(Debug, Default)]
struct Rule {
    freq: String,
    interval: u32,
    /// BYDAY: (nth, weekday 0 = Sunday); nth 0 when not given.
    days: Vec<(i32, u32)>,
    month: Option<u32>,
    /// It ends (COUNT or UNTIL): a pet's reminders don't, so it's read as not repeating if it
    /// already ended.
    until: Option<When>,
}

fn rule(value: &str) -> Rule {
    let mut r = Rule { interval: 1, ..Rule::default() };
    for part in value.split(';') {
        let Some((k, v)) = part.split_once('=') else { continue };
        match k.trim().to_ascii_uppercase().as_str() {
            "FREQ" => r.freq = v.trim().to_ascii_uppercase(),
            "INTERVAL" => r.interval = v.trim().parse().unwrap_or(1).max(1),
            "BYMONTH" => r.month = v.split(',').next().and_then(|m| m.trim().parse().ok()),
            "UNTIL" => {
                r.until = when(&Prop { name: String::new(), params: vec![], value: v.to_string() });
            }
            "BYDAY" => {
                for d in v.split(',') {
                    let d = d.trim().to_ascii_uppercase();
                    if d.len() < 2 {
                        continue;
                    }
                    let (n, name) = d.split_at(d.len() - 2);
                    if let Some(w) = DAY_NAMES.iter().position(|x| *x == name) {
                        r.days.push((n.parse().unwrap_or(0), w as u32));
                    }
                }
            }
            _ => {}
        }
    }
    r
}

fn todo_repeat(r: &Rule) -> TodoRepeat {
    match (r.freq.as_str(), r.interval) {
        ("DAILY", 1) => TodoRepeat::Daily,
        ("WEEKLY", 1) => TodoRepeat::Weekly,
        ("WEEKLY", 2) => TodoRepeat::Fortnightly,
        ("MONTHLY", 1) => TodoRepeat::Monthly,
        ("MONTHLY", 3) => TodoRepeat::Quarterly,
        ("YEARLY", 1) => TodoRepeat::Yearly,
        _ => TodoRepeat::None,
    }
}

fn weekday_bit(w: Weekday) -> DayMask {
    1 << w.num_days_from_sunday()
}

fn ms_of<Tz: TimeZone>(tz: &Tz, w: When) -> Option<Millis> {
    match w {
        When::Moment(ms) => Some(ms),
        When::Local(t) => local_ms(tz, t.date(), t.time()),
        When::Day(d) => local_ms(tz, d, NaiveTime::MIN),
    }
}

/// A stable id for an entry without a UID (the same file read again gives the same one).
fn made_up_uid(lines: &[String]) -> String {
    let mut h = Sha256::new();
    for l in lines {
        h.update(l.as_bytes());
        h.update(b"\n");
    }
    h.finalize()[..16].iter().map(|b| format!("{b:02x}")).collect()
}

fn anniversary_like(name: &str) -> (&'static str, &'static str) {
    let lower = name.to_lowercase();
    if ["birthday", "生日", "生辰", "誕辰", "诞辰", "geburtstag", "anniversaire de", "cumpleaños"]
        .iter()
        .any(|w| lower.contains(w))
    {
        ("birthday", "🎂")
    } else if ["wedding", "结婚", "結婚", "婚礼", "婚禮"].iter().any(|w| lower.contains(w)) {
        ("wedding", "💍")
    } else {
        ("custom", "🌟")
    }
}

/// One VEVENT or VTODO from elsewhere, from its standard part. None: nothing a pet keeps
/// (or in the past).
fn standard<Tz: TimeZone>(tz: &Tz, todo: bool, props: &[Prop], now: Millis) -> Option<Item> {
    let get = |n: &str| props.iter().find(|p| p.name == n);
    let title = get("SUMMARY").map(|p| unescape(&p.value).trim().to_string()).unwrap_or_default();
    if title.is_empty() {
        return None;
    }
    let today = local_date(tz, now)?;
    let r = get("RRULE").map(|p| rule(&p.value));
    // A rule that already ended: only its own time counts (and that's in the past).
    let ended = r.as_ref().and_then(|r| r.until).and_then(|u| ms_of(tz, u)).is_some_and(|u| u < now);
    let r = r.filter(|_| !ended);
    if todo {
        if get("STATUS").is_some_and(|s| s.value.trim().eq_ignore_ascii_case("COMPLETED")) {
            return None;
        }
        let repeat = r.as_ref().map(todo_repeat).unwrap_or_default();
        return Some(Item::Todo(match get("DUE").or(get("DTSTART")).and_then(when) {
            None => SharedTodo { title, at: None, day: None, repeat: TodoRepeat::None },
            Some(When::Day(d)) => SharedTodo { title, at: None, day: Some(d.format("%Y-%m-%d").to_string()), repeat },
            Some(w) => SharedTodo { title, at: ms_of(tz, w), day: None, repeat },
        }));
    }
    let start = get("DTSTART").and_then(when)?;
    match start {
        When::Day(d) => {
            if let Some(r) = r.as_ref().filter(|r| r.freq == "YEARLY" && r.interval == 1) {
                let (kind, icon) = anniversary_like(&title);
                let base = NewAnniversary {
                    kind: kind.into(),
                    icon: icon.into(),
                    name: title,
                    effect: true,
                    ..NewAnniversary::default()
                };
                return Some(Item::Anniversary(match (r.days.first(), r.month) {
                    (Some(&(nth, weekday)), Some(month)) if nth != 0 => NewAnniversary {
                        calendar: Calendar::Weekday,
                        month,
                        day: 1,
                        nth: Some(nth.clamp(-1, 4)),
                        weekday: Some(weekday),
                        ..base
                    },
                    _ => NewAnniversary {
                        month: d.month(),
                        day: d.day(),
                        // Birthdays start in the year of birth: "36th".
                        since: (d.year() < today.year()).then_some(d.year()),
                        ..base
                    },
                }));
            }
            let repeat = r.as_ref().map(todo_repeat).unwrap_or_default();
            if repeat == TodoRepeat::None && d < today {
                return None;
            }
            Some(Item::Todo(SharedTodo { title, at: None, day: Some(d.format("%Y-%m-%d").to_string()), repeat }))
        }
        start => {
            let at = ms_of(tz, start)?;
            let Some(r) = r else {
                return (at >= now).then(|| {
                    Item::Alarm(SharedAlarm {
                        label: title,
                        repeat: Repeat::None,
                        at: Some(at),
                        ..SharedAlarm::default()
                    })
                });
            };
            let local = DateTime::<Utc>::from_timestamp_millis(at)?.with_timezone(tz).naive_local();
            let time = format!("{:02}:{:02}", local.hour(), local.minute());
            let mask: DayMask = match (r.freq.as_str(), r.interval) {
                ("DAILY", 1) => EVERY_DAY,
                ("WEEKLY", 1) if r.days.is_empty() => weekday_bit(local.weekday()),
                ("WEEKLY", 1) => r.days.iter().fold(0, |m, &(_, w)| m | (1 << w)),
                _ => 0,
            };
            if mask == 0 {
                return Some(Item::Todo(SharedTodo { title, at: Some(at), day: None, repeat: todo_repeat(&r) }));
            }
            let (repeat, days) = match mask {
                EVERY_DAY => (Repeat::Daily, 0),
                WEEKDAYS => (Repeat::Weekdays, 0),
                m => (Repeat::Days, m),
            };
            Some(Item::Alarm(SharedAlarm { label: title, repeat, days, time: Some(time), ..SharedAlarm::default() }))
        }
    }
}

/// Reads a calendar file: None if it isn't one.
pub fn read<Tz: TimeZone>(tz: &Tz, text: &str, now: Millis) -> Option<Parsed> {
    if text.len() > MAX_BYTES
        || !text.trim_start_matches('\u{feff}').trim_start().to_ascii_uppercase().starts_with("BEGIN:VCALENDAR")
    {
        return None;
    }
    let mut out = Parsed::default();
    // The component being read (VEVENT/VTODO), its props and raw lines, and how deep we are
    // inside a nested one (VALARM, VTIMEZONE's parts).
    let mut current: Option<(bool, Vec<Prop>, Vec<String>)> = None;
    let mut nested = 0usize;
    for l in unfold(text) {
        let Some(p) = parse_line(&l) else { continue };
        let value = p.value.trim().to_ascii_uppercase();
        match (p.name.as_str(), current.is_some()) {
            ("BEGIN", false) if value == "VEVENT" || value == "VTODO" => {
                current = Some((value == "VTODO", vec![], vec![]));
                nested = 0;
            }
            ("BEGIN", true) => nested += 1,
            ("END", true) if nested > 0 => nested -= 1,
            ("END", true) => {
                let (todo, props, lines) = current.take().unwrap_or_default();
                if out.items.len() >= MAX_ITEMS {
                    out.skipped += 1;
                    continue;
                }
                let own = props
                    .iter()
                    .find(|p| p.name == "X-EPET-DATA")
                    .and_then(|p| serde_json::from_str::<Item>(&unescape(&p.value)).ok());
                let item = own.or_else(|| standard(tz, todo, &props, now));
                let Some(item) = item else {
                    out.skipped += 1;
                    continue;
                };
                let uid = props
                    .iter()
                    .find(|p| p.name == "UID")
                    .map(|p| unescape(&p.value).trim().chars().take(200).collect::<String>())
                    .filter(|u| !u.is_empty())
                    .unwrap_or_else(|| made_up_uid(&lines));
                out.items.push(Shared { uid, item: item.normalized() });
            }
            (_, true) if nested == 0 => {
                if let Some(c) = current.as_mut() {
                    c.2.push(l.clone());
                    c.1.push(p);
                }
            }
            ("X-EPET-TZ", false) => out.tz = Some(unescape(&p.value).trim().chars().take(64).collect()),
            ("X-EPET-OFFSET", false) => out.offset = p.value.trim().parse().ok().filter(|m: &i32| m.abs() <= 18 * 60),
            _ => {}
        }
    }
    Some(out)
}

/// The day an anniversary comes next, on or after today (for the preview).
pub fn next_day<Tz: TimeZone>(tz: &Tz, a: &NewAnniversary, now: Millis) -> Option<NaiveDate> {
    let rule: DateRule = a.rule();
    anniversary_on_or_after(&rule, local_date(tz, now)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AnniversaryPrep;
    use chrono_tz::Asia::Shanghai;
    use chrono_tz::Europe::London;

    fn ms(tz: &chrono_tz::Tz, y: i32, mo: u32, d: u32, h: u32, mi: u32) -> Millis {
        tz.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
    }

    fn shared(uid: &str, item: Item) -> Shared {
        Shared { uid: uid.into(), item }
    }

    fn samples(now: Millis) -> Vec<Shared> {
        vec![
            shared(
                "a1",
                Item::Alarm(SharedAlarm {
                    label: "Get up, now; really".into(),
                    repeat: Repeat::Weekdays,
                    time: Some("07:30".into()),
                    important: true,
                    auto_snooze: true,
                    ..SharedAlarm::default()
                }),
            ),
            shared(
                "a2",
                Item::Alarm(SharedAlarm {
                    label: "Video call".into(),
                    at: Some(now + 3_600_000),
                    ..SharedAlarm::default()
                }),
            ),
            shared(
                "t1",
                Item::Todo(SharedTodo {
                    title: "Bins".into(),
                    day: Some("2026-11-03".into()),
                    repeat: TodoRepeat::Weekly,
                    at: None,
                }),
            ),
            shared(
                "n1",
                Item::Anniversary(NewAnniversary {
                    kind: "wedding".into(),
                    icon: "💍".into(),
                    name: "结婚纪念日 — a long name that goes past the seventy-five octets of a line".into(),
                    month: 8,
                    day: 15,
                    since: Some(2012),
                    preps: vec![AnniversaryPrep { lead: "1w".into(), label: "订餐厅".into() }],
                    effect: true,
                    music: Some("wedding".into()),
                    calendar: Calendar::Lunar,
                    ..NewAnniversary::default()
                }),
            ),
        ]
    }

    #[test]
    fn what_epet_writes_it_reads_back_the_same() {
        let now = ms(&Shanghai, 2026, 10, 27, 9, 0);
        let items = samples(now);
        let text = write(&Shanghai, "Asia/Shanghai", &items, now);
        assert!(text.lines().all(|l| l.len() <= 76), "folded");
        assert!(text.contains("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"));
        assert!(text.contains("SUMMARY:Get up\\, now\\; really"));
        let back = read(&Shanghai, &text, now).unwrap();
        assert_eq!(
            back.items,
            items.iter().map(|s| Shared { uid: s.uid.clone(), item: s.item.normalized() }).collect::<Vec<_>>()
        );
        assert_eq!(back.tz.as_deref(), Some("Asia/Shanghai"));
        assert_eq!(back.offset, Some(480));
        assert_eq!(back.skipped, 0);
    }

    #[test]
    fn a_lunar_anniversary_is_written_as_its_dates_for_calendars() {
        let now = ms(&Shanghai, 2026, 10, 27, 9, 0);
        let text = write(&Shanghai, "", &samples(now)[3..], now);
        // 八月十五: 2027-09-15 next (2026's, Sep 25, has passed).
        assert!(text.contains("DTSTART;VALUE=DATE:20270915"), "{text}");
        let unfolded = unfold(&text).join("\n");
        let rdate = unfolded.lines().find(|l| l.starts_with("RDATE")).unwrap();
        assert_eq!(rdate.split(',').count(), 19);
        assert!(rdate.contains("20281003"));
    }

    #[test]
    fn a_phones_calendar_becomes_alarms_to_dos_and_anniversaries() {
        let now = ms(&London, 2026, 10, 27, 9, 0);
        let text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/London\r\nBEGIN:STANDARD\r\nDTSTART:19701025T020000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n\
BEGIN:VEVENT\r\nUID:bday@phone\r\nSUMMARY:Mum's birthday\r\nDTSTART;VALUE=DATE:19600312\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:dentist\r\nSUMMARY:Dentist\r\nDTSTART;TZID=Europe/London:20261103T143000\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nSUMMARY:not this\r\nEND:VALARM\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:gym\r\nSUMMARY:Gym\r\nDTSTART:20261028T070000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Stand-up\r\nDTSTART:20261028T093000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:mothers\r\nSUMMARY:Mother's Day\r\nDTSTART;VALUE=DATE:20270509\r\nRRULE:FREQ=YEARLY;BYMONTH=5;BYDAY=2SU\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:past\r\nSUMMARY:Last year's party\r\nDTSTART:20251001T200000Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261227\r\nEND:VEVENT\r\n\
BEGIN:VTODO\r\nUID:rent\r\nSUMMARY:Pay rent\r\nDUE;VALUE=DATE:20261101\r\nRRULE:FREQ=MONTHLY\r\nEND:VTODO\r\n\
BEGIN:VTODO\r\nUID:done\r\nSUMMARY:Done already\r\nSTATUS:COMPLETED\r\nEND:VTODO\r\n\
END:VCALENDAR\r\n";
        let p = read(&London, text, now).unwrap();
        assert_eq!(p.skipped, 2, "the past one and the completed one");
        let by = |uid: &str| p.items.iter().find(|s| s.uid == uid).map(|s| s.item.clone());
        let Some(Item::Anniversary(b)) = by("bday@phone") else { panic!() };
        assert_eq!((b.kind.as_str(), b.month, b.day, b.since), ("birthday", 3, 12, Some(1960)));
        assert_eq!(
            by("dentist"),
            Some(Item::Alarm(SharedAlarm {
                label: "Dentist".into(),
                at: Some(ms(&London, 2026, 11, 3, 14, 30)),
                ..Default::default()
            }))
        );
        let Some(Item::Alarm(g)) = by("gym") else { panic!() };
        assert_eq!((g.repeat, g.days, g.time.as_deref()), (Repeat::Days, 0b010_1010, Some("07:00")));
        let Some(Item::Alarm(s)) = by("standup") else { panic!() };
        assert_eq!((s.repeat, s.time.as_deref()), (Repeat::Weekdays, Some("09:30")));
        let Some(Item::Anniversary(m)) = by("mothers") else { panic!() };
        assert_eq!((m.calendar, m.month, m.nth, m.weekday), (Calendar::Weekday, 5, Some(2), Some(0)));
        let holiday = p.items.iter().find(|s| matches!(&s.item, Item::Todo(t) if t.title == "Holiday")).unwrap();
        assert_eq!(holiday.uid.len(), 32, "made up, stable");
        assert_eq!(
            read(&London, text, now).unwrap().items.iter().find(|s| s.uid == holiday.uid).map(|s| s.uid.len()),
            Some(32)
        );
        assert_eq!(
            by("rent"),
            Some(Item::Todo(SharedTodo {
                title: "Pay rent".into(),
                day: Some("2026-11-01".into()),
                repeat: TodoRepeat::Monthly,
                at: None
            }))
        );
    }

    #[test]
    fn not_a_calendar_is_none() {
        assert_eq!(read(&London, "hello", 0), None);
        assert!(read(&London, "\u{feff}BEGIN:VCALENDAR\nEND:VCALENDAR\n", 0).is_some());
    }
}
