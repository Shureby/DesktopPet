import { DRAG_STEP_PX } from "./timeField";

/**
 * A date field like the time field (src/panel/timeField.ts): day, month and year each change
 * by dragging up or down, the mouse wheel, ↑/↓ or typing. The weekday in front ("Tue") follows
 * the date. Parts are in the system's order (7 Oct 2026, or Oct 7, 2026) and wrap without
 * carrying, like a phone's date wheel; a day past the month's end becomes its last day.
 *
 * The element's `value` is "YYYY-MM-DD", like <input type="date">.
 */

export type DatePart = "day" | "month" | "year";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();
const wrap = (n: number, lo: number, hi: number) => lo + ((((n - lo) % (hi - lo + 1)) + (hi - lo + 1)) % (hi - lo + 1));

export function parseYmd(value: string): { y: number; m: number; d: number } {
  const [y, m, d] = value.split("-").map(Number);
  const now = new Date();
  const yy = Number.isFinite(y) && y > 0 ? y : now.getFullYear();
  const mm = Number.isFinite(m) ? wrap(m, 1, 12) : now.getMonth() + 1;
  const dd = Number.isFinite(d) ? Math.min(Math.max(d, 1), daysIn(yy, mm)) : now.getDate();
  return { y: yy, m: mm, d: dd };
}

export function formatYmd(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(Math.min(d, daysIn(y, m)))}`;
}

/** "YYYY-MM-DD" of the local day `ms` is on. */
export function ymdOf(ms: number): string {
  const t = new Date(ms);
  return formatYmd(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

/** Local midnight of a "YYYY-MM-DD" day. */
export function ymdToMs(value: string): number {
  const { y, m, d } = parseYmd(value);
  return new Date(y, m - 1, d).getTime();
}

/** One part moved by `delta` steps, wrapping without carrying (31 → 1 keeps the month). */
export function stepDate(value: string, part: DatePart, delta: number): string {
  const { y, m, d } = parseYmd(value);
  if (part === "day") return formatYmd(y, m, wrap(d + delta, 1, daysIn(y, m)));
  if (part === "month") return formatYmd(y, wrap(m + delta, 1, 12), d);
  return formatYmd(Math.max(1, y + delta), m, d);
}

/** The parts in the system's order: ["day", "month", "year"] in Australia, month first in the US. */
export function dateOrder(locale?: string): DatePart[] {
  const parts = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).formatToParts(
    new Date(2026, 9, 7),
  );
  const order = parts.map((p) => p.type).filter((t): t is DatePart => t === "day" || t === "month" || t === "year");
  return order.length === 3 ? order : ["day", "month", "year"];
}

/** What a part shows: "7", "Oct", "2026"; and the weekday: "Tue". */
export function datePartText(value: string, part: DatePart | "weekday", locale?: string): string {
  const { y, m, d } = parseYmd(value);
  if (part === "day") return String(d);
  if (part === "year") return String(y);
  const opts: Intl.DateTimeFormatOptions = part === "month" ? { month: "short" } : { weekday: "short" };
  return new Date(y, m - 1, d).toLocaleDateString(locale, opts);
}

/**
 * Typing a digit into a part. `typed` is what was typed into it so far. Returns the new value,
 * what has been typed, and whether the part is complete (focus moves on).
 */
export function typeDateDigit(
  value: string,
  part: DatePart,
  typed: string,
  digit: string,
): { value: string; typed: string; done: boolean } {
  const { y, m, d } = parseYmd(value);
  if (part === "year") {
    const text = typed.length >= 4 ? digit : typed + digit;
    const done = text.length === 4;
    return { value: done ? formatYmd(Number(text), m, d) : value, typed: text, done };
  }
  const max = part === "day" ? daysIn(y, m) : 12;
  let text = typed + digit;
  if (typed.length >= 2 || Number(text) > max) text = digit;
  const n = Number(text);
  const done = text.length >= 2 || n * 10 > max;
  if (n < 1) return { value, typed: text, done: false };
  return { value: part === "day" ? formatYmd(y, m, n) : formatYmd(y, n, d), typed: text, done };
}

export type DateFieldElement = HTMLElement & { value: string };

/**
 * The field itself. `onChange` runs after each change, `value` is "YYYY-MM-DD". With
 * `year: false` it's a day of the year (anniversaries): no year or weekday, and the year in
 * `value` is 2000, a leap year, so Feb 29 can be picked.
 */
export function dateField(
  initial: string,
  onChange?: (value: string) => void,
  label = "Date",
  opts: { year?: boolean } = {},
): DateFieldElement {
  const { y, m, d } = parseYmd(initial);
  let value = formatYmd(y, m, d);
  const root = document.createElement("span") as unknown as DateFieldElement;
  root.className = "time-field date-field";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", label);
  const weekday = document.createElement("span");
  weekday.className = "weekday";
  root.append(weekday);
  const withYear = opts.year !== false;
  if (!withYear) weekday.hidden = true;
  const parts = dateOrder().filter((p) => withYear || p !== "year");
  const els = new Map<DatePart, HTMLElement>();

  const paint = () => {
    weekday.textContent = datePartText(value, "weekday");
    for (const [part, el] of els) {
      el.textContent = datePartText(value, part);
      el.setAttribute("aria-valuetext", el.textContent);
    }
  };
  const set = (next: string) => {
    if (next === value) return;
    value = next;
    paint();
    onChange?.(value);
  };

  parts.forEach((part, i) => {
    const el = document.createElement("span");
    el.className = `part ${part}`;
    el.tabIndex = 0;
    el.setAttribute("role", "spinbutton");
    el.setAttribute("aria-label", part);
    el.title = "Drag up or down, scroll, or type";
    els.set(part, el);
    root.append(el);

    // Drag: up is more. The value follows the pointer from where the drag began.
    let drag: { y: number; from: string } | null = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.focus();
      el.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, from: value };
      el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      set(stepDate(drag.from, part, Math.trunc((drag.y - e.clientY) / DRAG_STEP_PX)));
    });
    const end = () => {
      drag = null;
      el.classList.remove("dragging");
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        set(stepDate(value, part, e.deltaY < 0 ? 1 : -1));
      },
      { passive: false },
    );

    let typed = "";
    el.addEventListener("focus", () => (typed = ""));
    el.addEventListener("keydown", (e) => {
      const next = els.get(parts[i + 1]);
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        set(stepDate(value, part, e.key === "ArrowUp" ? 1 : -1));
      } else if (/^\d$/.test(e.key)) {
        e.preventDefault();
        const r = typeDateDigit(value, part, typed, e.key);
        typed = r.typed;
        set(r.value);
        if (r.done && next) next.focus();
      } else if ((e.key === "/" || e.key === "-" || e.key === ".") && next) {
        e.preventDefault();
        next.focus();
      }
    });
  });
  paint();

  Object.defineProperty(root, "value", {
    get: () => value,
    set: (v: string) => {
      const p = parseYmd(v);
      value = formatYmd(p.y, p.m, p.d);
      paint();
    },
  });
  root.focus = () => els.get(parts[0])?.focus();
  return root;
}
