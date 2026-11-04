import { createRng, type Rng } from "../../../engine/random";

/**
 * 24 Points: four cards, + − × ÷, make 24. Exact fractions (8 ÷ 3 is 8/3, not 2.666…), a
 * solver that also says how hard a hand is, and dealing that never repeats a hand.
 * A hand is its four numbers: suits are only drawn, so ♥1 2 3 4 and ♠1 2 3 4 are the same hand.
 */

export interface Frac {
  n: number;
  d: number;
}

export type Op = "+" | "-" | "*" | "/";

export const OPS: readonly Op[] = ["+", "-", "*", "/"];

/** How each operator is written: × and ÷, and a real minus sign. */
export const OP_SIGN: Record<Op, string> = { "+": "+", "-": "−", "*": "×", "/": "÷" };

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function frac(n: number, d = 1): Frac {
  if (d < 0) [n, d] = [-n, -d];
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

/** a op b, or null for a division by zero. */
export function apply(a: Frac, op: Op, b: Frac): Frac | null {
  switch (op) {
    case "+":
      return frac(a.n * b.d + b.n * a.d, a.d * b.d);
    case "-":
      return frac(a.n * b.d - b.n * a.d, a.d * b.d);
    case "*":
      return frac(a.n * b.n, a.d * b.d);
    case "/":
      return b.n === 0 ? null : frac(a.n * b.d, a.d * b.n);
  }
}

export const isWhole = (f: Frac) => f.d === 1;
export const is24 = (f: Frac) => f.d === 1 && f.n === 24;

/** "8/3", "−1/3", "24". */
export function label(f: Frac): string {
  const s = f.d === 1 ? `${Math.abs(f.n)}` : `${Math.abs(f.n)}/${f.d}`;
  return f.n < 0 ? `−${s}` : s;
}

/** A card's face: A, 2…10, J, Q, K. */
export function face(rank: number): string {
  return ({ 1: "A", 11: "J", 12: "Q", 13: "K" } as Record<number, string>)[rank] ?? `${rank}`;
}

export interface Step {
  a: Frac;
  op: Op;
  b: Frac;
  r: Frac;
}

export interface Solution {
  /** "8 ÷ (3 − 8 ÷ 3)" */
  expr: string;
  /** The three operations in the order to do them. */
  steps: Step[];
}

/** "none": no way to make 24; "normal": doable in whole numbers; "hard": only through fractions. */
export type Kind = "none" | "normal" | "hard";

export interface Solved {
  kind: Kind;
  solution: Solution | null;
}

interface Node {
  v: Frac;
  expr: string;
  /** The operator at the top of the expression (null for a single number), for brackets. */
  top: Op | null;
  steps: Step[];
}

const low = (op: Op | null) => op === "+" || op === "-";

function join(x: Node, op: Op, y: Node, v: Frac): Node {
  const left = (op === "*" || op === "/") && low(x.top) ? `(${x.expr})` : x.expr;
  const needRight = op === "-" ? low(y.top) : op === "*" ? low(y.top) : op === "/" ? y.top !== null : false;
  const right = needRight ? `(${y.expr})` : y.expr;
  return { v, expr: `${left} ${OP_SIGN[op]} ${right}`, top: op, steps: [...x.steps, ...y.steps, { a: x.v, op, b: y.v, r: v }] };
}

/** How plain a solution is: whole numbers first, then fewer negative and fractional steps. */
function cost(n: Node): number {
  let c = 0;
  for (const s of n.steps) {
    if (!isWhole(s.r)) c += 100;
    if (s.r.n < 0) c += 10;
    if (s.op === "/") c += 1;
  }
  return c;
}

function search(nodes: Node[], best: { node: Node | null; cost: number }): void {
  if (nodes.length === 1) {
    if (is24(nodes[0].v)) {
      const c = cost(nodes[0]);
      if (c < best.cost) {
        best.node = nodes[0];
        best.cost = c;
      }
    }
    return;
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const rest = nodes.filter((_, k) => k !== i && k !== j);
      const [x, y] = [nodes[i], nodes[j]];
      const tries: [Node, Op, Node][] = [
        [x, "+", y], [x, "*", y], [x, "-", y], [y, "-", x], [x, "/", y], [y, "/", x],
      ];
      for (const [p, op, q] of tries) {
        const v = apply(p.v, op, q.v);
        if (v) search([...rest, join(p, op, q, v)], best);
      }
    }
  }
}

const cache = new Map<string, Solved>();

/** The plainest way to make 24 with these numbers, and how hard the hand is. */
export function solve(numbers: readonly Frac[] | readonly number[]): Solved {
  const fr = numbers.map((n) => (typeof n === "number" ? frac(n) : n));
  const key = fr.map(label).sort().join(",");
  const hit = cache.get(key);
  if (hit) return hit;
  const best = { node: null as Node | null, cost: Infinity };
  search(fr.map((v) => ({ v, expr: label(v), top: null, steps: [] })), best);
  const node = best.node;
  const result: Solved = node
    ? { kind: node.steps.every((s) => isWhole(s.r)) ? "normal" : "hard", solution: { expr: node.expr, steps: node.steps } }
    : { kind: "none", solution: null };
  cache.set(key, result);
  return result;
}

/** A hand's identity: its four numbers, whatever the suits. */
export function handKey(ranks: readonly number[]): string {
  return [...ranks].sort((a, b) => a - b).join("-");
}

export type Suit = "♠" | "♥" | "♣" | "♦";
const SUITS: readonly Suit[] = ["♠", "♥", "♣", "♦"];
export const isRed = (s: Suit) => s === "♥" || s === "♦";

export interface Hand {
  ranks: number[];
  suits: Suit[];
  key: string;
  kind: Kind;
  solution: Solution | null;
}

export interface DealOptions {
  /** Hands that need fractions too (otherwise only "normal" ones). */
  hard: boolean;
  /** Hands with no answer mixed in (about one in four), for the "No answer!" button. */
  unsolvable: boolean;
}

/** Share of hands without an answer when those are mixed in. */
export const UNSOLVABLE_SHARE = 0.25;

/** Four cards as a hand (suits drawn at random, never two of a card). */
export function handOf(ranks: readonly number[], rng: Rng): Hand {
  const used = new Set<string>();
  const suits = ranks.map((r) => {
    const free = SUITS.filter((s) => !used.has(`${r}${s}`));
    const s = free[Math.floor(rng() * free.length)] ?? "♠";
    used.add(`${r}${s}`);
    return s;
  });
  const { kind, solution } = solve(ranks);
  return { ranks: [...ranks], suits, key: handKey(ranks), kind, solution };
}

/**
 * A new hand that isn't in `avoid` (this round's and recent rounds' hands): only answerable
 * ones unless unsolvable ones are asked for, and hard ones only when allowed. If every
 * fitting hand was seen recently, recent ones may come back (never one from `round`).
 */
export function deal(rng: Rng, opts: DealOptions, round: ReadonlySet<string>, recent: ReadonlySet<string> = new Set()): Hand {
  const wantNone = opts.unsolvable && rng() < UNSOLVABLE_SHARE;
  const fits = (k: Kind) => (wantNone ? k === "none" : k === "normal" || (opts.hard && k === "hard"));
  for (let tries = 0; tries < 20_000; tries++) {
    const ranks = Array.from({ length: 4 }, () => 1 + Math.floor(rng() * 13));
    const key = handKey(ranks);
    if (round.has(key) || (tries < 10_000 && recent.has(key))) continue;
    if (!fits(solve(ranks).kind)) continue;
    return handOf(ranks, rng);
  }
  // (Never reached: there are hundreds of hands of each kind.)
  return handOf([1, 2, 3, 4], rng);
}

/** Today's hand, the same everywhere: any answerable hand, picked by the date. */
export function dailyHand(date: string): Hand {
  let seed = 2166136261;
  for (const ch of date) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  return deal(createRng(seed >>> 0), { hard: true, unsolvable: false }, new Set());
}

/** "Thinking 8 ÷ 3 = 8/3" pieces: the numbers and the operator. */
export function stepText(s: Step): string {
  return `${label(s.a)} ${OP_SIGN[s.op]} ${label(s.b)} = ${label(s.r)}`;
}

// --- The pet as an opponent -------------------------------------------------

export type Level = "easy" | "normal" | "strong";
export type LevelChoice = Level | "mood";

/** "Follows its mood": happy and fed plays well, content plays normally, grumpy or hungry plays badly. */
export function levelFromMood(m: { affection: number; fullness: number }): Level {
  if (m.fullness < 30 || m.affection < 40) return "easy";
  return m.affection >= 80 ? "strong" : "normal";
}

export interface PetPlan {
  /** When it answers (or gives up), from the deal. */
  ms: number;
  /** Whether it finds the answer (or rightly says there's none). */
  finds: boolean;
}

/**
 * Time for putting an answer in: three moves of three clicks (card, sign, card) at one to
 * two seconds a click. The pet's thinking comes on top, so someone who has worked it out
 * isn't beaten by their mouse.
 */
export const INPUT_S = 15;
/** Seconds of thinking at each level on a normal hand (hard hands twice as long, no-answer ones 1.5×). */
const THINK_S: Record<Level, number> = { easy: 30, normal: 15, strong: 6 };
/** How often it gets a hard hand at each level (normal hands: easy misses some too). */
const FINDS_HARD: Record<Level, number> = { easy: 0.4, normal: 0.8, strong: 1 };
const FINDS_NORMAL: Record<Level, number> = { easy: 0.85, normal: 1, strong: 1 };

/** It "has it" this long before it says so: the pet settles down, sure of itself. */
export const READY_MS = 5000;
/** Each move you make (the furthest you've got, not again after Undo) gives you this much more time. */
export const STEP_GRACE_MS = 3000;
/** A hard hand (fractions) takes longer to put in too: this much more before the pet answers. */
export const HARD_EXTRA_MS = 15_000;

export function petPlan(kind: Kind, level: Level, rng: Rng): PetPlan {
  const extra = kind === "hard" ? 2 : kind === "none" ? 1.5 : 1;
  const think = THINK_S[level] * extra * (0.8 + rng() * 0.45);
  const ms = Math.round((INPUT_S + think) * 1000) + (kind === "hard" ? HARD_EXTRA_MS : 0);
  const chance = kind === "hard" ? FINDS_HARD[level] : kind === "normal" ? FINDS_NORMAL[level] : 1;
  return { ms: Math.max(ms, READY_MS + 2000), finds: rng() < chance };
}
