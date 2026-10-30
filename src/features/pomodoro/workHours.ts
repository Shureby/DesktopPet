import type { WorkHours } from "../../platform/types";

/**
 * Focus work hours, in local time. Mirrors `run_cutoff` / `current_work_period` in
 * crates/desktoppet-core/src/pomodoro.rs (the app's source of truth); this copy powers the
 * browser mock and the Focus tab.
 */

function at(date: Date, hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** Work periods [start, end) beginning on work days from the day before `t` on, in order. */
function periods(w: WorkHours, t: number): [number, number][] {
  if (!/^\d{1,2}:\d{2}$/.test(w.start) || !/^\d{1,2}:\d{2}$/.test(w.end)) return [];
  const out: [number, number][] = [];
  const day = new Date(t);
  day.setHours(12, 0, 0, 0);
  day.setDate(day.getDate() - 1);
  for (let i = 0; i < 16; i++, day.setDate(day.getDate() + 1)) {
    if (!(w.days & (1 << day.getDay()))) continue;
    const start = at(day, w.start);
    let end = at(day, w.end);
    if (end <= start) {
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      end = at(next, w.end);
    }
    out.push([start, end]);
  }
  return out;
}

/**
 * When a run that started at `started` must stop: the end of the first work period ending
 * after it. Null with work hours off.
 */
export function runCutoff(w: WorkHours, started: number): number | null {
  if (!w.enabled) return null;
  return periods(w, started).find(([, end]) => end > started)?.[1] ?? null;
}

/** The start of the work period `now` is in, if any (with work hours on). */
export function currentWorkPeriod(w: WorkHours, now: number): number | null {
  if (!w.enabled) return null;
  return periods(w, now).find(([s, e]) => s <= now && now < e)?.[0] ?? null;
}
