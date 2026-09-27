import type { Backend } from "../../platform";

export interface Keys {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  action: boolean;
}

/** A mini-game plugged into GameHost. Games get the character via their constructor. */
export interface MiniGame {
  readonly id: string;
  readonly title: string;
  /** One line per control, shown on the start screen. */
  readonly controls: string[];
  readonly status: "playing" | "won" | "lost";
  readonly score: number;
  readonly message: string;
  reset(seed: number, width: number, height: number): void;
  step(keys: Keys, dt: number): void;
  render(ctx: CanvasRenderingContext2D, width: number, height: number): void;
}

const STEP = 1 / 60;

/**
 * Shared shell for every mini-game: canvas, keyboard, fixed-step loop,
 * start/result screens, scores, achievements and quitting back to the desktop.
 */
export class GameHost {
  private phase: "intro" | "playing" | "result" = "intro";
  private keys: Keys = { left: false, right: false, up: false, down: false, action: false };
  private acc = 0;
  private last = performance.now();
  private best = 0;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly game: MiniGame,
    private readonly canvas: HTMLCanvasElement,
    private readonly backend: Backend,
    private readonly characterId: string,
  ) {
    this.ctx = canvas.getContext("2d")!;
  }

  async start(): Promise<void> {
    this.resize();
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    this.best = (await this.backend.topScores(this.game.id, 1))[0]?.score ?? 0;
    this.game.reset(Date.now() & 0xffff, this.width, this.height);
    requestAnimationFrame((t) => this.frame(t));
  }

  private get width() {
    return window.innerWidth;
  }
  private get height() {
    return window.innerHeight;
  }

  private resize() {
    const r = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * r);
    this.canvas.height = Math.round(this.height * r);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(r, 0, 0, r, 0, 0);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const map: Record<string, keyof Keys> = {
      ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
      ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down", Space: "action",
    };
    if (map[e.code]) {
      this.keys[map[e.code]] = down;
      e.preventDefault();
    }
    if (!down) return;
    if (e.code === "Escape") void this.quit();
    else if ((e.code === "Space" || e.code === "Enter") && this.phase === "intro") this.phase = "playing";
    else if ((e.code === "KeyR" || e.code === "Enter" || e.code === "Space") && this.phase === "result") {
      this.game.reset(Date.now() & 0xffff, this.width, this.height);
      this.phase = "playing";
      this.keys.action = false;
    }
  }

  private async quit() {
    await this.backend.closeGame();
  }

  private async finish() {
    this.phase = "result";
    const score = this.game.score;
    if (score > 0) await this.backend.recordScore(this.game.id, this.characterId, score);
    if (this.game.status === "won") await this.backend.unlockAchievement(`${this.game.id.replace(/-/g, "_")}_win`);
    this.best = Math.max(this.best, score);
    // Playing together makes the pet happier (and a win makes it proud).
    await this.backend.emit("pet-event", { type: "game", won: this.game.status === "won" });
  }

  private frame(now: number) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.phase === "playing") {
      this.acc += dt;
      while (this.acc >= STEP) {
        this.game.step(this.keys, STEP);
        this.acc -= STEP;
        if (this.game.status !== "playing") {
          void this.finish();
          break;
        }
      }
    }
    this.game.render(this.ctx, this.width, this.height);
    if (this.phase !== "playing") this.overlay();
    requestAnimationFrame((t) => this.frame(t));
  }

  private overlay() {
    const { ctx, width: w, height: h } = this;
    ctx.fillStyle = "rgba(10, 12, 24, 0.55)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    const lines =
      this.phase === "intro"
        ? [this.game.title, ...this.game.controls, "Space to start · Esc to quit"]
        : [
            this.game.message,
            `Score ${this.game.score}   ·   Best ${this.best}`,
            "Space / R to play again · Esc to quit",
          ];
    lines.forEach((line, i) => {
      ctx.font = i === 0 ? "800 42px Nunito, 'Segoe UI', system-ui, sans-serif" : "18px Nunito, 'Segoe UI', system-ui, sans-serif";
      ctx.fillText(line, w / 2, h / 2 - 60 + (i === 0 ? 0 : 30 + i * 30));
    });
  }
}
