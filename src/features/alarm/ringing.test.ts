import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Alarm } from "../../platform/types";
import {
  alarmName,
  alarmTime,
  clock,
  missedAlarms,
  onUnanswered,
  snoozedAlarms,
  timeRange,
  timerBadgeLine,
  alarmBadgeLine,
  badgeAlarms,
  upcomingAlarms,
  visibleDoneTimers,
} from "./ringing";
import { timerLabel } from "./timers";

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
  skippedFire: null,
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

describe("badge info", () => {
  const at = (h: number, m: number) => new Date(2026, 8, 29, h, m).getTime();
  it("writes a time range short, with a shared AM/PM once", () => {
    // The exact text depends on the system's clock format; check it where it is 12-hour.
    if (clock(at(20, 19)) === "8:19 PM") {
      expect(timeRange(at(20, 19), at(20, 20))).toBe("8:19 → 8:20 PM");
      expect(timeRange(at(11, 50), at(12, 5))).toBe("11:50 AM → 12:05 PM");
    }
    expect(timeRange(at(20, 19), at(20, 20)).endsWith(clock(at(20, 20)))).toBe(true);
  });

  it("lists a timer by length and range", () => {
    const t = alarm({ label: timerLabel(12), repeat: "none", timeHm: null, nextFire: at(20, 22), createdAt: at(20, 10) });
    expect(timerBadgeLine(t as Alarm & { nextFire: number })).toBe(`12 min · ${timeRange(at(20, 10), at(20, 22))}`);
  });

  it("marks a snoozed timer, whose range is longer than its length", () => {
    const t = alarm({ label: timerLabel(1), repeat: "none", timeHm: null, nextFire: at(21, 45), createdAt: at(21, 38), snoozes: 1 });
    expect(timerBadgeLine(t as Alarm & { nextFire: number })).toBe(`1 min · 💤×1 · ${timeRange(at(21, 38), at(21, 45))}`);
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

describe("upcoming alarms (the 🔔 badge)", () => {
  const now = new Date(2026, 8, 29, 21, 0).getTime();
  const min = 60_000;
  const oneOff = (id: number, over: Partial<Alarm>) => alarm({ id, label: "Alarm", repeat: "none", timeHm: null, ...over });

  it("lists alarms ringing within the look-ahead, soonest first", () => {
    const list = [
      oneOff(1, { nextFire: now + 50 * min }),
      oneOff(2, { nextFire: now + 10 * min }),
      oneOff(3, { nextFire: now + 61 * min }), // too far
      oneOff(4, { nextFire: now + 5 * min, snoozes: 1 }), // snoozed: its own 💤 badge
      oneOff(5, { nextFire: now + 5 * min, enabled: false }),
      oneOff(6, { label: timerLabel(5), nextFire: now + 5 * min }), // a timer
    ];
    expect(upcomingAlarms(list, 60, now).map((a) => a.id)).toEqual([2, 1]);
    expect(upcomingAlarms(list, 5, now)).toEqual([]);
  });

  it("names the alarm with its time once; a snoozed one with its own time and next ring", () => {
    const at = now + 40 * min;
    const line = (a: Alarm) => alarmBadgeLine(a as Alarm & { nextFire: number });
    expect(line(oneOff(1, { nextFire: at }))).toBe(`Alarm ${clock(at)}`);
    expect(line(oneOff(1, { label: "Login CMC", nextFire: at }))).toBe(`Login CMC · ${clock(at)}`);
    const rang = now - 5 * min;
    expect(line(oneOff(1, { nextFire: now + 3 * min, rangAt: rang, snoozes: 1 }))).toBe(
      `Alarm ${clock(rang)} · 💤×1 · next ${clock(now + 3 * min)}`,
    );
  });

  it("puts snoozed and upcoming alarms in one list by next ring; snoozed ones always show", () => {
    const list = [
      oneOff(1, { nextFire: now + 30 * min }),
      oneOff(2, { nextFire: now + 3 * min, rangAt: now - 2 * min, snoozes: 1 }),
      oneOff(3, { nextFire: now + 1 * min }),
    ];
    expect(badgeAlarms(list, { show: true, minutes: 60 }, now).map((a) => a.id)).toEqual([3, 2, 1]);
    // Off, or a short look-ahead: the snoozed one still shows.
    expect(badgeAlarms(list, { show: false, minutes: 60 }, now).map((a) => a.id)).toEqual([2]);
    expect(badgeAlarms(list, { show: true, minutes: 1 }, now).map((a) => a.id)).toEqual([3, 2]);
  });
});
