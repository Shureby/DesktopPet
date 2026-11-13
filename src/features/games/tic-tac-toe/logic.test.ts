import { describe, expect, it } from "vitest";
import { createRng } from "../../../engine/random";
import { goesNext, legalMoves, newGame, petMove, play, type Level, type Rules, type State } from "./logic";

const moves = (s: State, ...m: number[]) => m.reduce(play, s);

describe("classic", () => {
  it("three in a row wins, a full board is a draw", () => {
    const s = moves(newGame("classic"), 0, 3, 1, 4, 2);
    expect(s.winner).toBe("x");
    expect(s.line).toEqual([0, 1, 2]);
    expect(legalMoves(s)).toEqual([]);
    const d = moves(newGame("classic"), 0, 1, 2, 4, 3, 5, 7, 6, 8);
    expect(d.winner).toBe("draw");
  });

  it("a taken cell can't be played", () => {
    const s = moves(newGame("classic"), 4);
    expect(play(s, 4)).toBe(s);
  });

  it("at its best the pet never loses (only draws or wins)", () => {
    const rng = createRng(7);
    for (let g = 0; g < 40; g++) {
      let s = newGame("classic", g % 2 ? "x" : "o");
      while (!s.winner) s = play(s, s.turn === "o" ? petMove(s, "strong", rng) : legalMoves(s)[Math.floor(rng() * legalMoves(s).length)]);
      expect(s.winner).not.toBe("x");
    }
  });

  it("takes a win, and blocks one", () => {
    const rng = createRng(1);
    // o to play, o has 3 and 4: 5 wins.
    expect(petMove(moves(newGame("classic"), 0, 3, 1, 4, 8), "strong", rng)).toBe(5);
    // x threatens 0-1-2: o blocks at 2.
    expect(petMove(moves(newGame("classic"), 0, 4, 1), "strong", rng)).toBe(2);
  });
});

describe("vanishing", () => {
  it("a fourth piece takes away the oldest first, which is marked before", () => {
    let s = moves(newGame("vanishing"), 0, 4, 2, 8, 6, 7);
    expect(goesNext(s, "x")).toBe(0);
    s = play(s, 3);
    expect(s.cells[0]).toBe(null);
    expect(s.order.x).toEqual([2, 6, 3]);
    expect(s.cells.filter((c) => c === "x").length).toBe(3);
  });

  it("a row made with the new piece wins, even as the oldest goes", () => {
    let s = moves(newGame("vanishing"), 6, 3, 1, 4, 2, 8);
    expect(goesNext(s, "x")).toBe(6);
    s = play(s, 0);
    expect(s.winner).toBe("x");
    expect(s.line).toEqual([0, 1, 2]);
  });

  it("never fills up: there's always somewhere to play", () => {
    const rng = createRng(3);
    let s = newGame("vanishing");
    for (let i = 0; i < 40 && !s.winner; i++) {
      expect(legalMoves(s).length).toBeGreaterThanOrEqual(3);
      s = play(s, petMove(s, "easy", rng));
    }
  });
});

describe("ultimate", () => {
  it("where you play sends the other player to that board", () => {
    const s = play(newGame("ultimate"), 4 * 9 + 2);
    expect(s.forced).toBe(2);
    expect(legalMoves(s).every((m) => Math.floor(m / 9) === 2)).toBe(true);
    expect(play(s, 5 * 9 + 0)).toBe(s);
  });

  it("a small board is won with three of its cells in a row", () => {
    const base = newGame("ultimate");
    const s = play({ ...base, cells: base.cells.map((c, i) => (i === 0 || i === 1 ? "x" : c)), forced: 0 }, 2);
    expect(s.small[0]).toBe("x");
    // Sent to board 2 (cell 2): still open.
    expect(s.forced).toBe(2);
    expect(s.winner).toBe(null);
  });

  it("three small boards in a row wins", () => {
    let s = newGame("ultimate");
    // Give x boards 0, 1 and 2 directly (as if won), then play a winning cell on board 2.
    s = { ...s, small: ["x", "x", null, null, null, null, null, null, null], cells: s.cells.map((c, i) => (i === 18 || i === 19 ? "x" : c)), forced: 2 };
    s = play(s, 20);
    expect(s.small[2]).toBe("x");
    expect(s.winner).toBe("x");
    expect(s.line).toEqual([0, 1, 2]);
  });

  it("sent to a board that's finished: anywhere open", () => {
    let s = newGame("ultimate");
    s = { ...s, small: ["o", null, null, null, null, null, null, null, null] };
    s = play(s, 4 * 9 + 0);
    expect(s.forced).toBe(null);
    expect(legalMoves(s).some((m) => Math.floor(m / 9) === 0)).toBe(false);
  });

  it("the pet picks a legal move quickly at every level", () => {
    const rng = createRng(5);
    for (const level of ["easy", "normal", "strong"] as Level[]) {
      let s = newGame("ultimate");
      const start = performance.now();
      for (let i = 0; i < 12 && !s.winner; i++) {
        const m = petMove(s, level, rng);
        expect(legalMoves(s)).toContain(m);
        s = play(s, m);
      }
      expect(performance.now() - start).toBeLessThan(8000);
    }
  });
});

describe("levels", () => {
  it("strong beats easy far more often than the other way round", () => {
    const rng = createRng(11);
    const games = (rules: Rules, a: Level, b: Level, n: number) => {
      let aWins = 0;
      for (let g = 0; g < n; g++) {
        let s = newGame(rules, g % 2 ? "x" : "o");
        while (!s.winner) s = play(s, petMove(s, s.turn === "x" ? a : b, rng));
        if (s.winner === "x") aWins++;
      }
      return aWins;
    };
    expect(games("vanishing", "strong", "easy", 10)).toBeGreaterThan(games("vanishing", "easy", "strong", 10));
  });
});
