import { describe, expect, it } from "vitest";
import { clock } from "../features/alarm/ringing";
import type { Todo } from "../platform/types";
import { repeatBadge, splitTodos, todoHint, todoWhen } from "./todoText";

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

describe("To-dos sections", () => {
  const todo = (id: number, over: Partial<Todo>): Todo => ({
    id,
    title: `t${id}`,
    dueAt: null,
    done: false,
    createdAt: 0,
    doneAt: null,
    allDay: false,
    repeat: "none",
    ...over,
  });
  it("puts overdue, today's and undated in Today, later days in Upcoming", () => {
    const list = [
      todo(1, {}), // no day
      todo(2, { dueAt: day(7), allDay: true }), // today, no time
      todo(3, { dueAt: at(7, 15) }), // today 3 pm
      todo(4, { dueAt: day(6), allDay: true }), // yesterday: overdue
      todo(5, { dueAt: day(13), allDay: true, repeat: "fortnightly" }),
      todo(6, { dueAt: day(8), allDay: true }), // tomorrow
      todo(7, { dueAt: at(7, 8) }), // today 8 am: overdue
      todo(8, { done: true, doneAt: 5 }),
      todo(9, { done: true, doneAt: 9 }),
    ];
    const { today, upcoming, done } = splitTodos(list, "09:00", now);
    expect(today.map((t) => t.id)).toEqual([4, 7, 3, 2, 1]);
    expect(upcoming.map((t) => t.id)).toEqual([6, 5]);
    expect(done.map((t) => t.id)).toEqual([9, 8]);
  });
});
