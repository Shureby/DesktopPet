import { areaCentreX } from "../characters/abilities/core";
import type { Pet } from "../characters/Pet";
import { weightedPick } from "../engine/random";
import type { Brain, PetEvent } from "./Brain";

export interface Needs {
  /** 0 = exhausted, 1 = full of beans. */
  energy: number;
  /** 0 = entertained, 1 = very bored. */
  boredom: number;
}

const ACTIVE = new Set(["walk", "run", "jump", "crouch", "pounce", "climb", "goto", "approach"]);
const CALM = new Set(["idle", "sit", "sleep"]);

/**
 * The free, offline brain: weighted random behaviours from the character's
 * personality, bent by needs (energy, boredom), the time of day and the mode (focus
 * sessions and quiet hours keep the pet calm). It has moments (petted, praised, dropped),
 * not a mood to keep up: nothing goes down while you're busy.
 */
export class RulesBrain implements Brain {
  needs: Needs = { energy: 1, boredom: 0.2 };

  constructor(private readonly clock: () => Date = () => new Date()) {}

  tick(pet: Pet, dt: number): void {
    const n = this.needs;
    if (pet.state === "sleep") n.energy = Math.min(1, n.energy + dt / 60);
    else if (ACTIVE.has(pet.state)) n.energy = Math.max(0, n.energy - dt / 240);
    // Bored, it gets up to something (it doesn't say so: no chatter out of nowhere).
    n.boredom = Math.min(1, n.boredom + dt / 600);
  }

  /** Behaviour weights after applying needs, time of day and mode. Exposed for tests. */
  weights(pet: Pet): Record<string, number> {
    const p = pet.def.personality;
    const hour = this.clock().getHours();
    const night = hour >= 23 || hour < 6;
    const base: Record<string, number> = { ...p.behaviors };

    const out: Record<string, number> = {};
    for (const [name, weight] of Object.entries(base)) {
      const behavior = pet.behaviors[name];
      if (!behavior || (behavior.canStart && !behavior.canStart(pet))) continue;
      let w = weight;
      if (name === "sleep") {
        w *= 1 + (1 - this.needs.energy) * 4 * p.sleepiness;
        if (night) w *= 1 + 3 * p.sleepiness;
      }
      if (ACTIVE.has(behavior.state)) {
        w *= 0.3 + this.needs.energy * (0.7 + this.needs.boredom);
      }
      if (pet.mode !== "free" && !CALM.has(behavior.state)) w = 0;
      out[name] = w;
    }
    // In a focus session the pet mostly sits and "works" next to you.
    if (pet.mode === "focus" && "sit" in out) out.sit += 10;
    return out;
  }

  next(pet: Pet): string {
    if (!pet.grounded) return "fall";
    // Stopped for the mouse (e.g. after landing or a happy hop, it goes back to attending).
    if (pet.attending) return "attend";
    const name = weightedPick(pet.rng, this.weights(pet)) ?? "idle";
    const state = pet.behaviors[name]?.state ?? "idle";
    if (state !== "idle" && state !== "sit" && state !== "sleep") this.needs.boredom *= 0.7;
    return state;
  }

  /** The mouse resting on the pet; the rules are in brain/hover.ts and docs/INTERACTIONS.md. */
  private onHover(pet: Pet, e: Extract<PetEvent, { type: "hover" }>, busy: boolean): void {
    switch (e.phase) {
      case "attend":
        pet.attending = true;
        // A happy hop or a perked-up alert finishes first; landing does too (see next()).
        if (!busy && !["goto", "happy", "alert", "attend"].includes(pet.state)) pet.fsm.set("attend", true);
        break;
      case "react":
        this.needs.boredom = Math.max(0, this.needs.boredom - 0.3);
        if (pet.rng() < 0.5) {
          pet.say("noticedHappy", {}, 2500);
          if (!busy) pet.fsm.set("happy", true);
        } else pet.say("noticed", {}, 2500);
        break;
      case "release":
      case "leave":
        pet.attending = false;
        if (e.phase === "release") pet.say("release", {}, 2500);
        if (pet.state === "attend") pet.fsm.set(pet.next(), true);
        break;
    }
  }

  onEvent(pet: Pet, e: PetEvent): void {
    const busy = pet.state === "drag" || pet.state === "climb" || !pet.grounded;
    switch (e.type) {
      case "greet":
        pet.say("greet");
        break;
      case "petted":
        this.needs.boredom = 0;
        // Now and then a warmer line, for variety.
        pet.say(pet.rng() < 0.3 ? "adoring" : "petted", {}, 2500);
        if (!busy) pet.fsm.set("happy", true);
        break;
      case "praise":
        pet.say("praise", {}, 3000);
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
        if (e.run !== false && pet.rng() < 0.3 + 0.7 * pet.def.personality.sociability) {
          pet.target = { x: areaCentreX(pet) };
          pet.fsm.set("goto", true);
        } else pet.fsm.set("alert", true);
        break;
      }
      case "hover":
        this.onHover(pet, e, busy);
        break;
      case "pomodoro":
        pet.say(e.phase === "focus" ? "focusStart" : e.phase === "idle" ? "focusEnd" : "breakStart", {}, 5000);
        if (!busy) pet.fsm.set(e.phase === "focus" ? "sit" : "happy", true);
        break;
    }
  }
}
