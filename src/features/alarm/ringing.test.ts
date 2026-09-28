import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Alarm } from "../../platform/types";
import { missedAlarms, onUnanswered, snoozedAlarms, visibleDoneTimers } from "./ringing";

const alarm = (over: Partial<Alarm> = {}): Alarm => ({
  id: 1,
  label: "Wake up",
  nextFire: null,
  timeHm: "07:00",
  repeat: "daily",
  enabled: true,
  snoozes: 0,
  missedAt: null,
  rangAt: null,
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
});
