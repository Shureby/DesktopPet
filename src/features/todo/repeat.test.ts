import { describe, expect, it } from "vitest";
import { endOfDay, isOverdue, nextAfterTick, nextTodo, todoRemindsAt } from "./repeat";

const d = (y: number, mo: number, day: number, h = 0, mi = 0) => new Date(y, mo - 1, day, h, mi).getTime();

describe("repeating to-dos", () => {
  it("keep their day", () => {
    const tue = d(2026, 10, 6, 19);
    expect(nextTodo(tue, "weekly", d(2026, 10, 7, 9))).toBe(d(2026, 10, 13, 19));
    expect(nextTodo(tue, "fortnightly", d(2027, 1, 1))).toBe(d(2027, 1, 12, 19));
    const jan31 = d(2026, 1, 31);
    expect(nextTodo(jan31, "monthly", d(2026, 11, 1))).toBe(d(2026, 11, 30));
    expect(nextTodo(jan31, "monthly", d(2026, 12, 1))).toBe(d(2026, 12, 31));
    expect(nextTodo(jan31, "quarterly", jan31)).toBe(d(2026, 4, 30));
    expect(nextTodo(d(2028, 2, 29), "yearly", d(2028, 2, 29))).toBe(d(2029, 2, 28));
    expect(nextTodo(jan31, "daily", jan31)).toBe(d(2026, 2, 1));
  });

  it("move on after a tick: past today, past their own day", () => {
    const wed = d(2026, 1, 7);
    const bins = { dueAt: wed, allDay: true, repeat: "weekly" as const };
    expect(nextAfterTick(bins, wed, d(2026, 1, 7, 19))).toBe(d(2026, 1, 14));
    // Weeks behind, ticked on a Thursday: the coming Wednesday.
    expect(nextAfterTick({ ...bins, dueAt: d(2026, 1, 14) }, wed, d(2026, 2, 5, 10))).toBe(d(2026, 2, 11));
    // Early: the one after its own day.
    expect(nextAfterTick({ ...bins, dueAt: d(2026, 2, 11) }, wed, d(2026, 2, 9, 10))).toBe(d(2026, 2, 18));
  });
});

describe("to-dos on a day without a time", () => {
  it("remind at the day time and are overdue only from the next day", () => {
    const day = { dueAt: d(2026, 10, 7), allDay: true, done: false };
    expect(todoRemindsAt(day, "09:00")).toBe(d(2026, 10, 7, 9));
    expect(isOverdue(day, d(2026, 10, 7, 23, 59))).toBe(false);
    expect(isOverdue(day, endOfDay(d(2026, 10, 7)))).toBe(true);
    const timed = { dueAt: d(2026, 10, 7, 15), allDay: false, done: false };
    expect(todoRemindsAt(timed, "09:00")).toBe(d(2026, 10, 7, 15));
    expect(isOverdue(timed, d(2026, 10, 7, 15, 1))).toBe(true);
  });
});
