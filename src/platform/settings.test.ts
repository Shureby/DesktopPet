import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "./types";

describe("mergeSettings", () => {
  it("fills defaults for settings saved before alerts existed", () => {
    const old = { character: "rooster", sound: false, pomodoro: { focusMin: 50 } } as unknown as Partial<Settings>;
    const s = mergeSettings(old);
    expect(s.character).toBe("rooster");
    expect(s.pomodoro.focusMin).toBe(50);
    expect(s.pomodoro.shortBreakMin).toBe(DEFAULT_SETTINGS.pomodoro.shortBreakMin);
    expect(s.alerts).toEqual(DEFAULT_SETTINGS.alerts);
  });

  it("keeps partial alert settings and fills the rest", () => {
    const s = mergeSettings({ alerts: { alarm: { ringtone: "rooster" } } } as unknown as Partial<Settings>);
    expect(s.alerts.alarm).toEqual({ ...DEFAULT_SETTINGS.alerts.alarm, ringtone: "rooster" });
    expect(s.alerts.todo).toEqual(DEFAULT_SETTINGS.alerts.todo);
  });

  it("handles missing settings", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});
