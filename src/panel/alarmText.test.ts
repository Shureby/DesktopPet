import { describe, expect, it } from "vitest";
import { clock } from "../features/alarm/ringing";
import { timerLabel } from "../features/alarm/timers";
import type { Alarm } from "../platform/types";
import { finishedStatus, skipWhen, timerTimes } from "./alarmText";

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
