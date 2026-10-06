import { describe, expect, it } from "vitest";
import { RulesBrain } from "../brain/RulesBrain";
import { createRng } from "../engine/random";
import { ABILITIES } from "./abilities";
import { movesetPower, POWER_BUDGET } from "./combat/moveset";
import { Pet } from "./Pet";
import { copyOf, loadBundled, loadUser } from "./registry";
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

  it("makes a copy that loads as a new user character", () => {
    const reg = loadBundled();
    const first = copyOf(reg.get("cat")!, reg);
    expect(first.id).toBe("cat-copy");
    const copy = JSON.parse(first.json);
    expect(copy).toMatchObject({ $schema: "../character.schema.json", id: "cat-copy", displayName: "Cat (copy)" });
    expect(validateCharacter(copy).ok).toBe(true);
    loadUser([{ dir: "/chars/cat-copy", json: first.json }], (p) => p, reg);
    expect(reg.get("cat-copy")).toMatchObject({ source: "user", dir: "/chars/cat-copy" });
    // A copy of the copy, or a second copy of the cat, takes the next free id.
    expect(copyOf(reg.get("cat-copy")!, reg).id).toBe("cat-copy-2");
    expect(copyOf(reg.get("cat")!, reg).id).toBe("cat-copy-2");
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

  it("comes over to the cursor when it adores you, mopes when grumpy", () => {
    const pet = spawn(registry.get("rooster")!.def);
    simulate(pet, 1);
    pet.cursor = { x: 300, y: 900 };
    pet.mood.affection = 95;
    expect(new RulesBrain().weights(pet).approach).toBeGreaterThan(0);
    pet.mood.affection = 60;
    expect(new RulesBrain().weights(pet).approach).toBeUndefined();
    const content = new RulesBrain().weights(pet);
    pet.mood.affection = 30;
    const grumpy = new RulesBrain().weights(pet);
    expect(grumpy.run).toBeLessThan(content.run);
    expect(grumpy.sit).toBeGreaterThan(content.sit);
  });

  it("walks over to the cursor and looks happy", () => {
    const pet = spawn(registry.get("cat")!.def, 2, 400, 900);
    simulate(pet, 1);
    pet.cursor = { x: 700, y: 880 };
    pet.fsm.set("approach", true);
    const seen = new Set<string>();
    simulate(pet, 6, () => seen.add(pet.state));
    expect(seen.has("happy")).toBe(true);
    expect(Math.abs(pet.body.x - 700)).toBeLessThan(80);
  });

  it("a sulking pet sometimes snubs petting, and hungry pets complain", () => {
    const pet = spawn(registry.get("cat")!.def);
    simulate(pet, 1);
    pet.mood.affection = 10;
    const said: string[] = [];
    pet.onSay = (t) => said.push(t);
    for (let i = 0; i < 20; i++) pet.react({ type: "petted" });
    const sulks = pet.def.personality.lines.sulk;
    expect(said.some((t) => sulks.includes(t))).toBe(true);
    expect(said.some((t) => !sulks.includes(t))).toBe(true);

    said.length = 0;
    pet.mood.fullness = 5;
    simulate(pet, 450);
    expect(said.some((t) => pet.def.personality.lines.hungry.includes(t))).toBe(true);
  });

  it("reminders always get through, whatever the mood", () => {
    const pet = spawn(registry.get("cat")!.def);
    simulate(pet, 1);
    pet.mood.affection = 0;
    pet.mood.fullness = 0;
    const said: string[] = [];
    pet.onSay = (t) => said.push(t);
    pet.react({ type: "reminder", kind: "alarm", title: "Meeting" });
    expect(said[0]).toMatch(/Meeting/);
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

describe("slams", () => {
  it("only counts hard landings after the user throws the pet, not ordinary falls", () => {
    const pet = spawn(registry.get("cat")!.def, 1, 800, 0);
    pet.world = { areas: [{ x: 0, y: 0, w: 1600, h: 4000 }], windows: [] };
    const start = pet.mood.affection;
    simulate(pet, 5);
    expect(pet.grounded).toBe(true);
    expect(pet.mood.affection).toBeCloseTo(start, 1);

    pet.startDrag();
    pet.dragTo(800, 100, 0);
    pet.endDrag();
    simulate(pet, 5);
    expect(pet.mood.affection).toBeLessThan(start - 0.5);
  });
});

describe("display scale", () => {
  it("resizes the pet when the scale changes, keeping it standing on the floor", () => {
    const pet = spawn(registry.get("cat")!.def);
    simulate(pet, 2);
    expect(pet.grounded).toBe(true);
    const { w, h } = pet.spriteSize;
    pet.setUnit(1.5); // Windows display scale 100% → 150%
    expect(pet.spriteSize.w).toBeCloseTo(w * 1.5);
    expect(pet.body.h).toBeCloseTo(h * 1.5);
    simulate(pet, 2);
    expect(pet.grounded).toBe(true);
    expect(pet.body.y).toBeCloseTo(screen.y + screen.h);
    pet.setUnit(1);
    expect(pet.body.h).toBeCloseTo(h);
  });
});

describe("mouse resting on the pet (docs/INTERACTIONS.md)", () => {
  function walkingCat() {
    const pet = spawn(registry.get("cat")!.def);
    simulate(pet, 2);
    pet.fsm.set("run", true);
    simulate(pet, 0.3);
    return pet;
  }

  it("stops and faces the cursor, stays put, and carries on once released", () => {
    const pet = walkingCat();
    pet.cursor = { x: pet.body.x - 200, y: pet.body.y - 20 };
    pet.react({ type: "hover", phase: "attend" });
    simulate(pet, 0.5);
    expect(pet.state).toBe("attend");
    expect(pet.body.vx).toBe(0);
    expect(pet.facing).toBe(-1);
    const x = pet.body.x;
    simulate(pet, 20);
    expect(pet.state).toBe("attend");
    expect(pet.body.x).toBeCloseTo(x);
    pet.react({ type: "hover", phase: "release" });
    expect(pet.state).not.toBe("attend");
    expect(pet.attending).toBe(false);
  });

  it("goes back to attending after a happy hop", () => {
    const pet = walkingCat();
    pet.cursor = { x: pet.body.x, y: pet.body.y - 20 };
    pet.react({ type: "hover", phase: "attend" });
    pet.react({ type: "petted" });
    expect(pet.state).toBe("happy");
    simulate(pet, 3);
    expect(pet.state).toBe("attend");
  });

  it("an unhappy pet steps about a body length away, says why, and turns back", () => {
    const pet = walkingCat();
    const said: string[] = [];
    pet.onSay = (t) => said.push(t);
    pet.cursor = { x: pet.body.x + 5, y: pet.body.y - 20 };
    const x = pet.body.x;
    pet.react({ type: "hover", phase: "dodge", reason: "hungry" });
    expect(pet.state).toBe("dodge");
    simulate(pet, 1.5);
    const moved = x - pet.body.x;
    expect(moved).toBeGreaterThan(pet.spriteSize.w * 0.6);
    expect(moved).toBeLessThan(pet.spriteSize.w * 2);
    expect(pet.facing).toBe(1);
    expect(registry.get("cat")!.def.personality.lines.dodgeHungry).toContain(said[0]);
  });

  it("every bundled character has the hover lines", () => {
    for (const c of registry.list()) {
      for (const key of ["dodgeHungry", "dodgeGrumpy", "noticed", "noticedHappy", "release"]) {
        expect(c.def.personality.lines[key]?.length, `${c.def.id}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
