import type { z } from "zod";
import type { StateDef } from "../../engine/fsm";
import type { Side } from "../../engine/physics";
import type { Pet } from "../Pet";

/** Something the brain can choose to do when the pet is left alone. */
export interface BehaviorDef {
  /** State entered when this behaviour is chosen. */
  state: string;
  canStart?(pet: Pet): boolean;
}

export interface WindowSideEdge {
  id: string;
  side: Side;
  x: number;
  top: number;
}

/** How a character's abilities change mini-game physics. Games read these, never character ids. */
export interface GameModifiers {
  /** Fall-speed multiplier while gliding, or null if the character cannot glide. */
  glideFallFactor: number | null;
  /** Multiplier applied to jump height. */
  jumpMultiplier: number;
  /** Multiplier applied to horizontal steering. */
  airControl: number;
  /** Can briefly cling to walls. */
  wallGrab: boolean;
}

export const BASE_GAME_MODIFIERS: GameModifiers = {
  glideFallFactor: null,
  jumpMultiplier: 1,
  airControl: 1,
  wallGrab: false,
};

/**
 * A reusable movement or behaviour. Characters opt in via `abilities` in their
 * character.json; any future character can reuse an ability without new code.
 */
export interface AbilityModule<P = Record<string, unknown>> {
  id: string;
  description: string;
  /** Validates and fills defaults for the params a character passes in. */
  params: z.ZodType<P>;
  /** Animations a character must provide to use this ability. */
  requiredAnimations: string[];
  /** Extra FSM states contributed by this ability. */
  states?: Record<string, StateDef<Pet>>;
  /** Idle behaviours the brain may pick (weights come from the character's personality). */
  behaviors?: Record<string, BehaviorDef>;
  /** Return a state name to take over from the default reaction. */
  onFalling?(pet: Pet, params: P): string | void;
  onHitWall?(pet: Pet, side: Side, params: P): string | void;
  onCrossWindowSide?(pet: Pet, edge: WindowSideEdge, params: P): string | void;
  gameModifiers?(params: P, mods: GameModifiers): void;
}

// Ability params are validated at load time, so erasing P here is safe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAbility = AbilityModule<any>;
