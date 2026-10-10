/**
 * Stepping aside (docs/INTERACTIONS.md, "Stepping aside"): while an app covers the pet's
 * screen, a slide show runs, or a camera or the microphone is in use, the pet leaves the
 * screen and comes back about 10 s after that's over. The app watches for these
 * (src-tauri/src/avoid.rs); this decides what the pet does about what comes due meanwhile.
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

/** Others may see or hear your screen: only important alarms ring, and ePet hides from capture. */
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
 * Something came due while the pet is aside and didn't bring it out (only important alarms
 * do): during a game or a video, alarms and timers ring (softly at first) and can be
 * answered once you're back; with others watching or listening, nothing rings. Either way
 * what isn't answered (and every to-do) is in "While you were busy you missed…".
 */
export function awayAction(reason: AvoidReason, kind: "alarm" | "timer" | "todo"): "ring" | "silent" {
  return kind !== "todo" && reason === "fullscreen" ? "ring" : "silent";
}

/** Focus and break start sounds: during a game or a video yes, with others listening no. */
export function focusTonesAway(reason: AvoidReason): boolean {
  return !othersPresent(reason);
}
