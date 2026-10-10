import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { leapMonth, lunarInYear, lunarToDate, monthDays } from "./lunar";
import { HOLIDAYS, nextAnniversary, nthWeekday, ruleText } from "./templates";

/** [lunarYear, month, day, leap, "YYYY-MM-DD"]: the Hong Kong Observatory's tables (shared with Rust). */
const { vectors } = JSON.parse(readFileSync(new URL("../../../crates/desktoppet-core/tests/lunar-vectors.json", import.meta.url), "utf8")) as {
  vectors: [number, number, number, boolean, string][];
};
const ymd = (d: Date | null) =>
  d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 10).getTime();

describe("the lunar calendar", () => {
  it("finds the Gregorian day of every date in the reference tables (1900–2099)", () => {
    expect(vectors.length).toBeGreaterThan(1000);
    for (const [y, m, d, leap, want] of vectors) expect(`${y}/${leap ? "leap " : ""}${m}/${d} ${ymd(lunarToDate(y, m, d, leap))}`).toBe(`${y}/${leap ? "leap " : ""}${m}/${d} ${want}`);
  });

  it("knows leap months and short months; days that don't exist are null", () => {
    expect([2023, 2025, 2028].map(leapMonth)).toEqual([2, 6, 5]);
    expect(leapMonth(2026)).toBe(0);
    expect(lunarToDate(2026, 6, 1, true)).toBeNull();
    expect(lunarToDate(1899, 1, 1)).toBeNull();
    expect(lunarToDate(2100, 1, 1)).toBeNull();
    const short = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].find((m) => monthDays(2026, m) === 29)!;
    expect(lunarToDate(2026, short, 30)).toBeNull();
  });

  it("a leap-month birthday falls in the leap month only in years that have it; a 30th is the 29th in a short month", () => {
    // 2025 has a leap 6th month; 2026 none.
    expect(ymd(lunarInYear(2025, 6, 10, true))).toBe(ymd(lunarToDate(2025, 6, 10, true)));
    expect(ymd(lunarInYear(2026, 6, 10, true))).toBe(ymd(lunarToDate(2026, 6, 10)));
    // New Year's Eve: "12/30" is the last day of the year whatever its length.
    for (const y of [2024, 2025, 2026, 2027]) {
      const eve = lunarInYear(y, 12, 30)!;
      expect(ymd(new Date(eve.getFullYear(), eve.getMonth(), eve.getDate() + 1))).toBe(ymd(lunarToDate(y + 1, 1, 1)));
    }
  });
});

describe("anniversary days", () => {
  it("a lunar date comes round on its day this lunar year, or next", () => {
    // Mid-Autumn: 2026-09-25, 2027-09-15.
    const midAutumn = { calendar: "lunar" as const, month: 8, day: 15 };
    expect(ymd(nextAnniversary(midAutumn, at(2026, 9, 1)))).toBe("2026-09-25");
    expect(ymd(nextAnniversary(midAutumn, at(2026, 9, 25)))).toBe("2026-09-25");
    expect(ymd(nextAnniversary(midAutumn, at(2026, 9, 26)))).toBe("2027-09-15");
    // A date late in the lunar year falls in January of the next Gregorian one: 2026-12-1 lunar (2027-01-08).
    expect(ymd(nextAnniversary({ calendar: "lunar", month: 12, day: 1 }, at(2026, 12, 20)))).toBe(ymd(lunarToDate(2026, 12, 1)));
    // Past the table: no day.
    expect(nextAnniversary(midAutumn, at(2100, 10, 1))).toBeNull();
  });

  it("the nth day of the week of a month (and the last)", () => {
    expect(ymd(nthWeekday(2026, 5, 2, 0))).toBe("2026-05-10"); // Mother's Day
    expect(ymd(nthWeekday(2026, 6, 3, 0))).toBe("2026-06-21"); // Father's Day
    expect(ymd(nthWeekday(2026, 11, 4, 4))).toBe("2026-11-26"); // Thanksgiving
    expect(ymd(nthWeekday(2026, 2, 1, 0))).toBe("2026-02-01"); // the 1st is a Sunday
    expect(ymd(nthWeekday(2026, 5, -1, 1))).toBe("2026-05-25"); // last Monday of May
    expect(ymd(nthWeekday(2026, 1, -1, 6))).toBe("2026-01-31"); // the last day is that day
    const mothers = { calendar: "weekday" as const, month: 5, day: 1, nth: 2, weekday: 0 };
    expect(ymd(nextAnniversary(mothers, at(2026, 5, 11)))).toBe("2027-05-09");
  });

  it("says how its day is kept", () => {
    expect(ruleText({ calendar: "lunar", month: 8, day: 15 })).toBe("Lunar 8/15");
    expect(ruleText({ calendar: "lunar", month: 4, day: 8, leap: true })).toBe("Lunar leap 4/8");
    expect(ruleText({ calendar: "weekday", month: 5, day: 1, nth: 2, weekday: 0 })).toBe("2nd Sunday of May");
    expect(ruleText({ calendar: "weekday", month: 5, day: 1, nth: -1, weekday: 1 })).toBe("Last Monday of May");
    expect(ruleText({ month: 10, day: 25 })).toBeNull();
  });

  it("every holiday has a day each year", () => {
    for (const h of HOLIDAYS) expect(nextAnniversary(h.rule, at(2026, 10, 10)), h.name).not.toBeNull();
    const eve = HOLIDAYS.find((h) => h.name === "Lunar New Year's Eve")!;
    expect(ymd(nextAnniversary(eve.rule, at(2026, 10, 10)))).toBe("2027-02-05");
  });
});
