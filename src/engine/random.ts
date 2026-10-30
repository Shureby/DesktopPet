/** Deterministic PRNG (mulberry32) so behaviour and games can be replayed in tests. */
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const range = (rng: Rng, min: number, max: number) => min + rng() * (max - min);

export function pick<T>(rng: Rng, items: readonly T[]): T | undefined {
  return items.length ? items[Math.floor(rng() * items.length)] : undefined;
}

/** Picks a key with probability proportional to its weight. */
export function weightedPick(rng: Rng, weights: Record<string, number>): string | undefined {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r < 0) return k;
  }
  return entries.at(-1)?.[0];
}
