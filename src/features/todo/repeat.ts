import type { Todo, TodoRepeat } from "../../platform/types";

/**
 * Repeating to-dos and to-dos on a day without a time. Mirrors `todo_occurrence`/`next_todo`
 * in crates/desktoppet-core/src/schedule.rs and the to-do rules of `take_due` (the app's
 * source of truth); this copy powers the browser mock and the panel.
 */

export const TODO_REPEATS: [TodoRepeat, string][] = [
  ["none", "No repeat"],
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["fortnightly", "Fortnightly"],
  ["monthly", "Monthly"],
  ["quarterly", "Quarterly"],
  ["yearly", "Yearly"],
];

/** "Weekly", "Fortnightly"… for a list row ("" when it doesn't repeat). */
export function repeatLabel(r: TodoRepeat): string {
  return r === "none" ? "" : (TODO_REPEATS.find(([k]) => k === r)?.[1] ?? "");
}

/** "every week", "every 2 weeks"… for the hint under the form. */
export function repeatPhrase(r: TodoRepeat): string {
  const phrases: Record<TodoRepeat, string> = {
    none: "",
    daily: "every day",
    weekly: "every week",
    fortnightly: "every 2 weeks",
    monthly: "every month",
    quarterly: "every 3 months",
    yearly: "every year",
  };
  return phrases[r];
}

const STEP_DAYS: Partial<Record<TodoRepeat, number>> = { daily: 1, weekly: 7, fortnightly: 14 };
const STEP_MONTHS: Partial<Record<TodoRepeat, number>> = { monthly: 1, quarterly: 3, yearly: 12 };

/**
 * The `n`th time after the first (`anchor`, n = 0), at the same local time of day. Months are
 * counted from the anchor: the 31st is the month's last day where there's no 31st.
 */
export function todoOccurrence(anchor: number, repeat: TodoRepeat, n: number): number | null {
  if (repeat === "none") return n === 0 ? anchor : null;
  const a = new Date(anchor);
  const days = STEP_DAYS[repeat];
  if (days !== undefined) {
    const d = new Date(a);
    d.setDate(a.getDate() + days * n);
    return d.getTime();
  }
  const months = a.getMonth() + (STEP_MONTHS[repeat] ?? 0) * n;
  const year = a.getFullYear() + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(a.getDate(), last), a.getHours(), a.getMinutes()).getTime();
}

/** The first time strictly after `after`. */
export function nextTodo(anchor: number, repeat: TodoRepeat, after: number): number | null {
  if (repeat === "none") return anchor > after ? anchor : null;
  const longestDays = { daily: 1, weekly: 7, fortnightly: 14, monthly: 31, quarterly: 92, yearly: 366 }[repeat];
  let n = Math.max(0, Math.floor((after - anchor) / ((longestDays * 24 + 1) * 3_600_000)));
  for (let i = 0; i < 10_000; i++, n++) {
    const t = todoOccurrence(anchor, repeat, n);
    if (t === null) return null;
    if (t > after) return t;
  }
  return null;
}

/** Local midnight of the day `ms` is on. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight of the next day. */
export function endOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** When a to-do reminds you: its time, or its day at the "to-dos without a time" time. */
export function todoRemindsAt(t: Pick<Todo, "dueAt" | "allDay">, dayTime: string): number | null {
  if (t.dueAt === null) return null;
  if (!t.allDay) return t.dueAt;
  const [h, m] = dayTime.split(":").map(Number);
  const d = new Date(t.dueAt);
  d.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  return d.getTime();
}

/** Past its time, or (on a day without a time) past its day. */
export function isOverdue(t: Pick<Todo, "dueAt" | "allDay" | "done">, now = Date.now()): boolean {
  if (t.done || t.dueAt === null) return false;
  return t.allDay ? endOfDay(t.dueAt) <= now : t.dueAt < now;
}

/**
 * Where a ticked-off repeating to-do goes next: after both its own day and today (several
 * missed times don't pile up). A day's to-do is next on a later day than today.
 */
export function nextAfterTick(t: Pick<Todo, "dueAt" | "allDay" | "repeat">, anchor: number, now = Date.now()): number | null {
  if (t.dueAt === null || t.repeat === "none") return null;
  const today = t.allDay ? endOfDay(now) - 1 : now;
  return nextTodo(anchor, t.repeat, Math.max(t.dueAt, today));
}
