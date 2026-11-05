/**
 * Tic-tac-toe (docs/INTERACTIONS.md, "Tic-tac-toe"): the rules of the three games and how the
 * pet picks its move. Pure: the window (game.ts) keeps a State and asks for the next one.
 *
 * - classic: 3×3, three in a row wins; played well it's a draw.
 * - vanishing: at most three pieces each; placing a fourth takes away your oldest first.
 * - ultimate: nine small boards; where you play in one sends the other player to that
 *   board (a finished one: anywhere); three small boards in a row wins.
 */
import { pick, type Rng } from "../../../engine/random";

export type Player = "x" | "o";
export type Rules = "classic" | "vanishing" | "ultimate";
export type Level = "easy" | "normal" | "strong";

export const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

/** Vanishing: pieces each player keeps on the board. */
export const VANISH_KEEP = 3;
/** Vanishing: a game this long is a draw (it almost never gets there). */
export const VANISH_MAX_MOVES = 60;

export interface State {
  rules: Rules;
  turn: Player;
  /** 9 cells; ultimate: 81 (small board b's cell c is b * 9 + c). */
  cells: (Player | null)[];
  /** Vanishing: each player's pieces, the oldest first. */
  order: Record<Player, number[]>;
  /** Ultimate: how each small board ended (null: still open). */
  small: (Player | "draw" | null)[];
  /** Ultimate: the small board to play in (null: any open one). */
  forced: number | null;
  moves: number;
  last: number | null;
  winner: Player | "draw" | null;
  /** The winning three: cells (classic, vanishing) or small boards (ultimate). */
  line: readonly number[] | null;
}

export const other = (p: Player): Player => (p === "x" ? "o" : "x");

export function newGame(rules: Rules, first: Player = "x"): State {
  return {
    rules,
    turn: first,
    cells: Array(rules === "ultimate" ? 81 : 9).fill(null),
    order: { x: [], o: [] },
    small: Array(9).fill(null),
    forced: null,
    moves: 0,
    last: null,
    winner: null,
    line: null,
  };
}

/** Three of `p` in a row in nine squares, and which. */
function threeOf(squares: readonly (Player | "draw" | null)[], p: Player): readonly number[] | null {
  return LINES.find((l) => l.every((i) => squares[i] === p)) ?? null;
}

/** The small board's nine cells (ultimate). */
function smallCells(cells: readonly (Player | null)[], b: number): (Player | null)[] {
  return cells.slice(b * 9, b * 9 + 9);
}

/** Where the player whose turn it is may play. */
export function legalMoves(s: State): number[] {
  if (s.winner) return [];
  if (s.rules !== "ultimate") return s.cells.flatMap((c, i) => (c === null ? [i] : []));
  const boards = s.forced !== null ? [s.forced] : s.small.flatMap((r, b) => (r === null ? [b] : []));
  return boards.flatMap((b) => smallCells(s.cells, b).flatMap((c, i) => (c === null ? [b * 9 + i] : [])));
}

/** Vanishing: the piece of `p` that goes when it plays next (it has three). */
export function goesNext(s: State, p: Player): number | null {
  return s.rules === "vanishing" && s.order[p].length >= VANISH_KEEP ? s.order[p][0] : null;
}

/** The state after the player whose turn it is plays at `i` (unchanged if it can't). */
export function play(s: State, i: number): State {
  if (s.winner || s.cells[i] !== null || !legalMoves(s).includes(i)) return s;
  const p = s.turn;
  const cells = [...s.cells];
  const order = { x: [...s.order.x], o: [...s.order.o] };
  let small = s.small;
  let forced: number | null = null;
  let winner: State["winner"] = null;
  let line: readonly number[] | null = null;
  if (s.rules === "vanishing" && order[p].length >= VANISH_KEEP) cells[order[p].shift()!] = null;
  cells[i] = p;
  order[p].push(i);
  const moves = s.moves + 1;
  if (s.rules === "ultimate") {
    const b = Math.floor(i / 9);
    small = [...s.small];
    const here = smallCells(cells, b);
    if (threeOf(here, p)) small[b] = p;
    else if (here.every((c) => c !== null)) small[b] = "draw";
    line = threeOf(small, p);
    if (line) winner = p;
    forced = small[i % 9] === null ? i % 9 : null;
    if (!winner && small.every((r) => r !== null)) winner = "draw";
  } else {
    line = threeOf(cells, p);
    if (line) winner = p;
    else if (s.rules === "classic" && cells.every((c) => c !== null)) winner = "draw";
    else if (s.rules === "vanishing" && moves >= VANISH_MAX_MOVES) winner = "draw";
  }
  return { ...s, turn: other(p), cells, order, small, forced, moves, last: i, winner, line };
}

// --- The pet's move -------------------------------------------------------------

const WIN = 1000;

/** How good the position is for `p` (not over yet): open lines, and ultimate's boards. */
function evaluate(s: State, p: Player): number {
  const q = other(p);
  const lines = (sq: readonly (Player | "draw" | null)[], weight: number) => {
    let v = 0;
    for (const l of LINES) {
      const mine = l.filter((i) => sq[i] === p).length;
      const theirs = l.filter((i) => sq[i] === q).length;
      const dead = l.some((i) => sq[i] === "draw");
      if (dead) continue;
      if (theirs === 0) v += mine === 2 ? 3 * weight : mine * weight;
      if (mine === 0) v -= theirs === 2 ? 3 * weight : theirs * weight;
    }
    return v;
  };
  if (s.rules !== "ultimate") {
    // Vanishing: a two about to lose its oldest piece counts for less.
    return lines(s.cells, 1) + (s.cells[4] === p ? 1 : s.cells[4] === q ? -1 : 0);
  }
  let v = lines(s.small, 25);
  for (let b = 0; b < 9; b++) {
    const r = s.small[b];
    const w = b === 4 ? 12 : b % 2 === 0 ? 10 : 8;
    if (r === p) v += w;
    else if (r === q) v -= w;
    else if (r === null) v += lines(smallCells(s.cells, b), 1);
  }
  // Sending the other player anywhere it likes is a gift.
  if (s.forced === null && !s.winner) v += s.turn === p ? 4 : -4;
  return v;
}

/** Negamax with alpha-beta, from the point of view of the player whose turn it is. */
function search(s: State, depth: number, alpha: number, beta: number, budget: { nodes: number }): number {
  if (s.winner) {
    if (s.winner === "draw") return 0;
    // (Sooner is better: the depth left counts.)
    return s.winner === s.turn ? WIN + depth : -WIN - depth;
  }
  if (depth === 0 || --budget.nodes <= 0) return evaluate(s, s.turn);
  let best = -Infinity;
  for (const m of ordered(s)) {
    const v = -search(play(s, m), depth - 1, -beta, -alpha, budget);
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/** Moves, likely good ones first (centres, then corners). */
function ordered(s: State): number[] {
  const rank = (i: number) => {
    const c = i % 9;
    return c === 4 ? 0 : c % 2 === 0 ? 1 : 2;
  };
  return legalMoves(s).sort((a, b) => rank(a) - rank(b));
}

/** How far the pet looks ahead, by game and level. */
const DEPTH: Record<Rules, Record<Level, number>> = {
  classic: { easy: 2, normal: 4, strong: 9 },
  vanishing: { easy: 1, normal: 3, strong: 7 },
  ultimate: { easy: 1, normal: 2, strong: 4 },
};
/** How often it plays any move instead of its best (it still takes a win in one, mostly). */
const SLIP: Record<Level, number> = { easy: 0.45, normal: 0.15, strong: 0 };

/** The scores of each legal move for the player whose turn it is. */
export function scoreMoves(s: State, depth: number): { move: number; score: number }[] {
  const budget = { nodes: 120_000 };
  return ordered(s).map((move) => ({ move, score: -search(play(s, move), depth - 1, -Infinity, Infinity, budget) }));
}

/** The pet's move (its turn): weaker levels miss things now and then. */
export function petMove(s: State, level: Level, rng: Rng): number {
  const moves = legalMoves(s);
  if (moves.length <= 1) return moves[0];
  const p = s.turn;
  // A win right there: taken (easy sometimes looks past it).
  const winning = moves.filter((m) => play(s, m).winner === p);
  if (winning.length && rng() < (level === "easy" ? 0.6 : 1)) return pick(rng, winning)!;
  if (rng() < SLIP[level]) {
    // A slip, but rarely leaving a win in one open on a normal level.
    const safe = moves.filter((m) => !legalMoves(play(s, m)).some((r) => play(play(s, m), r).winner === other(p)));
    return pick(rng, level === "normal" && safe.length ? safe : moves)!;
  }
  const scored = scoreMoves(s, DEPTH[s.rules][level]);
  const top = Math.max(...scored.map((x) => x.score));
  return pick(rng, scored.filter((x) => x.score === top).map((x) => x.move))!;
}

/** How long the pet takes over its move (ms): a little longer in the harder games. */
export function thinkMs(s: State, rng: Rng): number {
  const base = s.rules === "ultimate" ? 1800 : s.rules === "vanishing" ? 1400 : 1000;
  return Math.round(base * (0.8 + rng() * 0.6));
}

/** "Follows its mood", as in 24 Points: happy and fed plays well, grumpy or hungry badly. */
export function levelFromMood(m: { affection: number; fullness: number }): Level {
  if (m.fullness < 30 || m.affection < 40) return "easy";
  return m.affection >= 80 ? "strong" : "normal";
}
