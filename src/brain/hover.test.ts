import { describe, expect, it } from "vitest";
import { HOVER, HoverTracker, type HoverEvent, type HoverInput } from "./hover";

const FRAME = 1000 / 30;

/** Drives a tracker frame by frame; `at` is the cursor for each frame. */
function run(t: HoverTracker, from: number, ms: number, input: Partial<HoverInput>, at?: (now: number) => { x: number; y: number }) {
  const events: (HoverEvent & { at: number })[] = [];
  for (let now = from; now < from + ms; now += FRAME) {
    const cursor = at ? at(now) : { x: 100, y: 100 };
    for (const e of t.update(now, { over: true, cursor, unit: 1, canAttend: true, unhappy: null, ...input })) {
      events.push({ ...e, at: now - from });
    }
  }
  return events;
}
const types = (events: HoverEvent[]) => events.map((e) => e.type);
/** A cursor rubbing back and forth over the pet at `speed` px/s. */
const rubbing = (speed: number) => (now: number) => ({ x: 100 + ((speed * now) / 1000) % 60, y: 100 });

describe("hovering the pet", () => {
  it("stops the pet at once and reacts after two seconds", () => {
    const events = run(new HoverTracker(), 0, 3000, {});
    expect(types(events)).toEqual(["attend", "react"]);
    expect(events[1].at).toBeGreaterThanOrEqual(HOVER.REACT_AFTER);
  });

  it("does nothing while the pet can't attend (dragged, ringing, focus session)", () => {
    expect(run(new HoverTracker(), 0, 3000, { canAttend: false })).toEqual([]);
  });

  it("lets the pet go on when the cursor is left parked on it", () => {
    const t = new HoverTracker();
    expect(types(run(t, 0, HOVER.RELEASE_AFTER + 500, {}))).toEqual(["attend", "react", "release"]);
    // Still parked: it doesn't stop again…
    expect(run(t, 10_000, 5000, {})).toEqual([]);
    // …until the cursor leaves and comes back.
    run(t, 20_000, 100, { over: false });
    expect(types(run(t, 20_100, 100, {}))).toEqual(["attend"]);
  });

  it("counts moving the mouse over it after the reaction as stroking, at a steady pace", () => {
    const t = new HoverTracker();
    const events = run(t, 0, 2000 + 6000, {}, rubbing(200));
    const strokes = events.filter((e) => e.type === "stroke");
    expect(strokes.length).toBeGreaterThanOrEqual(3);
    expect(strokes.length).toBeLessThanOrEqual(6000 / HOVER.STROKE_EVERY + 1);
    for (let i = 1; i < strokes.length; i++) expect(strokes[i].at - strokes[i - 1].at).toBeGreaterThanOrEqual(HOVER.STROKE_EVERY - 1);
    // A moving mouse keeps the pet attending (no release).
    expect(types(events)).not.toContain("release");
  });

  it("doesn't count moving the mouse before the two seconds are up", () => {
    const events = run(new HoverTracker(), 0, HOVER.REACT_AFTER - 100, {}, rubbing(200));
    expect(types(events)).toEqual(["attend"]);
  });

  it("reports leaving", () => {
    const t = new HoverTracker();
    run(t, 0, 500, {});
    expect(types(run(t, 500, 100, { over: false }))).toEqual(["leave"]);
  });
});

describe("an unhappy pet", () => {
  it("steps away first and says why, then gives in if you insist", () => {
    const t = new HoverTracker();
    const first = run(t, 0, 100, { unhappy: "hungry" });
    expect(first).toEqual([{ type: "dodge", reason: "hungry", at: 0 }]);
    run(t, 100, 3000, { over: false });
    // Hovering again within INSIST_WITHIN: no dodge, and it reacts straight away.
    const again = run(t, 3100, 200, { unhappy: "hungry" });
    expect(types(again)).toEqual(["attend", "react"]);
  });

  it("counts following it as insisting too", () => {
    const t = new HoverTracker();
    const events = run(t, 0, HOVER.DODGE_TIME + 500, { unhappy: "grumpy" });
    expect(types(events)).toEqual(["dodge", "attend", "react"]);
    expect(events[1].at).toBeGreaterThanOrEqual(HOVER.DODGE_TIME);
  });

  it("dodges at most once per cooldown", () => {
    const t = new HoverTracker();
    run(t, 0, 100, { unhappy: "grumpy" });
    run(t, 100, 100, { over: false });
    // Long after the insist window, but within the cooldown: it stays put.
    expect(types(run(t, 60_000, 100, { unhappy: "grumpy" }))).toEqual(["attend"]);
    run(t, 60_100, 100, { over: false });
    expect(types(run(t, HOVER.DODGE_COOLDOWN + 1000, 100, { unhappy: "grumpy" }))).toEqual(["dodge"]);
  });
});
