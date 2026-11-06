import { msg } from "../../i18n";
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
  name: msg("Gliding"),
  description: msg("Floats down slowly instead of falling."),
  params: Params,
  requiredAnimations: ["glide"],
  onLedge(p, ledge) {
    p.facing = ledge.side === "left" ? -1 : 1;
    p.scratch.flyUp = { top: ledge.top, edge: ledge.x, area: ledge.area };
    return "flyUp";
  },
  onFalling(p, params) {
    if (p.body.vy > p.u(params.triggerSpeed)) return "glide";
  },
  states: {
    /** Flaps up onto a higher neighbouring screen's floor, then over its edge. */
    flyUp: {
      anim: "glide",
      kinematic: true,
      enter: (p) => {
        p.body.support = null;
        p.body.vx = p.body.vy = 0;
      },
      update: (p, dt) => {
        const f = p.scratch.flyUp as { top: number; edge: number; area: number } | undefined;
        if (!f || !p.world.areas[f.area] || p.fsm.time > 12) return "fall";
        const speed = p.u(220);
        if (p.body.y > f.top - p.u(6)) {
          p.body.y -= speed * dt;
          return;
        }
        p.body.x += p.facing * speed * dt;
        const past = p.facing === 1 ? p.body.x - p.body.w / 2 > f.edge : p.body.x + p.body.w / 2 < f.edge;
        if (!past) return;
        p.body.y = f.top;
        p.body.support = { kind: "floor", area: f.area };
        return "land";
      },
      exit: (p) => {
        delete p.scratch.flyUp;
      },
    },
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
