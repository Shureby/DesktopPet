import { describe, expect, it } from "vitest";
import { mergeSettings } from "../../platform/types";
import { avoidSettings, awayAction, DEFAULT_AVOID, focusTonesAway, othersPresent } from "./avoid";

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

  it("during a game or video alarms and timers ring; with others watching nothing does", () => {
    expect(awayAction("fullscreen", "alarm")).toBe("ring");
    expect(awayAction("fullscreen", "timer")).toBe("ring");
    expect(awayAction("fullscreen", "todo")).toBe("silent");
    for (const reason of ["call", "presenting"] as const) {
      expect(othersPresent(reason)).toBe(true);
      expect(awayAction(reason, "alarm")).toBe("silent");
      expect(awayAction(reason, "timer")).toBe("silent");
      expect(focusTonesAway(reason)).toBe(false);
    }
    expect(othersPresent("fullscreen")).toBe(false);
    expect(focusTonesAway("fullscreen")).toBe(true);
  });
});
