#!/usr/bin/env node
// Renders pixel-art characters to PNG previews (build/previews/<id>.png), and
// with --icon renders the default character to build/icon-source.png for `tauri icon`.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

// fileURLToPath, not .pathname: the latter yields "/D:/..." on Windows.
const root = fileURLToPath(new URL("..", import.meta.url));
const charsDir = join(root, "assets/characters");
const outDir = join(root, "build");
mkdirSync(join(outDir, "previews"), { recursive: true });

function hex(c) {
  const n = c.replace("#", "");
  return [0, 2, 4, 6].map((i) => (i < n.length ? parseInt(n.slice(i, i + 2), 16) : 255));
}

function blit(png, rows, palette, ox, oy, scale) {
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      const [r, g, b, a] = hex(palette[ch]);
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = ((oy + y * scale + dy) * png.width + ox + x * scale + dx) * 4;
          png.data.set([r, g, b, a], i);
        }
    });
  });
}

function fill(png, rgba) {
  for (let i = 0; i < png.data.length; i += 4) png.data.set(rgba, i);
}

const product = JSON.parse(readFileSync(join(root, "product.config.json"), "utf8"));

for (const id of readdirSync(charsDir)) {
  const file = join(charsDir, id, "character.json");
  if (!existsSync(file)) continue;
  const def = JSON.parse(readFileSync(file, "utf8"));
  if (def.sprite.type !== "pixels") continue;
  const frames = Object.entries(def.sprite.frames);
  const fw = frames[0][1][0].length;
  const fh = frames[0][1].length;
  const scale = 6;
  const cols = 6;
  const cell = { w: fw * scale + 8, h: fh * scale + 8 };
  const rows = Math.ceil(frames.length / cols);
  const png = new PNG({ width: cols * cell.w, height: rows * cell.h });
  fill(png, [236, 240, 245, 255]);
  frames.forEach(([, f], i) => blit(png, f, def.sprite.palette, (i % cols) * cell.w + 4, Math.floor(i / cols) * cell.h + 4, scale));
  writeFileSync(join(outDir, "previews", `${id}.png`), PNG.sync.write(png));
  console.log(`build/previews/${id}.png  (${frames.map(([n]) => n).join(", ")})`);

  if (process.argv.includes("--icon") && id === product.defaultCharacter) {
    const size = 1024;
    const icon = new PNG({ width: size, height: size });
    fill(icon, [0, 0, 0, 0]);
    // Rounded-square background.
    const r = 180;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const cx = Math.min(Math.max(x, r), size - r);
        const cy = Math.min(Math.max(y, r), size - r);
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) icon.data.set([255, 228, 181, 255], (y * size + x) * 4);
      }
    const f = def.sprite.frames.stand ?? frames[0][1];
    const s = Math.floor((size * 0.8) / Math.max(fw, fh));
    blit(icon, f, def.sprite.palette, Math.floor((size - fw * s) / 2), Math.floor((size - fh * s) / 2), s);
    writeFileSync(join(outDir, "icon-source.png"), PNG.sync.write(icon));
    console.log("build/icon-source.png");
  }
}
