import { describe, expect, it } from "vitest";
import { loadBundled } from "../characters/registry";
import { createRng } from "../engine/random";
import { clock } from "../features/alarm/ringing";
import { DEFAULT_SETTINGS, type Alarm } from "../platform/types";
import {
  buildItems,
  buildTrayItems,
  careLabel,
  panelTabFor,
  pickCare,
  type Item,
  type PetMenuContext,
  type TrayMenuContext,
} from "./menu";

const registry = loadBundled();
const cat = registry.get("cat")!.def;

function ctx(over: Partial<PetMenuContext> = {}): PetMenuContext {
  return {
    backend: {} as PetMenuContext["backend"],
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
    playGame: () => {},
    hide: () => {},
    ...over,
  };
}

function trayCtx(over: Partial<TrayMenuContext> = {}): TrayMenuContext {
  const { backend, registry, settings, pomodoro, timers, snoozed, setTimer, customTimer, playGame } = ctx();
  return {
    backend, registry, settings, pomodoro, timers, snoozed, setTimer, customTimer, playGame,
    petVisible: true,
    ...over,
  };
}

/** Texts including separators and submenus, so structure is compared too. */
const outline = (items: (Item | "sep")[]): unknown[] =>
  items.map((i) => (i === "sep" ? "—" : i.items ? [i.text, outline(i.items)] : `${i.checked ? "✓ " : ""}${i.text}`));

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
  missedSeenAt: null,
  skippedFire: null,
  repeatDays: 0,
  rangAt: null,
  createdAt: null,
});

describe("pet menu", () => {
  it("[menu.items] starts every item with a verb", () => {
    const verbs = /^(Stroke|Scratch|Rub|Feed|Add|Set|Cancel|Start|Stop|Play|Switch|Open|Hide)\b/;
    expect(texts(buildItems(ctx()))).toContain("Set alarm…");
    for (const t of texts(buildItems(ctx({ timers: [timer(1, 5)] })))) expect(t).toMatch(verbs);
  });

  it("[menu.care] offers a care action with the character's name, feeding first when hungry", () => {
    expect(careLabel(cat.personality.care[0], cat)).toBe("Stroke the Cat");
    for (let seed = 0; seed < 20; seed++) expect(pickCare(cat, true, createRng(seed)).kind).toBe("feed");
    const kinds = new Set(Array.from({ length: 40 }, (_, seed) => pickCare(cat, false, createRng(seed)).kind));
    expect(kinds).toEqual(new Set(["pet", "feed"]));
  });

  it("shows a cancel item only while timers run, with time left", () => {
    expect(texts(buildItems(ctx())).some((t) => t.startsWith("Cancel"))).toBe(false);
    expect(texts(buildItems(ctx({ timers: [timer(1, 5)] })))).toContainEqual(expect.stringMatching(/^Cancel timer: 5 min \(rings .+\)$/));
    const many = buildItems(ctx({ timers: [timer(1, 5), timer(2, 10)] }));
    const cancel = many.find((i): i is Item => i !== "sep" && i.text === "Cancel timer");
    expect(cancel?.items).toHaveLength(2);
  });

  it("[timer.presets] lists presets, then the user's custom lengths and Custom / Edit… below a separator", () => {
    const settings = { ...DEFAULT_SETTINGS, recentTimers: [20, 1.5, 90] };
    const set = buildItems(ctx({ settings })).find((i): i is Item => i !== "sep" && i.text === "Set timer")!;
    expect(set.items!.map((i) => (i === "sep" ? "—" : i.text))).toEqual([
      "1 min", "5 min", "10 min", "15 min", "30 min", "45 min", "1 hour",
      "—",
      "20 min (custom)", "1 min 30 s (custom)", "1 h 30 min (custom)",
      "Custom / Edit…",
    ]);
  });

  it("offers to cancel a snoozed alarm", () => {
    const snoozed = { ...timer(7, 5), label: "Wake up", repeat: "daily" as const, timeHm: "07:00", snoozes: 1 };
    expect(texts(buildItems(ctx({ snoozed: [snoozed] })))).toContainEqual(expect.stringMatching(/^Cancel snooze: Wake up \(next ring .+\)$/));
    // An unnamed alarm is called by its own time, not the snoozed ring's.
    const first = Date.now() - 6 * 60_000;
    const unnamed = { ...snoozed, label: "Alarm", repeat: "none" as const, timeHm: null, rangAt: first };
    expect(texts(buildItems(ctx({ snoozed: [unnamed] })))).toContainEqual(
      `Cancel snooze: Alarm ${clock(first)} (next ring ${clock(unnamed.nextFire)})`,
    );
  });

  it("shows when a running focus session ends, as a clock time", () => {
    const endsAt = Date.now() + 18 * 60_000;
    const items = texts(buildItems(ctx({ pomodoro: { phase: "focus", round: 0, endsAt } })));
    expect(items).toContain(`Stop focus session (ends ${clock(endsAt)})`);
  });
});

describe("tray menu", () => {
  const busy = {
    timers: [timer(1, 5), timer(2, 12)],
    snoozed: [{ ...timer(7, 5), label: "Wake up", repeat: "daily" as const, timeHm: "07:00", snoozes: 1 }],
    pomodoro: { phase: "focus" as const, round: 0, endsAt: Date.now() + 18 * 60_000 },
    settings: { ...DEFAULT_SETTINGS, recentTimers: [20] },
  };

  it("[tray.items] has exactly the pet menu's functions, in the same order", () => {
    for (const state of [{}, busy]) {
      const pet = outline(buildItems(ctx(state)));
      const tray = outline(buildTrayItems(trayCtx(state)));
      // Pet: care, —, [shared], —, Open panel…, Hide pet. Tray: Show/Hide, —, [shared], —, Open panel…, —, Quit.
      const shared = pet.slice(2, pet.indexOf("Open panel…"));
      expect(tray.slice(2, tray.indexOf("Open panel…"))).toEqual(shared);
      expect(shared).toContain("Set alarm…");
    }
  });

  it("[tray.items] differs only in show/hide on top and Quit at the bottom", () => {
    expect(outline(buildTrayItems(trayCtx())).slice(0, 2)).toEqual(["Hide pet", "—"]);
    expect(outline(buildTrayItems(trayCtx({ petVisible: false })))[0]).toBe("Show pet");
    expect(outline(buildTrayItems(trayCtx())).slice(-3)).toEqual(["Open panel…", "—", "Quit"]);
    expect(texts(buildItems(ctx()))).not.toContain("Quit");
  });

  it("never shows a countdown, which a menu built ahead of time can't keep current", () => {
    const all = JSON.stringify(outline(buildTrayItems(trayCtx(busy))));
    expect(all).not.toContain("left");
    expect(all).toContain(`Stop focus session (ends ${clock(busy.pomodoro.endsAt)})`);
  });
});

describe("Open panel…", () => {
  const soon = (min: number) => Date.now() + min * 60_000;
  const focus = (min: number) => ({ phase: "focus" as const, round: 0, endsAt: soon(min) });

  it("opens the tab of whatever runs out first", () => {
    expect(panelTabFor(ctx({ pomodoro: focus(8), timers: [timer(1, 5)] }))).toBe("alarms");
    expect(panelTabFor(ctx({ pomodoro: focus(3), timers: [timer(1, 5)] }))).toBe("focus");
    expect(panelTabFor(ctx({ pomodoro: { phase: "short_break", round: 1, endsAt: soon(2) } }))).toBe("focus");
    const snoozed = { ...timer(7, 1), label: "Wake up", repeat: "daily" as const, timeHm: "07:00", snoozes: 1 };
    expect(panelTabFor(ctx({ pomodoro: focus(3), snoozed: [snoozed] }))).toBe("alarms");
  });

  it("opens Alarms for a missed alarm, and the default tab when nothing is going on", () => {
    expect(panelTabFor(ctx({ missed: [{ ...timer(9, 0), missedAt: Date.now() }] }))).toBe("alarms");
    expect(panelTabFor(ctx())).toBeUndefined();
  });
});

describe("games during a focus session", () => {
  const focusing = { phase: "focus" as const, round: 0, endsAt: Date.now() + 10 * 60_000 };
  const play = (c: PetMenuContext) => (buildItems(c).find((i) => i !== "sep" && i.text.startsWith("Play")) as { text: string }).text;

  it("marks the game as held while focusing, not during breaks or with the option off", () => {
    expect(play(ctx())).toBe("Play Safe Landing");
    expect(play(ctx({ pomodoro: focusing }))).toBe("Play Safe Landing (focusing)");
    expect(play(ctx({ pomodoro: { ...focusing, phase: "short_break" } }))).toBe("Play Safe Landing");
    const off = { ...DEFAULT_SETTINGS, pomodoro: { ...DEFAULT_SETTINGS.pomodoro, holdGames: false } };
    expect(play(ctx({ pomodoro: focusing, settings: off }))).toBe("Play Safe Landing");
  });

  it("asks through the host rather than opening the game directly", () => {
    let asked = "";
    const item = buildItems(ctx({ pomodoro: focusing, playGame: (g) => (asked = g) })).find(
      (i) => i !== "sep" && i.text.startsWith("Play"),
    ) as { action: () => void };
    item.action();
    expect(asked).toBe("safe-landing");
  });
});

describe("the tray's game while the pet is hidden", () => {
  const focusing = { phase: "focus" as const, round: 0, endsAt: Date.now() + 10 * 60_000 };
  const games = (c: TrayMenuContext) => buildTrayItems(c).filter((i) => i !== "sep" && i.text.startsWith("Play")).map((i) => (i as { text: string }).text);

  it("is left out during a focus session (there's no pet to ask), and back otherwise", () => {
    expect(games(trayCtx({ petVisible: false, pomodoro: focusing }))).toEqual([]);
    expect(games(trayCtx({ petVisible: false }))).toEqual(["Play Safe Landing"]);
    expect(games(trayCtx({ petVisible: true, pomodoro: focusing }))).toEqual(["Play Safe Landing (focusing)"]);
    // The rest of the section stays.
    expect(buildTrayItems(trayCtx({ petVisible: false, pomodoro: focusing })).some((i) => i !== "sep" && i.text === "Switch character")).toBe(true);
  });
});
