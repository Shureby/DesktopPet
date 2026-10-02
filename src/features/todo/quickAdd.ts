import type { TodoRepeat } from "../../platform/types";

/**
 * Parses quick-add text such as "call mom at 3pm", "stretch in 20m",
 * "standup tomorrow 9:30", "pay rent fri 10am", "bins every tue" or "pay bills monthly 1st"
 * into a title, a due time or day, and how it repeats.
 * Deliberately small and predictable; the LLM tier can handle free-form text later.
 *
 * A day without a clock time ("buy milk today", "bins every tue") is a to-do on that day:
 * `allDay`, with `dueAt` at its local midnight. Repeating needs a day, so "water plants
 * daily" starts today.
 */
export interface QuickAdd {
  title: string;
  dueAt: number | null;
  allDay: boolean;
  repeat: TodoRepeat;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_WORD = "(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*";

/** Repeat phrases; the ones naming a weekday leave it behind as the day. */
const REPEATS: [RegExp, TodoRepeat][] = [
  [new RegExp(`\\s(?:every\\s+other|every\\s+2nd|fortnightly\\s+on)\\s+(${DAY_WORD})\\s`, "i"), "fortnightly"],
  [new RegExp(`\\s(?:every|weekly\\s+on)\\s+(${DAY_WORD})\\s`, "i"), "weekly"],
  [/\s(?:every\s*day|daily)\s/i, "daily"],
  [/\s(?:every\s+other\s+week|every\s+2\s+weeks|every\s+fortnight|fortnightly|biweekly)\s/i, "fortnightly"],
  [/\s(?:every\s+week|weekly)\s/i, "weekly"],
  [/\s(?:every\s+3\s+months|every\s+quarter|quarterly)\s/i, "quarterly"],
  [/\s(?:every\s+month|monthly)\s/i, "monthly"],
  [/\s(?:every\s+year|yearly|annually)\s/i, "yearly"],
];

export function parseQuickAdd(input: string, now = new Date()): QuickAdd {
  let text = ` ${input.trim()} `;
  let due: Date | null = null;
  let allDay = false;
  let repeat: TodoRepeat = "none";

  for (const [re, r] of REPEATS) {
    const m = text.match(re);
    if (m) {
      repeat = r;
      text = text.replace(m[0], m[1] ? ` ${m[1]} ` : " ");
      break;
    }
  }

  // Relative: "in 10m", "in 2 hours", "in 90 min"
  const rel = text.match(/\s(?:in\s+)?(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)\s/i);
  if (rel && /\sin\s/i.test(text.slice(0, (rel.index ?? 0) + 4))) {
    const n = parseFloat(rel[1]);
    const ms = /^h/i.test(rel[2]) ? n * 3_600_000 : n * 60_000;
    due = new Date(now.getTime() + ms);
    text = text.replace(rel[0], " ");
    text = text.replace(/\s+in\s*$/i, " ");
  }

  // The day: today / tomorrow / a weekday / "the 1st"
  let day: Date | null = null;
  let tonight = false;
  const dayWord = text.match(new RegExp(`\\s(today|tonight|tomorrow|tmr|${DAY_WORD})\\s`, "i"));
  if (!due && dayWord) {
    const w = dayWord[1].toLowerCase();
    let offset: number;
    if (w === "today" || w === "tonight") offset = 0;
    else if (w === "tomorrow" || w === "tmr") offset = 1;
    else {
      // "fri" is the coming Friday; a repeating "every fri" can start today.
      const ahead = (DAYS.indexOf(w.slice(0, 3)) - now.getDay() + 7) % 7;
      offset = ahead === 0 && repeat === "none" ? 7 : ahead;
    }
    tonight = w === "tonight";
    day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    text = text.replace(dayWord[0], " ");
  }
  const ordinal = text.match(/\s(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\s/i);
  if (!due && !day && ordinal) {
    const n = parseInt(ordinal[1], 10);
    if (n >= 1 && n <= 31) {
      // This month's, or next month's once it has passed (the last day where there's no 31st).
      const on = (monthsAhead: number) => {
        const last = new Date(now.getFullYear(), now.getMonth() + monthsAhead + 1, 0).getDate();
        return new Date(now.getFullYear(), now.getMonth() + monthsAhead, Math.min(n, last));
      };
      day = n >= now.getDate() ? on(0) : on(1);
      text = text.replace(ordinal[0], " ");
    }
  }

  // Clock times: "at 3pm", "15:30", "9am", "at 9"
  const time = text.match(/\s(?:at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s/i);
  const hasClock = time && (time[2] !== undefined || time[3] !== undefined || /\s(at|@)\s*\d/i.test(time[0]));
  if (!due && time && hasClock) {
    let h = parseInt(time[1], 10);
    const m = time[2] ? parseInt(time[2], 10) : 0;
    const ap = time[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h < 24 && m < 60) {
      due = new Date(day ?? now);
      due.setHours(h, m, 0, 0);
      // Passed already: tomorrow, or a repeating weekday's next week.
      if (due.getTime() <= now.getTime()) {
        if (!day) due.setDate(due.getDate() + 1);
        else if (repeat !== "none" && dayWord) due.setDate(due.getDate() + 7);
      }
      text = text.replace(time[0], " ");
    }
  }
  if (!due && tonight) {
    due = new Date(day!);
    due.setHours(20, 0, 0, 0);
  } else if (!due && (day || repeat !== "none")) {
    // A day without a time (repeating with no day starts today).
    due = day ?? new Date(now.getFullYear(), now.getMonth(), now.getDate());
    allDay = true;
  }

  const title = text
    .replace(/\s+/g, " ")
    .replace(/\s(at|@|on|by|every)$/i, "")
    .trim();
  return { title: title || input.trim(), dueAt: due ? due.getTime() : null, allDay, repeat: due ? repeat : "none" };
}
