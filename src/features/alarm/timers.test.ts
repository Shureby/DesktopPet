import { describe, expect, it } from "vitest";
import type { Alarm } from "../../platform/types";
import {
  activeTimers,
  durationInput,
  forgetCustomTimer,
  formatDuration,
  isTimer,
  parseDuration,
  rememberCustomTimer,
  replaceCustomTimer,
  timerLabel,
  timerName,
} from "./timers";

const alarm = (id: number, label: string, nextFire: number | null, enabled = true): Alarm => ({
  id,
  label,
  nextFire,
  timeHm: null,
  repeat: "none",
  enabled,
  snoozes: 0,
  missedAt: null,
  missedSeenAt: null,
  skippedFire: null,
  rangAt: null,
  createdAt: null,
});

describe("timers", () => {
  it("labels durations readably", () => {
    expect(timerLabel(5)).toBe("Timer: 5 min");
    expect(formatDuration(60)).toBe("1 hour");
    expect(formatDuration(90)).toBe("1 h 30 min");
    expect(formatDuration(120)).toBe("2 hours");
    expect(formatDuration(1.5)).toBe("1 min 30 s");
    expect(formatDuration(0.5)).toBe("30 s");
    expect(formatDuration(61.5)).toBe("1 h 1 min 30 s");
  });

  it.each([
    ["20", 20],
    ["45 min", 45],
    ["1:30", 90],
    ["0:05", 5],
    ["90s", 1.5],
    ["1m30s", 1.5],
    ["1h30m", 90],
    ["1h 30", 90],
    ["2.5h", 150],
    ["1 hour 15 minutes", 75],
  ])("parses %s", (input, minutes) => {
    expect(parseDuration(input)).toBe(minutes);
  });

  it.each(["", "abc", "0", "2s", "25h", "1:75", "20 apples", "-5"])("rejects %j", (input) => {
    expect(parseDuration(input)).toBeNull();
  });

  it("remembers up to three custom lengths, most recent first, skipping presets", () => {
    let recent: number[] = [];
    recent = rememberCustomTimer(recent, 20);
    recent = rememberCustomTimer(recent, 40);
    recent = rememberCustomTimer(recent, 15); // a preset: ignored
    expect(recent).toEqual([40, 20]);
    recent = rememberCustomTimer(recent, 1.5);
    recent = rememberCustomTimer(recent, 90);
    expect(recent).toEqual([90, 1.5, 40]);
    recent = rememberCustomTimer(recent, 40);
    expect(recent).toEqual([40, 90, 1.5]);
  });

  it("edits a saved custom length in place, or drops it when it clashes", () => {
    expect(replaceCustomTimer([40, 90, 1.5], 90, 25)).toEqual([40, 25, 1.5]);
    expect(replaceCustomTimer([40, 90, 1.5], 90, 90)).toEqual([40, 90, 1.5]);
    expect(replaceCustomTimer([40, 90, 1.5], 90, 30)).toEqual([40, 1.5]); // now a preset
    expect(replaceCustomTimer([40, 90, 1.5], 90, 40)).toEqual([40, 1.5]); // already saved
    expect(replaceCustomTimer([40], 90, 25)).toEqual([25, 40]); // gone meanwhile: just remember
    expect(forgetCustomTimer([40, 90, 1.5], 90)).toEqual([40, 1.5]);
  });

  it("pre-fills inputs with a form parseDuration reads back", () => {
    for (const m of [1, 20, 90, 1.5, 120, 61.25, 0.5]) expect(parseDuration(durationInput(m))).toBe(m);
    expect(durationInput(20)).toBe("20");
    expect(durationInput(90)).toBe("1h30m");
    expect(durationInput(1.5)).toBe("1m30s");
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

describe("timerName", () => {
  it("drops the stored prefix", () => {
    expect(timerName(alarm(1, timerLabel(12), 0))).toBe("12 min");
    expect(timerName(alarm(2, "Wake up", 0))).toBe("Wake up");
  });
});
