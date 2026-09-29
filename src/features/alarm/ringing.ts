import type { Alarm, AlertSettings } from "../../platform/types";
import { isTimer, timerName, timerStartedAt } from "./timers";

/**
 * What happens when an alarm or timer rang for its full time and nobody pressed
 * Snooze or Done:
 * - alarms snooze themselves a few times (you might just be away), then count as missed;
 * - timers don't snooze (a late "time's up" is useless): they're just done, quietly.
 */
export type Unanswered =
  | { action: "autoSnooze"; minutes: number; attempt: number; max: number }
  | { action: "missed" }
  | { action: "timerDone" };

export function onUnanswered(alarm: Alarm, s: AlertSettings): Unanswered {
  if (isTimer(alarm)) return { action: "timerDone" };
  if (alarm.snoozes < s.autoSnoozeMax) {
    return { action: "autoSnooze", minutes: s.snoozeMinutes, attempt: alarm.snoozes + 1, max: s.autoSnoozeMax };
  }
  return { action: "missed" };
}

/** A timer that finished while you were away; shown quietly for an hour. */
export interface DoneTimer {
  id: number;
  label: string;
  at: number;
}

export const DONE_TIMER_TTL_MS = 60 * 60_000;

export function visibleDoneTimers(list: DoneTimer[], now = Date.now()): DoneTimer[] {
  return list.filter((t) => now - t.at < DONE_TIMER_TTL_MS);
}

/** Alarms waiting to ring again after a snooze (not timers: those show as running timers). */
export function snoozedAlarms(alarms: Alarm[], now = Date.now()): (Alarm & { nextFire: number })[] {
  return alarms
    .filter((a): a is Alarm & { nextFire: number } => !isTimer(a) && a.enabled && a.snoozes > 0 && a.nextFire !== null && a.nextFire > now)
    .sort((a, b) => a.nextFire - b.nextFire);
}

/** Missed alarms the user hasn't seen yet (their badge by the pet); newest first. */
export function missedAlarms(alarms: Alarm[]): (Alarm & { missedAt: number })[] {
  return alarms
    .filter((a): a is Alarm & { missedAt: number } => a.missedAt !== null && !a.missedSeenAt)
    .sort((a, b) => b.missedAt - a.missedAt);
}

/**
 * Every time shown to the user goes through here: it follows the system's 12/24-hour
 * setting. Never put a formatted time into stored text (labels): it would stay in the
 * format of the day it was written.
 */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * "8:19 → 8:20 PM": a short time range for tight spaces (badge info). A shared AM/PM is
 * written once; "11:50 AM → 12:05 PM" keeps both; 24-hour clocks have none to share.
 */
export function timeRange(start: number, end: number): string {
  const a = clock(start);
  const b = clock(end);
  const suffix = /\s*[^\d\s:.]+$/.exec(a)?.[0];
  const shared = suffix && b.endsWith(suffix) ? a.slice(0, -suffix.length) : a;
  return `${shared} → ${b}`;
}

/** A running timer in the ⏱ badge's info: "12 min   8:10 → 8:22 PM" (or "12 min   rings 8:22 PM"). */
export function timerBadgeLine(a: Alarm & { nextFire: number }): string {
  const started = timerStartedAt(a);
  return `${timerName(a)}   ${started === null ? `rings ${clock(a.nextFire)}` : timeRange(started, a.nextFire)}`;
}

/** The label an alarm gets when the user doesn't name it; shown as "Alarm 9:40 PM". */
export const DEFAULT_ALARM_LABEL = "Alarm";

/**
 * The time the alarm is set for, the same through every snooze: a repeating alarm's time
 * of day (today), else the time its current ringing cycle began, else its next ring.
 */
export function alarmTime(a: Alarm, now = Date.now()): number | null {
  if (a.timeHm) {
    const [hh, mm] = a.timeHm.split(":").map(Number);
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  }
  const rung = a.rangAt !== null && (a.snoozes > 0 || a.nextFire === null || a.missedAt !== null);
  return rung ? a.rangAt : (a.nextFire ?? a.rangAt);
}

/** "Alarm 9:40 PM" for unnamed alarms, otherwise the user's own label ("Login CMC"). */
export function alarmName(a: Alarm): string {
  const label = a.label.trim();
  if (label && label !== DEFAULT_ALARM_LABEL) return label;
  const t = alarmTime(a);
  return t === null ? DEFAULT_ALARM_LABEL : `${DEFAULT_ALARM_LABEL} ${clock(t)}`;
}
