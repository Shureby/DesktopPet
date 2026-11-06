import { longWeekday, monthDay, weekdayShort, weekOrder } from "../i18n/format";
import { t } from "../i18n";
import { alarmTime, clock, DEFAULT_ALARM_LABEL } from "../features/alarm/ringing";
import { isTimer, timerStartedAt } from "../features/alarm/timers";
import { EVERY_DAY, repeatMask, WEEKDAYS, type Alarm, type DayMask, type HiddenAlerts, type Repeat } from "../platform/types";
import { formatWhen } from "./dom";

/** The time the alarm is set for, shown big like a phone clock app (the same through snoozes). */
export function bigTime(a: Alarm): string {
  const at = alarmTime(a);
  return at === null ? "--:--" : clock(at);
}

/** When a finished item happened, for sorting: its own time, not a later snoozed ring. */
export function finishedAt(a: Alarm): number | null {
  return isTimer(a) ? (a.rangAt ?? a.offAt ?? a.missedAt) : (alarmTime(a) ?? a.missedAt);
}

/** "Started 4:29 PM · rings at 4:41 PM", so identical timers can be told apart. */
export function timerTimes(a: Alarm): string {
  const started = timerStartedAt(a);
  if (started === null) return a.nextFire ? t("Rings at {time}", { time: clock(a.nextFire) }) : "";
  const begun = t("Started {time}", { time: clock(started) });
  return a.nextFire ? `${begun} · ${t("rings at {time}", { time: clock(a.nextFire) })}` : begun;
}

/**
 * "Missed · Today 9:40 PM · snoozed 3×", "Done · Today 12:42 PM" (timers),
 * "Rang · Yesterday 7:30 AM". Always the item's own time, not a later snoozed ring.
 */
export function finishedStatus(a: Alarm, now = Date.now()): string {
  // Due while ePet wasn't running: it didn't ring, and that isn't missing it.
  if (a.offAt && a.rangAt === null) return t("Didn't ring · {when} · ePet wasn't running", { when: formatWhen(a.offAt, now) });
  const at = isTimer(a) ? a.rangAt : alarmTime(a, now);
  const word = a.missedAt ? t("Missed") : isTimer(a) ? t("Done") : t("Rang");
  const parts = [word];
  if (at !== null) parts.push(formatWhen(at, now));
  else if (a.missedAt) parts.push(formatWhen(a.missedAt, now));
  if (a.snoozes > 0) parts.push(t("snoozed {n}×", { n: a.snoozes }));
  return parts.join(" · ");
}

/**
 * The ring "Skip once" skips: "Sep 30 7:00 PM (Today)", "Oct 1 7:00 PM (Tomorrow)",
 * "Oct 5 7:00 PM (Monday)". The date and the day, so there's no doubt which ring it is.
 */
export function skipWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const day =
    d.toDateString() === new Date(now).toDateString()
      ? t("Today")
      : d.toDateString() === new Date(now + 86_400_000).toDateString()
        ? t("Tomorrow")
        : longWeekday(ms);
  return t("{date} {time} ({day})", { date: monthDay(ms), time: clock(ms), day });
}

/** "Every day", "Weekdays", "Weekends", "Mon, Wed, Fri" (Monday first); "No days" for none. */
export function daysText(mask: DayMask): string {
  const m = mask & EVERY_DAY;
  if (m === EVERY_DAY) return t("Every day");
  if (m === WEEKDAYS) return t("Weekdays");
  if (m === WEEKENDS) return t("Weekends");
  const days = weekOrder().filter((d) => m & (1 << d)).map((d) => weekdayShort(d));
  return days.length ? days.join(t(", ")) : t("No days");
}

/** How an alarm repeats: "Once", "Every day", "Weekdays", "Mon, Wed, Fri". */
export function repeatText(a: Pick<Alarm, "repeat" | "repeatDays">): string {
  return a.repeat === "none" ? t("Once") : daysText(repeatMask(a.repeat, a.repeatDays ?? 0));
}

/** What the New alarm "Repeat" menu offers. Weekends and custom days are saved as "days". */
export type RepeatChoice = "none" | "daily" | "weekdays" | "weekends" | "days";
export const WEEKENDS: DayMask = 0b100_0001;

/** The menu entry for a set of days picked by hand: Weekdays, Weekends, or Custom days. */
export function choiceForDays(mask: DayMask): "weekdays" | "weekends" | "days" {
  return mask === WEEKDAYS ? "weekdays" : mask === WEEKENDS ? "weekends" : "days";
}

/**
 * The days shown when a menu entry is chosen. Custom days start from what was shown (so
 * Weekdays can be tweaked), or today's weekday coming from Once or Every day.
 */
export function daysForChoice(choice: RepeatChoice, previous: RepeatChoice, days: DayMask, today: number): DayMask {
  if (choice === "weekdays") return WEEKDAYS;
  if (choice === "weekends") return WEEKENDS;
  if (choice === "days") return previous === "weekdays" || previous === "weekends" || previous === "days" ? days : 1 << today;
  return days;
}

/** Whether a menu entry shows the day picker (only those that pick days). */
export function showsDays(choice: RepeatChoice): boolean {
  return choice === "weekdays" || choice === "weekends" || choice === "days";
}

/** What is saved for a menu entry. */
export function repeatFor(choice: RepeatChoice, days: DayMask): { repeat: Repeat; days: DayMask } {
  if (choice === "weekends") return { repeat: "days", days: WEEKENDS };
  if (choice === "days") return { repeat: "days", days };
  return { repeat: choice, days: 0 };
}

/** The New alarm form's fields; `editing` is the alarm being changed with ✎ (null: a new one). */
export interface AlarmDraft {
  time: string;
  choice: RepeatChoice;
  days: DayMask;
  label: string;
  /** Rings in full even when the pet has stepped aside, and in Quiet (`Alarm.important`). */
  important: boolean;
  /** "Try again if I don't answer"; it follows Important until changed by hand. */
  autoSnooze: boolean;
  autoSnoozeTouched: boolean;
  editing: number | null;
}

/** The form filled in from an alarm, for editing it (✎). An unnamed alarm leaves Label empty. */
export function draftFor(a: Alarm, now = Date.now()): AlarmDraft {
  const at = new Date(alarmTime(a, now) ?? now);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const choice: RepeatChoice = a.repeat === "days" ? choiceForDays(a.repeatDays) : a.repeat;
  const days = a.repeat === "days" ? a.repeatDays : WEEKDAYS;
  return { time, choice, days, label: a.label === DEFAULT_ALARM_LABEL ? "" : a.label, important: a.important === true, autoSnooze: a.autoSnooze !== false, autoSnoozeTouched: true, editing: a.id };
}

/**
 * The red warning under "When your pet is hidden, it comes out for…" when alarms, timers or
 * to-do reminders are unticked: they can't reach you while the pet is hidden.
 */
export function hiddenWarning(h: HiddenAlerts): string | null {
  const off = [h.alarms ? null : t("alarms"), h.timers ? null : t("timers"), h.todos ? null : t("to-do reminders")].filter(
    (x): x is string => x !== null,
  );
  if (!off.length) return null;
  const list = off.length === 1 ? off[0] : t("{list} and {last}", { list: off.slice(0, -1).join(t(", ")), last: off[off.length - 1] });
  return t("While your pet is hidden, {list} will not alert you.", { list });
}

/**
 * The Alarms list, like the pet's 🔔 badge: alarms that are on by their next ring (a snoozed
 * one by its snoozed ring), soonest first; those switched off after them, by time of day.
 */
export function sortAlarms(list: Alarm[], now = Date.now()): Alarm[] {
  const timeOfDay = (a: Alarm) => {
    const t = alarmTime(a, now);
    if (t === null) return Infinity;
    const d = new Date(t);
    return d.getHours() * 60 + d.getMinutes();
  };
  const on = (a: Alarm) => a.enabled && a.nextFire !== null;
  return [...list].sort((a, b) => {
    if (on(a) !== on(b)) return on(a) ? -1 : 1;
    const byTime = on(a) ? a.nextFire! - b.nextFire! : timeOfDay(a) - timeOfDay(b);
    return byTime || a.id - b.id;
  });
}