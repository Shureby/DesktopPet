import { z } from "zod";
import type { Pet } from "../Pet";
import { areaBounds } from "./core";
import type { AbilityModule } from "./types";

const Params = z.object({
  /** Chance to climb when walking into a screen edge. */
  chance: z.number().min(0).max(1).default(0.5),
  /** Chance to climb a window's side edge when walking past it. */
  windowChance: z.number().min(0).max(1).default(0.25),
  /** How far up a screen edge to climb, as a fraction of the screen height. */
  maxHeight: z.number().min(0.1).max(1).default(0.7),
});
type Params = z.infer<typeof Params>;

interface Climb {
  x: number;
  /** y of the feet when the climb ends. */
  top: number;
  /** Window to step onto at the top, if climbing a window's side. */
  windowId?: string;
}

const climbOf = (p: Pet) => p.scratch.climb as Climb | undefined;

function startClimb(p: Pet, climb: Climb): string {
  p.scratch.climb = climb;
  return "climb";
}

/** Climbs screen edges and window sides; tops out onto windows. Cats, gorillas, geckos… */
export const climbWall: AbilityModule<Params> = {
  id: "climbWall",
  description: "Climbs up screen edges and the sides of windows.",
  params: Params,
  requiredAnimations: ["climb"],
  onHitWall(p, side, params) {
    if (p.state !== "walk" && p.state !== "run") return;
    if (p.def.stats.climbSpeed <= 0 || p.rng() >= params.chance) return;
    const [, top, , floor] = areaBounds(p);
    p.facing = side === "left" ? -1 : 1;
    return startClimb(p, { x: p.body.x, top: floor - (floor - top) * params.maxHeight * (0.5 + p.rng() * 0.5) });
  },
  onCrossWindowSide(p, edge, params) {
    if (p.state !== "walk" && p.state !== "run") return;
    if (p.def.stats.climbSpeed <= 0 || p.rng() >= params.windowChance) return;
    // Face the window so the sprite hugs its border.
    p.facing = edge.side === "left" ? 1 : -1;
    return startClimb(p, { x: edge.x - (p.facing * p.body.w) / 2, top: edge.top, windowId: edge.id });
  },
  states: {
    climb: {
      anim: "climb",
      kinematic: true,
      enter: (p) => {
        p.body.support = null;
        p.body.vx = p.body.vy = 0;
      },
      update: (p, dt) => {
        const c = climbOf(p);
        if (!c) return "fall";
        const win = c.windowId ? p.world.windows.find((w) => w.id === c.windowId) : undefined;
        if (c.windowId && !win) return "fall";
        const top = win ? win.y : c.top;
        p.body.x = win ? (p.facing === 1 ? win.x : win.x + win.w) - (p.facing * p.body.w) / 2 : c.x;
        p.body.y -= p.u(p.def.stats.climbSpeed) * dt;
        if (p.body.y > top) return;
        if (win) {
          // Pull up onto the window's top edge.
          p.body.y = win.y;
          p.body.x += p.facing * p.body.w;
          p.body.support = { kind: "window", id: win.id, dx: p.body.x - win.x };
          return "idle";
        }
        // Reached the chosen height on a screen edge: kick off and fall back down.
        p.facing = p.facing === 1 ? -1 : 1;
        p.body.vx = p.facing * p.walkSpeed() * 1.5;
        p.body.vy = -p.u(150);
        return "fall";
      },
      exit: (p) => {
        delete p.scratch.climb;
      },
    },
  },
  gameModifiers(_params, mods) {
    mods.wallGrab = true;
  },
};
