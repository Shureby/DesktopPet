import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every .ts file under src/ but the tests. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the interface text", () => {
  // English until the app is translated: Chinese shows as boxes where no Chinese font is
  // installed, and most users couldn't read it anyway.
  it("has no Chinese in it", () => {
    const found = sources(join(__dirname))
      .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => ({ f, i, line })))
      .filter(({ line }) => /[㐀-鿿]/.test(line))
      .map(({ f, i, line }) => `${f}:${i + 1}: ${line.trim()}`);
    expect(found).toEqual([]);
  });
});
