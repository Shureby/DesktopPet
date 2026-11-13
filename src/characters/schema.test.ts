import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CharacterSchema } from "./schema";

// schema/character.schema.json gives creators autocompletion in their editor.
// Regenerate with: UPDATE_SCHEMA=1 npx vitest run src/characters/schema.test.ts
const path = new URL("../../schema/character.schema.json", import.meta.url);

describe("character JSON Schema", () => {
  it("is in sync with the zod schema", () => {
    const generated = JSON.stringify(
      { title: "Desktop pet character", ...z.toJSONSchema(CharacterSchema.extend({ $schema: z.string().optional() }), { io: "input" }) },
      null,
      2,
    ) + "\n";
    if (process.env.UPDATE_SCHEMA) writeFileSync(path, generated);
    expect(readFileSync(path, "utf8")).toBe(generated);
  });
});
