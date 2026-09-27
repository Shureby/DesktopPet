import { describe, expect, it } from "vitest";
import { loadBundled } from "../characters/registry";
import { createRng } from "../engine/random";
import { DEFAULT_SETTINGS, type Alarm } from "../platform/types";
import { buildItems, careLabel, pickCare, type Item, type MenuContext } from "./menu";

const registry = loadBundled();
const cat = registry.get("cat")!.def;

function ctx(over: Partial<MenuContext> = {}): MenuContext {
  return {
    backend: {} as MenuContext["backend"],
    registry,
    settings: DEFAULT_SETTINGS,
    pomodoro: { phase: "idle", round: 0, endsAt: null },
    character: cat,
    hungry: false,
    timers: [],
    rng: createRng(1),
    care: () => {},
    setTimer: () => {},
    customTimer: () => {},
    hide: () => {},
    ...over,
  };
}

const texts = (items: (Item | "sep")[]) => items.filter((i): i is Item => i !== "sep").map((i) => i.text);
const timer = (id: number, min: number): Alarm & { nextFire: number } => ({
  id,
  label: `Timer: ${min} min`,
  nextFire: Date.now() + min * 60_000,
  timeHm: null,
  repeat: "none",
  enabled: true,
  snoozes: 0,
  missedAt: null,
});

describe("pet menu", () => {
  it("starts every item with a verb", () => {
    const verbs = /^(Stroke|Scratch|Rub|Feed|Add|Set|Cancel|Start|Stop|Play|Switch|Open|Hide)\b/;
    expect(texts(buildItems(ctx()))).toContain("Set alarm…");
    for (const t of texts(buildItems(ctx({ timers: [timer(1, 5)] })))) expect(t).toMatch(verbs);
  });

  it("offers a care action with the character's name, feeding first when hungry", () => {
    expect(careLabel(cat.personality.care[0], cat)).toBe("Stroke the Cat");
    for (let seed = 0; seed < 20; seed++) expect(pickCare(cat, true, createRng(seed)).kind).toBe("feed");
    const kinds = new Set(Array.from({ length: 40 }, (_, seed) => pickCare(cat, false, createRng(seed)).kind));
    expect(kinds).toEqual(new Set(["pet", "feed"]));
  });

  it("shows a cancel item only while timers run, with time left", () => {
    expect(texts(buildItems(ctx())).some((t) => t.startsWith("Cancel"))).toBe(false);
    expect(texts(buildItems(ctx({ timers: [timer(1, 5)] })))).toContainEqual(expect.stringMatching(/^Cancel timer \((4:5\d|5:00) left\)$/));
    const many = buildItems(ctx({ timers: [timer(1, 5), timer(2, 10)] }));
    const cancel = many.find((i): i is Item => i !== "sep" && i.text === "Cancel timer");
    expect(cancel?.items).toHaveLength(2);
  });

  it("lists presets, then the user's custom lengths and Custom… below a separator", () => {
    const settings = { ...DEFAULT_SETTINGS, recentTimers: [20, 1.5, 90] };
    const set = buildItems(ctx({ settings })).find((i): i is Item => i !== "sep" && i.text === "Set timer")!;
    expect(set.items!.map((i) => (i === "sep" ? "—" : i.text))).toEqual([
      "1 min", "5 min", "10 min", "15 min", "30 min", "45 min", "1 hour",
      "—",
      "20 min (custom)", "1 min 30 s (custom)", "1 h 30 min (custom)",
      "Custom…",
    ]);
  });

  it("offers to cancel a snoozed alarm", () => {
    const snoozed = { ...timer(7, 5), label: "Wake up", repeat: "daily" as const, timeHm: "07:00", snoozes: 1 };
    expect(texts(buildItems(ctx({ snoozed: [snoozed] })))).toContainEqual(expect.stringMatching(/^Cancel snooze: Wake up \(.+\)$/));
  });

  it("shows focus session time left while one runs", () => {
    const items = texts(buildItems(ctx({ pomodoro: { phase: "focus", round: 0, endsAt: Date.now() + 18 * 60_000 } })));
    expect(items).toContainEqual(expect.stringMatching(/^Stop focus session \(1[78]:\d\d left\)$/));
  });
});
