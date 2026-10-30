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

  it("shows upcoming alarms by default and keeps the look-ahead within 1–120 minutes", () => {
    expect(mergeSettings({}).upcomingAlarms).toEqual({ show: true, minutes: 60 });
    const m = (minutes: unknown) => mergeSettings({ upcomingAlarms: { show: false, minutes } } as unknown as Partial<Settings>).upcomingAlarms;
    expect(m(30)).toEqual({ show: false, minutes: 30 });
    expect(m(0).minutes).toBe(1);
    expect(m(500).minutes).toBe(120);
    expect(m("abc").minutes).toBe(60);
  });

  it("keeps anniversary music off by default and its volume within 0–1", () => {
    // Saved by 0.26/0.27: no music fields yet.
    const old = mergeSettings({ celebrate: { enabled: false, seconds: 30 } } as unknown as Partial<Settings>);
    expect(old.celebrate).toEqual({ enabled: false, seconds: 30, music: false, musicVolume: 0.5 });
    const c = (musicVolume: unknown) =>
      mergeSettings({ celebrate: { enabled: true, seconds: 15, music: true, musicVolume } } as unknown as Partial<Settings>).celebrate;
    expect(c(0.2)).toEqual({ enabled: true, seconds: 15, music: true, musicVolume: 0.2 });
    expect(c(3).musicVolume).toBe(1);
    expect(c("x").musicVolume).toBe(0.5);
  });

  it("gives focus sessions their own sounds; “Other sounds” off before 0.36 keeps them silent", () => {
    expect(mergeSettings({}).pomodoro.sounds).toEqual({ focus: "fieldPhone", break: "trill", volume: 0.5 });
    expect(mergeSettings({ sound: false }).pomodoro.sounds).toEqual({ focus: "off", break: "off", volume: 0.5 });
    const kept = mergeSettings({ sound: false, pomodoro: { sounds: { focus: "digital", break: "nope", volume: 7 } } } as unknown as Partial<Settings>);
    expect(kept.pomodoro.sounds).toEqual({ focus: "digital", break: "trill", volume: 1 });
  });

  it("handles missing settings", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});
