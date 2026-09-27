/**
 * The pet's mood: affection and fullness, both 0..100, saved per character.
 *
 * Mood only changes flavour (animations, lines, how eager the pet is), never
 * usefulness: reminders and alarms always get through. It only decays while the
 * app is running, so the pet isn't miserable after a weekend away.
 */
export interface Mood {
  affection: number;
  fullness: number;
  /** Rolling one-hour window limiting how much petting can add. */
  petWindow: { start: number; gained: number };
}

export type MoodTier = "adoring" | "content" | "grumpy" | "sulking";

export type MoodEvent =
  | "pet"
  | "feed"
  | "todoDone"
  | "focusDone"
  | "game"
  | "thrown";

export const MOOD = {
  start: 50,
  /** Affection lost per hour of app time (about 1 per 30 minutes). */
  affectionDecayPerHour: 2,
  /** Hungry pets lose affection this many times faster. */
  hungryDecayMultiplier: 2,
  /** Fullness drains from 100 to 0 in about 6 hours of app time. */
  fullnessDecayPerHour: 100 / 6,
  hungryBelow: 30,
  petGain: 3,
  petCapPerHour: 15,
  feedFullness: 40,
  feedAffection: 2,
  /** Feeding a pet this full makes it refuse the food. */
  fullAbove: 90,
  gains: { todoDone: 2, focusDone: 5, game: 3, thrown: -2 },
} as const;

export function defaultMood(now = Date.now()): Mood {
  return { affection: MOOD.start, fullness: 70, petWindow: { start: now, gained: 0 } };
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));

export function isHungry(m: Mood): boolean {
  return m.fullness < MOOD.hungryBelow;
}

export function moodTier(m: Mood): MoodTier {
  if (m.affection >= 80) return "adoring";
  if (m.affection >= 50) return "content";
  if (m.affection >= 25) return "grumpy";
  return "sulking";
}

/** Passive decay for `dtSeconds` of app time. */
export function decayMood(m: Mood, dtSeconds: number): void {
  const hours = dtSeconds / 3600;
  m.fullness = clamp(m.fullness - MOOD.fullnessDecayPerHour * hours);
  const rate = MOOD.affectionDecayPerHour * (isHungry(m) ? MOOD.hungryDecayMultiplier : 1);
  m.affection = clamp(m.affection - rate * hours);
}

/**
 * Applies something the user did. Returns what happened so the pet can react
 * (e.g. "full" when it refuses food, "capped" when petting no longer helps).
 */
export function applyMoodEvent(m: Mood, e: MoodEvent, now = Date.now()): "ok" | "full" | "capped" {
  switch (e) {
    case "pet": {
      if (now - m.petWindow.start >= 3_600_000) m.petWindow = { start: now, gained: 0 };
      const gain = Math.min(MOOD.petGain, MOOD.petCapPerHour - m.petWindow.gained);
      if (gain <= 0) return "capped";
      m.petWindow.gained += gain;
      m.affection = clamp(m.affection + gain);
      return "ok";
    }
    case "feed":
      if (m.fullness > MOOD.fullAbove) return "full";
      m.fullness = clamp(m.fullness + MOOD.feedFullness);
      m.affection = clamp(m.affection + MOOD.feedAffection);
      return "ok";
    default:
      m.affection = clamp(m.affection + MOOD.gains[e]);
      return "ok";
  }
}

/** Accepts mood saved by any version, falling back to defaults for bad data. */
export function parseMood(raw: unknown, now = Date.now()): Mood {
  const d = defaultMood(now);
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<Mood>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? clamp(v) : fallback);
  return {
    affection: num(r.affection, d.affection),
    fullness: num(r.fullness, d.fullness),
    petWindow:
      r.petWindow && typeof r.petWindow.start === "number" && typeof r.petWindow.gained === "number"
        ? { start: r.petWindow.start, gained: r.petWindow.gained }
        : d.petWindow,
  };
}
