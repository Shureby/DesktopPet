/**
 * The texts to translate, as the source uses them: every `t("…")` and `msg("…")` with a plain
 * string, and every line set `lines("id", …)` (ids built with a template are listed in
 * LINE_SETS). For the dictionaries' tests and the review table (scripts/i18n-table.mjs).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Line sets whose ids are built in code (src/features/avoid/lines.ts). */
export const LINE_SETS = [
  "avoid.leaving.fullscreen",
  "avoid.leaving.presenting",
  "avoid.leaving.call",
  "avoid.back.fullscreen.short",
  "avoid.back.fullscreen.long",
  "avoid.back.presenting.short",
  "avoid.back.presenting.long",
  "avoid.back.call.short",
  "avoid.back.call.long",
  "avoid.shownAnyway",
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    // Not the dictionaries themselves.
    const skip = ["zh-CN.ts", "zh-TW.ts", "keys.ts"].includes(e.name);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !skip ? [path] : [];
  });
}

export interface Key {
  text: string;
  /** Where it's used: "src/panel/main.ts:123", the first place. */
  where: string;
}

/** Every English text the source translates, once each, in the order found. */
export function sourceKeys(srcDir: string): Key[] {
  const found = new Map<string, string>();
  for (const file of sources(srcDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\b(?:t|msg)\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        const text = JSON.parse(`"${m[1]}"`) as string;
        if (!found.has(text)) found.set(text, `${file.slice(file.indexOf("src"))}:${i + 1}`);
      }
    });
  }
  return [...found].map(([text, where]) => ({ text, where }));
}

/** `{name}`s in a text, sorted. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}
