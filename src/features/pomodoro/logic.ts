import type { PomodoroConfig, PomodoroPhase, PomodoroStatus } from "../../platform/types";

/**
 * Tomato-clock state machine. The Rust scheduler (crates/desktoppet-core/src/pomodoro.rs)
 * is the source of truth in the app; this mirror powers the browser mock and the UI.
 */
export function phaseMinutes(phase: PomodoroPhase, c: PomodoroConfig): number {
  return phase === "focus" ? c.focusMin : phase === "short_break" ? c.shortBreakMin : phase === "long_break" ? c.longBreakMin : 0;
}

const IDLE: PomodoroStatus = { phase: "idle", round: 0, endsAt: null, runStartedAt: null };

/** A new run: the first focus. */
export function startFocus(now: number, c: PomodoroConfig, round = 0): PomodoroStatus {
  return { phase: "focus", round, endsAt: now + c.focusMin * 60_000, runStartedAt: now };
}

/**
 * Moves to the phase after the current one (used when a phase ends or is skipped). `cutoff`
 * is when this run must stop (work hours, `runCutoff`): no new focus begins at or after it,
 * and a focus that ends after it skips its break.
 */
export function nextPhase(s: PomodoroStatus, now: number, c: PomodoroConfig, cutoff: number | null = null): PomodoroStatus {
  const pastCutoff = cutoff !== null && now >= cutoff;
  const runStartedAt = s.runStartedAt ?? now;
  if (s.phase === "focus") {
    if (pastCutoff) return { ...IDLE };
    const round = s.round + 1;
    const phase = round % c.roundsBeforeLong === 0 ? "long_break" : "short_break";
    return { phase, round, endsAt: now + phaseMinutes(phase, c) * 60_000, runStartedAt };
  }
  if (s.phase === "idle") return startFocus(now, c, 0);
  return c.autoContinue && !pastCutoff
    ? { ...startFocus(now, c, s.phase === "long_break" ? 0 : s.round), runStartedAt }
    : { ...IDLE };
}

/** Returns the new status if the current phase has ended, else null. */
export function tick(s: PomodoroStatus, now: number, c: PomodoroConfig, cutoff: number | null = null): PomodoroStatus | null {
  if (s.endsAt === null || now < s.endsAt) return null;
  return nextPhase(s, s.endsAt, c, cutoff);
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** During a focus session (and with Focus → "Ask before games" on), games ask first. */
export function gameHeld(c: PomodoroConfig, s: PomodoroStatus, now = Date.now()): boolean {
  return c.holdGames !== false && s.phase === "focus" && (s.endsAt === null || s.endsAt > now);
}
