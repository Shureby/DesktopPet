import type { Rng } from "../../../engine/random";
import type { Level } from "../levels";

/**
 * Pet Crossing (docs/INTERACTIONS.md, "Pet Crossing"): the pet hops up a board of lanes, one
 * cell a hop — past things moving along the road, then on things sliding along the river —
 * to the goal at the top. Positions are in cells; nothing here draws.
 */
export const COLS = 9;
export const ROWS = 11;
export const START_ROW = ROWS - 1;
export const GOAL_ROW = 0;
export const LIVES = 3;
/** The last level of the first run; after it the pet asks about endless levels. */
export const LAST_LEVEL = 20;
/** How long the pet lies there after a mishap, or cheers at the goal, before the game goes on. */
export const HOLD = 0.9;

export type RowKind = "goal" | "river" | "safe" | "road";

/** Top to bottom: the goal, three river lanes, a safe strip, four road lanes, a safe strip, the start. */
export function rowKind(row: number): RowKind {
  if (row === GOAL_ROW) return "goal";
  if (row >= 1 && row <= 3) return "river";
  if (row >= 5 && row <= 8) return "road";
  return "safe";
}

/** What the lanes look like (src/features/games/crossing/themes.ts draws them). More can be added. */
export const THEMES = ["cute", "traffic", "office"] as const;
export type ThemeId = (typeof THEMES)[number];
/** What you pick: one theme for the whole game, or another one each level. */
export type ThemeChoice = ThemeId | "random";
export const THEME_CHOICES: readonly ThemeChoice[] = [...THEMES, "random"];

export function parseTheme(v: unknown): ThemeChoice {
  return THEME_CHOICES.find((c) => c === v) ?? "cute";
}

/** Per difficulty: seconds for a level, and the lanes' speeds at level 1 (cells a second). */
export const TUNING: Record<Level, { time: number; road: number; river: number }> = {
  easy: { time: 55, road: 0.5, river: 0.45 },
  normal: { time: 40, road: 0.78, river: 0.68 },
  strong: { time: 28, road: 1.14, river: 1.0 },
};

/** Each level is this much faster than level 1 (7% a level, at most three times). */
export function speedScale(level: number): number {
  return Math.min(3, 1 + 0.07 * (level - 1));
}

/**
 * A lane: `count` things of `width` cells, evenly `gap` cells apart (count × gap = COLS, so
 * they come round again), all moving one way. On the road they must not touch the pet; on
 * the river the pet must stand on one.
 */
export interface Lane {
  kind: "road" | "river";
  dir: 1 | -1;
  speed: number;
  width: number;
  count: number;
  gap: number;
  /** How far the lane has moved (cells). */
  offset: number;
  /** Which picture each thing shows (an index the theme wraps). */
  looks: number[];
}

export type Cause = "hit" | "fell" | "time";
export type Dir = "up" | "down" | "left" | "right";
export type Phase = "playing" | "dead" | "won" | "over" | "cleared";

export interface State {
  difficulty: Level;
  choice: ThemeChoice;
  theme: ThemeId;
  level: number;
  lives: number;
  score: number;
  /** Seconds left in this level. */
  time: number;
  /** The furthest row reached in this level (a row counts once). */
  bestRow: number;
  endless: boolean;
  /** The pet: its left edge (cells; on the river it rides, so not whole) and its row. */
  x: number;
  row: number;
  lanes: (Lane | null)[];
  phase: Phase;
  /** Seconds left of "dead" or "won". */
  hold: number;
  cause: Cause | null;
}

export type Event = "hop" | "died" | "respawn" | "level" | "over" | "cleared";

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Where thing `i` of a lane is: its left edge, and again a board to the left where it wraps round. */
export function itemXs(lane: Lane, i: number): number[] {
  const x = mod(i * lane.gap + lane.offset, COLS);
  return x + lane.width > COLS ? [x, x - COLS] : [x];
}

/** The platform under the pet's middle on a river lane, if any. */
export function standsOn(lane: Lane, x: number): boolean {
  const mid = x + 0.5;
  for (let i = 0; i < lane.count; i++) for (const px of itemXs(lane, i)) if (mid >= px + 0.08 && mid <= px + lane.width - 0.08) return true;
  return false;
}

/** Whether something on a road lane touches the pet (a little forgiving at the edges). */
export function touches(lane: Lane, x: number): boolean {
  const a = x + 0.16;
  const b = x + 0.84;
  for (let i = 0; i < lane.count; i++) for (const ox of itemXs(lane, i)) if (b > ox + 0.1 && a < ox + lane.width - 0.1) return true;
  return false;
}

function buildLane(kind: "road" | "river", row: number, s: Pick<State, "difficulty" | "level">, rng: Rng): Lane {
  const tune = TUNING[s.difficulty];
  const scale = speedScale(s.level);
  // Three small things, or two bigger ones: always room to pass between (road), or to stand (river).
  const three = rng() < 0.6;
  const count = three ? 3 : 2;
  const width = kind === "road" ? (three ? 1 : rng() < 0.5 ? 1 : 2) : three ? 2 : 3;
  const base = kind === "road" ? tune.road : tune.river;
  return {
    kind,
    dir: row % 2 ? 1 : -1,
    speed: base * scale * (0.85 + 0.3 * rng()),
    width,
    count,
    gap: COLS / count,
    offset: rng() * COLS,
    looks: Array.from({ length: count }, () => Math.floor(rng() * 1000)),
  };
}

/** The lanes of the state's level, the pet at the start, the clock full. */
function buildLevel(s: State, rng: Rng): void {
  if (s.choice === "random") {
    // Another one than the last level's.
    const others = THEMES.filter((id) => id !== s.theme || s.level === 1);
    s.theme = others[Math.floor(rng() * others.length)];
  } else s.theme = s.choice;
  s.lanes = Array.from({ length: ROWS }, (_, row) => {
    const kind = rowKind(row);
    return kind === "road" || kind === "river" ? buildLane(kind, row, s, rng) : null;
  });
  s.bestRow = START_ROW;
  s.time = TUNING[s.difficulty].time;
  toStart(s);
}

function toStart(s: State): void {
  s.x = Math.floor(COLS / 2);
  s.row = START_ROW;
  s.phase = "playing";
  s.hold = 0;
  s.cause = null;
}

export function newGame(difficulty: Level, choice: ThemeChoice, rng: Rng): State {
  const s: State = {
    difficulty,
    choice,
    theme: "cute",
    level: 1,
    lives: LIVES,
    score: 0,
    time: 0,
    bestRow: START_ROW,
    endless: false,
    x: 0,
    row: START_ROW,
    lanes: [],
    phase: "playing",
    hold: 0,
    cause: null,
  };
  buildLevel(s, rng);
  return s;
}

function die(s: State, cause: Cause): Event[] {
  s.lives--;
  s.phase = "dead";
  s.hold = HOLD;
  s.cause = cause;
  return ["died"];
}

/** One hop. A row further up than ever in this level scores the level's number. */
export function move(s: State, dir: Dir): Event[] {
  if (s.phase !== "playing") return [];
  let { x, row } = s;
  if (dir === "up") row--;
  else if (dir === "down") row++;
  else x += dir === "left" ? -1 : 1;
  row = Math.max(GOAL_ROW, Math.min(START_ROW, row));
  // Off the river the pet stands in a cell; on it, where it stepped.
  if (rowKind(row) !== "river") x = Math.round(x);
  x = Math.max(0, Math.min(COLS - 1, x));
  if (x === s.x && row === s.row) return [];
  s.x = x;
  s.row = row;
  if (row < s.bestRow) {
    s.score += (s.bestRow - row) * s.level;
    s.bestRow = row;
  }
  if (row === GOAL_ROW) {
    // The seconds left count too.
    s.score += Math.ceil(s.time) * s.level;
    s.phase = "won";
    s.hold = HOLD;
    return ["hop", "level"];
  }
  return ["hop"];
}

/** Time passing: the lanes move, the clock runs, and the pet rides, falls or is bumped. */
export function step(s: State, dt: number, rng: Rng): Event[] {
  if (s.phase === "over" || s.phase === "cleared") return [];
  const advance = () => {
    for (const lane of s.lanes) if (lane) lane.offset += lane.dir * lane.speed * dt;
  };
  if (s.phase === "dead" || s.phase === "won") {
    advance();
    s.hold -= dt;
    if (s.hold > 0) return [];
    if (s.phase === "dead") {
      if (s.lives <= 0) {
        s.phase = "over";
        return ["over"];
      }
      // Back at the start, the clock full again; the rows already reached stay counted.
      s.time = TUNING[s.difficulty].time;
      toStart(s);
      return ["respawn"];
    }
    if (s.level >= LAST_LEVEL && !s.endless) {
      s.phase = "cleared";
      return ["cleared"];
    }
    s.level++;
    buildLevel(s, rng);
    return [];
  }
  s.time -= dt;
  if (s.time <= 0) {
    s.time = 0;
    advance();
    return die(s, "time");
  }
  const lane = s.lanes[s.row];
  // What it stands on carries it along (so: where it stood before this moment).
  const afloat = lane?.kind === "river" && standsOn(lane, s.x);
  advance();
  if (lane?.kind === "river") {
    if (!afloat) return die(s, "fell");
    s.x += lane.dir * lane.speed * dt;
    // Carried off the side.
    if (s.x < -0.5 || s.x > COLS - 0.5) return die(s, "fell");
  } else if (lane?.kind === "road" && touches(lane, s.x)) return die(s, "hit");
  return [];
}

/** After the last level: on into endless levels. */
export function goEndless(s: State, rng: Rng): void {
  if (s.phase !== "cleared") return;
  s.endless = true;
  s.level++;
  buildLevel(s, rng);
}

/** After the last level: enough. */
export function stopHere(s: State): void {
  if (s.phase === "cleared") s.phase = "over";
}
