import { describe, expect, it } from "vitest";
import { createBody, isPlatformAt, step, type PhysicsOptions, type World } from "./physics";

// The user's screens: 2 (portrait, the lowest bottom) | 1 | 3 (the highest bottom).
const two = { x: -1080, y: -200, w: 1080, h: 1920 };
const one = { x: 0, y: 0, w: 2560, h: 1400 };
const three = { x: 2560, y: 100, w: 1920, h: 1040 };

const opt: PhysicsOptions = { gravity: 2000, gravityScale: 1, maxFallSpeed: 1400, airDrag: 0 };
const screen = { x: 0, y: 0, w: 1000, h: 800 };

function run(body: ReturnType<typeof createBody>, world: World, seconds: number, o = opt) {
  const results = [];
  for (let t = 0; t < seconds; t += 1 / 30) results.push(step(body, world, 1 / 30, o));
  return results;
}

describe("physics", () => {
  it("falls onto the floor of the work area", () => {
    const world: World = { areas: [screen], windows: [] };
    const body = createBody(500, 100, 40, 40);
    const results = run(body, world, 2);
    expect(results.some((r) => r.landed)).toBe(true);
    expect(body.y).toBe(800);
    expect(body.support).toEqual({ kind: "floor", area: 0 });
  });

  it("lands on a window's top edge and rides it when the window moves", () => {
    const world: World = { areas: [screen], windows: [{ id: "a", x: 300, y: 400, w: 400, h: 300 }] };
    const body = createBody(500, 100, 40, 40);
    run(body, world, 2);
    expect(body.y).toBe(400);
    expect(body.support).toMatchObject({ kind: "window", id: "a" });

    world.windows[0] = { ...world.windows[0], x: 350, y: 450 };
    step(body, world, 1 / 30, opt);
    expect(body.x).toBe(550);
    expect(body.y).toBe(450);
  });

  it("falls when the window it stands on closes", () => {
    const world: World = { areas: [screen], windows: [{ id: "a", x: 300, y: 400, w: 400, h: 300 }] };
    const body = createBody(500, 100, 40, 40);
    run(body, world, 2);
    world.windows = [];
    const r = step(body, world, 1 / 30, opt);
    expect(r.lostSupport).toBe(true);
    run(body, world, 2);
    expect(body.y).toBe(800);
  });

  it("ignores window tops covered by a window in front", () => {
    const world: World = {
      areas: [screen],
      windows: [
        { id: "front", x: 0, y: 300, w: 600, h: 400 },
        { id: "back", x: 200, y: 400, w: 600, h: 300 },
      ],
    };
    expect(isPlatformAt(world, 1, 500)).toBe(false);
    expect(isPlatformAt(world, 1, 700)).toBe(true);
  });

  it("does not treat maximised windows as platforms", () => {
    const world: World = { areas: [screen], windows: [{ id: "max", x: 0, y: 0, w: 1000, h: 800 }] };
    expect(isPlatformAt(world, 0, 500)).toBe(false);
  });

  it("stops at screen edges and reports the wall", () => {
    const world: World = { areas: [screen], windows: [] };
    const body = createBody(950, 800, 40, 40);
    body.support = { kind: "floor", area: 0 };
    body.vx = 300;
    const results = run(body, world, 1);
    expect(results.some((r) => r.hitWall === "right")).toBe(true);
    expect(body.x).toBe(980);
  });

  it("walks across onto an adjacent monitor", () => {
    const world: World = { areas: [screen, { x: 1000, y: 0, w: 800, h: 800 }], windows: [] };
    const body = createBody(950, 800, 40, 40);
    body.support = { kind: "floor", area: 0 };
    body.vx = 300;
    run(body, world, 1);
    expect(body.x).toBeGreaterThan(1100);
    expect(body.support).toEqual({ kind: "floor", area: 1 });
  });

  it("reports crossing the side of a tall window", () => {
    const world: World = { areas: [screen], windows: [{ id: "w", x: 520, y: 200, w: 300, h: 600 }] };
    const body = createBody(500, 800, 40, 40);
    body.support = { kind: "floor", area: 0 };
    body.vx = 300;
    const r = step(body, world, 1 / 10, opt);
    expect(r.crossedWindowSide).toEqual({ id: "w", side: "left", x: 520, top: 200 });
  });

  it("heavier bodies fall faster; a lower terminal velocity falls slower", () => {
    const world: World = { areas: [{ x: 0, y: 0, w: 1000, h: 5000 }], windows: [] };
    const light = createBody(500, 0, 10, 10);
    const heavy = createBody(500, 0, 10, 10);
    const glider = createBody(500, 0, 10, 10);
    run(light, world, 0.5);
    run(heavy, world, 0.5, { ...opt, gravityScale: 2 });
    run(glider, world, 0.5, { ...opt, maxFallSpeed: 200 });
    expect(heavy.y).toBeGreaterThan(light.y);
    expect(glider.y).toBeLessThan(light.y);
  });
});

describe("screens not aligned at the bottom, and screens the pet doesn't go to", () => {
  const walk = (body: ReturnType<typeof createBody>, world: World, vx: number, seconds: number) => {
    const results = [];
    for (let t = 0; t < seconds; t += 1 / 30) {
      if (body.support) body.vx = vx;
      results.push(step(body, world, 1 / 30, opt));
    }
    return results;
  };

  it("walking down onto a lower screen falls onto its floor", () => {
    const world: World = { areas: [one, two, three], windows: [] };
    const body = createBody(200, 1400, 40, 40);
    body.support = { kind: "floor", area: 0 };
    walk(body, world, -400, 2);
    expect(body.support).toEqual({ kind: "floor", area: 1 });
    expect(body.y).toBe(1720);
  });

  it("walking up to a higher screen meets a ledge (its floor), not just a wall", () => {
    const world: World = { areas: [one, two, three], windows: [] };
    const body = createBody(-300, 1720, 40, 40);
    body.support = { kind: "floor", area: 1 };
    const r = walk(body, world, 400, 2).find((x) => x.ledge);
    expect(r?.ledge).toEqual({ side: "right", x: 0, top: 1400, area: 0 });
    const body3 = createBody(2400, 1400, 40, 40);
    body3.support = { kind: "floor", area: 0 };
    expect(walk(body3, world, 400, 2).find((x) => x.ledge)?.ledge).toMatchObject({ top: 1140, area: 2 });
  });

  it("a jump high enough over the ledge lands on the higher screen", () => {
    const world: World = { areas: [one, two, three], windows: [] };
    const body = createBody(-30, 1720, 40, 40);
    body.vy = -Math.sqrt(2 * 2000 * (1720 - 1400 + 14)) - 2000 / 30;
    body.vx = 400;
    run(body, world, 2);
    expect(body.support).toEqual({ kind: "floor", area: 0 });
    expect(body.y).toBe(1400);
  });

  it("a screen not allowed is a wall, walking or thrown; allowed again, it's open", () => {
    const world: World = { areas: [one, two, three], windows: [], allowed: [true, false, true] };
    const body = createBody(200, 1400, 40, 40);
    body.support = { kind: "floor", area: 0 };
    const r = walk(body, world, -400, 2);
    expect(body.support).toEqual({ kind: "floor", area: 0 });
    expect(r.some((x) => x.hitWall === "left" && !x.ledge)).toBe(true);
    const thrown = createBody(100, 600, 40, 40);
    thrown.vx = -2000;
    run(thrown, world, 2);
    expect(thrown.x).toBeGreaterThanOrEqual(0);
    // Carried onto 2 (allowed for the visit): from there, home is open.
    const visiting: World = { ...world, allowed: [true, true, true] };
    const back = createBody(-30, 1720, 40, 40);
    back.vy = -Math.sqrt(2 * 2000 * (1720 - 1400 + 14)) - 2000 / 30;
    back.vx = 400;
    run(back, visiting, 2);
    expect(back.support).toEqual({ kind: "floor", area: 0 });
  });
});
