import { clock } from "../features/alarm/ringing";

/**
 * A time field like a phone's time wheel: hour, minute and (on a 12-hour system) AM/PM.
 * Each part changes by dragging it up or down, the mouse wheel, ↑/↓ or typing. The system
 * <input type="time"> only takes the wheel, and dragging a number does nothing
 * (docs/INTERACTIONS.md, "Time fields").
 *
 * The element's `value` is "HH:MM" (24-hour), like <input type="time">.
 */

export type Part = "hour" | "minute" | "period";

/** Pixels of dragging per step. */
export const DRAG_STEP_PX = 8;

/** True when the system shows times as "1:05 PM" rather than "13:05". */
export function uses12Hour(): boolean {
  return !clock(new Date(2020, 0, 1, 13, 5).getTime()).includes("13");
}

export function parseHm(value: string): { h: number; m: number } {
  const [h, m] = value.split(":").map(Number);
  return { h: Number.isFinite(h) ? ((h % 24) + 24) % 24 : 0, m: Number.isFinite(m) ? ((m % 60) + 60) % 60 : 0 };
}

export function formatHm(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const wrap = (n: number, size: number) => ((n % size) + size) % size;

/**
 * One part moved by `delta` steps. Parts wrap without carrying (59 → 00 keeps the hour), and
 * on a 12-hour clock the hour wraps 12 → 1 keeping AM/PM, like a phone's wheel.
 */
export function stepPart(value: string, part: Part, delta: number, twelveHour: boolean): string {
  const { h, m } = parseHm(value);
  if (part === "minute") return formatHm(h, wrap(m + delta, 60));
  if (part === "period") return delta % 2 === 0 ? value : formatHm(wrap(h + 12, 24), m);
  if (!twelveHour) return formatHm(wrap(h + delta, 24), m);
  const pm = h >= 12;
  return formatHm(wrap(h + delta, 12) + (pm ? 12 : 0), m);
}

/** What a part shows: "9", "05", "PM". */
export function partText(value: string, part: Part, twelveHour: boolean): string {
  const { h, m } = parseHm(value);
  if (part === "minute") return String(m).padStart(2, "0");
  if (part === "period") return h >= 12 ? "PM" : "AM";
  return twelveHour ? String(h % 12 || 12) : String(h).padStart(2, "0");
}

/**
 * Typing a digit into a part. `typed` is what was typed into it so far. Returns the new
 * value, what has been typed, and whether the part is complete (focus moves on).
 */
export function typeDigit(
  value: string,
  part: "hour" | "minute",
  typed: string,
  digit: string,
  twelveHour: boolean,
): { value: string; typed: string; done: boolean } {
  const { h, m } = parseHm(value);
  const max = part === "minute" ? 59 : twelveHour ? 12 : 23;
  const min = part === "hour" && twelveHour ? 1 : 0;
  let text = typed + digit;
  if (typed.length >= 2 || Number(text) > max) text = digit;
  const n = Number(text);
  const done = text.length >= 2 || n * 10 > max;
  if (n < min) return { value, typed: text, done: false };
  if (part === "minute") return { value: formatHm(h, n), typed: text, done };
  const hour = twelveHour ? (n % 12) + (h >= 12 ? 12 : 0) : n;
  return { value: formatHm(hour, m), typed: text, done };
}

export type TimeFieldElement = HTMLElement & { value: string };

/** The field itself. `onChange` runs after each change (like "input"), `value` is "HH:MM". */
export function timeField(initial: string, onChange?: (value: string) => void, label = "Time"): TimeFieldElement {
  const twelve = uses12Hour();
  let value = formatHm(parseHm(initial).h, parseHm(initial).m);
  const root = document.createElement("span") as unknown as TimeFieldElement;
  root.className = "time-field";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", label);
  const parts: Part[] = twelve ? ["hour", "minute", "period"] : ["hour", "minute"];
  const els = new Map<Part, HTMLElement>();

  const paint = () => {
    for (const [part, el] of els) {
      el.textContent = partText(value, part, twelve);
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
    if (part === "minute") root.append(Object.assign(document.createElement("span"), { className: "sep", textContent: ":" }));
    const el = document.createElement("span");
    el.className = `part ${part}`;
    el.tabIndex = 0;
    el.setAttribute("role", "spinbutton");
    el.setAttribute("aria-label", part === "period" ? "AM/PM" : part);
    el.title = "Drag up or down, scroll, or type";
    els.set(part, el);
    root.append(el);

    // Drag: up is more. The value follows the pointer from where the drag began.
    let drag: { y: number; from: string; moved: boolean } | null = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.focus();
      el.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, from: value, moved: false };
      el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const steps = Math.trunc((drag.y - e.clientY) / DRAG_STEP_PX);
      if (steps !== 0) drag.moved = true;
      set(stepPart(drag.from, part, steps, twelve));
    });
    const end = () => {
      // A click without dragging flips AM/PM.
      if (drag && !drag.moved && part === "period") set(stepPart(value, part, 1, twelve));
      drag = null;
      el.classList.remove("dragging");
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        set(stepPart(value, part, e.deltaY < 0 ? 1 : -1, twelve));
      },
      { passive: false },
    );

    let typed = "";
    el.addEventListener("focus", () => (typed = ""));
    el.addEventListener("keydown", (e) => {
      const next = els.get(parts[i + 1]);
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        set(stepPart(value, part, e.key === "ArrowUp" ? 1 : -1, twelve));
      } else if (part !== "period" && /^\d$/.test(e.key)) {
        e.preventDefault();
        const r = typeDigit(value, part, typed, e.key, twelve);
        typed = r.typed;
        set(r.value);
        if (r.done && next) next.focus();
      } else if (part === "period" && /^[ap]$/i.test(e.key)) {
        e.preventDefault();
        const pm = e.key.toLowerCase() === "p";
        if (pm !== parseHm(value).h >= 12) set(stepPart(value, "period", 1, twelve));
      } else if (e.key === ":" && next) {
        e.preventDefault();
        next.focus();
      }
    });
  });
  paint();

  Object.defineProperty(root, "value", {
    get: () => value,
    set: (v: string) => {
      value = formatHm(parseHm(v).h, parseHm(v).m);
      paint();
    },
  });
  root.focus = () => els.get("hour")?.focus();
  return root;
}
