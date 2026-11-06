import { describe, expect, it } from "vitest";
import { easter, holidaysFor, tableDate, tableNumber } from "./holidays";
import { nextAnniversary, ruleText } from "./templates";

const ymd = (d: Date | null) =>
  d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

describe("[region.holidays] each region's holidays", () => {
  it("Easter Sundays (the same as in schedule.rs)", () => {
    const sundays = ["2008-03-23", "2024-03-31", "2025-04-20", "2026-04-05", "2027-03-28", "2028-04-16", "2035-03-25", "2038-04-25"];
    for (const s of sundays) expect(ymd(easter(Number(s.slice(0, 4))))).toBe(s);
    expect(ymd(nextAnniversary({ calendar: "easter", month: 1, day: 1, nth: -2 }, at(2026, 1, 1)))).toBe("2026-04-03");
  });

  it("announced days come from the table; none once past it", () => {
    expect(ymd(tableDate(tableNumber("qingming"), 2026))).toBe("2026-04-05");
    expect(ymd(tableDate(tableNumber("hariRayaPuasa"), 2027))).toBe("2027-03-10");
    expect(tableDate(tableNumber("hariRayaPuasa"), 2028)).toBeNull();
    const puasa = { calendar: "table" as const, month: tableNumber("hariRayaPuasa"), day: 1 };
    expect(ymd(nextAnniversary(puasa, at(2026, 10, 1)))).toBe("2027-03-10");
    expect(nextAnniversary(puasa, at(2027, 4, 1))).toBeNull();
    expect(ruleText(puasa)).toBe("as announced each year");
  });

  it("each region has its own", () => {
    const names = (r: Parameters<typeof holidaysFor>[0]) => holidaysFor(r).map((h) => h.name);
    expect(names("TW")).toContain("Double Tenth Day");
    expect(names("CN")).not.toContain("Double Tenth Day");
    expect(names("CN")).toContain("National Day");
    expect(names("SG")).toEqual(expect.arrayContaining(["Hari Raya Puasa", "Deepavali", "Vesak Day", "Good Friday"]));
    expect(names("MY")).toEqual(expect.arrayContaining(["Merdeka Day", "Malaysia Day", "Thaipusam"]));
    expect(names("HK")).toEqual(expect.arrayContaining(["Buddha's Birthday", "HKSAR Establishment Day", "Easter"]));
    expect(names("other")).toEqual(expect.arrayContaining(["Thanksgiving (US)", "Mid-Autumn Festival"]));
    // Taiwan's Father's Day is 8/8; the mainland's the 3rd Sunday of June.
    expect(holidaysFor("TW").find((h) => h.name === "Father's Day")!.rule).toMatchObject({ calendar: "solar", month: 8, day: 8 });
    expect(holidaysFor("CN").find((h) => h.name === "Father's Day")!.rule).toMatchObject({ calendar: "weekday", month: 6, nth: 3 });
    for (const r of ["CN", "TW", "HK", "SG", "MY", "other"] as const) {
      // Every one has a day coming up (from the start of the table's years).
      for (const h of holidaysFor(r)) expect(nextAnniversary(h.rule, at(2026, 1, 1)), `${r} ${h.name}`).not.toBeNull();
    }
  });
});
