import { areaCentreX } from "../characters/abilities/core";
import type { Pet } from "../characters/Pet";
import { weightedPick } from "../engine/random";
import type { Brain, PetEvent } from "./Brain";

export interface Needs {
  /** 0 = exhausted, 1 = full of beans. */
  energy: number;
  /** 0 = entertained, 1 = very bored. */
  boredom: number;
  /** 0..1, grows with petting. */
  affection: number;
}

const ACTIVE = new Set(["walk", "run", "jump", "crouch", "pounce", "climb", "goto"]);
const CALM = new Set(["idle", "sit", "sleep"]);

/**
 * The free, offline brain: weighted random behaviours from the character's
 * personality, bent by needs (energy, boredom), the time of day and the mode
 * (focus sessions and quiet hours keep the pet calm).
 */
export class RulesBrain implements Brain {
  needs: Needs = { energy: 1, boredom: 0.2, affection: 0.5 };

  constructor(private readonly clock: () => Date = () => new Date()) {}

  tick(pet: Pet, dt: number): void {
    const n = this.needs;
    if (pet.state === "sleep") n.energy = Math.min(1, n.energy + dt / 60);
    else if (ACTIVE.has(pet.state)) n.energy = Math.max(0, n.energy - dt / 240);
    n.boredom = Math.min(1, n.boredom + dt / 600);
    if (n.boredom >= 1 && pet.mode === "free") {
      pet.say("bored");
      n.boredom = 0.6;
    }
  }

  /** Behaviour weights after applying needs, time of day and mode. Exposed for tests. */
  weights(pet: Pet): Record<string, number> {
    const p = pet.def.personality;
    const hour = this.clock().getHours();
    const night = hour >= 23 || hour < 6;
    const out: Record<string, number> = {};
    for (const [name, base] of Object.entries(p.behaviors)) {
      const behavior = pet.behaviors[name];
      if (!behavior || (behavior.canStart && !behavior.canStart(pet))) continue;
      let w = base;
      if (name === "sleep") {
        w *= 1 + (1 - this.needs.energy) * 4 * p.sleepiness;
        if (night) w *= 1 + 3 * p.sleepiness;
      }
      if (ACTIVE.has(behavior.state)) w *= 0.3 + this.needs.energy * (0.7 + this.needs.boredom);
      if (pet.mode !== "free" && !CALM.has(behavior.state)) w = 0;
      out[name] = w;
    }
    // In a focus session the pet mostly sits and "works" next to you.
    if (pet.mode === "focus" && "sit" in out) out.sit += 10;
    return out;
  }

  next(pet: Pet): string {
    if (!pet.grounded) return "fall";
    const name = weightedPick(pet.rng, this.weights(pet)) ?? "idle";
    const state = pet.behaviors[name]?.state ?? "idle";
    if (state !== "idle" && state !== "sit" && state !== "sleep") this.needs.boredom *= 0.7;
    return state;
  }

  onEvent(pet: Pet, e: PetEvent): void {
    const busy = pet.state === "drag" || pet.state === "climb" || !pet.grounded;
    switch (e.type) {
      case "greet":
        pet.say("greet");
        break;
      case "petted":
        this.needs.affection = Math.min(1, this.needs.affection + 0.1);
        this.needs.boredom = 0;
        pet.say("petted", {}, 2500);
        if (!busy) pet.fsm.set("happy", true);
        break;
      case "thrown":
        pet.say("thrown", {}, 2500);
        break;
      case "landedHard":
        pet.say("landed", {}, 2500);
        break;
      case "reminder": {
        pet.say(e.kind === "alarm" ? "alarm" : "reminder", { title: e.title }, 60_000);
        if (busy) break;
        // Sociable pets come running to the middle of the screen; aloof ones just perk up.
        if (pet.rng() < 0.3 + 0.7 * pet.def.personality.sociability) {
          pet.target = { x: areaCentreX(pet) };
          pet.fsm.set("goto", true);
        } else pet.fsm.set("alert", true);
        break;
      }
      case "pomodoro":
        pet.say(e.phase === "focus" ? "focusStart" : e.phase === "idle" ? "focusEnd" : "breakStart", {}, 5000);
        if (!busy) pet.fsm.set(e.phase === "focus" ? "sit" : "happy", true);
        break;
    }
  }
}
