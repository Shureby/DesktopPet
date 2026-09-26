import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../platform/types";
import { formatRemaining, nextPhase, startFocus, tick } from "./logic";

const c = DEFAULT_SETTINGS.pomodoro;
const MIN = 60_000;

describe("pomodoro", () => {
  it("cycles focus → short break → focus, with a long break every N rounds", () => {
    let s = startFocus(0, c);
    const phases: string[] = [];
    let now = 0;
    for (let i = 0; i < 8; i++) {
      now = s.endsAt!;
      s = tick(s, now, c)!;
      phases.push(s.phase);
    }
    expect(phases).toEqual(["short_break", "focus", "short_break", "focus", "short_break", "focus", "long_break", "focus"]);
    expect(now).toBe((25 * 4 + 5 * 3 + 15) * MIN);
  });

  it("does nothing before the phase ends", () => {
    expect(tick(startFocus(0, c), 24 * MIN, c)).toBeNull();
  });

  it("goes idle after a break when auto-continue is off", () => {
    const s = nextPhase({ phase: "short_break", round: 1, endsAt: 0 }, 0, { ...c, autoContinue: false });
    expect(s).toEqual({ phase: "idle", round: 0, endsAt: null });
  });

  it("formats the countdown", () => {
    expect(formatRemaining(25 * MIN)).toBe("25:00");
    expect(formatRemaining(61_001)).toBe("1:02");
    expect(formatRemaining(-5)).toBe("0:00");
  });
});
