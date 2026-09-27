import type { Brain, PetEvent, PetMode } from "../brain/Brain";
import { defaultMood, type Mood } from "../brain/mood";
import { AnimationPlayer } from "../engine/animation";
import { StateMachine, type StateDef } from "../engine/fsm";
import { createBody, step, type Body, type StepResult, type World } from "../engine/physics";
import { pick, range, type Rng } from "../engine/random";
import { resolveAbilities, type ResolvedAbility } from "./abilities";
import { BASE_GAME_MODIFIERS, type BehaviorDef, type GameModifiers } from "./abilities/types";
import { frameSize, type CharacterDef } from "./schema";

export interface PetOptions {
  brain: Brain;
  rng: Rng;
  /** Physical pixels per logical pixel (display scale × user size setting). */
  unit: number;
  /** User speed multiplier from settings. */
  speed?: number;
  x: number;
  y: number;
}

const GRAVITY = 2000;
const MAX_FALL = 1400;
/** Collision width relative to the sprite width (art usually has padding and a tail). */
const BODY_WIDTH_RATIO = 0.6;

/**
 * One live pet: a character definition + physics body + state machine + brain.
 * States (from the core ability and the character's special abilities) drive it.
 */
export class Pet {
  readonly body: Body;
  readonly fsm: StateMachine<Pet>;
  readonly anim: AnimationPlayer;
  readonly abilities: ResolvedAbility[];
  readonly behaviors: Record<string, BehaviorDef>;
  world: World = { areas: [], windows: [] };
  facing: 1 | -1 = 1;
  mode: PetMode = "free";
  /** Last known cursor position in physical px (null when unknown). */
  cursor: { x: number; y: number } | null = null;
  /** Destination for the `goto` state. */
  target: { x: number } | null = null;
  /** Scratch space for ability states (e.g. the wall being climbed). */
  scratch: Record<string, unknown> = {};
  /** Affection and fullness; the host loads and saves it per character. */
  mood: Mood = defaultMood();
  /** Fall speed multiplier (glide lowers it). */
  maxFallFactor = 1;
  lastStep: StepResult | null = null;
  /** Called when the pet wants to say something. */
  onSay: (text: string, ms: number) => void = () => {};
  readonly brain: Brain;
  readonly rng: Rng;
  unit: number;
  speed: number;

  private activityLength = 0;
  /** Set when the user throws the pet, so only those landings count as slams. */
  private thrown = false;
  private dragVel = { x: 0, y: 0 };
  private lastDrag: { x: number; y: number; t: number } | null = null;

  constructor(
    readonly def: CharacterDef,
    opts: PetOptions,
  ) {
    this.brain = opts.brain;
    this.rng = opts.rng;
    this.unit = opts.unit;
    this.speed = opts.speed ?? 1;
    this.abilities = resolveAbilities(def);
    const { w, h } = this.spriteSize;
    this.body = createBody(opts.x, opts.y, w * BODY_WIDTH_RATIO, h);

    const states: Record<string, StateDef<Pet>> = {};
    this.behaviors = {};
    for (const { module } of this.abilities) {
      Object.assign(states, module.states);
      Object.assign(this.behaviors, module.behaviors);
    }
    this.anim = new AnimationPlayer(def.animations);
    this.fsm = new StateMachine<Pet>(states, this as Pet, "fall");
    this.anim.play(this.animFor("fall"));
  }

  /** Sprite size in physical pixels. */
  get spriteSize(): { w: number; h: number } {
    const { w, h } = frameSize(this.def.sprite);
    const s = this.def.sprite.scale * this.unit;
    return { w: w * s, h: h * s };
  }

  get state(): string {
    return this.fsm.current;
  }

  get grounded(): boolean {
    return this.body.support !== null;
  }

  /** Converts logical px (from character.json) to physical px. */
  u(v: number): number {
    return v * this.unit;
  }

  walkSpeed(): number {
    return this.u(this.def.stats.walkSpeed) * this.speed;
  }

  runSpeed(): number {
    return this.u(this.def.stats.runSpeed) * this.speed;
  }

  params<P>(abilityId: string): P | undefined {
    return this.abilities.find((a) => a.module.id === abilityId)?.params as P | undefined;
  }

  hasAbility(id: string): boolean {
    return this.abilities.some((a) => a.module.id === id);
  }

  /** Start a timed activity of random length; see `activityDone`. */
  activity(minSeconds: number, maxSeconds: number): void {
    this.activityLength = range(this.rng, minSeconds, maxSeconds);
  }

  activityDone(): boolean {
    return this.fsm.time >= this.activityLength;
  }

  /** Ask the brain what to do next (states return this from `update`). */
  next(): string {
    return this.brain.next(this);
  }

  react(event: PetEvent): void {
    this.brain.onEvent(this, event);
  }

  /** Say a random line for `key` from the character's personality, if it has any. */
  say(key: string, vars: Record<string, string> = {}, ms = 4000): void {
    const line = pick(this.rng, this.def.personality.lines[key] ?? []);
    if (line) this.onSay(line.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? ""), ms);
  }

  gameModifiers(): GameModifiers {
    const mods = { ...BASE_GAME_MODIFIERS };
    for (const { module, params } of this.abilities) module.gameModifiers?.(params, mods);
    return mods;
  }

  // --- Dragging -----------------------------------------------------------

  startDrag(): void {
    this.body.support = null;
    this.body.vx = this.body.vy = 0;
    this.dragVel = { x: 0, y: 0 };
    this.lastDrag = null;
    this.fsm.set("drag");
  }

  /** Move the pet so its feet are at (x, y) — the caller offsets for the grab point. */
  dragTo(x: number, y: number, nowMs: number): void {
    if (this.lastDrag) {
      const dt = (nowMs - this.lastDrag.t) / 1000;
      if (dt > 0) {
        // Exponential smoothing so a jittery final mouse event doesn't dominate the throw.
        this.dragVel.x = this.dragVel.x * 0.5 + ((x - this.lastDrag.x) / dt) * 0.5;
        this.dragVel.y = this.dragVel.y * 0.5 + ((y - this.lastDrag.y) / dt) * 0.5;
      }
    }
    this.lastDrag = { x, y, t: nowMs };
    if (x !== this.body.x) this.facing = x > this.body.x ? 1 : -1;
    this.body.x = x;
    this.body.y = y;
  }

  endDrag(): void {
    const w = this.def.stats.weight;
    const cap = this.u(2500);
    this.body.vx = Math.max(-cap, Math.min(cap, this.dragVel.x / w));
    this.body.vy = Math.max(-cap, Math.min(cap, this.dragVel.y / w));
    this.fsm.set("fall");
    this.thrown = true;
    const speed = Math.hypot(this.body.vx, this.body.vy) / this.unit;
    if (speed > 600) this.react({ type: "thrown", speed });
  }

  // --- Simulation ---------------------------------------------------------

  animFor(state: string): string {
    const anim = this.fsm.stateDef(state)?.anim ?? state;
    return typeof anim === "function" ? anim(this) : anim;
  }

  update(dt: number): void {
    this.brain.tick(this, dt);
    this.fsm.update(dt);

    if (!this.fsm.def.kinematic) {
      const fallSpeed = this.body.vy;
      const r = step(this.body, this.world, dt, {
        gravity: this.u(GRAVITY),
        gravityScale: this.def.stats.weight,
        maxFallSpeed: this.u(MAX_FALL) * this.maxFallFactor,
        airDrag: 0.6,
      });
      this.lastStep = r;
      if (r.landed) {
        if (this.thrown && fallSpeed > this.u(1100)) this.react({ type: "landedHard" });
        this.thrown = false;
        if (this.fsm.def.airborne) this.fsm.set("land");
      } else if (!this.body.support && !this.fsm.def.airborne && !this.fsm.def.kinematic) {
        this.fsm.set("fall");
      }
      if (this.body.support && r.hitWall) this.handleWall(r.hitWall);
      if (this.body.support && r.crossedWindowSide) {
        for (const { module, params } of this.abilities) {
          const next = module.onCrossWindowSide?.(this, r.crossedWindowSide, params);
          if (next) {
            this.fsm.set(next);
            break;
          }
        }
      }
    }

    this.anim.play(this.animFor(this.state));
    this.anim.update(dt);
  }

  private handleWall(side: "left" | "right"): void {
    for (const { module, params } of this.abilities) {
      const next = module.onHitWall?.(this, side, params);
      if (next) {
        this.fsm.set(next);
        return;
      }
    }
    this.facing = side === "left" ? 1 : -1;
  }

  /** Lets airborne states hand over to ability states (e.g. glide). */
  fallingHook(): string | void {
    for (const { module, params } of this.abilities) {
      const next = module.onFalling?.(this, params);
      if (next) return next;
    }
  }
}
