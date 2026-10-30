import { describe, expect, it } from "vitest";
import { allowedScreens, homeScreen, isLastScreen, nearestAllowed, screenNumbers, screensOf, walkHome, type ScreenInfo } from "./screens";

// The user's screens: 2 (portrait, the lowest bottom) | 1 (main) | 3 (the highest bottom).
const frames = [
  { x: 0, y: 0, w: 2560, h: 1440 },
  { x: -1080, y: -200, w: 1080, h: 1920 },
  { x: 2560, y: 100, w: 1920, h: 1080 },
];
const names = ["\\\\.\\DISPLAY1", "\\\\.\\DISPLAY2", "\\\\.\\DISPLAY3"];
const screens: ScreenInfo[] = frames.map((frame, i) => ({ id: `s${i}`, name: names[i], primary: i === 0, frame }));
const areas = frames.map((f) => ({ ...f, h: f.h - 40 }));

describe("screens the pet lives on", () => {
  it("numbers screens as Windows does, else main first then left to right", () => {
    expect(screenNumbers(screens)).toEqual(["1", "2", "3"]);
    const mac = screens.map((s) => ({ ...s, name: "" }));
    // No numbers in the names (macOS): main first, then left to right.
    expect(screenNumbers(mac)).toEqual(["1", "2", "3"]);
    // Screen 2 moved right of 3: numbered after it.
    const moved = mac.map((s, i) => (i === 1 ? { ...s, frame: { ...s.frame, x: 5000 } } : s));
    expect(screenNumbers(moved)).toEqual(["1", "3", "2"]);
  });

  it("all ticked by default; never none", () => {
    expect(allowedScreens(screens, [])).toEqual([true, true, true]);
    expect(allowedScreens(screens, ["s0"])).toEqual([false, true, true]);
    expect(allowedScreens(screens, ["s0", "s1", "s2"])).toEqual([true, true, true]);
    expect(isLastScreen(screens, ["s0", "s1"], "s2")).toBe(true);
    expect(isLastScreen(screens, ["s0"], "s2")).toBe(false);
  });

  it("starts on the main screen if ticked, else the first ticked", () => {
    expect(homeScreen(screens, [true, true, true])).toBe(0);
    expect(homeScreen(screens, [false, true, true])).toBe(1);
  });

  it("goes home on foot to a ticked screen next to it, the nearer side", () => {
    const home = [false, true, true];
    expect(walkHome(areas, home, 0, 300)).toEqual({ area: 1, side: "left", edge: 0 });
    expect(walkHome(areas, home, 0, 2400)).toEqual({ area: 2, side: "right", edge: 2560 });
    // Not next to it: it vanishes and appears on the nearest one.
    const far = [false, false, true];
    expect(walkHome(areas, far, 1, -500)).toBeNull();
    expect(nearestAllowed(areas, far, -500, 1700)).toBe(2);
  });

  it("makes screens up from the work areas when the snapshot has none", () => {
    const made = screensOf({ areas });
    expect(made.map((s) => s.primary)).toEqual([true, false, false]);
    expect(new Set(made.map((s) => s.id)).size).toBe(3);
  });
});
