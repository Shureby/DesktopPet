import type { Pet } from "../../../characters/Pet";
import { AnimationPlayer } from "../../../engine/animation";
import type { SpriteAtlas } from "../../../engine/sprites";
import type { Keys, MiniGame } from "../GameHost";
import { createSafeLanding, scoreSafeLanding, stepSafeLanding, TUNING, type SafeLandingState } from "./logic";

/** Renders Safe Landing and adapts it to the GameHost. */
export class SafeLandingGame implements MiniGame {
  readonly id = "safe-landing";
  readonly title = "Safe Landing";
  readonly controls: string[];
  private s!: SafeLandingState;
  private readonly anim: AnimationPlayer;
  private readonly mods;
  private readonly scale: number;

  constructor(
    private readonly pet: Pet,
    private readonly atlas: SpriteAtlas,
  ) {
    this.mods = pet.gameModifiers();
    this.anim = new AnimationPlayer(pet.def.animations);
    this.scale = pet.def.sprite.scale * 1.5;
    this.controls = [
      "← → to steer",
      this.mods.glideFallFactor !== null ? `Hold Space to glide — ${pet.def.displayName}s float!` : "Grab ☂ umbrellas to slow down",
      ...(this.mods.wallGrab ? ["Push into a wall to cling and slide"] : []),
      `Touch down on the pad slower than ${TUNING.safeSpeed} px/s`,
    ];
  }

  get status() {
    return this.s.status === "playing" ? "playing" : this.s.status === "landed" ? "won" : "lost";
  }
  get score() {
    return scoreSafeLanding(this.s);
  }
  get message() {
    return this.s.reason;
  }

  reset(seed: number, width: number, height: number): void {
    this.s = createSafeLanding({
      width,
      height,
      seed,
      mods: this.mods,
      weight: this.pet.def.stats.weight,
      radius: (this.atlas.width * this.scale) / 2.5,
    });
  }

  step(keys: Keys, dt: number): void {
    stepSafeLanding(this.s, { left: keys.left, right: keys.right, glide: keys.action || keys.up }, dt, {
      mods: this.mods,
      weight: this.pet.def.stats.weight,
    });
    const has = (a: string) => a in this.pet.def.animations;
    const s = this.s;
    const anim =
      s.status === "landed" ? "happy" : s.status === "crashed" ? "alert" : s.clinging && has("climb") ? "climb" : s.gliding && has("glide") ? "glide" : "fall";
    this.anim.play(anim);
    this.anim.update(dt);
  }

  render(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const s = this.s;
    const camY = Math.max(0, Math.min(s.worldHeight - h + 80, s.y - h * 0.35));
    ctx.clearRect(0, 0, w, h);
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    const depth = camY / s.worldHeight;
    sky.addColorStop(0, `rgba(${40 + depth * 60}, ${70 + depth * 80}, ${140 + depth * 60}, 0.88)`);
    sky.addColorStop(1, `rgba(${90 + depth * 80}, ${140 + depth * 70}, ${200 + depth * 30}, 0.88)`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // Parallax clouds.
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    for (let i = 0; i < 12; i++) {
      const cy = ((i * 397 - camY * 0.4) % (h + 200) + h + 200) % (h + 200) - 100;
      const cx = (i * 263) % w;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 70, 22, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const it of s.items) {
      const y = it.y - camY;
      if (it.taken || y < -40 || y > h + 40) continue;
      if (it.kind === "spike") drawSpike(ctx, it.x, y, it.r);
      else {
        ctx.font = `${it.r * 2}px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
        ctx.fillText(it.kind === "umbrella" ? "☂️" : "🪙", it.x, y);
      }
    }

    // Ground and landing pad.
    const gy = s.worldHeight - camY;
    if (gy < h + 10) {
      ctx.fillStyle = "#3d5a3a";
      ctx.fillRect(0, gy, w, h - gy + 10);
      const px = s.pad.x - s.pad.w / 2;
      for (let i = 0; i < s.pad.w; i += 12) {
        ctx.fillStyle = (i / 12) % 2 ? "#ffd166" : "#2b2118";
        ctx.fillRect(px + i, gy - 6, Math.min(12, s.pad.w - i), 8);
      }
    }

    // Player.
    const py = s.y - camY;
    if (s.umbrella > 0) {
      ctx.font = "34px system-ui, 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif";
      ctx.fillText("☂️", s.x, py - this.atlas.height * this.scale - 14);
    }
    const facing = s.clinging ? (s.x < w / 2 ? -1 : 1) : s.vx < -5 ? -1 : 1;
    this.atlas.draw(ctx, this.anim.frame, s.x, py + (s.status === "playing" ? this.atlas.height * this.scale * 0.5 : 0), this.scale, facing);

    // HUD.
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#fff";
    ctx.font = "600 16px Nunito, 'Segoe UI', system-ui, sans-serif";
    const left = Math.max(0, Math.round((s.worldHeight - s.y) / 10));
    ctx.fillText(`🪙 ${s.coins}    ⬇ ${left} m`, 16, 28);
    const safe = s.vy <= TUNING.safeSpeed;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(16, 40, 160, 10);
    ctx.fillStyle = safe ? "#5ad17a" : "#ff6b6b";
    ctx.fillRect(16, 40, Math.min(160, (s.vy / TUNING.maxFall) * 160), 10);
    ctx.fillStyle = "#fff";
    ctx.fillRect(16 + (TUNING.safeSpeed / TUNING.maxFall) * 160, 36, 2, 18);
    ctx.fillText(safe ? "speed OK" : "too fast!", 184, 50);
  }
}

function drawSpike(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.fillStyle = "#e63946";
  ctx.strokeStyle = "#5c0b10";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const rr = i % 2 ? r * 0.55 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}
