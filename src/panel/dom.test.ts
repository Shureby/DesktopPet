import { describe, expect, it } from "vitest";
import { formatWhen } from "./dom";

describe("formatWhen", () => {
  const now = new Date(2026, 8, 28, 15, 0).getTime();
  const at = (day: number, h: number, m: number) => new Date(2026, 8, day, h, m).getTime();
  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  it("names today, yesterday and tomorrow, and dates otherwise", () => {
    expect(formatWhen(at(28, 12, 42), now)).toBe(`Today ${time(at(28, 12, 42))}`);
    expect(formatWhen(at(27, 23, 50), now)).toBe(`Yesterday ${time(at(27, 23, 50))}`);
    expect(formatWhen(at(29, 7, 30), now)).toBe(`Tomorrow ${time(at(29, 7, 30))}`);
    expect(formatWhen(at(25, 9, 0), now)).not.toMatch(/^(Today|Yesterday|Tomorrow)/);
  });
});
