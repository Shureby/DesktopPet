/** Axis-aligned rectangle in physical screen pixels (y grows downward). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A visible desktop window. Lists of these are ordered front-to-back (z-order). */
export interface WindowRect extends Rect {
  id: string;
}

export const right = (r: Rect) => r.x + r.w;
export const bottom = (r: Rect) => r.y + r.h;

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < right(r) && y >= r.y && y < bottom(r);
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
