import type { CharacterDef } from "./schema";
import { validateCharacter } from "./validate";

export interface LoadedCharacter {
  def: CharacterDef;
  source: "bundled" | "user";
  /** Resolves a path relative to the character folder (sprite sheets, sounds) to a URL. */
  asset(path: string): string;
}

export interface LoadIssue {
  source: string;
  errors: string[];
}

/** A user character folder as returned by the backend. */
export interface UserCharacterFile {
  dir: string;
  json: string;
}

// Adding a folder under assets/characters/ is all it takes to ship a new character.
const bundledJson = import.meta.glob("../../assets/characters/*/character.json", {
  eager: true,
  import: "default",
});
const bundledAssets = import.meta.glob("../../assets/characters/*/*.{png,webp,ogg,mp3,wav}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export class CharacterRegistry {
  private readonly byId = new Map<string, LoadedCharacter>();
  readonly issues: LoadIssue[] = [];

  add(c: LoadedCharacter, source: string): void {
    if (this.byId.has(c.def.id)) {
      this.issues.push({ source, errors: [`duplicate character id "${c.def.id}" (ignored)`] });
      return;
    }
    this.byId.set(c.def.id, c);
  }

  list(): LoadedCharacter[] {
    return [...this.byId.values()];
  }

  get(id: string): LoadedCharacter | undefined {
    return this.byId.get(id);
  }

  /** The requested character, else the fallback, else whatever loaded first. */
  pick(id: string | undefined, fallback: string): LoadedCharacter {
    const c = (id && this.get(id)) || this.get(fallback) || this.list()[0];
    if (!c) throw new Error("No valid characters are installed");
    return c;
  }
}

export function loadBundled(registry = new CharacterRegistry()): CharacterRegistry {
  for (const [path, raw] of Object.entries(bundledJson)) {
    const dir = path.slice(0, path.lastIndexOf("/") + 1);
    const result = validateCharacter(raw);
    if (!result.ok) {
      registry.issues.push({ source: path, errors: result.errors });
      continue;
    }
    registry.add(
      { def: result.def, source: "bundled", asset: (p) => bundledAssets[dir + p] ?? dir + p },
      path,
    );
  }
  return registry;
}

/**
 * Adds user-installed (and Steam Workshop) characters. These are data-only:
 * JSON plus images — never scripts — so they are safe to load.
 */
export function loadUser(
  files: UserCharacterFile[],
  toUrl: (absolutePath: string) => string,
  registry: CharacterRegistry,
): CharacterRegistry {
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(file.json);
    } catch (e) {
      registry.issues.push({ source: file.dir, errors: [`invalid JSON: ${(e as Error).message}`] });
      continue;
    }
    const result = validateCharacter(raw);
    if (!result.ok) {
      registry.issues.push({ source: file.dir, errors: result.errors });
      continue;
    }
    registry.add({ def: result.def, source: "user", asset: (p) => toUrl(`${file.dir}/${p}`) }, file.dir);
  }
  return registry;
}
