import { alarmTime, clock } from "../features/alarm/ringing";
import { isTimer, timerStartedAt } from "../features/alarm/timers";
import type { Alarm } from "../platform/types";
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
