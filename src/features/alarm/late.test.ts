import { describe, expect, it } from "vitest";
import { lateBy, lateness, lateNote } from "./late";
import { clock } from "./ringing";

const MIN = 60_000;
const due = new Date(2026, 9, 12, 16, 30).getTime();

describe("[alarm.late-note] rung late", () => {
  it("a minute late or less is on time", () => {
    expect(lateness("alarm", due, due + MIN - 1, "presenting")).toBeNull();
    expect(lateness("alarm", undefined, due + 10 * MIN, "presenting")).toBeNull();
    expect(lateness("alarm", due, due + MIN, null)).not.toBeNull();
  });

  it("says when it was meant for, how late, and why", () => {
    const at = clock(due);
    expect(lateNote(lateness("alarm", due, due + 7 * MIN, "presenting")!)).toBe(`Due ${at} · 7 min late — you were presenting`);
    expect(lateNote(lateness("timer", due, due + 7 * MIN, "fullscreen")!)).toBe(`Ran out at ${at} · 7 min ago — an app was full screen`);
    expect(lateNote(lateness("todo", due, due + 2 * MIN, "queued")!)).toBe(`Due ${at} · 2 min late — another reminder was ringing`);
    expect(lateNote(lateness("alarm", due, due + 12 * MIN, "notRunning")!)).toBe(`Due ${at} · 12 min late — ePet wasn't running`);
    expect(lateness("alarm", due, due + 9 * MIN, "asleep")!.why).toBe("the computer was asleep");
    expect(lateness("alarm", due, due + 9 * MIN, "call")!.why).toBe("you were in a call");
    // Not known (the test clock set ahead): just how late.
    expect(lateNote(lateness("alarm", due, due + 3 * MIN)!)).toBe(`Due ${at} · 3 min late`);
  });

  it("a day's to-do only says the time it was meant for", () => {
    expect(lateness("day", due, due + 90 * MIN, "notRunning")).toEqual({ what: `Meant for ${clock(due)}`, by: "1 h 30 min", why: null });
  });

  it("rounds to minutes and hours", () => {
    expect(lateBy(65_000)).toBe("1 min");
    expect(lateBy(7 * MIN + 29_000)).toBe("7 min");
    expect(lateBy(60 * MIN)).toBe("1 h");
    expect(lateBy(65 * MIN)).toBe("1 h 5 min");
  });
});
