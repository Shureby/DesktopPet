/**
 * Rung late (docs/INTERACTIONS.md, "Rung late"): when an alarm, timer or to-do rings a minute
 * or more after it was meant to, the pet says when it was meant for, how late it is and why.
 */
import type { AvoidReason } from "../avoid/avoid";
import { clock } from "./ringing";

/**
 * Why it's late: the app's scheduler knows two (ePet wasn't running, the computer was
 * asleep); the pet knows the rest (stepped aside for this, another reminder was ringing).
 */
export type LateReason = "notRunning" | "asleep" | "queued" | AvoidReason;

/** A minute late or less is on time (the app looks every second, and nobody minds seconds). */
export const LATE_AFTER_MS = 60_000;

const WHY: Record<LateReason, string> = {
  notRunning: "ePet wasn't running",
  asleep: "the computer was asleep",
  queued: "another reminder was ringing",
  fullscreen: "an app was full screen",
  presenting: "you were presenting",
  call: "you were in a call",
};

/** "7 min", "1 h", "1 h 5 min". */
export function lateBy(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export type LateKind = "alarm" | "timer" | "todo" | "day";

export interface Late {
  /** "Due 4:30 PM · 7 min late", "Ran out at 4:30 PM · 7 min ago", "Meant for 9:00 AM". */
  what: string;
  /** "7 min" (in a list of several: "• Laundry (7 min late)"). */
  by: string;
  /** "you were presenting" (none for a day's to-do, or when the app doesn't know). */
  why: string | null;
}

/**
 * How late, or null when it's on time. A day's to-do only says the time it was meant for (it
 * reminds any time that day).
 */
export function lateness(kind: LateKind, dueAt: number | undefined, now: number, reason?: LateReason | null): Late | null {
  if (!dueAt || now - dueAt < LATE_AFTER_MS) return null;
  const by = lateBy(now - dueAt);
  const at = clock(dueAt);
  if (kind === "day") return { what: `Meant for ${at}`, by, why: null };
  const what = kind === "timer" ? `Ran out at ${at} · ${by} ago` : `Due ${at} · ${by} late`;
  return { what, by, why: reason ? WHY[reason] : null };
}

/** The bubble's small line: "Due 4:30 PM · 7 min late — you were presenting". */
export function lateNote(late: Late): string {
  return late.why ? `${late.what} — ${late.why}` : late.what;
}
