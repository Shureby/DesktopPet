import { describe, expect, it } from "vitest";
import { RulesBrain } from "../brain/RulesBrain";
import { createRng } from "../engine/random";
import { onBoard } from "./board";
import { Pet } from "./Pet";
import { loadBundled } from "./registry";

const registry = loadBundled();
const screen = { x: 0, y: 0, w: 1600, h: 900 };
const board = { id: "epet-board", x: 500, y: 300, w: 500, h: 560 };

function spawn(id: string, x = 1100) {
  const pet = new Pet(registry.pick(id, "cat").def, { brain: new RulesBrain(() => new Date(2026, 0, 1, 12)), rng: createRng(3), unit: 1, x, y: 900 });
  pet.world = { areas: [screen], windows: [board] };
  return pet;
}

function simulate(pet: Pet, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 30) pet.update(1 / 30);
}

describe("a board game's window", () => {
  for (const id of ["cat", "rooster"]) {
    it(`${id}: gets up onto it, does what the game says there, falls off when it goes and goes back up`, () => {
      const pet = spawn(id);
      simulate(pet, 1);
      pet.board = { id: board.id, pose: "rest" };
      pet.fsm.set(pet.next(), true);
      simulate(pet, 12);
      expect(onBoard(pet), pet.state).toBe(true);
      expect(pet.body.y).toBe(board.y);
      // Near its right end, sitting.
      expect(pet.body.x).toBeGreaterThan(board.x + board.w / 2);
      expect(pet.state).toBe("boardRest");
      // Thinking: it paces along the top, never off it.
      pet.board.pose = "think";
      pet.fsm.set(pet.next(), true);
      const xs: number[] = [];
      for (let t = 0; t < 8; t += 1 / 30) {
        pet.update(1 / 30);
        xs.push(pet.body.x);
        expect(onBoard(pet)).toBe(true);
      }
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(60);
      // Has it: settles down.
      pet.board.pose = "ready";
      pet.fsm.set(pet.next(), true);
      simulate(pet, 0.5);
      expect(pet.state).toBe("boardSettle");
      // Minimized: the window goes, it falls to the floor and waits there.
      pet.world = { areas: [screen], windows: [] };
      simulate(pet, 6);
      expect(pet.body.y).toBe(900);
      expect(pet.state).toBe("boardWait");
      // Back: up it goes again.
      pet.world = { areas: [screen], windows: [board] };
      simulate(pet, 12);
      expect(onBoard(pet), pet.state).toBe(true);
      // The game over: back to its usual ways.
      pet.board = null;
      expect(pet.next().startsWith("board")).toBe(false);
    });
  }

  it("rides along when the board is dragged", () => {
    const pet = spawn("rooster");
    pet.board = { id: board.id, pose: "rest" };
    pet.fsm.set(pet.next(), true);
    simulate(pet, 12);
    expect(onBoard(pet)).toBe(true);
    const dx = pet.body.x - board.x;
    pet.world = { areas: [screen], windows: [{ ...board, x: 200, y: 250 }] };
    simulate(pet, 0.2);
    expect(onBoard(pet)).toBe(true);
    expect(pet.body.y).toBe(250);
    expect(Math.abs(pet.body.x - (200 + dx))).toBeLessThan(40);
  });
});
