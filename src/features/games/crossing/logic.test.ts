import { describe, expect, it } from "vitest";
import { createRng } from "../../../engine/random";
import {
  COLS,
  GOAL_ROW,
  goEndless,
  HOLD,
  itemXs,
  LAST_LEVEL,
  LIVES,
  move,
  newGame,
  parseTheme,
  rowKind,
  ROWS,
  speedScale,
  standsOn,
  START_ROW,
  step,
  stopHere,
  THEMES,
  touches,
  TUNING,
  type Lane,
  type State,
} from "./logic";

const rng = () => createRng(7);

/** A game whose lanes stand still: nothing on the road, the river covered. */
function calm(s: State): State {
  for (const lane of s.lanes) {
    if (!lane) continue;
    lane.speed = 0;
    lane.offset = 0;
    if (lane.kind === "road") lane.count = 0;
    else Object.assign(lane, { count: 1, gap: COLS, width: COLS });
  }
  return s;
}

/** Hops to the goal and waits out the cheer. */
function cross(s: State, r = rng()): void {
  while (s.row > GOAL_ROW) move(s, "up");
  step(s, HOLD + 0.01, r);
}

describe("[cross.board] the board", () => {
  it("is the goal, three river lanes, a safe strip, four road lanes, a safe strip and the start", () => {
    const kinds = Array.from({ length: ROWS }, (_, r) => rowKind(r));
    expect(kinds).toEqual(["goal", "river", "river", "river", "safe", "road", "road", "road", "road", "safe", "safe"]);
    const s = newGame("normal", "cute", rng());
    expect(s.lanes.map((l) => l?.kind ?? null)).toEqual([null, "river", "river", "river", null, "road", "road", "road", "road", null, null]);
    expect([s.x, s.row, s.lives, s.level, s.score]).toEqual([4, START_ROW, LIVES, 1, 0]);
  });

  it("always leaves room: two cells between things on the road, two to stand on at the river, neighbours opposite ways", () => {
    for (let seed = 1; seed < 40; seed++) {
      const s = newGame("strong", "random", createRng(seed));
      s.lanes.forEach((lane, row) => {
        if (!lane) return;
        expect(lane.count * lane.gap).toBeCloseTo(COLS);
        if (lane.kind === "road") expect(lane.gap - lane.width).toBeGreaterThanOrEqual(2);
        else expect(lane.width).toBeGreaterThanOrEqual(2);
        const next = s.lanes[row + 1];
        if (next) expect(next.dir).toBe(-lane.dir);
      });
    }
  });

  it("is faster each level (7%), at most three times; harder difficulties are faster with less time", () => {
    expect(speedScale(1)).toBe(1);
    expect(speedScale(2)).toBeCloseTo(1.07);
    expect(speedScale(20)).toBeCloseTo(2.33);
    expect(speedScale(200)).toBe(3);
    expect(TUNING.easy.road).toBeLessThan(TUNING.normal.road);
    expect(TUNING.normal.road).toBeLessThan(TUNING.strong.road);
    expect(TUNING.easy.time).toBeGreaterThan(TUNING.strong.time);
    // The time for a level doesn't shrink.
    const s = calm(newGame("normal", "cute", rng()));
    cross(s);
    expect(s.level).toBe(2);
    expect(s.time).toBe(TUNING.normal.time);
  });

  it("things come round again", () => {
    const lane: Lane = { kind: "road", dir: 1, speed: 1, width: 2, count: 2, gap: 4.5, offset: 8, looks: [0, 0] };
    expect(itemXs(lane, 0)).toEqual([8, -1]);
    expect(itemXs(lane, 1)).toEqual([3.5]);
  });
});

describe("[cross.move] hopping", () => {
  it("goes one cell each way, back too, and stays on the board", () => {
    const s = calm(newGame("normal", "cute", rng()));
    expect(move(s, "down")).toEqual([]);
    expect(move(s, "up")).toEqual(["hop"]);
    expect(s.row).toBe(START_ROW - 1);
    move(s, "down");
    expect(s.row).toBe(START_ROW);
    for (let i = 0; i < 12; i++) move(s, "left");
    expect(s.x).toBe(0);
    for (let i = 0; i < 12; i++) move(s, "right");
    expect(s.x).toBe(COLS - 1);
  });

  it("is bumped by what's on the road, not by what's beside it", () => {
    const lane: Lane = { kind: "road", dir: 1, speed: 0, width: 1, count: 3, gap: 3, offset: 0, looks: [] };
    expect(touches(lane, 0)).toBe(true);
    expect(touches(lane, 0.5)).toBe(true);
    // A little forgiving at the edges.
    expect(touches(lane, 0.8)).toBe(false);
    expect(touches(lane, 1)).toBe(false);
    expect(touches(lane, 2)).toBe(false);
    expect(touches(lane, 3)).toBe(true);
  });

  it("rides what it stands on at the river, falls where there's nothing, and is carried off the side", () => {
    const s = calm(newGame("normal", "cute", rng()));
    while (s.row > 3) move(s, "up");
    const lane = s.lanes[3]!;
    Object.assign(lane, { count: 1, gap: COLS, width: 2, offset: 4, speed: 1, dir: 1 });
    expect(standsOn(lane, 4)).toBe(true);
    expect(standsOn(lane, 6)).toBe(false);
    expect(step(s, 0.5, rng())).toEqual([]);
    expect(s.x).toBeCloseTo(4.5);
    // Off the river it stands in a cell again.
    move(s, "down");
    expect(s.x).toBe(5);
    move(s, "up");
    step(s, 0, rng());
    expect(s.phase).toBe("playing");
    // Carried off.
    lane.speed = 10;
    expect(step(s, 0.5, rng())).toEqual(["died"]);
    expect(s.cause).toBe("fell");
    // Stepping where nothing is.
    const u = calm(newGame("normal", "cute", rng()));
    while (u.row > 4) move(u, "up");
    Object.assign(u.lanes[3]!, { count: 1, gap: COLS, width: 2, offset: 0 });
    move(u, "up");
    expect(step(u, 0, rng())).toEqual(["died"]);
    expect(u.cause).toBe("fell");
  });
});

describe("[cross.score] lives, time and the score", () => {
  it("scores the level's number for each new row, and the seconds left × the level at the goal", () => {
    const s = calm(newGame("normal", "cute", rng()));
    move(s, "up");
    move(s, "up");
    expect(s.score).toBe(2);
    // The same rows again: nothing.
    move(s, "down");
    move(s, "up");
    expect(s.score).toBe(2);
    step(s, 9.5, rng());
    while (s.row > GOAL_ROW) move(s, "up");
    expect(s.phase).toBe("won");
    expect(s.score).toBe(10 + Math.ceil(TUNING.normal.time - 9.5));
    step(s, HOLD + 0.01, rng());
    expect([s.level, s.row, s.phase]).toEqual([2, START_ROW, "playing"]);
    calm(s);
    move(s, "up");
    expect(s.score).toBe(10 + 31 + 2);
  });

  it("takes a life for a bump, a fall or the time running out; the clock starts again; three and it's over", () => {
    const s = calm(newGame("easy", "cute", rng()));
    move(s, "up");
    Object.assign(s.lanes[8]!, { count: 1, gap: COLS, width: COLS });
    step(s, 5, rng());
    expect(step(s, 0, rng())).toEqual([]);
    move(s, "up");
    expect(step(s, 0, rng())).toEqual(["died"]);
    expect([s.lives, s.cause, s.phase]).toEqual([2, "hit", "dead"]);
    // It can't move while it lies there.
    expect(move(s, "up")).toEqual([]);
    expect(step(s, HOLD + 0.01, rng())).toEqual(["respawn"]);
    expect([s.row, s.x, s.time, s.phase]).toEqual([START_ROW, 4, TUNING.easy.time, "playing"]);
    // Rows reached before don't score again.
    const before = s.score;
    move(s, "up");
    expect(s.score).toBe(before);
    expect(step(s, TUNING.easy.time + 1, rng())).toEqual(["died"]);
    expect(s.cause).toBe("time");
    step(s, HOLD + 0.01, rng());
    step(s, TUNING.easy.time + 1, rng());
    expect(s.lives).toBe(0);
    expect(step(s, HOLD + 0.01, rng())).toEqual(["over"]);
    expect(s.phase).toBe("over");
    expect(step(s, 1, rng())).toEqual([]);
  });

  it("after level 20 asks: endless levels go on (and faster), or it's over", () => {
    const r = rng();
    const s = calm(newGame("normal", "cute", r));
    for (let level = 1; level < LAST_LEVEL; level++) {
      cross(s, r);
      calm(s);
    }
    expect(s.level).toBe(LAST_LEVEL);
    while (s.row > GOAL_ROW) move(s, "up");
    expect(step(s, HOLD + 0.01, r)).toEqual(["cleared"]);
    expect(s.phase).toBe("cleared");
    const t = structuredClone(s);
    stopHere(t);
    expect(t.phase).toBe("over");
    goEndless(s, r);
    expect([s.level, s.endless, s.phase, s.lives]).toEqual([LAST_LEVEL + 1, true, "playing", LIVES]);
    calm(s);
    cross(s, r);
    expect(s.level).toBe(LAST_LEVEL + 2);
    expect(s.phase).toBe("playing");
  });
});

describe("[cross.themes] themes", () => {
  it("keeps the theme you picked; Random is another one each level", () => {
    const r = rng();
    const s = calm(newGame("normal", "office", r));
    cross(s, r);
    expect(s.theme).toBe("office");
    const u = calm(newGame("normal", "random", r));
    const seen = new Set([u.theme]);
    for (let i = 0; i < 12; i++) {
      const before = u.theme;
      cross(u, r);
      calm(u);
      expect(u.theme).not.toBe(before);
      seen.add(u.theme);
    }
    expect([...seen].sort()).toEqual([...THEMES].sort());
  });

  it("reads a saved theme; anything else is Cute", () => {
    expect(parseTheme("traffic")).toBe("traffic");
    expect(parseTheme("random")).toBe("random");
    expect(parseTheme("lava")).toBe("cute");
    expect(parseTheme(undefined)).toBe("cute");
  });
});
