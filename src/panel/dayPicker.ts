import type { DayMask } from "../platform/types";

/** Monday first, as bits of a DayMask (Sunday = bit 0). */
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Seven round toggles, M T W T F S S, for an alarm's repeat days and the focus work days.
 * `onChange` gets the new mask; unticking the last day is allowed (the caller decides).
 */
export function dayPicker(mask: DayMask, onChange: (mask: DayMask) => void): HTMLElement {
  const root = document.createElement("div");
  root.className = "day-picker";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Days");
  let current = mask;
  for (const day of WEEK) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = NAMES[day][0];
    b.title = NAMES[day];
    const paint = () => {
      const on = (current & (1 << day)) !== 0;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    };
    b.addEventListener("click", () => {
      current ^= 1 << day;
      paint();
      onChange(current);
    });
    paint();
    root.append(b);
  }
  return root;
}
