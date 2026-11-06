import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../platform/types";
import { formatRemaining, gameHeld, nextPhase, startFocus, tick } from "./logic";
import { currentWorkPeriod, runCutoff } from "./workHours";

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
    expect(s).toEqual({ phase: "idle", round: 0, endsAt: null, runStartedAt: null });
  });

  it("formats the countdown", () => {
    expect(formatRemaining(25 * MIN)).toBe("25:00");
    expect(formatRemaining(61_001)).toBe("1:02");
    expect(formatRemaining(-5)).toBe("0:00");
  });
});

describe("work hours (mirror of pomodoro.rs)", () => {
  // Wednesday 2026-01-07, local time.
  const at = (day: number, h: number, m = 0) => new Date(2026, 0, day, h, m).getTime();
  const w = { enabled: true, days: 0b011_1110, start: "09:00", end: "17:30" };

  it("stops a run at the end of work: today's, or the next work day's", () => {
    expect(runCutoff(w, at(7, 9))).toBe(at(7, 17, 30));
    expect(runCutoff(w, at(7, 20))).toBe(at(8, 17, 30));
    // Friday evening → Monday.
    expect(runCutoff(w, at(9, 20))).toBe(at(12, 17, 30));
    expect(runCutoff({ ...w, enabled: false }, at(7, 9))).toBeNull();
  });

  it("knows the work period now is in, overnight ones too", () => {
    expect(currentWorkPeriod(w, at(7, 10))).toBe(at(7, 9));
    expect(currentWorkPeriod(w, at(7, 18))).toBeNull();
    expect(currentWorkPeriod(w, at(10, 10))).toBeNull(); // Saturday
    const night = { ...w, start: "22:00", end: "06:00" };
    expect(currentWorkPeriod(night, at(8, 1))).toBe(at(7, 22));
  });

  it("starts no new focus after the cutoff", () => {
    const run = { ...startFocus(at(7, 17, 10), c), runStartedAt: at(7, 9) };
    const cutoff = runCutoff(w, at(7, 9));
    expect(tick(run, at(7, 17, 35), c, cutoff)?.phase).toBe("idle");
    const brk = { phase: "short_break" as const, round: 1, endsAt: at(7, 12), runStartedAt: at(7, 9) };
    expect(tick(brk, at(7, 12), c, cutoff)).toMatchObject({ phase: "focus", runStartedAt: at(7, 9) });
    expect(tick({ ...brk, endsAt: at(7, 17, 31) }, at(7, 17, 31), c, cutoff)?.phase).toBe("idle");
  });

  it("holds games during a focus session only", () => {
    expect(gameHeld(c, startFocus(0, c), 1)).toBe(true);
    expect(gameHeld(c, { phase: "short_break", round: 1, endsAt: 10 }, 1)).toBe(false);
    expect(gameHeld({ ...c, holdGames: false }, startFocus(0, c), 1)).toBe(false);
  });
});
