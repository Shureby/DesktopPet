import { z } from "zod";
import { bottom, right } from "../../engine/geometry";
import { areaIndexAt, nearestAreaIndex } from "../../engine/physics";
import type { Pet } from "../Pet";
import type { AbilityModule } from "./types";

const grounded = (p: Pet) => p.grounded;

/** Stop moving and hold still for a random while, then ask the brain. */
function rest(anim: string, min: number, max: number) {
  return {
    anim,
    enter: (p: Pet) => {
      p.body.vx = 0;
      p.activity(min, max);
    },
    update: (p: Pet) => (p.activityDone() ? p.next() : undefined),
  };
}

function move(anim: string, speed: (p: Pet) => number, min: number, max: number) {
  return {
    anim,
    enter: (p: Pet) => {
      if (p.rng() < 0.35) p.facing = p.facing === 1 ? -1 : 1;
      p.activity(min, max);
    },
    update: (p: Pet) => {
      p.body.vx = p.facing * speed(p);
      return p.activityDone() ? p.next() : undefined;
    },
    exit: (p: Pet) => {
      p.body.vx = 0;
    },
  };
}

/** The abilities every character has. Always resolved first. */
export const core: AbilityModule<Record<string, never>> = {
  id: "core",
  description: "Idle, walk, run, sit, sleep, jump, fall, land, be dragged, react.",
  params: z.object({}).strict(),
  requiredAnimations: [],
  behaviors: {
    idle: { state: "idle" },
    walk: { state: "walk", canStart: grounded },
    run: { state: "run", canStart: grounded },
    sit: { state: "sit", canStart: grounded },
    sleep: { state: "sleep", canStart: grounded },
    jump: { state: "jump", canStart: grounded },
    // Not in personalities: the brain offers it when the pet adores you.
    approach: { state: "approach", canStart: (p) => grounded(p) && p.cursor !== null },
  },
  states: {
    idle: rest("idle", 2, 5),
    sit: rest("sit", 4, 10),
    sleep: {
      anim: "sleep",
      enter: (p) => {
        p.body.vx = 0;
        const s = p.def.personality.sleepiness;
        p.activity(10 + 10 * s, 25 + 30 * s);
      },
      update: (p) => (p.activityDone() ? p.next() : undefined),
    },
    happy: rest("happy", 1.2, 1.8),
    alert: rest("alert", 2.5, 3.5),
    walk: move("walk", (p) => p.walkSpeed(), 3, 8),
    run: move("run", (p) => p.runSpeed(), 1.5, 4),
    jump: {
      anim: "jump",
      airborne: true,
      enter: (p) => {
        if (!p.grounded) return;
        p.body.support = null;
        p.body.vy = -p.u(p.def.stats.jumpPower);
        p.body.vx = p.facing * p.walkSpeed();
      },
      update: (p) => (p.body.vy > 0 ? "fall" : undefined),
    },
    fall: {
      anim: "fall",
      airborne: true,
      update: (p) => p.fallingHook(),
    },
    land: {
      anim: "land",
      enter: (p) => {
        p.body.vx = 0;
      },
      update: (p) => (p.anim.finished || p.fsm.time > 0.6 ? p.next() : undefined),
    },
    drag: { anim: "drag", kinematic: true },
    /** Walk over to the cursor, then look happy (affectionate pets do this). */
    approach: {
      anim: "walk",
      update: (p) => {
        const c = p.cursor;
        if (!c || p.fsm.time > 6 || p.lastStep?.hitWall) return p.next();
        const dx = c.x - p.body.x;
        if (Math.abs(dx) < p.u(30)) {
          p.body.vx = 0;
          return "happy";
        }
        p.facing = dx > 0 ? 1 : -1;
        p.body.vx = p.facing * p.walkSpeed() * 1.4;
      },
      exit: (p) => {
        p.body.vx = 0;
      },
    },
    /** Stopped for the mouse resting on it: brakes, then keeps facing the cursor. */
    attend: {
      anim: "idle",
      update: (p) => {
        p.body.vx *= 0.8;
        if (Math.abs(p.body.vx) < p.u(5)) p.body.vx = 0;
        // Turn only when the cursor is clearly to one side, so stroking doesn't make it flicker.
        const c = p.cursor;
        if (c && Math.abs(c.x - p.body.x) > p.body.w * 0.6) p.facing = c.x > p.body.x ? 1 : -1;
        return p.attending ? undefined : p.next();
      },
      exit: (p) => {
        p.body.vx = 0;
      },
    },
    /** An unhappy pet steps about one body length away from the cursor, then turns back. */
    dodge: {
      anim: "walk",
      enter: (p) => {
        const c = p.cursor;
        p.facing = c ? (c.x > p.body.x ? -1 : 1) : p.facing === 1 ? -1 : 1;
        p.activity(1, 1.2);
      },
      update: (p) => {
        const speed = Math.max(p.walkSpeed(), p.spriteSize.w / 1.1);
        p.body.vx = p.facing * speed;
        if (!p.activityDone() && !p.lastStep?.hitWall) return;
        p.body.vx = 0;
        const c = p.cursor;
        if (c) p.facing = c.x > p.body.x ? 1 : -1;
        return "idle";
      },
      exit: (p) => {
        p.body.vx = 0;
      },
    },
    /**
     * Walk calmly to `pet.target`, then keep vigil if one is set (`scratch.vigil`: a
     * remembrance's candle), else idle.
     */
    walkTo: {
      anim: "walk",
      update: (p) => {
        if (!p.target) return "idle";
        const dx = p.target.x - p.body.x;
        if (Math.abs(dx) < p.u(8) || p.lastStep?.hitWall || p.fsm.time > 10) {
          p.target = null;
          p.body.vx = 0;
          return p.scratch.vigil ? "vigil" : "idle";
        }
        p.facing = dx > 0 ? 1 : -1;
        p.body.vx = p.facing * p.walkSpeed();
      },
      exit: (p) => {
        p.body.vx = 0;
      },
    },
    /** Sits facing `scratch.vigil.face` for `scratch.vigil.seconds`, then roams again. */
    vigil: {
      anim: "sit",
      enter: (p) => {
        p.body.vx = 0;
        const v = p.scratch.vigil as Vigil | undefined;
        p.activity(v?.seconds ?? 5, v?.seconds ?? 5);
      },
      update: (p) => {
        const v = p.scratch.vigil as Vigil | undefined;
        if (v) p.facing = v.face;
        if (p.activityDone()) {
          delete p.scratch.vigil;
          return p.next();
        }
      },
    },
    /** Run to `pet.target` (e.g. to the middle of the screen for a reminder), then alert. */
    goto: {
      anim: "run",
      update: (p) => {
        if (!p.target) return "alert";
        const dx = p.target.x - p.body.x;
        if (Math.abs(dx) < p.u(12) || p.lastStep?.hitWall || p.fsm.time > 8) {
          p.target = null;
          p.body.vx = 0;
          return "alert";
        }
        p.facing = dx > 0 ? 1 : -1;
        p.body.vx = p.facing * p.runSpeed();
      },
      exit: (p) => {
        p.body.vx = 0;
      },
    },
  },
};

/** Where a vigil faces and how long it lasts (set in `pet.scratch.vigil`). */
export interface Vigil {
  face: 1 | -1;
  seconds: number;
}

/** Horizontal centre of the work area the pet is on (target for reminders). */
export function areaCentreX(p: Pet): number {
  let i = areaIndexAt(p.world, p.body.x, p.body.y - 1);
  if (i < 0) i = nearestAreaIndex(p.world, p.body.x, p.body.y);
  const a = p.world.areas[i];
  return a ? a.x + a.w / 2 : p.body.x;
}

/** Bounds of the area the pet is on: [left, top, right, bottom]. */
export function areaBounds(p: Pet): [number, number, number, number] {
  let i = areaIndexAt(p.world, p.body.x, p.body.y - 1);
  if (i < 0) i = nearestAreaIndex(p.world, p.body.x, p.body.y);
  const a = p.world.areas[i] ?? { x: 0, y: 0, w: 1920, h: 1080 };
  return [a.x, a.y, right(a), bottom(a)];
}
