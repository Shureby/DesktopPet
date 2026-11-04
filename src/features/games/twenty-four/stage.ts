import type { CharacterDef } from "../../../characters/schema";
import { AnimationPlayer } from "../../../engine/animation";
import type { SpriteAtlas } from "../../../engine/sprites";

/**
 * What the pet is doing on top of the board: pacing while it thinks, settled down once it
 * has the answer (crouched or sitting, whichever pose the character has), cheering, sulking,
 * or come over to help.
 */
export type Pose = "rest" | "think" | "ready" | "cheer" | "sulk" | "help";

/**
 * The strip above the board where the pet stands, with its speech bubble. It stands on the
 * board's top edge, at the right unless it walks over to help.
 */
export class PetStage {
  private readonly anim: AnimationPlayer;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scale: number;
  private x = 0;
  private target = 0;
  private facing: 1 | -1 = -1;
  private pose: Pose = "rest";
  private pause = 0;
  private bubbleTimer = 0;
  private last = performance.now();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly bubble: HTMLElement,
    private readonly def: CharacterDef,
    private readonly atlas: SpriteAtlas,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.anim = new AnimationPlayer(def.animations);
    this.scale = Math.max(3, Math.round(def.sprite.scale * 1.5));
    this.resize();
    this.x = this.target = this.restX;
    window.addEventListener("resize", () => this.resize());
    requestAnimationFrame((t) => this.frame(t));
  }

  get current(): Pose {
    return this.pose;
  }

  /** Where it sits by default: the board's top right. */
  private get restX() {
    return this.width - 24 - (this.atlas.width * this.scale) / 2;
  }
  private get width() {
    return this.canvas.clientWidth;
  }
  private get height() {
    return this.canvas.clientHeight;
  }

  private resize() {
    const r = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * r);
    this.canvas.height = Math.round(this.height * r);
    this.ctx.setTransform(r, 0, 0, r, 0, 0);
  }

  private has(name: string) {
    return name in this.def.animations;
  }

  set(pose: Pose): void {
    if (pose === this.pose) return;
    this.pose = pose;
    this.pause = 0;
    this.target = pose === "help" ? this.width * 0.55 : pose === "think" ? this.x : this.restX;
  }

  /** A line in its bubble, for `ms` (0: until the next one). */
  say(text: string, ms = 0): void {
    this.bubble.textContent = text;
    this.bubble.hidden = !text;
    this.bubbleTimer = ms;
    this.placeBubble();
  }

  get saying(): string {
    return this.bubble.hidden ? "" : (this.bubble.textContent ?? "");
  }

  private placeBubble() {
    // To the left of the pet, its right edge just short of the pet's head.
    const right = Math.max(0, this.width - (this.x - (this.atlas.width * this.scale) / 2) + 6);
    this.bubble.style.right = `${Math.min(right, this.width - 160)}px`;
  }

  private frame(now: number) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.step(dt);
    this.draw();
    requestAnimationFrame((t) => this.frame(t));
  }

  private step(dt: number) {
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt * 1000;
      if (this.bubbleTimer <= 0) this.say("");
    }
    const half = (this.atlas.width * this.scale) / 2;
    if (this.pose === "think") {
      // Pacing to and fro along the top edge, stopping now and then.
      if (this.pause > 0) this.pause -= dt;
      else if (Math.abs(this.target - this.x) < 2) {
        this.pause = 0.4 + Math.random() * 1.1;
        const lo = half + 12;
        const hi = this.width - half - 12;
        this.target = lo + Math.random() * (hi - lo);
      }
    }
    const dx = this.target - this.x;
    const walking = Math.abs(dx) > 1.5 && this.pause <= 0;
    if (walking) {
      const v = 70 * dt;
      this.x += Math.sign(dx) * Math.min(Math.abs(dx), v);
      this.facing = dx > 0 ? 1 : -1;
      this.placeBubble();
    } else if (this.pose !== "think") {
      // Settled: face the board's middle.
      this.facing = this.x > this.width / 2 ? -1 : 1;
    }
    this.anim.play(walking ? "walk" : this.still());
    this.anim.update(dt);
  }

  private still(): string {
    switch (this.pose) {
      case "ready":
        // Sure of itself: lying low if it can crouch (the cat), sitting otherwise (the rooster).
        return this.has("crouch") ? "crouch" : "sit";
      case "cheer":
        return "happy";
      case "sulk":
        return "alert";
      case "help":
        return "idle";
      case "think":
        return "idle";
      default:
        return "sit";
    }
  }

  private draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    this.atlas.draw(ctx, this.anim.frame, this.x, this.height, this.scale, this.facing);
  }
}
