import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "./quickAdd";

// Wednesday 2026-01-07 10:00 local time.
const now = new Date(2026, 0, 7, 10, 0, 0);
const at = (d: number, h: number, m = 0) => new Date(2026, 0, d, h, m).getTime();
const day = (d: number, month = 0) => new Date(2026, month, d).getTime();

describe("parseQuickAdd", () => {
  it.each([
    ["call mom at 3pm", "call mom", at(7, 15)],
    ["standup tomorrow 9:30", "standup", at(8, 9, 30)],
    ["stretch in 20m", "stretch", now.getTime() + 20 * 60_000],
    ["in 2 hours check oven", "check oven", now.getTime() + 2 * 3_600_000],
    ["pay rent fri 10am", "pay rent", at(9, 10)],
    ["water plants at 9", "water plants", at(8, 9)],
    ["call dad tonight", "call dad", at(7, 20)],
    ["just a note", "just a note", null],
    ["read 3 chapters", "read 3 chapters", null],
  ])("%s", (input, title, due) => {
    expect(parseQuickAdd(input, now)).toEqual({ title, dueAt: due, allDay: false, repeat: "none" });
  });

  it.each([
    ["buy milk today", "buy milk", day(7), "none"],
    ["dentist fri", "dentist", day(9), "none"],
    ["bins every tue", "bins", day(13), "weekly"],
    ["groceries every wed", "groceries", day(7), "weekly"],
    ["recycling every other thu", "recycling", day(8), "fortnightly"],
    ["water plants daily", "water plants", day(7), "daily"],
    ["pay bills monthly 1st", "pay bills", day(1, 1), "monthly"],
    ["review budget quarterly", "review budget", day(7), "quarterly"],
    ["car rego yearly on the 20th", "car rego", day(20), "yearly"],
  ])("%s (a day, no time)", (input, title, due, repeat) => {
    expect(parseQuickAdd(input, now)).toEqual({ title, dueAt: due, allDay: true, repeat });
  });

  it("keeps a time with a repeat", () => {
    expect(parseQuickAdd("bins every tue 7pm", now)).toEqual({ title: "bins", dueAt: at(13, 19), allDay: false, repeat: "weekly" });
    // Today's (Wednesday's) 9am has passed: next week's.
    expect(parseQuickAdd("standup every wed 9am", now)).toEqual({ title: "standup", dueAt: at(14, 9), allDay: false, repeat: "weekly" });
    expect(parseQuickAdd("stretch every day at 3pm", now)).toEqual({ title: "stretch", dueAt: at(7, 15), allDay: false, repeat: "daily" });
  });
});
