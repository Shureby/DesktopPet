import { describe, expect, it } from "vitest";
import { clock } from "../features/alarm/ringing";
import { repeatBadge, todoHint, todoWhen } from "./todoText";

// Wednesday 2026-10-07 10:00.
const now = new Date(2026, 9, 7, 10, 0).getTime();
const day = (d: number) => new Date(2026, 9, d).getTime();
const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime();

describe("to-do rows", () => {
  it("say when, with Overdue only after a day's to-do's day", () => {
    expect(todoWhen({ dueAt: day(7), allDay: true, done: false }, now)).toEqual({ text: "Today", overdue: false });
    expect(todoWhen({ dueAt: day(6), allDay: true, done: false }, now)).toEqual({ text: "Overdue · Yesterday", overdue: true });
    expect(todoWhen({ dueAt: at(7, 9), allDay: false, done: false }, now)).toEqual({
      text: `Overdue · Today ${clock(at(7, 9))}`,
      overdue: true,
    });
    expect(todoWhen({ dueAt: null, allDay: false, done: false }, now)).toBeNull();
    expect(repeatBadge("fortnightly")).toBe("🔁 Fortnightly");
    expect(repeatBadge("none")).toBe("");
  });

  it("explain the form in the hint", () => {
    expect(todoHint("bins", day(13), true, "weekly", "09:00", now)).toBe(
      `📅 ${new Date(day(13)).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} — “bins” · 🔁 every week · reminds at ${clock(at(7, 9))} that day`,
    );
    expect(todoHint("call mom", at(7, 15), false, "none", "09:00", now)).toBe(`⏰ Today ${clock(at(7, 15))} — “call mom”`);
    expect(todoHint("note", null, false, "none", "09:00", now)).toBe("No reminder — “note”");
    expect(todoHint("  ", null, false, "none", "09:00", now)).toBe("");
  });
});
