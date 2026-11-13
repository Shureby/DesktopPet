import type { Move, Moveset } from "../schema";

/**
 * Fighting styles differ per character, but every moveset must land inside
 * the same power budget so no animal dominates Stickman Fight.
 */
export const POWER_BUDGET = { target: 20, tolerance: 0.25 } as const;

/** Damage per second of a move if spammed, boosted by reach. */
export function movePower(m: Move): number {
  const cycleSeconds = (m.startup + m.active + m.recovery + m.cooldown) / 1000;
  return (m.damage / cycleSeconds) * (1 + m.range / 200);
}

/** Average move power; this is what the budget constrains. */
export function movesetPower(set: Moveset): number {
  return set.moves.reduce((sum, m) => sum + movePower(m), 0) / set.moves.length;
}

export function movesetProblems(set: Moveset, animations: Set<string>): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const m of set.moves) {
    if (ids.has(m.id)) problems.push(`duplicate move id "${m.id}"`);
    ids.add(m.id);
    if (!animations.has(m.anim)) problems.push(`move "${m.id}" uses unknown animation "${m.anim}"`);
  }
  for (const kind of ["light", "heavy"] as const) {
    if (!set.moves.some((m) => m.kind === kind)) problems.push(`moveset needs at least one ${kind} move`);
  }
  const power = movesetPower(set);
  const { target, tolerance } = POWER_BUDGET;
  if (Math.abs(power - target) > target * tolerance) {
    problems.push(
      `moveset power ${power.toFixed(1)} is outside the budget ${target}±${Math.round(tolerance * 100)}%`,
    );
  }
  return problems;
}

/**
 * Resolves one exchange: does `move` hit a target `distance` px away (front edge
 * to front edge), and what damage/knockback results. Used by fight mini-games.
 */
export function resolveHit(move: Move, distance: number): { hit: boolean; damage: number; knockback: number } {
  const hit = distance <= move.range;
  return { hit, damage: hit ? move.damage : 0, knockback: hit ? move.knockback : 0 };
}
