import type { Pet } from "../characters/Pet";

export type PetEvent =
  | { type: "greet" }
  /** `capped`: petting no longer raises affection this hour. */
  | { type: "petted"; result?: "ok" | "capped" }
  | { type: "fed"; result: "ok" | "full" }
  /** The user got something done (to-do, focus session, game). */
  | { type: "praise" }
  | { type: "thrown"; speed: number }
  | { type: "landedHard" }
  /** `run: false` keeps the pet where it is (user setting). */
  | { type: "reminder"; kind: "todo" | "alarm"; title: string; run?: boolean }
  | { type: "pomodoro"; phase: "focus" | "short_break" | "long_break" | "idle" }
  /** The mouse resting on the pet (see brain/hover.ts and docs/INTERACTIONS.md). */
  | { type: "hover"; phase: "attend" | "react" | "release" | "leave" }
  | { type: "hover"; phase: "dodge"; reason: "hungry" | "grumpy" };

/** How the pet is allowed to behave right now. */
export type PetMode = "free" | "focus" | "quiet" | "hidden";

/**
 * Decides what the pet does. The rules-based brain ships first; LLM-backed
 * brains (local or cloud) can implement the same interface later.
 */
export interface Brain {
  /** Called when the current activity finishes; returns the next state. */
  next(pet: Pet): string;
  /** React to something that happened; may switch the pet's state. */
  onEvent(pet: Pet, event: PetEvent): void;
  /** Update needs/moods every tick. */
  tick(pet: Pet, dt: number): void;
}
