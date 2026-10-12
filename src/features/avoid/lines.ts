/**
 * What the pet says when it steps aside and when it's back (docs/INTERACTIONS.md, "Stepping
 * aside"). Leaving it says why; back, with nothing to tell (no reminder to ring, nothing
 * missed), it chats about what you were doing — after 2 minutes away or more.
 */
import type { AvoidReason } from "./avoid";

/** Away less than this: back without a word (a video leaving full screen for a moment). */
export const CHAT_AFTER_MS = 2 * 60_000;

/** Away this long or more: the "long" lines. */
const LONG_MS: Record<AvoidReason, number> = {
  fullscreen: 60 * 60_000,
  presenting: 45 * 60_000,
  call: 60 * 60_000,
};

const LEAVING: Record<AvoidReason, string[]> = {
  fullscreen: [
    "Full screen? I'll get out of your way.",
    "Go on, I'll wait off-screen.",
    "Big screen time! I'll be just around the corner.",
  ],
  presenting: [
    "Presenting? Good luck! I'll keep out of sight.",
    "Showtime! I'll hide backstage.",
    "Knock 'em dead! I'll stay out of the slides.",
  ],
  call: [
    "You're on a call — I'll be quiet.",
    "Shh, meeting time. I'll tiptoe out.",
    "On a call? I'll wait outside.",
  ],
};

const BACK: Record<AvoidReason, { short: string[]; long: string[] }> = {
  fullscreen: {
    short: [
      "Are you playing games without me?",
      "What app needs the whole screen like that?",
      "Back from the big screen? I missed you.",
    ],
    long: [
      "That was a long game! Did you win?",
      "Whatever that was, it kept you busy for ages!",
      "Your eyes must be tired after all that. Blink with me!",
    ],
  },
  presenting: {
    short: [
      "How did the presentation go?",
      "Done presenting? I bet you were great.",
      "Slides all done? Nice work!",
    ],
    long: [
      "That was a long presentation you had there!",
      "What a marathon of slides! Time for a breather.",
      "All that talking — have some water!",
    ],
  },
  call: {
    short: [
      "Good call?",
      "All done talking? I kept quiet!",
      "Was that someone fun on the call?",
    ],
    long: [
      "Long meeting… stretch with me!",
      "That call went on forever! Need a break?",
      "Phew, what a long meeting. Time to move a little.",
    ],
  },
};

/** Shown again from the tray while it had stepped aside ("Show pet"). */
const SHOWN_ANYWAY = ["OK, I'm back!", "You called? Here I am!", "Back already? Hi again!"];

const pick = (lines: string[], random: () => number) => lines[Math.floor(random() * lines.length) % lines.length];

/** Leaving: why. */
export function leavingLine(reason: AvoidReason, random: () => number = Math.random): string {
  return pick(LEAVING[reason], random);
}

/**
 * Back with nothing else to tell: a line about what you were doing (null: away too briefly).
 * Shown anyway from the tray: it just says it's back.
 */
export function backLine(reason: AvoidReason, awayMs: number, shownAnyway: boolean, random: () => number = Math.random): string | null {
  if (shownAnyway) return pick(SHOWN_ANYWAY, random);
  if (awayMs < CHAT_AFTER_MS) return null;
  const lines = BACK[reason];
  return pick(awayMs >= LONG_MS[reason] ? lines.long : lines.short, random);
}

/** Every line, for the tests (each case has at least three). */
export const ALL_LINES = { LEAVING, BACK, SHOWN_ANYWAY };
