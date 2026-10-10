import type { CharacterDef } from "../schema";
import { climbWall } from "./climbWall";
import { core } from "./core";
import { glide } from "./glide";
import { pounce } from "./pounce";
import type { AnyAbility } from "./types";

/**
 * Every ability the engine knows. To add one: write a module next to these
 * and list it here — any character can then opt in from its character.json.
 */
export const ABILITIES: Record<string, AnyAbility> = Object.fromEntries(
  [core, climbWall, glide, pounce].map((a) => [a.id, a as AnyAbility]),
);

export interface ResolvedAbility {
  module: AnyAbility;
  params: unknown;
}

/** Core first, then the character's abilities in declaration order (with params validated). */
export function resolveAbilities(def: CharacterDef): ResolvedAbility[] {
  const resolved: ResolvedAbility[] = [{ module: core as AnyAbility, params: {} }];
  for (const ref of def.abilities) {
    const module = ABILITIES[ref.id];
    if (!module || module.id === "core") throw new Error(`Unknown ability "${ref.id}"`);
    resolved.push({ module, params: module.params.parse(ref.params) });
  }
  return resolved;
}

/** All behaviour names available to a character (core + its abilities). */
export function availableBehaviors(def: CharacterDef): Set<string> {
  const names = new Set(Object.keys(core.behaviors ?? {}));
  for (const ref of def.abilities) {
    for (const b of Object.keys(ABILITIES[ref.id]?.behaviors ?? {})) names.add(b);
  }
  return names;
}
