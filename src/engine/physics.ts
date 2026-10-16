import { bottom, contains, right, type Rect, type WindowRect } from "./geometry";

/**
 * The desktop as the pet sees it: monitor work areas (floors and walls) and
 * other applications' windows (whose top edges are platforms), front-to-back.
 */
export interface World {
  areas: Rect[];
  windows: WindowRect[];
}

export type Support =
  | { kind: "floor"; area: number }
  /** Standing on a window's top edge; `dx` is the feet offset from the window's left edge. */
  | { kind: "window"; id: string; dx: number };

/**
 * A physics body. `x` is the horizontal centre and `y` is the feet
 * (bottom edge), which keeps floor/platform maths trivial.
 */
export interface Body {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  support: Support | null;
}

export interface PhysicsOptions {
  /** px/s², already multiplied by the display scale. */
  gravity: number;
  /** Character weight: heavier characters fall faster and are thrown less far. */
  gravityScale: number;
  /** Terminal fall speed in px/s (abilities like glide lower this). */
  maxFallSpeed: number;
  /** Horizontal velocity decay per second while airborne (0..1). */
  airDrag: number;
}

export type Side = "left" | "right";

export interface StepResult {
  landed: boolean;
  lostSupport: boolean;
  hitWall: Side | null;
  /** Grounded body walked across the side edge of a window taller than itself. */
  crossedWindowSide: { id: string; side: Side; x: number; top: number } | null;
}

/** Minimum distance between a window top and its work area's top for it to count as a platform. */
const MIN_PLATFORM_CLEARANCE = 24;

export function areaIndexAt(world: World, x: number, y: number): number {
  for (let i = 0; i < world.areas.length; i++) {
    if (contains(world.areas[i], x, y)) return i;
  }
  return -1;
}

/** Nearest work area to a point (used when the body is momentarily outside all of them). */
export function nearestAreaIndex(world: World, x: number, y: number): number {
  let best = -1;
  let bestDist = Infinity;
  world.areas.forEach((a, i) => {
    const dx = x < a.x ? a.x - x : x > right(a) ? x - right(a) : 0;
    const dy = y < a.y ? a.y - y : y > bottom(a) ? y - bottom(a) : 0;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/**
 * Whether the top edge of `world.windows[index]` is a usable platform at `x`:
 * horizontally within the window, on screen, not hugging the screen top
 * (maximised windows) and not covered by a window in front of it.
 */
export function isPlatformAt(world: World, index: number, x: number): boolean {
  const win = world.windows[index];
  if (x < win.x || x > right(win)) return false;
  const area = areaIndexAt(world, x, win.y);
  if (area < 0 || win.y - world.areas[area].y < MIN_PLATFORM_CLEARANCE) return false;
  for (let j = 0; j < index; j++) {
    const front = world.windows[j];
    if (x >= front.x && x <= right(front) && win.y > front.y && win.y < bottom(front)) return false;
  }
  return true;
}

function findWindow(world: World, id: string): number {
  return world.windows.findIndex((w) => w.id === id);
}

/** Areas are walls unless another area continues on that side at the body's height. */
function horizontalLimits(world: World, areaIdx: number, y: number): [number, number] {
  const a = world.areas[areaIdx];
  let min = a.x;
  let max = right(a);
  for (const other of world.areas) {
    if (other === a || y <= other.y || y > bottom(other)) continue;
    if (Math.abs(right(other) - a.x) <= 2) min = Math.min(min, other.x);
    if (Math.abs(other.x - right(a)) <= 2) max = Math.max(max, right(other));
  }
  return [min, max];
}

export function createBody(x: number, y: number, w: number, h: number): Body {
  return { x, y, w, h, vx: 0, vy: 0, support: null };
}

/**
 * Re-validates the body's support after the world changed (windows moved,
 * closed or got covered). Riding a moving window carries the body with it.
 * Returns false if the support is gone.
 */
export function refreshSupport(body: Body, world: World): boolean {
  const s = body.support;
  if (!s) return false;
  if (s.kind === "floor") {
    const area = world.areas[s.area];
    if (!area || Math.abs(bottom(area) - body.y) > 1 || body.x < area.x || body.x > right(area)) {
      const idx = areaIndexAt(world, body.x, body.y - 1);
      if (idx >= 0 && Math.abs(bottom(world.areas[idx]) - body.y) <= 1) {
        body.support = { kind: "floor", area: idx };
        return true;
      }
      body.support = null;
      return false;
    }
    return true;
  }
  const idx = findWindow(world, s.id);
  if (idx < 0) {
    body.support = null;
    return false;
  }
  const win = world.windows[idx];
  body.x = win.x + s.dx;
  body.y = win.y;
  if (!isPlatformAt(world, idx, body.x)) {
    body.support = null;
    return false;
  }
  return true;
}

/** Advance the body by `dt` seconds. Horizontal walking speed is whatever `vx` the caller set. */
export function step(body: Body, world: World, dt: number, opt: PhysicsOptions): StepResult {
  const result: StepResult = { landed: false, lostSupport: false, hitWall: null, crossedWindowSide: null };
  if (world.areas.length === 0) return result;

  if (body.support) {
    if (!refreshSupport(body, world)) {
      result.lostSupport = true;
    } else {
      stepGrounded(body, world, dt, result);
      return result;
    }
  }
  stepAirborne(body, world, dt, opt, result);
  return result;
}

function stepGrounded(body: Body, world: World, dt: number, result: StepResult) {
  const s = body.support!;
  const oldX = body.x;
  let newX = body.x + body.vx * dt;
  const areaIdx = s.kind === "floor" ? s.area : Math.max(0, nearestAreaIndex(world, body.x, body.y - 1));
  const [minX, maxX] = horizontalLimits(world, areaIdx, body.y);
  const half = body.w / 2;

  if (newX - half < minX) {
    newX = minX + half;
    result.hitWall = "left";
  } else if (newX + half > maxX) {
    newX = maxX - half;
    result.hitWall = "right";
  }
  body.x = newX;

  if (s.kind === "window") {
    const idx = findWindow(world, s.id);
    const win = world.windows[idx];
    s.dx = body.x - win.x;
    if (!isPlatformAt(world, idx, body.x)) {
      body.support = null;
      result.lostSupport = true;
    }
    return;
  }

  // Walking onto a neighbouring monitor.
  const nowIn = areaIndexAt(world, body.x, body.y - 1);
  if (nowIn >= 0 && nowIn !== s.area) {
    if (Math.abs(bottom(world.areas[nowIn]) - body.y) <= 1) s.area = nowIn;
    else {
      body.support = null;
      result.lostSupport = true;
      return;
    }
  }

  // Report window sides that are tall enough to climb.
  for (let i = 0; i < world.windows.length; i++) {
    const win = world.windows[i];
    if (win.y >= body.y - body.h || bottom(win) < body.y - 4) continue;
    for (const side of ["left", "right"] as const) {
      const edge = side === "left" ? win.x : right(win);
      if ((oldX < edge && body.x >= edge) || (oldX > edge && body.x <= edge)) {
        result.crossedWindowSide = { id: win.id, side, x: edge, top: win.y };
        return;
      }
    }
  }
}

function stepAirborne(body: Body, world: World, dt: number, opt: PhysicsOptions, result: StepResult) {
  body.vy = Math.min(body.vy + opt.gravity * opt.gravityScale * dt, opt.maxFallSpeed);
  body.vx *= Math.max(0, 1 - opt.airDrag * dt);
  const oldY = body.y;
  let newX = body.x + body.vx * dt;
  let newY = body.y + body.vy * dt;

  let areaIdx = areaIndexAt(world, newX, newY - body.h / 2);
  if (areaIdx < 0) areaIdx = nearestAreaIndex(world, newX, newY);
  const area = world.areas[areaIdx];
  const [minX, maxX] = horizontalLimits(world, areaIdx, Math.min(newY, bottom(area)));
  const half = body.w / 2;
  if (newX - half < minX) {
    newX = minX + half;
    body.vx = Math.abs(body.vx) * 0.3;
    result.hitWall = "left";
  } else if (newX + half > maxX) {
    newX = maxX - half;
    body.vx = -Math.abs(body.vx) * 0.3;
    result.hitWall = "right";
  }
  if (newY - body.h < area.y && body.vy < 0) {
    newY = area.y + body.h;
    body.vy = 0;
  }

  if (body.vy >= 0) {
    // Find the highest surface crossed this step.
    let landY = Infinity;
    let support: Support | null = null;
    for (let i = 0; i < world.windows.length; i++) {
      const top = world.windows[i].y;
      if (oldY <= top && newY >= top && top < landY && isPlatformAt(world, i, newX)) {
        landY = top;
        support = { kind: "window", id: world.windows[i].id, dx: newX - world.windows[i].x };
      }
    }
    const floor = bottom(area);
    if (newY >= floor && floor < landY) {
      landY = floor;
      support = { kind: "floor", area: areaIdx };
    }
    if (support) {
      newY = landY;
      body.vy = 0;
      body.vx = 0;
      body.support = support;
      result.landed = true;
    }
  }
  body.x = newX;
  body.y = newY;
}
