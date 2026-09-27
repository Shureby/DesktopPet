import type { Alarm, AlertSettings } from "../../platform/types";
import { isTimer } from "./timers";

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

export function missedAlarms(alarms: Alarm[]): (Alarm & { missedAt: number })[] {
  return alarms.filter((a): a is Alarm & { missedAt: number } => a.missedAt !== null).sort((a, b) => b.missedAt - a.missedAt);
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
