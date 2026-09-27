import { describe, expect, it } from "vitest";
import { applyMoodEvent, decayMood, defaultMood, isHungry, MOOD, moodTier, parseMood } from "./mood";

const HOUR = 3600;

describe("mood", () => {
  it("starts content at 50 affection", () => {
    const m = defaultMood(0);
    expect(m.affection).toBe(50);
    expect(moodTier(m)).toBe("content");
  });

  it("decays about 1 affection per 30 minutes, faster when hungry", () => {
    const fed = defaultMood(0);
    fed.fullness = 100;
    decayMood(fed, 0.5 * HOUR);
    expect(fed.affection).toBeCloseTo(49);

    const hungry = defaultMood(0);
    hungry.fullness = 10;
    decayMood(hungry, 0.5 * HOUR);
    expect(hungry.affection).toBeCloseTo(48);
  });

  it("gets hungry after a few hours of app time", () => {
    const m = defaultMood(0);
    m.fullness = 100;
    decayMood(m, 3 * HOUR);
    expect(isHungry(m)).toBe(false);
    decayMood(m, 2 * HOUR);
    expect(isHungry(m)).toBe(true);
  });

  it("caps affection gained from petting per hour", () => {
    const m = defaultMood(0);
    const results = Array.from({ length: 8 }, (_, i) => applyMoodEvent(m, "pet", i * 1000));
    expect(m.affection).toBe(50 + MOOD.petCapPerHour);
    expect(results.at(-1)).toBe("capped");
    // The window resets after an hour.
    expect(applyMoodEvent(m, "pet", HOUR * 1000 + 1)).toBe("ok");
    expect(m.affection).toBe(50 + MOOD.petCapPerHour + MOOD.petGain);
  });

  it("feeding fills up the pet; a full pet refuses food", () => {
    const m = defaultMood(0);
    m.fullness = 20;
    expect(applyMoodEvent(m, "feed")).toBe("ok");
    expect(m.fullness).toBe(60);
    m.fullness = 95;
    expect(applyMoodEvent(m, "feed")).toBe("full");
    expect(m.fullness).toBe(95);
  });

  it("using features raises affection, throwing lowers it", () => {
    const m = defaultMood(0);
    applyMoodEvent(m, "focusDone");
    applyMoodEvent(m, "todoDone");
    applyMoodEvent(m, "game");
    applyMoodEvent(m, "thrown");
    expect(m.affection).toBe(50 + 5 + 2 + 3 - 2);
  });

  it("maps affection to tiers and stays within 0..100", () => {
    const m = defaultMood(0);
    for (const [a, tier] of [[90, "adoring"], [60, "content"], [30, "grumpy"], [10, "sulking"]] as const) {
      m.affection = a;
      expect(moodTier(m)).toBe(tier);
    }
    m.affection = 99;
    applyMoodEvent(m, "focusDone");
    expect(m.affection).toBe(100);
  });

  it("parses saved mood defensively", () => {
    expect(parseMood(null, 0)).toEqual(defaultMood(0));
    expect(parseMood({ affection: 999, fullness: "x" }, 0)).toEqual({ ...defaultMood(0), affection: 100 });
  });
});
