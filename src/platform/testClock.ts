import type { Backend } from "./types";

/**
 * The test clock (test builds and end-to-end tests): the app's clock can be set ahead to see
 * tomorrow without waiting (src-tauri/src/state.rs, `shift_clock`). In this window `Date`
 * follows it: `Date.now()` and `new Date()` read the app's clock; a date given explicitly
 * stays as given. A release has no test clock and nothing changes. `onShift` runs when it moves.
 */
export async function followTestClock(backend: Backend, onShift?: () => void): Promise<void> {
  const clock = await backend.testClock().catch(() => null);
  if (!clock) return;
  const RealDate = Date;
  let shift = clock.shift;
  class AppDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + shift);
      else super(...(args as [number]));
    }
    static now() {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = AppDate as DateConstructor;
  await backend.on("clock-shift", (s) => {
    shift = s;
    onShift?.();
  });
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** "+1 d 2 h" for a shift; "now" when there is none. */
export function shiftLabel(ms: number): string {
  if (ms <= 0) return "now";
  const d = Math.floor(ms / DAY);
  const h = Math.round((ms % DAY) / HOUR);
  return `+${[d && `${d} d`, h && `${h} h`].filter(Boolean).join(" ") || "<1 h"}`;
}

/** The test clock's steps in the tray (ePet Test): label and how far each moves it. */
export const CLOCK_STEPS: [string, number][] = [
  ["+1 hour", HOUR],
  ["+6 hours", 6 * HOUR],
  ["+1 day", DAY],
  ["+1 week", 7 * DAY],
];
