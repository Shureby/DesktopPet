import { ABILITIES, availableBehaviors } from "./abilities";
import { movesetProblems } from "./combat/moveset";
import { CORE_ANIMATIONS, CharacterSchema, frameSize, type CharacterDef } from "./schema";

export type ValidationResult = { ok: true; def: CharacterDef } | { ok: false; errors: string[] };

/**
 * Full validation of a character: schema shape plus cross-references
 * (animations ↔ frames, abilities ↔ required animations, moveset budget…).
 * Bundled, user and Workshop characters all pass through here.
 */
export function validateCharacter(raw: unknown): ValidationResult {
  const parsed = CharacterSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const def = parsed.data;
  const errors: string[] = [];
  const anims = new Set(Object.keys(def.animations));
  const frames = new Set(Object.keys(def.sprite.frames));

  for (const name of CORE_ANIMATIONS) {
    if (!anims.has(name)) errors.push(`missing core animation "${name}"`);
  }
  for (const [name, a] of Object.entries(def.animations)) {
    for (const f of a.frames) if (!frames.has(f)) errors.push(`animation "${name}" uses unknown frame "${f}"`);
    if (a.next && !anims.has(a.next)) errors.push(`animation "${name}" continues with unknown "${a.next}"`);
  }

  if (def.sprite.type === "pixels") {
    const { w, h } = frameSize(def.sprite);
    const palette = new Set([".", ...Object.keys(def.sprite.palette)]);
    for (const [name, rows] of Object.entries(def.sprite.frames)) {
      if (rows.length !== h) errors.push(`frame "${name}" has ${rows.length} rows, expected ${h}`);
      rows.forEach((row, y) => {
        if (row.length !== w) errors.push(`frame "${name}" row ${y} has width ${row.length}, expected ${w}`);
        for (const ch of row) {
          if (!palette.has(ch)) {
            errors.push(`frame "${name}" row ${y} uses "${ch}" which is not in the palette`);
            break;
          }
        }
      });
    }
  }

  for (const ref of def.abilities) {
    const ability = ABILITIES[ref.id];
    if (!ability || ability.id === "core") {
      errors.push(`unknown ability "${ref.id}"`);
      continue;
    }
    const params = ability.params.safeParse(ref.params);
    if (!params.success) errors.push(`ability "${ref.id}" params: ${params.error.issues.map((i) => i.message).join(", ")}`);
    for (const a of ability.requiredAnimations) {
      if (!anims.has(a)) errors.push(`ability "${ref.id}" needs animation "${a}"`);
    }
  }

  const behaviors = availableBehaviors(def);
  for (const b of Object.keys(def.personality.behaviors)) {
    if (!behaviors.has(b)) errors.push(`personality uses behaviour "${b}" that no ability provides`);
  }
  if (!Object.values(def.personality.behaviors).some((w) => w > 0)) {
    errors.push("personality needs at least one behaviour with weight > 0");
  }

  errors.push(...movesetProblems(def.moveset, anims));
  return errors.length ? { ok: false, errors } : { ok: true, def };
}
