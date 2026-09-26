import { z } from "zod";
import type { AbilityModule } from "./types";

const Params = z.object({
  /** Max horizontal reach of a pounce (logical px). */
  range: z.number().min(40).max(1000).default(260),
  /** Crouch (wiggle) time before leaping, seconds. */
  windup: z.number().min(0.1).max(3).default(0.7),
});
type Params = z.infer<typeof Params>;

/** Crouches, wiggles, then leaps — at the cursor if it is close. Cats, tigers, foxes… */
export const pounce: AbilityModule<Params> = {
  id: "pounce",
  description: "Crouches and leaps at the cursor (or at nothing in particular).",
  params: Params,
  requiredAnimations: ["crouch", "pounce"],
  behaviors: {
    pounce: { state: "crouch", canStart: (p) => p.grounded },
  },
  states: {
    crouch: {
      anim: "crouch",
      enter: (p) => {
        p.body.vx = 0;
        const c = p.cursor;
        const range = p.u(p.params<Params>("pounce")!.range);
        if (c && Math.abs(c.x - p.body.x) < range && Math.abs(c.y - p.body.y) < range) {
          p.facing = c.x > p.body.x ? 1 : -1;
        }
      },
      update: (p) => (p.fsm.time >= p.params<Params>("pounce")!.windup ? "pounce" : undefined),
    },
    pounce: {
      anim: "pounce",
      airborne: true,
      enter: (p) => {
        if (!p.grounded) return;
        const range = p.u(p.params<Params>("pounce")!.range);
        const c = p.cursor;
        const dx = c && Math.abs(c.x - p.body.x) < range ? c.x - p.body.x : p.facing * range * (0.4 + p.rng() * 0.6);
        p.body.support = null;
        p.body.vy = -p.u(p.def.stats.jumpPower) * 0.75;
        // Time in the air ≈ 2·vy/g; aim to cover dx in that time.
        const airTime = (2 * -p.body.vy) / (p.u(2000) * p.def.stats.weight);
        p.body.vx = dx / airTime;
        p.facing = dx >= 0 ? 1 : -1;
      },
    },
  },
  gameModifiers(_params, mods) {
    mods.jumpMultiplier *= 1.15;
    mods.airControl *= 1.1;
  },
};
