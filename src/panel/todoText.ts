import { endOfDay, isOverdue, repeatLabel, repeatPhrase, todoRemindsAt } from "../features/todo/repeat";
import type { Todo, TodoRepeat } from "../platform/types";
import { formatDay, formatWhen } from "./dom";

/** When an open to-do is due, for its row: "Today", "Fri 3:30 PM", "Overdue · Yesterday". */
export function todoWhen(t: Pick<Todo, "dueAt" | "allDay" | "done">, now = Date.now()): { text: string; overdue: boolean } | null {
  if (t.dueAt === null) return null;
  const when = t.allDay ? formatDay(t.dueAt, now) : formatWhen(t.dueAt, now);
  const overdue = isOverdue(t, now);
  return { text: overdue ? `Overdue · ${when}` : when, overdue };
}

/** "🔁 Weekly" in front of a repeating to-do's day ("" otherwise). */
export function repeatBadge(r: TodoRepeat): string {
  const label = repeatLabel(r);
  return label ? `🔁 ${label}` : "";
}

/**
 * The line under the form: what will be saved.
 * "📅 Tue, Oct 7 — “bins” · 🔁 every week · reminds at 9:00 AM that day"
 */
export function todoHint(
  title: string,
  dueAt: number | null,
  allDay: boolean,
  repeat: TodoRepeat,
  dayTime: string,
  now = Date.now(),
): string {
  if (!title.trim()) return "";
  if (dueAt === null) return `No reminder — “${title}”`;
  const every = repeat !== "none" ? ` · 🔁 ${repeatPhrase(repeat)}` : "";
  if (!allDay) return `⏰ ${formatWhen(dueAt, now)} — “${title}”${every}`;
  const [h, m] = dayTime.split(":").map(Number);
  const at = new Date(2020, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `📅 ${formatDay(dueAt, now)} — “${title}”${every} · reminds at ${at} that day`;
}

/**
 * The To-dos list in sections. Today: overdue first, then today's with a time, today's
 * without one, and those with no day (any time is fine, so they're today's too). Upcoming:
 * from tomorrow, soonest first. Done: most recently ticked off first.
 */
export function splitTodos(todos: Todo[], dayTime: string, now = Date.now()): { today: Todo[]; upcoming: Todo[]; done: Todo[] } {
  const tomorrow = endOfDay(now);
  const remindsAt = (t: Todo) => todoRemindsAt(t, dayTime) ?? Infinity;
  const rank = (t: Todo) => (t.dueAt === null ? 3 : isOverdue(t, now) ? 0 : t.allDay ? 2 : 1);
  const open = todos.filter((t) => !t.done);
  const today = open
    .filter((t) => t.dueAt === null || t.dueAt < tomorrow)
    .sort((a, b) => rank(a) - rank(b) || remindsAt(a) - remindsAt(b) || a.id - b.id);
  const upcoming = open
    .filter((t) => t.dueAt !== null && t.dueAt >= tomorrow)
    .sort((a, b) => remindsAt(a) - remindsAt(b) || a.id - b.id);
  const done = todos.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0) || b.id - a.id);
  return { today, upcoming, done };
}
