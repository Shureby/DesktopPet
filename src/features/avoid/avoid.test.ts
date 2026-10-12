import { describe, expect, it } from "vitest";
import { mergeSettings } from "../../platform/types";
import { avoidSettings, CATCH_UP_MS, catchUp, DEFAULT_AVOID, focusTonesAway, othersPresent, outOfTheSlideShow } from "./avoid";

describe("stepping aside", () => {
  it("reads the settings, filling in what's missing", () => {
    expect(avoidSettings(undefined)).toEqual(DEFAULT_AVOID);
    expect(avoidSettings({ calls: false, alwaysHide: true, fullscreen: "yes" })).toEqual({
      ...DEFAULT_AVOID,
      calls: false,
      alwaysHide: true,
    });
    expect(mergeSettings({}).avoid).toEqual(DEFAULT_AVOID);
    expect(mergeSettings({ avoid: { presenting: false } as never }).avoid.presenting).toBe(false);
  });

  it("focus sounds play during a game or a video, not with others watching", () => {
    for (const reason of ["call", "presenting"] as const) {
      expect(othersPresent(reason)).toBe(true);
      expect(focusTonesAway(reason)).toBe(false);
    }
    expect(othersPresent("fullscreen")).toBe(false);
    expect(focusTonesAway("fullscreen")).toBe(true);
  });

  it("back within 15 minutes what was held rings, alarms before to-dos; older is missed", () => {
    const now = 1_000_000_000;
    const held = [
      { item: "todo", at: now - 60_000, todo: true },
      { item: "late alarm", at: now - 60_000, todo: false },
      { item: "old timer", at: now - CATCH_UP_MS - 1, todo: false },
      { item: "alarm", at: now - CATCH_UP_MS, todo: false },
    ];
    const { ring, missed } = catchUp(held, now);
    expect(ring.map((h) => h.item)).toEqual(["alarm", "late alarm", "todo"]);
    expect(missed.map((h) => h.item)).toEqual(["old timer"]);
    expect(catchUp([], now)).toEqual({ ring: [], missed: [] });
  });

  it("an important alarm during a slide show brings the pet out on the presenter's screen", () => {
    const left = { x: 0, y: 0, w: 1920, h: 1040 };
    const right = { x: 1920, y: 0, w: 1920, h: 1040 };
    const slides = [{ x: 1920, y: 0, w: 1920, h: 1080 }];
    expect(outOfTheSlideShow([left, right], 1, slides)).toBe(0);
    expect(outOfTheSlideShow([left, right], 0, slides)).toBe(0);
    // One screen, or slides everywhere: where it is.
    expect(outOfTheSlideShow([right], 0, slides)).toBe(0);
    expect(outOfTheSlideShow([left, right], 1, [...slides, { x: 0, y: 0, w: 1920, h: 1080 }])).toBe(1);
    expect(outOfTheSlideShow([left, right], 1, [])).toBe(1);
  });
});
