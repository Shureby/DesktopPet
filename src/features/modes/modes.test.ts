import { describe, expect, it } from "vitest";
import { mergeSettings } from "../../platform/types";
import { DEFAULT_MODES, isDayOff, modeNow, modeSettings, rampVolume, scheduledMode, workSpan, type ModeSettings } from "./modes";

// 2026-10-05 is a Monday.
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
const modes = (patch: Partial<ModeSettings> = {}): ModeSettings => ({ ...structuredClone(DEFAULT_MODES), ...patch });

describe("reminder modes", () => {
  it("follows the default schedule: quiet nights, work hours on work days, normal otherwise", () => {
    const m = modes();
    expect(scheduledMode(m, at(5, 6, 59))).toBe("quiet"); // Monday early: Sunday's night (a day off: 23–8)
    expect(scheduledMode(m, at(5, 8, 30))).toBe("normal");
    expect(scheduledMode(m, at(5, 9, 0))).toBe("work");
    expect(scheduledMode(m, at(5, 17, 29))).toBe("work");
    expect(scheduledMode(m, at(5, 17, 30))).toBe("normal");
    expect(scheduledMode(m, at(5, 22, 0))).toBe("quiet");
    expect(scheduledMode(m, at(6, 6, 59))).toBe("quiet"); // Monday's night goes on into Tuesday
    expect(scheduledMode(m, at(6, 7, 0))).toBe("normal");
    // Saturday: no work; the night starts at 23:00 and Saturday morning is Friday's night.
    expect(scheduledMode(m, at(10, 6, 0))).toBe("quiet");
    expect(scheduledMode(m, at(10, 7, 30))).toBe("normal");
    expect(scheduledMode(m, at(10, 10, 0))).toBe("normal");
    expect(scheduledMode(m, at(10, 22, 30))).toBe("normal");
    expect(scheduledMode(m, at(10, 23, 0))).toBe("quiet");
  });

  it("a day off today, or a holiday, uses the days-off table", () => {
    expect(scheduledMode(modes({ dayOffOn: "2026-10-05" }), at(5, 10))).toBe("normal");
    expect(scheduledMode(modes({ dayOffOn: "2026-10-04" }), at(5, 10))).toBe("work");
    const holiday = modes({ holidayUntil: "2026-10-07" });
    expect(isDayOff(holiday, at(7, 0))).toBe(true);
    expect(isDayOff(holiday, at(8, 0))).toBe(false);
    expect(scheduledMode(holiday, at(8, 10))).toBe("work");
  });

  it("a mode picked by hand comes first, then one for a while, then the schedule", () => {
    expect(modeNow(modes({ choice: "lively" }), at(5, 10))).toEqual({ mode: "lively", why: "manual", until: null });
    const until = at(5, 11).getTime();
    expect(modeNow(modes({ override: { mode: "quiet", until } }), at(5, 10))).toEqual({ mode: "quiet", why: "override", until });
    // Run out: the schedule again.
    expect(modeNow(modes({ override: { mode: "quiet", until } }), at(5, 11, 1)).mode).toBe("work");
  });

  it("says when the schedule changes next", () => {
    expect(modeNow(modes(), at(5, 10)).until).toBe(at(5, 17, 30).getTime());
    expect(modeNow(modes(), at(5, 23)).until).toBe(at(6, 7).getTime());
    // Friday 17:30 → Friday 22:00 (quiet), then Saturday until 08:00.
    expect(modeNow(modes(), at(9, 18)).until).toBe(at(9, 22).getTime());
    // No slots: Normal for good.
    expect(modeNow(modes({ workday: [], dayOff: [] }), at(5, 10)).until).toBeNull();
  });

  it("where slots overlap the quieter wins", () => {
    const m = modes({ workday: [{ start: "09:00", end: "17:00", mode: "work" }, { start: "12:00", end: "13:00", mode: "quiet" }, { start: "16:00", end: "20:00", mode: "lively" }] });
    expect(scheduledMode(m, at(5, 12, 30))).toBe("quiet");
    expect(scheduledMode(m, at(5, 16, 30))).toBe("work");
    expect(scheduledMode(m, at(5, 18))).toBe("lively");
  });

  it("settings from before 0.37 become slots: Quiet hours on both tables, work hours on their days", () => {
    const old = { quietHours: { enabled: true, start: "21:30", end: "06:30" }, pomodoro: { workHours: { enabled: true, days: 0b001_1110, start: "08:00", end: "16:00" } } };
    const m = modeSettings(undefined, old);
    expect(m.workDays).toBe(0b001_1110);
    expect(m.workday).toEqual([
      { start: "21:30", end: "06:30", mode: "quiet" },
      { start: "08:00", end: "16:00", mode: "work" },
    ]);
    expect(m.dayOff).toEqual([{ start: "21:30", end: "06:30", mode: "quiet" }]);
    expect(m.choice).toBe("auto");
    // Only Quiet hours: no Work slot.
    expect(modeSettings(undefined, { quietHours: old.quietHours }).workday).toEqual([{ start: "21:30", end: "06:30", mode: "quiet" }]);
    // Neither: the default schedule.
    expect(modeSettings(undefined, { quietHours: { enabled: false } })).toEqual(DEFAULT_MODES);
    expect(mergeSettings(old as never).modes.workday).toHaveLength(2);
  });

  it("cleans what's stored: bad slots dropped, presets filled in and kept in range", () => {
    const m = modeSettings({
      choice: "loud",
      workday: [{ start: "9:00", end: "17:00", mode: "work" }, { start: "09:00", end: "10:00", mode: "nap" }, { start: "12:00", end: "13:00", mode: "quiet" }],
      presets: { work: { volume: 0.1, ringSeconds: -5 }, quiet: { calm: "yes" } },
      dayOffOn: "today",
    });
    expect(m.choice).toBe("auto");
    expect(m.workday).toEqual([{ start: "12:00", end: "13:00", mode: "quiet" }]);
    expect(m.dayOff).toEqual(DEFAULT_MODES.dayOff);
    expect(m.presets.work.volume).toBe(0.25);
    expect(m.presets.work.ringSeconds).toBe(0);
    expect(m.presets.work.petRuns).toBe(false);
    expect(m.presets.quiet.calm).toBe(true);
    expect(m.dayOffOn).toBeNull();
  });

  it("the Focus tab's work hours follow the Work slots", () => {
    expect(workSpan(modes())).toEqual({ days: 0b011_1110, start: "09:00", end: "17:30" });
    const two = modes({ workday: [{ start: "13:00", end: "18:00", mode: "work" }, { start: "08:30", end: "12:00", mode: "work" }] });
    expect(workSpan(two)).toEqual({ days: 0b011_1110, start: "08:30", end: "18:00" });
    expect(workSpan(modes({ workday: [] }))).toBeNull();
  });

  it("a ramped ring starts at a quarter and is full after 30 seconds", () => {
    expect(rampVolume(0.8, 0)).toBeCloseTo(0.2);
    expect(rampVolume(0.8, 15)).toBeCloseTo(0.5);
    expect(rampVolume(0.8, 30)).toBeCloseTo(0.8);
    expect(rampVolume(0.8, 90)).toBeCloseTo(0.8);
  });
});
