import { alarmTime, clock } from "../features/alarm/ringing";
import { isTimer, timerStartedAt } from "../features/alarm/timers";
import { EVERY_DAY, repeatMask, WEEKDAYS, type Alarm, type DayMask, type Repeat } from "../platform/types";
import { formatWhen } from "./dom";

/** The time the alarm is set for, shown big like a phone clock app (the same through snoozes). */
export function bigTime(a: Alarm): string {
  const t = alarmTime(a);
  return t === null ? "--:--" : clock(t);
}

/** When a finished item happened, for sorting: its own time, not a later snoozed ring. */
export function finishedAt(a: Alarm): number | null {
  return isTimer(a) ? (a.rangAt ?? a.missedAt) : (alarmTime(a) ?? a.missedAt);
}

/** "Started 4:29 PM · rings at 4:41 PM", so identical timers can be told apart. */
export function timerTimes(a: Alarm): string {
  const rings = a.nextFire ? `rings at ${clock(a.nextFire)}` : "";
  const started = timerStartedAt(a);
  if (started === null) return rings.replace(/^r/, "R");
  return rings ? `Started ${clock(started)} · ${rings}` : `Started ${clock(started)}`;
}

/**
 * "Missed · Today 9:40 PM · snoozed 3×", "Done · Today 12:42 PM" (timers),
 * "Rang · Yesterday 7:30 AM". Always the item's own time, not a later snoozed ring.
 */
export function finishedStatus(a: Alarm, now = Date.now()): string {
  const at = isTimer(a) ? a.rangAt : alarmTime(a, now);
  const word = a.missedAt ? "Missed" : isTimer(a) ? "Done" : "Rang";
  const parts = [word];
  if (at !== null) parts.push(formatWhen(at, now));
  else if (a.missedAt) parts.push(formatWhen(a.missedAt, now));
  if (a.snoozes > 0) parts.push(`snoozed ${a.snoozes}×`);
  return parts.join(" · ");
}

/**
 * The ring "Skip once" skips: "Sep 30 7:00 PM (Today)", "Oct 1 7:00 PM (Tomorrow)",
 * "Oct 5 7:00 PM (Monday)". The date and the day, so there's no doubt which ring it is.
 */
export function skipWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const day =
    d.toDateString() === new Date(now).toDateString()
      ? "Today"
      : d.toDateString() === new Date(now + 86_400_000).toDateString()
        ? "Tomorrow"
        : d.toLocaleDateString([], { weekday: "long" });
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(ms)} (${day})`;
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Every day", "Weekdays", "Weekends", "Mon, Wed, Fri" (Monday first); "No days" for none. */
export function daysText(mask: DayMask): string {
  const m = mask & EVERY_DAY;
  if (m === EVERY_DAY) return "Every day";
  if (m === WEEKDAYS) return "Weekdays";
  if (m === WEEKENDS) return "Weekends";
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => m & (1 << d)).map((d) => SHORT_DAYS[d]);
  return days.length ? days.join(", ") : "No days";
}

/** How an alarm repeats: "Once", "Every day", "Weekdays", "Mon, Wed, Fri". */
export function repeatText(a: Pick<Alarm, "repeat" | "repeatDays">): string {
  return a.repeat === "none" ? "Once" : daysText(repeatMask(a.repeat, a.repeatDays ?? 0));
}

/** What the New alarm "Repeat" menu offers. Weekends and custom days are saved as "days". */
export type RepeatChoice = "none" | "daily" | "weekdays" | "weekends" | "days";
export const WEEKENDS: DayMask = 0b100_0001;

/** The menu entry for a set of days picked by hand: Weekdays, Weekends, or Custom days. */
export function choiceForDays(mask: DayMask): "weekdays" | "weekends" | "days" {
  return mask === WEEKDAYS ? "weekdays" : mask === WEEKENDS ? "weekends" : "days";
}

/**
 * The days shown when a menu entry is chosen. Custom days start from what was shown (so
 * Weekdays can be tweaked), or today's weekday coming from Once or Every day.
 */
export function daysForChoice(choice: RepeatChoice, previous: RepeatChoice, days: DayMask, today: number): DayMask {
  if (choice === "weekdays") return WEEKDAYS;
  if (choice === "weekends") return WEEKENDS;
  if (choice === "days") return previous === "weekdays" || previous === "weekends" || previous === "days" ? days : 1 << today;
  return days;
}

/** Whether a menu entry shows the day picker (only those that pick days). */
export function showsDays(choice: RepeatChoice): boolean {
  return choice === "weekdays" || choice === "weekends" || choice === "days";
}

/** What is saved for a menu entry. */
export function repeatFor(choice: RepeatChoice, days: DayMask): { repeat: Repeat; days: DayMask } {
  if (choice === "weekends") return { repeat: "days", days: WEEKENDS };
  if (choice === "days") return { repeat: "days", days };
  return { repeat: choice, days: 0 };
}