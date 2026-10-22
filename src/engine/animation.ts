export interface AnimationDef {
  frames: string[];
  fps: number;
  loop: boolean;
  /** Animation to continue with after a non-looping animation ends. */
  next?: string;
}

/** Tracks playback of named animations; pure logic so it can be unit tested. */
export class AnimationPlayer {
  private name = "";
  private t = 0;

  constructor(private readonly anims: Record<string, AnimationDef>) {}

  get current(): string {
    return this.name;
  }

  play(name: string, restart = false): void {
    if (!this.anims[name]) throw new Error(`Unknown animation "${name}"`);
    if (name === this.name && !restart) return;
    this.name = name;
    this.t = 0;
  }

  /** True once a non-looping animation has shown its last frame for a full frame time. */
  get finished(): boolean {
    const a = this.anims[this.name];
    return !!a && !a.loop && this.t >= a.frames.length / a.fps;
  }

  update(dt: number): void {
    this.t += dt;
    const a = this.anims[this.name];
    if (a && !a.loop && a.next && this.finished) this.play(a.next);
  }

  get frame(): string {
    const a = this.anims[this.name];
    if (!a) return "";
    const i = Math.floor(this.t * a.fps);
    return a.frames[a.loop ? i % a.frames.length : Math.min(i, a.frames.length - 1)];
  }
}
