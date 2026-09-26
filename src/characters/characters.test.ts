import { describe, expect, it } from "vitest";
import { RulesBrain } from "../brain/RulesBrain";
import { createRng } from "../engine/random";
import { ABILITIES } from "./abilities";
import { movesetPower, POWER_BUDGET } from "./combat/moveset";
import { Pet } from "./Pet";
import { loadBundled, loadUser } from "./registry";
import type { CharacterDef } from "./schema";
import { validateCharacter } from "./validate";

const registry = loadBundled();
const screen = { x: 0, y: 0, w: 1600, h: 900 };

function spawn(def: CharacterDef, seed = 1, x = 800, y = 900) {
  const pet = new Pet(def, { brain: new RulesBrain(() => new Date(2026, 0, 1, 12)), rng: createRng(seed), unit: 1, x, y });
  pet.world = { areas: [screen], windows: [] };
  return pet;
}

function simulate(pet: Pet, seconds: number, each?: () => void) {
  for (let t = 0; t < seconds; t += 1 / 30) {
    pet.update(1 / 30);
    each?.();
  }
}

describe("bundled characters (conformance)", () => {
  it("all load without validation issues", () => {
    expect(registry.issues).toEqual([]);
    expect(registry.list().length).toBeGreaterThanOrEqual(2);
  });

  // Every character, present and future, must pass these.
  for (const c of registry.list()) {
    describe(c.def.id, () => {
      it("keeps its moveset within the shared power budget", () => {
        const power = movesetPower(c.def.moveset);
        expect(Math.abs(power - POWER_BUDGET.target)).toBeLessThanOrEqual(POWER_BUDGET.target * POWER_BUDGET.tolerance);
      });

      it("only uses known abilities", () => {
        for (const a of c.def.abilities) expect(ABILITIES[a.id], a.id).toBeDefined();
      });

      it("survives a few simulated minutes of free roaming", () => {
        const pet = spawn(c.def);
        const seen = new Set<string>();
        simulate(pet, 180, () => seen.add(pet.state));
        expect(pet.body.x).toBeGreaterThanOrEqual(0);
        expect(pet.body.x).toBeLessThanOrEqual(1600);
        expect(pet.body.y).toBeLessThanOrEqual(900);
        expect(seen.size).toBeGreaterThan(3);
      });
    });
  }
});

describe("validation", () => {
  const cat = registry.get("cat")!.def;

  it("rejects characters missing core animations", () => {
    const broken = structuredClone(cat) as Record<string, unknown> & CharacterDef;
    delete (broken.animations as Record<string, unknown>).sleep;
    const r = validateCharacter(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('missing core animation "sleep"');
  });

  it("rejects unknown abilities and missing ability animations", () => {
    const broken = structuredClone(cat);
    broken.abilities = [{ id: "teleport", params: {} }, { id: "glide", params: {} }];
    const r = validateCharacter(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('unknown ability "teleport"');
      expect(r.errors).toContain('ability "glide" needs animation "glide"');
    }
  });

  it("rejects overpowered movesets", () => {
    const broken = structuredClone(cat);
    broken.moveset.moves[0].damage = 60;
    const r = validateCharacter(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/outside the budget/);
  });

  it("loads a data-only user character that reuses existing abilities", () => {
    const goat = structuredClone(cat);
    goat.id = "goat";
    goat.displayName = "Goat";
    const reg = loadBundled();
    loadUser(
      [
        { dir: "/chars/goat", json: JSON.stringify(goat) },
        { dir: "/chars/bad", json: "{ nope" },
      ],
      (p) => `asset://${p}`,
      reg,
    );
    expect(reg.get("goat")?.source).toBe("user");
    expect(reg.issues).toHaveLength(1);
    expect(reg.issues[0].errors[0]).toMatch(/invalid JSON/);
  });
});

describe("abilities change behaviour", () => {
  it("the rooster glides: it falls much slower than the cat", () => {
    const tall = { x: 0, y: 0, w: 1600, h: 4000 };
    const cat = spawn(registry.get("cat")!.def, 1, 800, 0);
    const rooster = spawn(registry.get("rooster")!.def, 1, 800, 0);
    cat.world = rooster.world = { areas: [tall], windows: [] };
    simulate(cat, 1.5);
    simulate(rooster, 1.5);
    expect(rooster.state).toBe("glide");
    expect(rooster.body.y).toBeLessThan(cat.body.y * 0.7);
  });

  it("the cat can climb a screen edge", () => {
    const cat = spawn(registry.get("cat")!.def, 3, 1500, 900);
    simulate(cat, 0.2);
    let climbed = false;
    for (let i = 0; i < 40 && !climbed; i++) {
      cat.facing = 1;
      cat.fsm.set("walk", true);
      simulate(cat, 3, () => (climbed ||= cat.state === "climb"));
    }
    expect(climbed).toBe(true);
  });

  it("exposes game modifiers from abilities, not character ids", () => {
    expect(spawn(registry.get("rooster")!.def).gameModifiers().glideFallFactor).toBeCloseTo(0.22);
    expect(spawn(registry.get("cat")!.def).gameModifiers().glideFallFactor).toBeNull();
    expect(spawn(registry.get("cat")!.def).gameModifiers().wallGrab).toBe(true);
  });
});

describe("RulesBrain", () => {
  it("keeps the pet calm during focus sessions", () => {
    const pet = spawn(registry.get("rooster")!.def);
    simulate(pet, 1);
    pet.mode = "focus";
    const w = new RulesBrain().weights(pet);
    expect(w.run).toBe(0);
    expect(w.walk).toBe(0);
    expect(w.sit).toBeGreaterThan(10);
  });

  it("gets sleepier at night", () => {
    const pet = spawn(registry.get("cat")!.def);
    simulate(pet, 1);
    const day = new RulesBrain(() => new Date(2026, 0, 1, 14)).weights(pet).sleep;
    const night = new RulesBrain(() => new Date(2026, 0, 1, 2)).weights(pet).sleep;
    expect(night).toBeGreaterThan(day * 2);
  });

  it("stays put for reminders when the user turned running off", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const pet = spawn(registry.get("rooster")!.def, seed, 200, 900);
      simulate(pet, 1);
      pet.fsm.set("sit", true);
      // Airborne pets finish their jump first; only check grounded ones.
      if (!pet.grounded) continue;
      pet.react({ type: "reminder", kind: "alarm", title: "Wake up", run: false });
      expect(pet.state).toBe("alert");
    }
  });

  it("runs to the middle of the screen for reminders (sociable characters)", () => {
    const pet = spawn(registry.get("rooster")!.def, 5, 200, 900);
    simulate(pet, 1);
    const said: string[] = [];
    pet.onSay = (t) => said.push(t);
    pet.react({ type: "reminder", kind: "todo", title: "Call mom" });
    expect(said[0]).toMatch(/Call mom/);
    expect(["goto", "alert"]).toContain(pet.state);
  });
});
