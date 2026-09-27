import { describe, expect, it } from "vitest";
import type { Alarm } from "../../platform/types";
import { activeTimers, formatDuration, isTimer, timerLabel } from "./timers";

const alarm = (id: number, label: string, nextFire: number | null, enabled = true): Alarm => ({
  id,
  label,
  nextFire,
  timeHm: null,
  repeat: "none",
  enabled,
});

describe("timers", () => {
  it("labels durations readably", () => {
    expect(timerLabel(5)).toBe("Timer: 5 min");
    expect(formatDuration(60)).toBe("1 hour");
    expect(formatDuration(90)).toBe("1 h 30 min");
  });

  it("lists running timers soonest first, ignoring alarms and finished timers", () => {
    const list = [
      alarm(1, timerLabel(10), 10_000),
      alarm(2, "Wake up", 1_000),
      alarm(3, timerLabel(1), 2_000),
      alarm(4, timerLabel(5), null, false),
      alarm(5, timerLabel(5), 500),
    ];
    expect(isTimer(list[1])).toBe(false);
    expect(activeTimers(list, 1_000).map((a) => a.id)).toEqual([3, 1]);
  });
});
