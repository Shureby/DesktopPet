import { describe, expect, it } from "vitest";
import { celebrationEffect, celebrationLines, daysUntil, musicChoices, musicFor, nextAnniversary, ordinal, untilText, yearsText } from "./templates";

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 10).getTime();

describe("anniversaries", () => {
  it("play music by type", () => {
    // Birthdays (a pet's too) always play their own.
    expect(musicFor({ kind: "birthday", music: "canon" }).id).toBe("birthday");
    expect(musicFor({ kind: "pet", music: null }).id).toBe("birthday");
    // A wedding: the Canon, or either wedding march.
    expect(musicChoices("wedding").map((p) => p.id)).toEqual(["canon", "mendelssohn", "wagner"]);
    expect(musicFor({ kind: "wedding", music: null }).id).toBe("canon");
    expect(musicFor({ kind: "wedding", music: "wagner" }).id).toBe("wagner");
    expect(musicFor({ kind: "wedding", music: "waltz" }).id).toBe("canon");
    expect(musicFor({ kind: "dating", music: "mendelssohn" }).id).toBe("mendelssohn");
    // Others choose among their mood's pieces; nothing chosen, or one that doesn't suit: the default.
    expect(musicFor({ kind: "work", music: null }).id).toBe("waltz");
    expect(musicFor({ kind: "dating", music: "jasmine" }).id).toBe("jasmine");
    expect(musicFor({ kind: "custom", music: "chopin" }).id).toBe("waltz");
    expect(musicFor({ kind: "remembrance", music: null }).id).toBe("aisi");
    expect(musicFor({ kind: "remembrance", music: "taps" }).id).toBe("taps");
    expect(musicFor({ kind: "remembrance", music: "festive" }).id).toBe("aisi");
    expect(musicChoices("remembrance").map((p) => p.id)).toEqual(["aisi", "chopin", "taps", "reflection"]);
    expect(musicChoices("home").every((p) => p.mood === "happy")).toBe(true);
  });

  it("count years the way people say them", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 36, 101, 111].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "36th", "101st", "111th",
    ]);
    expect(yearsText("birthday", 36)).toBe("36th");
    expect(yearsText("remembrance", 1)).toBe("1 year");
    expect(yearsText("dating", 5)).toBe("5 years");
  });

  it("give the pet its words", () => {
    expect(celebrationLines({ kind: "birthday", name: "老婆", icon: "🎂" }, 36)).toEqual(["🎉 Happy 36th birthday, 老婆!", ""]);
    expect(celebrationLines({ kind: "birthday", name: "Mum", icon: "🎂" }, null)).toEqual(["🎉 Happy birthday, Mum!", ""]);
    expect(celebrationLines({ kind: "wedding", name: "Our wedding", icon: "💍" }, 10)).toEqual(["🥂 Happy 10th wedding anniversary!", "Our wedding"]);
    expect(celebrationLines({ kind: "remembrance", name: "外婆", icon: "🕯️" }, 7)).toEqual(["🕯️ Remembering 外婆 today.", "7 years"]);
    expect(celebrationLines({ kind: "custom", name: "Launch day", icon: "🚀" }, null)).toEqual(["🚀 Today is Launch day!", ""]);
  });

  it("pick the effect: fireworks with the icon falling, or a candle", () => {
    expect(celebrationEffect({ kind: "birthday", icon: "🎂" })).toEqual({ mode: "fireworks", icons: ["🎂", "🎈", "🎁"] });
    expect(celebrationEffect({ kind: "remembrance", icon: "🕯️" })).toEqual({ mode: "candle", icons: [] });
  });

  it("come round every year (Feb 29 on the 28th otherwise)", () => {
    expect(nextAnniversary(10, 25, at(2026, 10, 2))).toEqual(new Date(2026, 9, 25));
    expect(nextAnniversary(10, 2, at(2026, 10, 2))).toEqual(new Date(2026, 9, 2));
    expect(nextAnniversary(3, 3, at(2026, 10, 2))).toEqual(new Date(2027, 2, 3));
    expect(nextAnniversary(2, 29, at(2026, 10, 2))).toEqual(new Date(2027, 1, 28));
    expect(daysUntil(new Date(2026, 9, 25), at(2026, 10, 2))).toBe(23);
    expect([0, 1, 3, 60, 150].map(untilText)).toEqual(["Today 🎉", "Tomorrow", "in 3 days", "in 60 days", "in 5 months"]);
  });
});
