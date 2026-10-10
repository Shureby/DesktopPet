import { describe, expect, it } from "vitest";
import { BASE_GAME_MODIFIERS, type GameModifiers } from "../../../characters/abilities/types";
import { createSafeLanding, scoreSafeLanding, stepSafeLanding, TUNING, type SafeLandingInput } from "./logic";

const base = { width: 800, height: 600, seed: 7, weight: 1, radius: 20 };
const idle: SafeLandingInput = { left: false, right: false, glide: false };

function play(mods: GameModifiers, input: (s: ReturnType<typeof createSafeLanding>) => SafeLandingInput, clear = true, seed = base.seed) {
  const s = createSafeLanding({ ...base, seed, mods });
  if (clear) s.items = [];
  else s.items = s.items.filter((i) => i.kind !== "spike");
  let t = 0;
  while (s.status === "playing" && t < 120) {
    stepSafeLanding(s, input(s), 1 / 60, { mods, weight: base.weight });
    t += 1 / 60;
  }
  return s;
}

/** Steers toward the pad centre. */
const steer = (glide: boolean) => (s: ReturnType<typeof createSafeLanding>): SafeLandingInput => ({
  left: s.x > s.pad.x + 5,
  right: s.x < s.pad.x - 5,
  glide,
});

describe("Safe Landing", () => {
  it("is deterministic per seed", () => {
    const a = createSafeLanding({ ...base, mods: BASE_GAME_MODIFIERS });
    const b = createSafeLanding({ ...base, mods: BASE_GAME_MODIFIERS });
    expect(a.items).toEqual(b.items);
    expect(a.pad).toEqual(b.pad);
  });

  it("crashes when free-falling onto the pad (too fast)", () => {
    const s = play(BASE_GAME_MODIFIERS, steer(false));
    expect(s.status).toBe("crashed");
    expect(s.reason).toMatch(/Too fast/);
    expect(scoreSafeLanding(s)).toBe(0);
  });

  it("gliders can land softly by gliding", () => {
    const mods = { ...BASE_GAME_MODIFIERS, glideFallFactor: 0.25 };
    const s = play(mods, steer(true));
    expect(s.status).toBe("landed");
    expect(scoreSafeLanding(s)).toBeGreaterThan(1000);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("non-gliders can win using the guaranteed umbrellas (seed %i)", (seed) => {
    const s = play(
      BASE_GAME_MODIFIERS,
      (st) => {
        // Grab the next umbrella below unless the current one lasts until touchdown.
        const lastsToGround = st.umbrella * TUNING.umbrellaFall >= st.worldHeight - st.y;
        const below = st.items.filter((i) => i.kind === "umbrella" && !i.taken && i.y > st.y + st.radius).sort((a, b) => a.y - b.y);
        const target = lastsToGround ? undefined : below[0];
        const x = target && target.y - st.y < 1000 ? target.x : st.pad.x;
        return { left: st.x > x + 5, right: st.x < x - 5, glide: false };
      },
      false,
      seed,
    );
    // Spikes are removed: this checks the level is winnable, not the bot's dodging.
    expect(s.status).toBe("landed");
  });

  it("umbrellas slow the fall for non-gliders", () => {
    const s = createSafeLanding({ ...base, mods: BASE_GAME_MODIFIERS });
    s.items = [{ kind: "umbrella", x: s.x, y: 200, r: 14 }];
    for (let i = 0; i < 180 && s.umbrella === 0; i++) stepSafeLanding(s, idle, 1 / 60, { mods: BASE_GAME_MODIFIERS, weight: 1 });
    expect(s.umbrella).toBeGreaterThan(0);
    for (let i = 0; i < 90; i++) stepSafeLanding(s, idle, 1 / 60, { mods: BASE_GAME_MODIFIERS, weight: 1 });
    expect(s.vy).toBeLessThanOrEqual(TUNING.umbrellaFall + 1);
  });

  it("wall-grabbers slide slowly down walls", () => {
    const mods = { ...BASE_GAME_MODIFIERS, wallGrab: true };
    const s = createSafeLanding({ ...base, mods });
    s.items = [];
    for (let i = 0; i < 240; i++) stepSafeLanding(s, { left: true, right: false, glide: false }, 1 / 60, { mods, weight: 1 });
    expect(s.clinging).toBe(true);
    expect(s.vy).toBeLessThanOrEqual(TUNING.clingFall + 1);
  });

  it("spikes end the run", () => {
    const s = createSafeLanding({ ...base, mods: BASE_GAME_MODIFIERS });
    s.items = [{ kind: "spike", x: s.x, y: 150, r: 20 }];
    for (let i = 0; i < 120; i++) stepSafeLanding(s, idle, 1 / 60, { mods: BASE_GAME_MODIFIERS, weight: 1 });
    expect(s.status).toBe("crashed");
  });
});
