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
  // Chinese only in the translations (src/i18n): everywhere else the English is the key, and
  // the English interface must not show Chinese (boxes where there's no Chinese font).
  it("has Chinese only in src/i18n", () => {
    const found = sources(join(__dirname))
      .filter((f) => !f.includes(join("src", "i18n")))
      .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => ({ f, i, line })))
      // Comments may show what the Chinese looks like.
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /[㐀-鿿]/.test(line))
      .map(({ f, i, line }) => `${f}:${i + 1}: ${line.trim()}`);
    expect(found).toEqual([]);
  });
});
