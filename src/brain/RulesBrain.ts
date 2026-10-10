import { areaCentreX } from "../characters/abilities/core";
import type { Pet } from "../characters/Pet";
import { range, weightedPick } from "../engine/random";
import type { Brain, PetEvent } from "./Brain";
import { applyMoodEvent, decayMood, isHungry, moodTier } from "./mood";

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
 * personality, bent by needs (energy, boredom), mood (affection, hunger), the
 * time of day and the mode (focus sessions and quiet hours keep the pet calm).
 */
export class RulesBrain implements Brain {
  needs: Needs = { energy: 1, boredom: 0.2 };
  /** Seconds until the pet may grumble or gush on its own again. */
  private moodLineIn = 120;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  tick(pet: Pet, dt: number): void {
    const n = this.needs;
    if (pet.state === "sleep") n.energy = Math.min(1, n.energy + dt / 60);
    else if (ACTIVE.has(pet.state)) n.energy = Math.max(0, n.energy - dt / 240);
    n.boredom = Math.min(1, n.boredom + dt / 600);
    decayMood(pet.mood, dt);
    if (pet.mode !== "free" || !pet.chatty) return;

    if (n.boredom >= 1) {
      pet.say("bored");
      n.boredom = 0.6;
    }
    this.moodLineIn -= dt;
    if (this.moodLineIn <= 0) {
      this.moodLineIn = range(pet.rng, 180, 420);
      const tier = moodTier(pet.mood);
      if (isHungry(pet.mood)) pet.say("hungry", {}, 5000);
      else if (tier === "grumpy" || tier === "sulking") pet.say("grumpy", {}, 4000);
      else if (tier === "adoring" && pet.rng() < 0.4) pet.say("adoring", {}, 4000);
    }
  }

  /** Behaviour weights after applying needs, mood, time of day and mode. Exposed for tests. */
  weights(pet: Pet): Record<string, number> {
    const p = pet.def.personality;
    const hour = this.clock().getHours();
    const night = hour >= 23 || hour < 6;
    const tier = moodTier(pet.mood);
    const base: Record<string, number> = { ...p.behaviors };
    // Pets that adore you come over to say hi.
    if (tier === "adoring") base.approach = 1 + 2 * p.sociability;

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
        // Unhappy or hungry pets mope instead of playing.
        if (tier === "grumpy" || isHungry(pet.mood)) w *= 0.5;
        if (tier === "sulking") w *= 0.3;
      }
      if (name === "sit" && (tier === "grumpy" || tier === "sulking")) w *= 2;
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
    const tier = moodTier(pet.mood);
    switch (e.phase) {
      case "attend":
        pet.attending = true;
        // A happy hop or a perked-up alert finishes first; landing does too (see next()).
        if (!busy && !["goto", "happy", "alert", "attend"].includes(pet.state)) pet.fsm.set("attend", true);
        break;
      case "dodge":
        pet.attending = false;
        pet.say(e.reason === "hungry" ? "dodgeHungry" : "dodgeGrumpy", {}, 3500);
        if (!busy) pet.fsm.set("dodge", true);
        break;
      case "react":
        this.needs.boredom = Math.max(0, this.needs.boredom - 0.3);
        if (tier === "adoring" || (tier === "content" && pet.rng() < 0.5)) {
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
    const tier = moodTier(pet.mood);
    switch (e.type) {
      case "greet":
        pet.say(isHungry(pet.mood) ? "hungry" : "greet");
        break;
      case "petted":
        this.needs.boredom = 0;
        // A sulking pet sometimes snubs you — keep trying and it comes round.
        if (tier === "sulking" && pet.rng() < 0.5) {
          pet.say("sulk", {}, 2500);
          if (!busy) pet.fsm.set("sit", true);
          break;
        }
        pet.say(e.result === "capped" ? "enough" : tier === "adoring" && pet.rng() < 0.5 ? "adoring" : "petted", {}, 2500);
        if (!busy) pet.fsm.set("happy", true);
        break;
      case "fed":
        pet.say(e.result === "full" ? "full" : "fed", {}, 3000);
        if (!busy && e.result === "ok") pet.fsm.set("happy", true);
        break;
      case "praise":
        pet.say("praise", {}, 3000);
        if (!busy) pet.fsm.set("happy", true);
        break;
      case "thrown":
        pet.say("thrown", {}, 2500);
        break;
      case "landedHard":
        // Only a real slam costs affection; being carried around is play (see PetHost).
        applyMoodEvent(pet.mood, "slammed");
        pet.say("landed", {}, 2500);
        break;
      case "reminder": {
        // Reminders always get through, whatever the mood.
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
