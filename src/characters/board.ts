import { areaIndexAt } from "../engine/physics";
import type { Pet } from "./Pet";

/**
 * A board game's window (24 Points…) the pet sits on while you play: the same desktop pet,
 * standing on the window's top edge as on any window. It gets up there as it can (climbing a
 * side, or a leap, or straight there from another screen), then does what the game says:
 * paces while it thinks, settles down when it has the answer, cheers, sulks, comes over to
 * help. The window gone (minimized), it falls off like off any window, and goes back up when
 * the window is back. Set by the host (`Pet.board`); `boardNext` picks its state.
 */
export type BoardPose = "rest" | "think" | "ready" | "cheer" | "sulk" | "help";

export interface BoardPerch {
  /** The window's id in `world.windows`. */
  id: string;
  pose: BoardPose;
}

interface Leap {
  x0: number;
  y0: number;
  /** Landing point: offset from the window's left edge (the window may move meanwhile). */
  dx: number;
  id: string;
  /** Seconds in the air. */
  t: number;
  apex: number;
}

const leapOf = (p: Pet) => p.scratch.boardLeap as Leap | undefined;

export function boardWindow(p: Pet) {
  return p.board ? p.world.windows.find((w) => w.id === p.board!.id) : undefined;
}

export function onBoard(p: Pet): boolean {
  const s = p.body.support;
  return !!p.board && s?.kind === "window" && s.id === p.board.id;
}

/** Where it sits by default: near the board's right end. */
function perchX(p: Pet, win: { x: number; w: number }): number {
  return win.x + win.w - p.u(24) - p.body.w;
}

/** Keeps a point on the board's top, clear of its ends. */
function onTop(p: Pet, win: { x: number; w: number }, x: number): number {
  const margin = p.body.w / 2 + p.u(10);
  return Math.max(win.x + margin, Math.min(win.x + win.w - margin, x));
}

/** The state for a pet with a board: up onto it, or what the game wants from it there. */
export function boardNext(p: Pet): string {
  if (!p.grounded) return "fall";
  if (!onBoard(p)) return "boardMount";
  switch (p.board!.pose) {
    case "think":
      return "boardPace";
    case "ready":
      return "boardSettle";
    case "cheer":
      return "happy";
    case "sulk":
      return "alert";
    case "help":
      return "boardHelp";
    default:
      return "boardRest";
  }
}

/** Walks on the board's top to `x`, then `then` (a pause there for pacing). */
function walkOnBoard(p: Pet, x: number, dt: number): boolean {
  const dx = x - p.body.x;
  if (Math.abs(dx) < p.u(6)) {
    p.body.vx = 0;
    return true;
  }
  p.facing = dx > 0 ? 1 : -1;
  p.body.vx = p.facing * Math.min(p.walkSpeed(), Math.abs(dx) / Math.max(dt, 1 / 60));
  return false;
}

const faceMiddle = (p: Pet) => {
  const win = boardWindow(p);
  if (win) p.facing = p.body.x > win.x + win.w / 2 ? -1 : 1;
};

export const BOARD_STATES = {
  /** Gets onto the board: up its side (climbers), a leap (the rest), or there at once from another screen. */
  boardMount: {
    anim: "idle",
    enter: (p: Pet) => {
      p.body.vx = 0;
    },
    update: (p: Pet) => {
      if (!p.board) return p.next();
      if (onBoard(p)) return p.next();
      const win = boardWindow(p);
      // The board isn't there (minimized): it waits where it is, quietly.
      if (!win) return p.fsm.time > 1 ? "boardWait" : undefined;
      const here = areaIndexAt(p.world, p.body.x, p.body.y - 1);
      const there = areaIndexAt(p.world, win.x + win.w / 2, win.y + 1);
      const x = perchX(p, win);
      if (here !== there || here < 0) {
        // Another screen: there at once, like a visit to another screen ends.
        p.body.x = x;
        p.body.y = win.y;
        p.body.vx = p.body.vy = 0;
        p.body.support = { kind: "window", id: win.id, dx: x - win.x };
        return "land";
      }
      if (p.hasAbility("climbWall") && p.def.stats.climbSpeed > 0 && p.body.y > win.y + win.h * 0.5) {
        // To the nearer side, then up it.
        const left = p.body.x < win.x + win.w / 2;
        const standX = left ? win.x - p.body.w / 2 : win.x + win.w + p.body.w / 2;
        if (Math.abs(p.body.x - standX) > p.u(10)) {
          p.facing = standX > p.body.x ? 1 : -1;
          p.body.vx = p.facing * p.runSpeed();
          // (Arrives within a few frames of the side; overshoot is caught next frame.)
          if (Math.abs(p.body.x - standX) < p.runSpeed() / 30) p.body.x = standX;
          return p.fsm.time > 8 ? "boardLeap" : undefined;
        }
        p.body.vx = 0;
        p.facing = left ? 1 : -1;
        p.scratch.climb = { x: p.body.x, top: win.y, windowId: win.id };
        return "climb";
      }
      return "boardLeap";
    },
    exit: (p: Pet) => {
      p.body.vx = 0;
    },
  },
  /** Board minimized: sits where it fell, and goes up again once it's back. */
  boardWait: {
    anim: "sit",
    enter: (p: Pet) => {
      p.body.vx = 0;
    },
    update: (p: Pet) => (!p.board || boardWindow(p) ? p.next() : undefined),
  },
  /** A leap (a flight for flyers) in an arc onto the board's top, landing near its right end. */
  boardLeap: {
    anim: (p: Pet) => {
      const l = leapOf(p);
      const rising = l ? p.fsm.time < l.t / 2 : true;
      if (p.hasAbility("glide")) return "glide";
      return rising ? "jump" : "fall";
    },
    kinematic: true,
    enter: (p: Pet) => {
      const win = boardWindow(p);
      if (!win) return;
      const x1 = onTop(p, win, perchX(p, win));
      const dist = Math.hypot(x1 - p.body.x, win.y - p.body.y);
      p.scratch.boardLeap = {
        x0: p.body.x,
        y0: p.body.y,
        dx: x1 - win.x,
        id: win.id,
        t: Math.max(0.7, Math.min(1.8, dist / p.u(520))),
        apex: p.u(60) + Math.max(0, p.body.y - win.y) * 0.15,
      } satisfies Leap;
      p.body.support = null;
      p.body.vx = p.body.vy = 0;
      p.facing = x1 >= p.body.x ? 1 : -1;
    },
    update: (p: Pet) => {
      const l = leapOf(p);
      const win = l && p.world.windows.find((w) => w.id === l.id);
      if (!l || !win) return "fall";
      const s = Math.min(1, p.fsm.time / l.t);
      const x1 = win.x + l.dx;
      const ease = 1 - (1 - s) * (1 - s);
      p.body.x = l.x0 + (x1 - l.x0) * s;
      p.body.y = l.y0 + (win.y - l.y0) * ease - l.apex * 4 * s * (1 - s);
      if (s < 1) return;
      p.body.x = x1;
      p.body.y = win.y;
      p.body.support = { kind: "window", id: win.id, dx: l.dx };
      return "land";
    },
    exit: (p: Pet) => {
      delete p.scratch.boardLeap;
    },
  },
  /** Thinking: pacing to and fro along the board's top, stopping now and then. */
  boardPace: {
    anim: (p: Pet) => (p.body.vx !== 0 ? "walk" : "idle"),
    enter: (p: Pet) => {
      p.scratch.paceTo = undefined;
      p.scratch.pauseUntil = 0;
    },
    update: (p: Pet, dt: number) => {
      if (!onBoard(p) || p.board!.pose !== "think") return p.next();
      const win = boardWindow(p)!;
      if (p.fsm.time < ((p.scratch.pauseUntil as number) ?? 0)) return;
      let to = p.scratch.paceTo as number | undefined;
      if (to === undefined) {
        to = onTop(p, win, win.x + p.rng() * win.w);
        p.scratch.paceTo = to;
      }
      if (walkOnBoard(p, onTop(p, win, to), dt)) {
        p.scratch.paceTo = undefined;
        p.scratch.pauseUntil = p.fsm.time + 0.4 + p.rng() * 1.1;
      }
    },
    exit: (p: Pet) => {
      p.body.vx = 0;
      delete p.scratch.paceTo;
      delete p.scratch.pauseUntil;
    },
  },
  /** Has the answer: settles down, sure of itself (crouched if it can, sitting otherwise). */
  boardSettle: {
    anim: (p: Pet) => ("crouch" in p.def.animations ? "crouch" : "sit"),
    enter: (p: Pet) => {
      p.body.vx = 0;
      faceMiddle(p);
    },
    update: (p: Pet) => (!onBoard(p) || p.board!.pose !== "ready" ? p.next() : undefined),
  },
  /** Back at its place near the right end, sitting. */
  boardRest: {
    anim: (p: Pet) => (p.body.vx !== 0 ? "walk" : "sit"),
    update: (p: Pet, dt: number) => {
      if (!onBoard(p) || p.board!.pose !== "rest") return p.next();
      const win = boardWindow(p)!;
      if (walkOnBoard(p, onTop(p, win, perchX(p, win)), dt)) faceMiddle(p);
    },
    exit: (p: Pet) => {
      p.body.vx = 0;
    },
  },
  /** Come over to help: to the middle of the board. */
  boardHelp: {
    anim: (p: Pet) => (p.body.vx !== 0 ? "walk" : "idle"),
    update: (p: Pet, dt: number) => {
      if (!onBoard(p) || p.board!.pose !== "help") return p.next();
      const win = boardWindow(p)!;
      if (walkOnBoard(p, onTop(p, win, win.x + win.w * 0.55), dt)) faceMiddle(p);
    },
    exit: (p: Pet) => {
      p.body.vx = 0;
    },
  },
};
