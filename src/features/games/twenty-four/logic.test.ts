import { describe, expect, it } from "vitest";
import { createRng } from "../../../engine/random";
import { apply, dailyHand, deal, frac, handKey, handOf, INPUT_S, is24, label, levelFromMood, petPlan, READY_MS, solve, stepText, type Frac } from "./logic";

/** Runs a solution's steps and checks they end at 24. */
function replays(nums: number[], steps: { a: Frac; op: "+" | "-" | "*" | "/"; b: Frac; r: Frac }[]): boolean {
  let pool = nums.map((n) => label(frac(n)));
  for (const s of steps) {
    const r = apply(s.a, s.op, s.b);
    if (!r || label(r) !== label(s.r)) return false;
    for (const v of [s.a, s.b]) {
      const i = pool.indexOf(label(v));
      if (i < 0) return false;
      pool.splice(i, 1);
    }
    pool.push(label(r));
  }
  return pool.length === 1 && pool[0] === "24";
}

describe("fractions", () => {
  it("keeps exact values", () => {
    expect(label(apply(frac(8), "/", frac(3))!)).toBe("8/3");
    expect(label(apply(frac(3), "-", frac(8, 3))!)).toBe("1/3");
    expect(label(apply(frac(1), "-", frac(8, 3))!)).toBe("−5/3");
    expect(apply(frac(1), "/", frac(0))).toBeNull();
    expect(is24(apply(frac(8), "/", frac(1, 3))!)).toBe(true);
  });
});

describe("solve", () => {
  it("finds plain answers and calls them normal", () => {
    const s = solve([1, 2, 3, 4]);
    expect(s.kind).toBe("normal");
    expect(replays([1, 2, 3, 4], s.solution!.steps)).toBe(true);
  });

  it("calls a hand that needs fractions hard", () => {
    for (const nums of [[3, 3, 8, 8], [1, 5, 5, 5], [1, 3, 4, 6], [3, 3, 7, 7]]) {
      const s = solve(nums);
      expect(s.kind, nums.join()).toBe("hard");
      expect(replays(nums, s.solution!.steps), s.solution!.expr).toBe(true);
    }
    expect(solve([3, 3, 8, 8]).solution!.expr).toBe("8 ÷ (3 − 8 ÷ 3)");
  });

  it("knows when there's no answer", () => {
    for (const nums of [[1, 1, 1, 1], [1, 1, 1, 2], [13, 13, 13, 13], [1, 7, 7, 13]]) expect(solve(nums).kind, nums.join()).toBe("none");
  });

  it("writes brackets only where needed", () => {
    expect(solve([6, 6, 6, 6]).solution!.expr).toMatch(/^[\d +−×÷()]+$/);
    expect(solve([4, 4, 10, 10]).solution!.expr).toBe("(10 × 10 − 4) ÷ 4");
    expect(stepText(solve([3, 3, 8, 8]).solution!.steps[0])).toBe("8 ÷ 3 = 8/3");
  });

  it("covers every hand", () => {
    const counts = { none: 0, normal: 0, hard: 0 };
    for (let a = 1; a <= 13; a++)
      for (let b = a; b <= 13; b++)
        for (let c = b; c <= 13; c++)
          for (let d = c; d <= 13; d++) {
            const s = solve([a, b, c, d]);
            counts[s.kind]++;
            if (s.solution) expect(replays([a, b, c, d], s.solution.steps)).toBe(true);
          }
    expect(counts.none + counts.normal + counts.hard).toBe(1820);
    expect(counts.none).toBe(458);
    expect(counts.hard).toBeGreaterThan(10);
  });
});

describe("dealing", () => {
  it("a hand is its numbers, not its suits", () => {
    expect(handKey([4, 1, 3, 2])).toBe(handKey([1, 2, 3, 4]));
    const h = handOf([5, 5, 5, 5], createRng(3));
    expect(new Set(h.suits).size).toBe(4);
  });

  it("never repeats a hand in a round, and only answerable normal ones by default", () => {
    const rng = createRng(7);
    const round = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const h = deal(rng, { hard: false, unsolvable: false }, round);
      expect(round.has(h.key)).toBe(false);
      expect(h.kind).toBe("normal");
      round.add(h.key);
    }
  });

  it("mixes in hard hands and ones without an answer when asked", () => {
    const rng = createRng(11);
    const kinds = { none: 0, normal: 0, hard: 0 };
    for (let i = 0; i < 400; i++) kinds[deal(rng, { hard: true, unsolvable: true }, new Set()).kind]++;
    expect(kinds.none).toBeGreaterThan(60);
    expect(kinds.none).toBeLessThan(140);
    expect(kinds.hard).toBeGreaterThan(0);
  });

  it("avoids recent hands", () => {
    const rng = createRng(5);
    const recent = new Set<string>();
    for (let i = 0; i < 50; i++) recent.add(deal(rng, { hard: false, unsolvable: false }, recent).key);
    const next = deal(rng, { hard: false, unsolvable: false }, new Set(), recent);
    expect(recent.has(next.key)).toBe(false);
  });

  it("today's hand is the same for everyone and always has an answer", () => {
    expect(dailyHand("2026-11-04").key).toBe(dailyHand("2026-11-04").key);
    const days = new Set(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"].map((d) => dailyHand(d).key));
    expect(days.size).toBeGreaterThan(1);
    expect(dailyHand("2026-11-06").kind).not.toBe("none");
  });
});

describe("the pet's play", () => {
  it("plays by its mood", () => {
    expect(levelFromMood({ affection: 90, fullness: 80 })).toBe("strong");
    expect(levelFromMood({ affection: 60, fullness: 80 })).toBe("normal");
    expect(levelFromMood({ affection: 90, fullness: 10 })).toBe("easy");
    expect(levelFromMood({ affection: 20, fullness: 80 })).toBe("easy");
  });

  it("is quicker when stronger and slower on hard hands, and leaves time after it's ready", () => {
    const avg = (kind: "normal" | "hard", level: "easy" | "normal" | "strong") => {
      const rng = createRng(1);
      let t = 0;
      for (let i = 0; i < 200; i++) t += petPlan(kind, level, rng).ms;
      return t / 200;
    };
    expect(avg("normal", "strong")).toBeLessThan(avg("normal", "normal"));
    expect(avg("normal", "normal")).toBeLessThan(avg("normal", "easy"));
    expect(avg("hard", "normal")).toBeGreaterThan(avg("normal", "normal"));
    const rng = createRng(2);
    for (let i = 0; i < 100; i++) expect(petPlan("normal", "strong", rng).ms).toBeGreaterThan(READY_MS);
    // Never quicker than putting an answer in plus a little thinking.
    for (let i = 0; i < 100; i++) expect(petPlan("normal", "strong", rng).ms).toBeGreaterThanOrEqual(INPUT_S * 1000 + 4800);
    expect(avg("normal", "strong")).toBeGreaterThan(19_000);
    expect(avg("normal", "normal")).toBeGreaterThan(28_000);
    expect(avg("normal", "easy")).toBeGreaterThan(42_000);
    const misses = Array.from({ length: 200 }, () => petPlan("hard", "easy", rng).finds).filter((f) => !f).length;
    expect(misses).toBeGreaterThan(60);
  });
});
