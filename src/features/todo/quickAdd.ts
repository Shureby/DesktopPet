/**
 * Parses quick-add text such as "call mom at 3pm", "stretch in 20m",
 * "standup tomorrow 9:30" or "pay rent fri 10am" into a title and due time.
 * Deliberately small and predictable; the LLM tier can handle free-form text later.
 */
export interface QuickAdd {
  title: string;
  dueAt: number | null;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function parseQuickAdd(input: string, now = new Date()): QuickAdd {
  let text = ` ${input.trim()} `;
  let due: Date | null = null;

  // Relative: "in 10m", "in 2 hours", "in 90 min"
  const rel = text.match(/\s(?:in\s+)?(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)\s/i);
  if (rel && /\sin\s/i.test(text.slice(0, (rel.index ?? 0) + 4))) {
    const n = parseFloat(rel[1]);
    const ms = /^h/i.test(rel[2]) ? n * 3_600_000 : n * 60_000;
    due = new Date(now.getTime() + ms);
    text = text.replace(rel[0], " ");
    text = text.replace(/\s+in\s*$/i, " ");
  }

  // Day words: today / tomorrow / weekday names
  let dayOffset: number | null = null;
  const dayWord = text.match(/\s(today|tonight|tomorrow|tmr|(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*)\s/i);
  if (!due && dayWord) {
    const w = dayWord[1].toLowerCase();
    if (w === "today" || w === "tonight") dayOffset = 0;
    else if (w === "tomorrow" || w === "tmr") dayOffset = 1;
    else {
      const target = DAYS.indexOf(w.slice(0, 3));
      dayOffset = (target - now.getDay() + 7) % 7 || 7;
    }
    text = text.replace(dayWord[0], " ");
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
      due = new Date(now);
      due.setHours(h, m, 0, 0);
      if (dayOffset !== null) due.setDate(due.getDate() + dayOffset);
      else if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
      text = text.replace(time[0], " ");
    }
  } else if (!due && dayOffset !== null) {
    due = new Date(now);
    due.setHours(dayWord![1].toLowerCase() === "tonight" ? 20 : 9, 0, 0, 0);
    due.setDate(due.getDate() + dayOffset);
  }

  const title = text.replace(/\s+/g, " ").replace(/\s(at|@|on|by)$/i, "").trim();
  return { title: title || input.trim(), dueAt: due ? due.getTime() : null };
}
