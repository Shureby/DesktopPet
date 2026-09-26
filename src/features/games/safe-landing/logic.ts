import type { GameModifiers } from "../../../characters/abilities/types";
import { createRng, range, type Rng } from "../../../engine/random";

/**
 * Safe Landing: fall from the top of a tall level, steer around spikes, grab
 * umbrellas (slow fall) and coins, and touch down gently on the landing pad.
 * Pure logic in CSS pixels; rendering lives in game.ts.
 */
export interface Item {
  kind: "spike" | "umbrella" | "coin";
  x: number;
  y: number;
  r: number;
  taken?: boolean;
}

export interface SafeLandingState {
  width: number;
  worldHeight: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Player half-size used for collisions. */
  radius: number;
  items: Item[];
  pad: { x: number; w: number };
  umbrella: number;
  coins: number;
  gliding: boolean;
  clinging: boolean;
  time: number;
  status: "playing" | "landed" | "crashed";
  reason: string;
}

export interface SafeLandingInput {
  left: boolean;
  right: boolean;
  /** Hold to glide (only characters with the glide ability). */
  glide: boolean;
}

export const TUNING = {
  gravity: 900,
  maxFall: 650,
  /** Touchdown faster than this crashes. */
  safeSpeed: 240,
  accel: 1500,
  maxSide: 320,
  umbrellaFall: 170,
  umbrellaSeconds: 3.5,
  clingFall: 110,
  screens: 5,
};

export interface SafeLandingOptions {
  width: number;
  height: number;
  seed: number;
  mods: GameModifiers;
  /** Character weight (1 = average). */
  weight: number;
  /** Player collision radius (half the sprite width is a good choice). */
  radius: number;
}

export function createSafeLanding(o: SafeLandingOptions): SafeLandingState {
  const rng = createRng(o.seed);
  const worldHeight = o.height * TUNING.screens;
  const items: Item[] = [];
  // Leave the first screen clear so the player can get their bearings.
  for (let y = o.height * 0.9; y < worldHeight - o.height * 0.35; y += range(rng, 90, 150)) {
    items.push(spawn(rng, o.width, y));
    if (rng() < 0.35) items.push(spawn(rng, o.width, y + range(rng, 20, 60)));
  }
  const padW = Math.max(90, o.width * 0.12);
  const padX = range(rng, padW, o.width - padW);
  // Guarantee umbrellas on the final approach (the last one near the pad) so non-gliders can always win.
  const clampX = (x: number) => Math.max(40, Math.min(o.width - 40, x));
  items.push({ kind: "umbrella", x: range(rng, 40, o.width - 40), y: worldHeight - o.height * 0.9, r: 14 });
  items.push({ kind: "umbrella", x: clampX(padX + range(rng, -200, 200)), y: worldHeight - o.height * 0.55, r: 14 });
  return {
    width: o.width,
    worldHeight,
    x: o.width / 2,
    y: Math.min(120, o.height * 0.15),
    vx: 0,
    vy: 0,
    radius: o.radius,
    items,
    pad: { x: padX, w: padW },
    umbrella: 0,
    coins: 0,
    gliding: false,
    clinging: false,
    time: 0,
    status: "playing",
    reason: "",
  };
}

function spawn(rng: Rng, width: number, y: number): Item {
  const roll = rng();
  const kind = roll < 0.6 ? "spike" : roll < 0.75 ? "umbrella" : "coin";
  const r = kind === "spike" ? range(rng, 16, 28) : 14;
  return { kind, x: range(rng, r + 10, width - r - 10), y, r };
}

export function stepSafeLanding(s: SafeLandingState, input: SafeLandingInput, dt: number, o: Pick<SafeLandingOptions, "mods" | "weight">): void {
  if (s.status !== "playing") return;
  s.time += dt;
  const { mods } = o;

  // Horizontal steering.
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const maxSide = TUNING.maxSide * mods.airControl;
  if (dir) s.vx += dir * TUNING.accel * mods.airControl * dt;
  else s.vx *= Math.max(0, 1 - 6 * dt);
  s.vx = Math.max(-maxSide, Math.min(maxSide, s.vx));
  s.x += s.vx * dt;

  // Walls: wall-grabbers can cling (and slide slowly) while pushing into a wall.
  s.clinging = false;
  if (s.x < s.radius) {
    s.x = s.radius;
    s.vx = 0;
    s.clinging = mods.wallGrab && input.left;
  } else if (s.x > s.width - s.radius) {
    s.x = s.width - s.radius;
    s.vx = 0;
    s.clinging = mods.wallGrab && input.right;
  }

  // Vertical: gravity with a terminal velocity that umbrellas, gliding and clinging lower.
  s.gliding = input.glide && mods.glideFallFactor !== null;
  let maxFall = TUNING.maxFall;
  if (s.gliding) maxFall *= mods.glideFallFactor!;
  if (s.umbrella > 0) maxFall = Math.min(maxFall, TUNING.umbrellaFall);
  if (s.clinging) maxFall = Math.min(maxFall, TUNING.clingFall);
  s.vy += TUNING.gravity * o.weight * dt;
  if (s.vy > maxFall) s.vy = Math.max(maxFall, s.vy - TUNING.gravity * 3 * dt);
  s.y += s.vy * dt;
  s.umbrella = Math.max(0, s.umbrella - dt);

  for (const it of s.items) {
    if (it.taken || Math.abs(it.y - s.y) > it.r + s.radius || Math.abs(it.x - s.x) > it.r + s.radius) continue;
    if (Math.hypot(it.x - s.x, it.y - s.y) > it.r + s.radius * 0.8) continue;
    if (it.kind === "spike") {
      s.status = "crashed";
      s.reason = "Ouch! Spikes.";
      return;
    }
    it.taken = true;
    if (it.kind === "umbrella") s.umbrella = TUNING.umbrellaSeconds;
    else s.coins++;
  }

  if (s.y >= s.worldHeight) {
    s.y = s.worldHeight;
    const onPad = Math.abs(s.x - s.pad.x) <= s.pad.w / 2;
    if (!onPad) {
      s.status = "crashed";
      s.reason = "Missed the landing pad!";
    } else if (s.vy > TUNING.safeSpeed) {
      s.status = "crashed";
      s.reason = "Too fast! Slow down before touchdown.";
    } else {
      s.status = "landed";
      s.reason = "Perfect landing!";
    }
    s.vy = 0;
  }
}

export function scoreSafeLanding(s: SafeLandingState): number {
  const coins = s.coins * 50;
  if (s.status !== "landed") return coins;
  const accuracy = 1 - Math.min(1, Math.abs(s.x - s.pad.x) / (s.pad.w / 2));
  return Math.round(1000 + accuracy * 500 + coins + Math.max(0, 60 - s.time) * 10);
}
