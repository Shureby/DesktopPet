import type { Alarm } from "../../platform/types";

/**
 * Timers are one-shot alarms whose label starts with this prefix; they get a
 * countdown badge next to the pet and a "Cancel timer" menu item.
 */
export const TIMER_PREFIX = "Timer: ";

/** Built-in timer lengths (minutes) offered in the menu and the panel. */
export const PRESET_MINUTES = [1, 5, 10, 15, 30, 45, 60];
/** How many custom timer lengths are remembered. */
export const MAX_RECENT_TIMERS = 3;

export function timerLabel(minutes: number): string {
  return `${TIMER_PREFIX}${formatDuration(minutes)}`;
}

/** "45 min", "1 hour", "1 h 30 min", "1 min 30 s", "90 s"… (accepts fractional minutes). */
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes * 60);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h === 0 && m === 0) return `${sec} s`;
  if (h === 0) return sec ? `${m} min ${sec} s` : `${m} min`;
  const parts = [h === 1 && !m && !sec ? "1 hour" : m || sec ? `${h} h` : `${h} hours`];
  if (m) parts.push(`${m} min`);
  if (sec) parts.push(`${sec} s`);
  return parts.join(" ");
}

/**
 * Parses what the user types for a custom timer, in minutes (null if invalid):
 * "20" (minutes), "1:30" (h:mm), "90s", "1m30s", "1h30m", "1h 30", "2.5h", "45 min".
 * Between 5 seconds and 24 hours.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return null;
  let minutes: number | null = null;
  const clockLike = text.match(/^(\d{1,2}):(\d{2})$/);
  if (clockLike) {
    const m = Number(clockLike[2]);
    if (m < 60) minutes = Number(clockLike[1]) * 60 + m;
  } else if (/^\d+(\.\d+)?$/.test(text)) {
    minutes = Number(text);
  } else {
    const unit = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)?(?=\s|\d|$)/g;
    let rest = text;
    let sum = 0;
    let matched = false;
    for (const [whole, num, u] of text.matchAll(unit)) {
      const n = Number(num);
      const kind = u?.[0];
      // A bare number after hours means minutes ("1h 30").
      sum += kind === "h" ? n * 60 : kind === "s" ? n / 60 : n;
      matched = true;
      rest = rest.replace(whole, "");
    }
    if (matched && rest.trim() === "") minutes = sum;
  }
  if (minutes === null || !Number.isFinite(minutes)) return null;
  return minutes >= 5 / 60 && minutes <= 24 * 60 ? Math.round(minutes * 60) / 60 : null;
}

/**
 * Remembers a custom timer length: most recent first, at most three, no
 * duplicates, and never a length that is already a preset.
 */
export function rememberCustomTimer(recent: number[], minutes: number, presets = PRESET_MINUTES): number[] {
  if (presets.includes(minutes)) return recent;
  return [minutes, ...recent.filter((m) => m !== minutes)].slice(0, MAX_RECENT_TIMERS);
}

/**
 * Edits one saved custom length in place ("✎"): `previous` becomes `minutes` at the same
 * position. If the new length is a preset or already saved, the slot is simply dropped.
 */
export function replaceCustomTimer(recent: number[], previous: number, minutes: number, presets = PRESET_MINUTES): number[] {
  const i = recent.indexOf(previous);
  if (i < 0) return rememberCustomTimer(recent, minutes, presets);
  if (presets.includes(minutes) || (minutes !== previous && recent.includes(minutes))) return recent.filter((m) => m !== previous);
  return recent.map((m, j) => (j === i ? minutes : m));
}

/** Removes a saved custom length ("✕"). */
export function forgetCustomTimer(recent: number[], minutes: number): number[] {
  return recent.filter((m) => m !== minutes);
}

/** A compact, re-parseable form for pre-filling an input: 20 → "20", 90 → "1h30m", 1.5 → "1m30s". */
export function durationInput(minutes: number): string {
  const total = Math.round(minutes * 60);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (!h && !s) return String(m);
  return (h ? `${h}h` : "") + (m ? `${m}m` : "") + (s ? `${s}s` : "");
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
