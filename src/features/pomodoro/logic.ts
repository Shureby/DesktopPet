import type { PomodoroConfig, PomodoroPhase, PomodoroStatus } from "../../platform/types";

/**
 * Tomato-clock state machine. The Rust scheduler (crates/desktoppet-core/src/pomodoro.rs)
 * is the source of truth in the app; this mirror powers the browser mock and the UI.
 */
export function phaseMinutes(phase: PomodoroPhase, c: PomodoroConfig): number {
  return phase === "focus" ? c.focusMin : phase === "short_break" ? c.shortBreakMin : phase === "long_break" ? c.longBreakMin : 0;
}

export function startFocus(now: number, c: PomodoroConfig, round = 0): PomodoroStatus {
  return { phase: "focus", round, endsAt: now + c.focusMin * 60_000 };
}

/** Moves to the phase after the current one (used when a phase ends or is skipped). */
export function nextPhase(s: PomodoroStatus, now: number, c: PomodoroConfig): PomodoroStatus {
  if (s.phase === "focus") {
    const round = s.round + 1;
    const phase = round % c.roundsBeforeLong === 0 ? "long_break" : "short_break";
    return { phase, round, endsAt: now + phaseMinutes(phase, c) * 60_000 };
  }
  if (s.phase === "idle") return startFocus(now, c, 0);
  return c.autoContinue ? startFocus(now, c, s.phase === "long_break" ? 0 : s.round) : { phase: "idle", round: 0, endsAt: null };
}

/** Returns the new status if the current phase has ended, else null. */
export function tick(s: PomodoroStatus, now: number, c: PomodoroConfig): PomodoroStatus | null {
  if (s.endsAt === null || now < s.endsAt) return null;
  return nextPhase(s, s.endsAt, c);
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
