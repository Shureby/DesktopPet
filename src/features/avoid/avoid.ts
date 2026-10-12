import type { Rect } from "../../engine/geometry";

/**
 * Stepping aside (docs/INTERACTIONS.md, "Stepping aside"): while an app covers the pet's
 * screen, a slide show runs, or a camera or the microphone is in use, the pet leaves the
 * screen and comes back about 10 s after that's over. The app watches for these
 * (src-tauri/src/avoid.rs). Wherever something rings, the pet is there: only an important
 * alarm brings it out meanwhile; the rest waits for you to be back (`catchUp`).
 */

/** Why the pet stepped aside. */
export type AvoidReason = "fullscreen" | "presenting" | "call";

/** Settings → Modes → "Step aside automatically". */
export interface AvoidSettings {
  /** Full-screen apps: games, videos, a browser on F11. */
  fullscreen: boolean;
  /** Slide shows (PowerPoint, Keynote). */
  presenting: boolean;
  /** Video calls: a camera or the microphone in use. */
  calls: boolean;
  /** Leave ePet out of screenshots and recordings always (not only during calls and slide shows). */
  alwaysHide: boolean;
}

export const DEFAULT_AVOID: AvoidSettings = { fullscreen: true, presenting: true, calls: true, alwaysHide: false };

/** What you're doing, as the app sees it (test builds can pretend). */
export interface Busy {
  fullscreen: boolean;
  presenting: boolean;
  call: boolean;
}

export const NOT_BUSY: Busy = { fullscreen: false, presenting: false, call: false };

/** The settings as stored (missing or odd values: the defaults). */
export function avoidSettings(stored: unknown): AvoidSettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const flag = (k: keyof AvoidSettings) => (typeof s[k] === "boolean" ? (s[k] as boolean) : DEFAULT_AVOID[k]);
  return { fullscreen: flag("fullscreen"), presenting: flag("presenting"), calls: flag("calls"), alwaysHide: flag("alwaysHide") };
}

/** Others may see or hear your screen: ePet hides from capture, and no focus sounds. */
export function othersPresent(reason: AvoidReason): boolean {
  return reason !== "fullscreen";
}

/** "in a call": the tray's "Stepped aside: in a call". */
export const AVOID_LABELS: Record<AvoidReason, string> = {
  fullscreen: "full screen",
  presenting: "presenting",
  call: "in a call",
};

/**
 * Held while the pet is aside this long at most: back sooner, what came due rings then (with
 * the pet); later, it's missed (a timer is just done) and listed in "While you were busy…".
 */
export const CATCH_UP_MS = 15 * 60_000;

/** Something that came due while the pet was aside and didn't bring it out (only important alarms do). */
export interface Held<T> {
  item: T;
  /** When it came due. */
  at: number;
  todo: boolean;
}

/**
 * Back: what was held rings now, alarms and timers first (to-dos are told after them), each
 * kind in the order it came due; what waited longer than CATCH_UP_MS is missed.
 */
export function catchUp<T>(held: Held<T>[], now: number): { ring: Held<T>[]; missed: Held<T>[] } {
  const byTime = [...held].sort((a, b) => a.at - b.at);
  const fresh = byTime.filter((h) => now - h.at <= CATCH_UP_MS);
  return {
    ring: [...fresh.filter((h) => !h.todo), ...fresh.filter((h) => h.todo)],
    missed: byTime.filter((h) => now - h.at > CATCH_UP_MS),
  };
}

/**
 * An important alarm while a slide show runs: the pet comes out on a screen without it (the
 * presenter's), if the one it's on shows the slides. Returns the area's index.
 */
export function outOfTheSlideShow(areas: Rect[], current: number, slideshows: Rect[]): number {
  const showing = (a: Rect) => {
    const [x, y] = [a.x + a.w / 2, a.y + a.h / 2];
    return slideshows.some((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);
  };
  if (!areas[current] || !showing(areas[current])) return current;
  const other = areas.findIndex((a) => !showing(a));
  return other >= 0 ? other : current;
}

/** Focus and break start sounds: during a game or a video yes, with others listening no. */
export function focusTonesAway(reason: AvoidReason): boolean {
  return !othersPresent(reason);
}
