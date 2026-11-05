import { describe, expect, it } from "vitest";
import { RulesBrain } from "../brain/RulesBrain";
import { createRng } from "../engine/random";
import { Pet } from "./Pet";
import { loadBundled } from "./registry";

const registry = loadBundled();
const screen = { x: 0, y: 0, w: 1600, h: 900 };

describe("after an error mid-step", () => {
  for (const id of ["cat", "rooster"]) {
    it(`${id}: stuck in the air (or off screen) where a window was, it falls back to the floor`, () => {
      const pet = new Pet(registry.pick(id, "cat").def, { brain: new RulesBrain(() => new Date(2026, 0, 1, 12)), rng: createRng(3), unit: 1, x: 800, y: 900 });
      // On a window that has gone, held in a kinematic state (as when an error stopped it).
      pet.world = { areas: [screen], windows: [] };
      pet.body.y = 300;
      pet.body.x = 1700;
      pet.body.support = { kind: "window", id: "gone", dx: 10 };
      pet.recover();
      expect(pet.state).toBe("fall");
      expect(pet.body.x).toBeLessThanOrEqual(screen.w);
      for (let t = 0; t < 6; t += 1 / 30) pet.update(1 / 30);
      expect(pet.grounded).toBe(true);
      expect(pet.body.y).toBe(screen.h);
    });
  }
});
