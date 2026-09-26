#!/usr/bin/env node
// Assembles a Steam depot folder from a `tauri build --no-bundle --features steam` build:
// the executable plus the Steam API library it links against.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname: the latter yields "/D:/..." on Windows.
const root = fileURLToPath(new URL("..", import.meta.url));
const target = process.argv[2] ?? join(root, "target/release");
const product = JSON.parse(readFileSync(join(root, "product.config.json"), "utf8"));
const out = join(root, "build/steam-depot");
mkdirSync(out, { recursive: true });

const exe = ["desktoppet.exe", "desktoppet"].map((f) => join(target, f)).find(existsSync);
if (!exe) throw new Error(`No desktoppet executable in ${target}; run: npx tauri build --no-bundle --features steam`);
copyFileSync(exe, join(out, exe.endsWith(".exe") ? `${product.productName}.exe` : product.productName));

const buildDir = join(target, "build");
const sdkLibs = ["steam_api64.dll", "libsteam_api.so", "libsteam_api.dylib"];
let copied = 0;
for (const dir of readdirSync(buildDir).filter((d) => d.startsWith("steamworks-sys-"))) {
  for (const lib of sdkLibs) {
    const p = join(buildDir, dir, "out", lib);
    if (existsSync(p)) {
      copyFileSync(p, join(out, lib));
      copied++;
    }
  }
}
if (!copied) throw new Error("Steam API library not found; was the build made with --features steam?");
console.log(`Steam depot ready in ${out}`);
