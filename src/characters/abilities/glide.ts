import { z } from "zod";
import type { AbilityModule } from "./types";

const Params = z.object({
  /** Fall speed multiplier while gliding (lower = floatier). */
  fallSpeedFactor: z.number().min(0.05).max(1).default(0.3),
  /** Start gliding once falling faster than this (logical px/s). */
  triggerSpeed: z.number().min(0).max(2000).default(350),
  /** Forward drift speed while gliding (logical px/s). */
  drift: z.number().min(0).max(400).default(70),
});
type Params = z.infer<typeof Params>;

/** Spreads wings (or an umbrella, or ears…) to float down slowly. Roosters, bats, flying squirrels… */
export const glide: AbilityModule<Params> = {
  id: "glide",
  description: "Floats down slowly instead of falling.",
  params: Params,
  requiredAnimations: ["glide"],
  onFalling(p, params) {
    if (p.body.vy > p.u(params.triggerSpeed)) return "glide";
  },
  states: {
    glide: {
      anim: "glide",
      airborne: true,
      enter: (p) => {
        const params = p.params<Params>("glide")!;
        // Physics clamps the fall speed to the (now lower) terminal velocity.
        p.maxFallFactor = params.fallSpeedFactor;
        if (p.body.vx !== 0) p.facing = p.body.vx > 0 ? 1 : -1;
      },
      update: (p, dt) => {
        const params = p.params<Params>("glide")!;
        const drift = p.facing * p.u(params.drift);
        p.body.vx += (drift - p.body.vx) * Math.min(1, dt * 2);
      },
      exit: (p) => {
        p.maxFallFactor = 1;
      },
    },
  },
  gameModifiers(params, mods) {
    mods.glideFallFactor = params.fallSpeedFactor;
  },
};
