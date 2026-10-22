import { describe, expect, it } from "vitest";
import { shiftLabel } from "./testClock";

describe("test clock", () => {
  it("labels how far ahead it is", () => {
    expect(shiftLabel(0)).toBe("now");
    expect(shiftLabel(3_600_000)).toBe("+1 h");
    expect(shiftLabel(26 * 3_600_000)).toBe("+1 d 2 h");
    expect(shiftLabel(7 * 86_400_000)).toBe("+7 d");
    expect(shiftLabel(60_000)).toBe("+<1 h");
  });
});
