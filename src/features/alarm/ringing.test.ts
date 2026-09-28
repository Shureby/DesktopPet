import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Alarm } from "../../platform/types";
import { alarmName, alarmTime, clock, missedAlarms, onUnanswered, snoozedAlarms, visibleDoneTimers } from "./ringing";

const alarm = (over: Partial<Alarm> = {}): Alarm => ({
  id: 1,
  label: "Wake up",
  nextFire: null,
  timeHm: "07:00",
  repeat: "daily",
  enabled: true,
  snoozes: 0,
  missedAt: null,
  missedSeenAt: null,
  rangAt: null,
  createdAt: null,
  ...over,
});
const s = DEFAULT_SETTINGS.alerts.alarm;

describe("unanswered alarms", () => {
  it("auto-snoozes an alarm up to the limit, then marks it missed", () => {
    expect(onUnanswered(alarm(), s)).toEqual({ action: "autoSnooze", minutes: 5, attempt: 1, max: 3 });
    expect(onUnanswered(alarm({ snoozes: 2 }), s)).toMatchObject({ action: "autoSnooze", attempt: 3 });
    expect(onUnanswered(alarm({ snoozes: 3 }), s)).toEqual({ action: "missed" });
  });

  it("goes straight to missed when auto-snooze is off", () => {
    expect(onUnanswered(alarm(), { ...s, autoSnoozeMax: 0 })).toEqual({ action: "missed" });
  });

  it("never snoozes timers", () => {
    expect(onUnanswered(alarm({ label: "Timer: 5 min", repeat: "none", timeHm: null }), s)).toEqual({ action: "timerDone" });
  });

  it("hides quiet 'timer done' badges after an hour", () => {
    const now = 10 * 3600_000;
    const list = [
      { id: 1, label: "Timer: 5 min", at: now - 10 * 60_000 },
      { id: 2, label: "Timer: 1 min", at: now - 61 * 60_000 },
    ];
    expect(visibleDoneTimers(list, now).map((t) => t.id)).toEqual([1]);
  });

  it("lists snoozed and missed alarms", () => {
    const now = 1000;
    const list = [
      alarm({ id: 1, snoozes: 1, nextFire: 5000 }),
      alarm({ id: 2, snoozes: 0, nextFire: 3000 }),
      alarm({ id: 3, label: "Timer: 5 min", repeat: "none", snoozes: 1, nextFire: 2000 }),
      alarm({ id: 4, missedAt: 500 }),
    ];
    expect(snoozedAlarms(list, now).map((a) => a.id)).toEqual([1]);
    expect(missedAlarms(list).map((a) => a.id)).toEqual([4]);
  });

  it("stops badging a missed alarm once it has been seen (it stays missed in the history)", () => {
    expect(missedAlarms([alarm({ missedAt: 500, missedSeenAt: 900 })])).toEqual([]);
  });
});

describe("an alarm's own time and name", () => {
  const t940 = new Date(2026, 8, 28, 21, 40).getTime();
  const min = 60_000;
  const oneOff = (over: Partial<Alarm>) => alarm({ label: "Alarm", repeat: "none", timeHm: null, ...over });

  it("keeps the time it was set for through snoozes and after it was missed", () => {
    // Not rung yet: its next ring.
    expect(alarmTime(oneOff({ nextFire: t940 }))).toBe(t940);
    // Snoozed twice: still 9:40, not the next ring at 9:52.
    expect(alarmTime(oneOff({ nextFire: t940 + 12 * min, rangAt: t940, snoozes: 2 }))).toBe(t940);
    // Missed and finished.
    expect(alarmTime(oneOff({ nextFire: null, enabled: false, rangAt: t940, snoozes: 3, missedAt: t940 + 19 * min }))).toBe(
      t940,
    );
  });

  it("uses a repeating alarm's time of day", () => {
    const today = new Date(t940);
    today.setHours(7, 0, 0, 0);
    expect(alarmTime(alarm({ nextFire: t940 }), t940)).toBe(today.getTime());
  });

  it("calls unnamed alarms by their time, in the system's format, and named ones by their name", () => {
    expect(alarmName(oneOff({ nextFire: t940 + 12 * min, rangAt: t940, snoozes: 2 }))).toBe(`Alarm ${clock(t940)}`);
    expect(alarmName(oneOff({ label: "", nextFire: t940 }))).toBe(`Alarm ${clock(t940)}`);
    expect(alarmName(oneOff({ label: "Login CMC", nextFire: t940 }))).toBe("Login CMC");
  });
});
