import type { Sprite } from "../characters/schema";

/** Pre-rendered frames of a character's sprite, ready to blit. */
export class SpriteAtlas {
  private readonly frames = new Map<string, CanvasImageSource>();
  private readonly alpha = new Map<string, Uint8ClampedArray>();

  private constructor(
    readonly width: number,
    readonly height: number,
    readonly facing: "left" | "right",
  ) {}

  static async load(sprite: Sprite, asset: (path: string) => string): Promise<SpriteAtlas> {
    if (sprite.type === "pixels") {
      const first = Object.values(sprite.frames)[0];
      const atlas = new SpriteAtlas(first[0].length, first.length, sprite.facing);
      const colors = Object.fromEntries(Object.entries(sprite.palette).map(([k, v]) => [k, v]));
      for (const [name, rows] of Object.entries(sprite.frames)) {
        const c = document.createElement("canvas");
        c.width = atlas.width;
        c.height = atlas.height;
        const ctx = c.getContext("2d")!;
        rows.forEach((row, y) => {
          for (let x = 0; x < row.length; x++) {
            const ch = row[x];
            if (ch === ".") continue;
            ctx.fillStyle = colors[ch];
            ctx.fillRect(x, y, 1, 1);
          }
        });
        atlas.add(name, c, ctx);
      }
      return atlas;
    }

    const img = new Image();
    img.src = asset(sprite.src);
    await img.decode();
    const atlas = new SpriteAtlas(sprite.frameWidth, sprite.frameHeight, sprite.facing);
    for (const [name, [col, row]] of Object.entries(sprite.frames)) {
      const c = document.createElement("canvas");
      c.width = atlas.width;
      c.height = atlas.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, col * atlas.width, row * atlas.height, atlas.width, atlas.height, 0, 0, atlas.width, atlas.height);
      atlas.add(name, c, ctx);
    }
    return atlas;
  }

  private add(name: string, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.frames.set(name, canvas);
    this.alpha.set(name, ctx.getImageData(0, 0, this.width, this.height).data);
  }

  /**
   * Draws a frame with its feet centred at (x, y). `facing` 1 = right, -1 = left;
   * the art is mirrored when it faces the other way.
   */
  draw(ctx: CanvasRenderingContext2D, frame: string, x: number, y: number, scale: number, facing: 1 | -1): void {
    const img = this.frames.get(frame);
    if (!img) return;
    const w = this.width * scale;
    const h = this.height * scale;
    const flip = (facing === 1) !== (this.facing === "right");
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(Math.round(x), Math.round(y));
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(img, -w / 2, -h, w, h);
    ctx.restore();
  }

  /** Whether the pixel at (px, py), relative to the frame's feet anchor, is opaque. */
  hit(frame: string, px: number, py: number, scale: number, facing: 1 | -1): boolean {
    const data = this.alpha.get(frame);
    if (!data) return false;
    const flip = (facing === 1) !== (this.facing === "right");
    let fx = Math.floor(px / scale + this.width / 2);
    const fy = Math.floor(py / scale + this.height);
    if (flip) fx = this.width - 1 - fx;
    if (fx < 0 || fy < 0 || fx >= this.width || fy >= this.height) return false;
    return data[(fy * this.width + fx) * 4 + 3] > 32;
  }
}
