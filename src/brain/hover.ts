/**
 * What the pet does when the mouse rests on it. The full rules, with the reasons behind
 * them, are in docs/INTERACTIONS.md; keep the two in step.
 *
 *  1. Hovering stops the pet: it turns to face the cursor (`attend`).
 *  2. A hungry or unhappy pet first steps away a little and says why (`dodge`), at most
 *     once per DODGE_COOLDOWN.
 *  3. Hovering again soon after a dodge counts as insisting: no dodge, and it reacts
 *     straight away.
 *  4. After REACT_AFTER on the pet it reacts once (`react`).
 *  5. From then on, moving the mouse over it is stroking (`stroke`), at most once per
 *     STROKE_EVERY.
 *  6. A cursor that sits still for RELEASE_AFTER lets the pet go on (`release`), so a
 *     parked mouse never keeps it blocking whatever is underneath; it won't stop again
 *     until the cursor leaves and comes back.
 */
export const HOVER = {
  REACT_AFTER: 2_000,
  INSIST_WITHIN: 10_000,
  DODGE_COOLDOWN: 120_000,
  STROKE_EVERY: 1_500,
  /** Mouse travel over the pet that makes one stroke, in logical px. */
  STROKE_DISTANCE: 40,
  /** The cursor counts as moved once it is this far (logical px) from where it last moved. */
  STILL_WITHIN: 3,
  RELEASE_AFTER: 8_000,
  /** How long a dodge (stepping away) plays before hovering counts again. */
  DODGE_TIME: 1_500,
} as const;

export type HoverEvent =
  | { type: "attend" }
  | { type: "dodge"; reason: "hungry" | "grumpy" }
  | { type: "react" }
  | { type: "stroke" }
  | { type: "release" }
  | { type: "leave" };

export interface HoverInput {
  /** The cursor is on the pet's own pixels. */
  over: boolean;
  cursor: { x: number; y: number } | null;
  /** Physical px per logical px, to measure mouse travel. */
  unit: number;
  /** False while dragged, ringing, in a focus session, running to a reminder… */
  canAttend: boolean;
  /** Why the pet would rather step away, if it would. */
  unhappy: "hungry" | "grumpy" | null;
}

export class HoverTracker {
  /** `none`: not hovered; `attending`: stopped for you; `released`: until the cursor leaves. */
  private phase: "none" | "attending" | "released" = "none";
  private since = 0;
  private reacted = false;
  private lastMoveAt = 0;
  private lastCursor: { x: number; y: number } | null = null;
  private travel = 0;
  private lastStrokeAt = -Infinity;
  private lastDodgeAt = -Infinity;
  /** Where the cursor was when it last really moved. */
  private anchor: { x: number; y: number } | null = null;

  update(now: number, input: HoverInput): HoverEvent[] {
    const out: HoverEvent[] = [];
    if (this.track(input)) this.lastMoveAt = now;
    // Let a dodge play out; if the cursor is still on the pet afterwards, that's insisting.
    if (now - this.lastDodgeAt < HOVER.DODGE_TIME) return out;

    if (!input.over || !input.canAttend) {
      if (this.phase === "attending") out.push({ type: "leave" });
      // Cleared only once the cursor is off the pet, so a pause (e.g. a reminder) doesn't restart it.
      if (!input.over) this.phase = "none";
      else if (this.phase === "attending") this.phase = "released";
      return out;
    }

    if (this.phase === "none") {
      this.phase = "attending";
      this.since = now;
      this.lastMoveAt = now;
      this.reacted = false;
      this.travel = 0;
      const insisting = now - this.lastDodgeAt < HOVER.INSIST_WITHIN;
      if (insisting) {
        // Rule 3: treat it as having hovered long enough already.
        this.since = now - HOVER.REACT_AFTER;
      } else if (input.unhappy && now - this.lastDodgeAt >= HOVER.DODGE_COOLDOWN) {
        this.lastDodgeAt = now;
        this.phase = "none";
        out.push({ type: "dodge", reason: input.unhappy });
        return out;
      }
      out.push({ type: "attend" });
    }
    if (this.phase !== "attending") return out;

    if (now - this.lastMoveAt >= HOVER.RELEASE_AFTER) {
      this.phase = "released";
      out.push({ type: "release" });
      return out;
    }
    if (!this.reacted && now - this.since >= HOVER.REACT_AFTER) {
      this.reacted = true;
      this.travel = 0;
      out.push({ type: "react" });
    } else if (this.reacted && this.travel >= HOVER.STROKE_DISTANCE && now - this.lastStrokeAt >= HOVER.STROKE_EVERY) {
      this.lastStrokeAt = now;
      this.travel = 0;
      out.push({ type: "stroke" });
    }
    return out;
  }

  /** Adds up mouse travel over the pet (logical px); true if the cursor really moved. */
  private track({ over, cursor, unit }: HoverInput): boolean {
    const last = this.lastCursor;
    this.lastCursor = cursor;
    if (!cursor) return false;
    if (last && over && this.reacted) this.travel += Math.hypot(cursor.x - last.x, cursor.y - last.y) / unit;
    // Compared with where it last moved, not the previous frame, so a slow stroke still counts.
    const a = this.anchor;
    if (a && Math.hypot(cursor.x - a.x, cursor.y - a.y) / unit < HOVER.STILL_WITHIN) return false;
    this.anchor = cursor;
    return a !== null;
  }
}
