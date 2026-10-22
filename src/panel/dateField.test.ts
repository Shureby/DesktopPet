import { describe, expect, it } from "vitest";
import { dateOrder, datePartText, stepDate, typeDateDigit, ymdOf, ymdToMs } from "./dateField";

describe("date field", () => {
  it("steps parts without carrying, keeping the day inside the month", () => {
    expect(stepDate("2026-10-31", "day", 1)).toBe("2026-10-01");
    expect(stepDate("2026-10-01", "day", -1)).toBe("2026-10-31");
    expect(stepDate("2026-12-15", "month", 1)).toBe("2026-01-15");
    expect(stepDate("2026-01-31", "month", 1)).toBe("2026-02-28");
    expect(stepDate("2028-02-29", "year", 1)).toBe("2029-02-28");
  });

  it("takes typed digits like the time field", () => {
    expect(typeDateDigit("2026-10-07", "day", "", "2")).toEqual({ value: "2026-10-02", typed: "2", done: false });
    expect(typeDateDigit("2026-10-02", "day", "2", "5")).toEqual({ value: "2026-10-25", typed: "25", done: true });
    // 4 can't start a two-digit day: done at once.
    expect(typeDateDigit("2026-10-07", "day", "", "4")).toEqual({ value: "2026-10-04", typed: "4", done: true });
    expect(typeDateDigit("2026-10-07", "month", "", "1")).toEqual({ value: "2026-01-07", typed: "1", done: false });
    expect(typeDateDigit("2026-01-07", "month", "1", "2")).toEqual({ value: "2026-12-07", typed: "12", done: true });
    expect(typeDateDigit("2026-10-07", "year", "202", "7")).toEqual({ value: "2027-10-07", typed: "2027", done: true });
  });

  it("follows the locale's order and names", () => {
    expect(dateOrder("en-AU")).toEqual(["day", "month", "year"]);
    expect(dateOrder("en-US")).toEqual(["month", "day", "year"]);
    expect(datePartText("2026-10-07", "weekday", "en-AU")).toBe("Wed");
    expect(datePartText("2026-10-07", "month", "en-AU")).toBe("Oct");
  });

  it("converts to and from local midnight", () => {
    const ms = new Date(2026, 9, 7).getTime();
    expect(ymdToMs("2026-10-07")).toBe(ms);
    expect(ymdOf(ms + 15 * 3_600_000)).toBe("2026-10-07");
  });
});
