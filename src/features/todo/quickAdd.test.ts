import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "./quickAdd";

// Wednesday 2026-01-07 10:00 local time.
const now = new Date(2026, 0, 7, 10, 0, 0);
const at = (d: number, h: number, m = 0) => new Date(2026, 0, d, h, m).getTime();

describe("parseQuickAdd", () => {
  it.each([
    ["call mom at 3pm", "call mom", at(7, 15)],
    ["standup tomorrow 9:30", "standup", at(8, 9, 30)],
    ["stretch in 20m", "stretch", now.getTime() + 20 * 60_000],
    ["in 2 hours check oven", "check oven", now.getTime() + 2 * 3_600_000],
    ["pay rent fri 10am", "pay rent", at(9, 10)],
    ["water plants at 9", "water plants", at(8, 9)],
    ["buy milk today", "buy milk", at(7, 9)],
    ["just a note", "just a note", null],
    ["read 3 chapters", "read 3 chapters", null],
  ])("%s", (input, title, due) => {
    expect(parseQuickAdd(input, now)).toEqual({ title, dueAt: due });
  });
});
