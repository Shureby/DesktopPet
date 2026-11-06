import { weekdayName, weekdayNarrow, weekOrder } from "../i18n/format";
import { t } from "../i18n";
import type { DayMask } from "../platform/types";

/** The days in the language's order (Monday first, Sunday first in Taiwan), as bits of a DayMask (Sunday = bit 0). */
export function week(): number[] {
  return weekOrder();
}

/**
 * Seven round toggles, M T W T F S S, for an alarm's repeat days and the focus work days.
 * `onChange` gets the new mask; unticking the last day is allowed (the caller decides).
 */
export function dayPicker(mask: DayMask, onChange: (mask: DayMask) => void): HTMLElement & { setMask(mask: DayMask): void } {
  const root = document.createElement("div") as unknown as HTMLElement & { setMask(mask: DayMask): void };
  const painters: (() => void)[] = [];
  root.className = "day-picker";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", t("Days"));
  let current = mask;
  for (const day of week()) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = weekdayNarrow(day);
    b.title = weekdayName(day);
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
    painters.push(paint);
    root.append(b);
  }
  /** Shows another set of days (e.g. Weekdays chosen from a menu) without calling onChange. */
  root.setMask = (m: DayMask) => {
    current = m;
    painters.forEach((p) => p());
  };
  return root;
}
