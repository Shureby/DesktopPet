import { z } from "zod";

/**
 * Schema for `assets/characters/<id>/character.json`.
 *
 * Characters are data-first: everything here is plain JSON, so user-made and
 * Steam Workshop characters can be loaded safely without running their code.
 * Bump `schemaVersion` (and add a migration in registry.ts) on breaking changes.
 */

const Hex = z.string().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "expected #rrggbb or #rrggbbaa");

export const PixelSpriteSchema = z.object({
  type: z.literal("pixels"),
  /** Logical pixels per art pixel. */
  scale: z.number().int().min(1).max(8),
  /** Single-character keys; "." is always transparent. */
  palette: z.record(z.string().length(1), Hex),
  /** Frame name → rows of palette keys; all frames share one size. */
  frames: z.record(z.string(), z.array(z.string().min(1)).min(1)),
  /** Direction the art faces; the renderer mirrors it for the other direction. */
  facing: z.enum(["left", "right"]).default("right"),
});

export const SheetSpriteSchema = z.object({
  type: z.literal("sheet"),
  /** Image path relative to the character folder. */
  src: z.string().regex(/^[\w\-./]+\.(png|webp)$/),
  frameWidth: z.number().int().min(4).max(512),
  frameHeight: z.number().int().min(4).max(512),
  scale: z.number().min(0.25).max(8),
  /** Frame name → [column, row] in the sheet. */
  frames: z.record(z.string(), z.tuple([z.number().int().min(0), z.number().int().min(0)])),
  facing: z.enum(["left", "right"]).default("right"),
});

export const SpriteSchema = z.discriminatedUnion("type", [PixelSpriteSchema, SheetSpriteSchema]);

export const AnimationSchema = z.object({
  frames: z.array(z.string()).min(1),
  fps: z.number().positive().max(60),
  loop: z.boolean().default(true),
  next: z.string().optional(),
});

export const StatsSchema = z.object({
  /** Logical px per second. */
  walkSpeed: z.number().min(10).max(400),
  runSpeed: z.number().min(20).max(900),
  /** Initial upward speed of a jump, logical px per second. */
  jumpPower: z.number().min(100).max(1500),
  /** Gravity multiplier: 1 is average, higher falls faster and throws shorter. */
  weight: z.number().min(0.3).max(3),
  climbSpeed: z.number().min(0).max(400).default(0),
});

export const AbilityRefSchema = z.object({
  id: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const PersonalitySchema = z.object({
  /** Relative weights for what the pet does when left alone (keys: core + ability behaviours). */
  behaviors: z.record(z.string(), z.number().min(0)),
  /** 0..1, how strongly the pet wants to sleep at night and when tired. */
  sleepiness: z.number().min(0).max(1).default(0.5),
  /** 0..1, how eager the pet is to react to you and to reminders. */
  sociability: z.number().min(0).max(1).default(0.5),
  /** Speech lines per situation; `{title}` is replaced with the reminder text. */
  lines: z.record(z.string(), z.array(z.string().max(80)).min(1)).default({}),
});

export const MoveSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["light", "heavy", "special", "aerial"]),
  /** Animation to play for the move. */
  anim: z.string(),
  /** Timings in milliseconds. */
  startup: z.number().int().min(0).max(2000),
  active: z.number().int().min(16).max(2000),
  recovery: z.number().int().min(0).max(3000),
  cooldown: z.number().int().min(0).max(10000).default(0),
  damage: z.number().min(0).max(100),
  /** Reach in logical px from the character's front edge. */
  range: z.number().min(0).max(400),
  knockback: z.number().min(0).max(2000).default(0),
});

export const MovesetSchema = z.object({
  /** Human-readable description of the fighting style. */
  style: z.string().max(120),
  moves: z.array(MoveSchema).min(2),
});

export const CharacterSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, "lowercase letters, digits and dashes"),
  displayName: z.string().min(1).max(40),
  description: z.string().max(200).default(""),
  sprite: SpriteSchema,
  stats: StatsSchema,
  animations: z.record(z.string(), AnimationSchema),
  abilities: z.array(AbilityRefSchema).default([]),
  personality: PersonalitySchema,
  moveset: MovesetSchema,
});

export type PixelSprite = z.infer<typeof PixelSpriteSchema>;
export type SheetSprite = z.infer<typeof SheetSpriteSchema>;
export type Sprite = z.infer<typeof SpriteSchema>;
export type Stats = z.infer<typeof StatsSchema>;
export type Move = z.infer<typeof MoveSchema>;
export type Moveset = z.infer<typeof MovesetSchema>;
export type Personality = z.infer<typeof PersonalitySchema>;
export type CharacterDef = z.infer<typeof CharacterSchema>;

/** Animations every character must provide; abilities may require more. */
export const CORE_ANIMATIONS = [
  "idle",
  "walk",
  "run",
  "jump",
  "fall",
  "land",
  "sit",
  "sleep",
  "drag",
  "happy",
  "alert",
] as const;

/** Frame size in art pixels. */
export function frameSize(sprite: Sprite): { w: number; h: number } {
  if (sprite.type === "sheet") return { w: sprite.frameWidth, h: sprite.frameHeight };
  const first = Object.values(sprite.frames)[0] ?? [""];
  return { w: first[0]?.length ?? 0, h: first.length };
}
