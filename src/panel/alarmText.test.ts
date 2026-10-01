import { describe, expect, it } from "vitest";
import { clock } from "../features/alarm/ringing";
import { timerLabel } from "../features/alarm/timers";
import type { Alarm } from "../platform/types";
import { finishedStatus, hiddenWarning, skipWhen, sortAlarms, timerTimes } from "./alarmText";

const now = new Date(2026, 8, 28, 22, 30).getTime();
const at = (h: number, m: number) => new Date(2026, 8, 28, h, m).getTime();
const alarm = (over: Partial<Alarm>): Alarm => ({
  id: 1,
  label: "Alarm",
  nextFire: null,
  timeHm: null,
  repeat: "none",
  enabled: false,
  snoozes: 0,
  missedAt: null,
  missedSeenAt: null,
  skippedFire: null,
  repeatDays: 0,
  rangAt: null,
  createdAt: null,
  ...over,
});

describe("Finished rows", () => {
  it("show a missed alarm at its own time with its snoozes, even after its badge was clicked", () => {
    const missed = alarm({ rangAt: at(21, 40), snoozes: 3, missedAt: at(21, 59), missedSeenAt: at(22, 0) });
    expect(finishedStatus(missed, now)).toBe(`Missed · Today ${clock(at(21, 40))} · snoozed 3×`);
  });

  it("show when an answered alarm or timer rang", () => {
    expect(finishedStatus(alarm({ rangAt: at(21, 40), snoozes: 2 }), now)).toBe(`Rang · Today ${clock(at(21, 40))} · snoozed 2×`);
    expect(finishedStatus(alarm({ label: timerLabel(12), rangAt: at(16, 41) }), now)).toBe(`Done · Today ${clock(at(16, 41))}`);
  });
});

describe("running timers", () => {
  it("say when they were started", () => {
    const t = alarm({ label: timerLabel(12), nextFire: at(16, 41), enabled: true, createdAt: at(16, 29) });
    expect(timerTimes(t)).toBe(`Started ${clock(at(16, 29))} · rings at ${clock(at(16, 41))}`);
  });

  it("work out the start of timers set before 0.14 from their length", () => {
    const old = alarm({ label: timerLabel(90), nextFire: at(17, 59), enabled: true });
    expect(timerTimes(old)).toBe(`Started ${clock(at(16, 29))} · rings at ${clock(at(17, 59))}`);
    // Snoozed: the ring moved, so the start can't be worked out.
    expect(timerTimes({ ...old, snoozes: 1 })).toBe(`Rings at ${clock(at(17, 59))}`);
  });
});

describe("skipWhen", () => {
  // Wednesday Sep 30, 2026, 9 AM.
  const now = new Date(2026, 8, 30, 9, 0).getTime();
  const at = (day: number) => new Date(2026, 8, day, 19, 0).getTime();
  const date = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

  it("says the date, the time and which day it is", () => {
    expect(skipWhen(at(30), now)).toBe(`${date(at(30))} ${clock(at(30))} (Today)`);
    expect(skipWhen(at(31), now)).toBe(`${date(at(31))} ${clock(at(31))} (Tomorrow)`);
    const monday = new Date(2026, 9, 5, 19, 0).getTime();
    expect(skipWhen(monday, now)).toBe(`${date(monday)} ${clock(monday)} (${new Date(monday).toLocaleDateString([], { weekday: "long" })})`);
    if (clock(at(30)) === "7:00 PM" && date(at(30)) === "Sep 30") {
      expect(skipWhen(monday, now)).toBe("Oct 5 7:00 PM (Monday)");
    }
  });
});

describe("hidden pet: warnings and what didn't ring", () => {
  const all = { alarms: true, timers: true, todos: true, focus: false };
  it("warns about what can't reach you while the pet is hidden", () => {
    expect(hiddenWarning(all)).toBeNull();
    expect(hiddenWarning({ ...all, focus: true })).toBeNull();
    expect(hiddenWarning({ ...all, todos: false })).toBe("While your pet is hidden, to-do reminders will not alert you.");
    expect(hiddenWarning({ ...all, alarms: false, timers: false })).toBe("While your pet is hidden, alarms and timers will not alert you.");
    expect(hiddenWarning({ alarms: false, timers: false, todos: false, focus: true })).toBe(
      "While your pet is hidden, alarms, timers and to-do reminders will not alert you.",
    );
  });

  it("says an alarm didn't ring while ePet wasn't running (not missed)", () => {
    const off = alarm({ nextFire: null, enabled: false, offAt: at(9, 0) });
    expect(finishedStatus(off, now)).toBe(`Didn't ring · Today ${clock(at(9, 0))} · ePet wasn't running`);
  });
});

describe("the Alarms list order", () => {
  it("puts the soonest ring first (a snoozed alarm by its snoozed ring), switched-off ones last by time of day", () => {
    const list = [
      alarm({ id: 1, label: "Login CMC", repeat: "weekdays", timeHm: "08:40", nextFire: at(8, 40) + 86_400_000, enabled: true }),
      alarm({ id: 2, label: "test 2", nextFire: at(23, 58), enabled: true }),
      alarm({ id: 3, label: "test 1", nextFire: at(23, 0), rangAt: at(22, 50), snoozes: 2, enabled: true }),
      alarm({ id: 4, label: "off late", nextFire: at(21, 0), enabled: false }),
      alarm({ id: 5, label: "off early", repeat: "daily", timeHm: "06:00", nextFire: null, enabled: false }),
    ];
    expect(sortAlarms(list, now).map((a) => a.label)).toEqual(["test 1", "test 2", "Login CMC", "off early", "off late"]);
  });
});
