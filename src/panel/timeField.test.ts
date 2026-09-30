import { describe, expect, it } from "vitest";
import { partText, stepPart, typeDigit } from "./timeField";
import { daysText, repeatText } from "./alarmText";

describe("time field", () => {
  it("steps each part and wraps without carrying", () => {
    expect(stepPart("09:59", "minute", 1, true)).toBe("09:00");
    expect(stepPart("09:00", "minute", -1, true)).toBe("09:59");
    expect(stepPart("09:40", "minute", 5, true)).toBe("09:45");
    // 12-hour: 12 → 1 keeps AM/PM; 24-hour: 23 → 00.
    expect(stepPart("12:00", "hour", 1, true)).toBe("13:00");
    expect(stepPart("11:30", "hour", 1, true)).toBe("00:30");
    expect(stepPart("23:10", "hour", 1, false)).toBe("00:10");
    expect(stepPart("09:10", "period", 1, true)).toBe("21:10");
    expect(stepPart("21:10", "period", -1, true)).toBe("09:10");
  });

  it("shows parts in the system's style", () => {
    expect([partText("21:05", "hour", true), partText("21:05", "minute", true), partText("21:05", "period", true)]).toEqual(["9", "05", "PM"]);
    expect(partText("00:05", "hour", true)).toBe("12");
    expect(partText("07:05", "hour", false)).toBe("07");
  });

  it("takes typed digits", () => {
    // "1" could still become 10–12: wait. "2" then makes 12, and it's complete.
    let r = typeDigit("09:00", "hour", "", "1", true);
    expect(r).toEqual({ value: "01:00", typed: "1", done: false });
    r = typeDigit(r.value, "hour", r.typed, "2", true);
    expect(r).toEqual({ value: "00:00", typed: "12", done: true });
    // PM stays PM.
    expect(typeDigit("21:00", "hour", "", "7", true).value).toBe("19:00");
    // "7" can't start a two-digit minute: 07, done.
    expect(typeDigit("09:00", "minute", "", "7", true)).toEqual({ value: "09:07", typed: "7", done: true });
    // 24-hour: "2", "3" → 23.
    expect(typeDigit(typeDigit("09:00", "hour", "", "2", false).value, "hour", "2", "3", false).value).toBe("23:00");
    // Too big starts over: "5" then "8" in the hour of a 24-hour clock is 8.
    expect(typeDigit("05:00", "hour", "5", "8", false).value).toBe("08:00");
  });
});

describe("day names", () => {
  it("names common sets and lists the rest Monday first", () => {
    expect(daysText(0b111_1111)).toBe("Every day");
    expect(daysText(0b011_1110)).toBe("Weekdays");
    expect(daysText(0b100_0001)).toBe("Weekends");
    expect(daysText(0b010_1010)).toBe("Mon, Wed, Fri");
    expect(daysText(0b000_0001)).toBe("Sun");
    expect(repeatText({ repeat: "none", repeatDays: 0 })).toBe("Once");
    expect(repeatText({ repeat: "days", repeatDays: 0b010_1010 })).toBe("Mon, Wed, Fri");
  });
});
