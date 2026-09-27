import type { Alarm } from "../../platform/types";

/**
 * Timers are one-shot alarms whose label starts with this prefix; they get a
 * countdown badge next to the pet and a "Cancel timer" menu item.
 */
export const TIMER_PREFIX = "Timer: ";

export function timerLabel(minutes: number): string {
  return `${TIMER_PREFIX}${formatDuration(minutes)}`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : h === 1 ? "1 hour" : `${h} hours`;
}

export function isTimer(a: Alarm): boolean {
  return a.label.startsWith(TIMER_PREFIX) && a.repeat === "none";
}

/** Running timers, soonest first. */
export function activeTimers(alarms: Alarm[], now = Date.now()): (Alarm & { nextFire: number })[] {
  return alarms
    .filter((a): a is Alarm & { nextFire: number } => isTimer(a) && a.enabled && a.nextFire !== null && a.nextFire > now)
    .sort((a, b) => a.nextFire - b.nextFire);
}
