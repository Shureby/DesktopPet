// The screens the pet lives on (Settings → Screens the pet lives on). The pet stays on the
// ticked screens; dragged onto another one it visits it for a while (VISIT_MS), then goes
// home: across the edge if a ticked screen is next to it, otherwise it vanishes there and
// appears on the nearest ticked screen.

import type { Rect } from "../../engine/geometry";

/** A monitor (the snapshot lists them in the order of its work areas). */
export interface ScreenInfo {
  id: string;
  name: string;
  primary: boolean;
  /** The whole monitor, physical px. */
  frame: Rect;
}

/** How long a visit to an unticked screen lasts before the pet heads home. */
export const VISIT_MS = 10 * 60_000;

/** The screens of a snapshot; made up from the work areas when it has none (the browser preview). */
export function screensOf(snap: { areas: Rect[]; screens?: ScreenInfo[] }): ScreenInfo[] {
  if (snap.screens && snap.screens.length === snap.areas.length) return snap.screens;
  return snap.areas.map((a, i) => ({ id: `area|${a.w}x${a.h}|${a.x},${a.y}`, name: "", primary: i === 0, frame: a }));
}

/**
 * The numbers shown for the screens: Windows' own (\\.\DISPLAY2 is 2, as in its display
 * settings) when every screen has a different one; otherwise the main screen is 1 and the
 * others follow left to right.
 */
export function screenNumbers(screens: ScreenInfo[]): string[] {
  const own = screens.map((s) => /(\d+)\s*$/.exec(s.name)?.[1] ?? "");
  if (own.every((n) => n) && new Set(own).size === own.length) return own.map((n) => String(Number(n)));
  const order = screens
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(b.s.primary) - Number(a.s.primary) || a.s.frame.x - b.s.frame.x || a.s.frame.y - b.s.frame.y);
  const numbers: string[] = new Array(screens.length);
  order.forEach(({ i }, k) => (numbers[i] = String(k + 1)));
  return numbers;
}

/** Which screens the pet lives on: all but the unticked ones (and never none). */
export function allowedScreens(screens: ScreenInfo[], off: string[]): boolean[] {
  const allowed = screens.map((s) => !off.includes(s.id));
  return allowed.some(Boolean) ? allowed : screens.map(() => true);
}

/** Unticking `id` would leave no screen: it can't be unticked. */
export function isLastScreen(screens: ScreenInfo[], off: string[], id: string): boolean {
  return !off.includes(id) && screens.every((s) => s.id === id || off.includes(s.id));
}

/** Where the pet starts: the main screen if ticked, else the first ticked one. */
export function homeScreen(screens: ScreenInfo[], allowed: boolean[]): number {
  const main = screens.findIndex((s) => s.primary);
  if (main >= 0 && allowed[main]) return main;
  const first = allowed.indexOf(true);
  return first >= 0 ? first : 0;
}

/** The ticked screen nearest to the point (x, y). */
export function nearestAllowed(areas: Rect[], allowed: boolean[], x: number, y: number): number {
  let best = -1;
  let bestD = Infinity;
  areas.forEach((a, i) => {
    if (!allowed[i]) return;
    const dx = Math.max(a.x - x, 0, x - (a.x + a.w));
    const dy = Math.max(a.y - y, 0, y - (a.y + a.h));
    const d = dx * dx + dy * dy;
    if (d < bestD) [best, bestD] = [i, d];
  });
  return best;
}

/**
 * A ticked screen right next to screen `from` (sharing a side edge that its floor height can
 * reach), the nearer one to `x` if there are two: the way home on foot.
 */
export function walkHome(areas: Rect[], allowed: boolean[], from: number, x: number): { area: number; side: "left" | "right"; edge: number } | null {
  const a = areas[from];
  if (!a) return null;
  let best: { area: number; side: "left" | "right"; edge: number } | null = null;
  areas.forEach((o, i) => {
    if (i === from || !allowed[i]) return;
    // Side by side, the pet's floor within the other screen's height (a step up or a drop).
    const overlap = Math.min(a.y + a.h, o.y + o.h) - Math.max(a.y, o.y);
    // Feet above its top: no way in on foot.
    if (overlap <= 0 || a.y + a.h <= o.y) return;
    const side = Math.abs(o.x + o.w - a.x) <= 2 ? "left" : Math.abs(o.x - (a.x + a.w)) <= 2 ? "right" : null;
    if (!side) return;
    const edge = side === "left" ? a.x : a.x + a.w;
    if (!best || Math.abs(edge - x) < Math.abs(best.edge - x)) best = { area: i, side, edge };
  });
  return best;
}
