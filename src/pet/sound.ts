/**
 * Synthesized sounds and ringtones (WebAudio), so the app needs no audio files.
 * Characters or skins can ship recorded sounds later.
 */
import { playPiece, type Piece } from "../celebrate/music";
import type { FocusTone } from "../platform/types";

let ctx: AudioContext | null = null;

/**
 * What was played, for the end-to-end tests (e2e/): the windows set `window.__epetSounds`
 * to an array in debug builds started for them; otherwise nothing is kept.
 */
function logSound(entry: Record<string, unknown>): void {
  (globalThis as { __epetSounds?: unknown[] }).__epetSounds?.push({ ...entry, at: Date.now() });
}

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

interface Note {
  /** Start frequency in Hz. */
  f: number;
  /** Optional end frequency for a glide. */
  to?: number;
  /** Start time and duration in seconds. */
  at: number;
  dur: number;
  wave?: OscillatorType;
  /** Relative loudness 0..1. */
  gain?: number;
}

function play(notes: Note[], volume: number): void {
  const a = audio();
  if (!a || volume <= 0) return;
  const t0 = a.currentTime + 0.02;
  for (const n of notes) {
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = n.wave ?? "triangle";
    osc.frequency.setValueAtTime(n.f, t0 + n.at);
    if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, t0 + n.at + n.dur);
    const peak = 0.25 * volume * (n.gain ?? 1);
    g.gain.setValueAtTime(0, t0 + n.at);
    g.gain.linearRampToValueAtTime(peak, t0 + n.at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.05);
  }
}

// Note frequencies.
const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5, E6 = 1318.5;

export interface Ringtone {
  name: string;
  /** Seconds between repeats when ringing continuously. */
  period: number;
  /** Notes for one repeat; `rep` lets tones evolve (e.g. get louder). */
  notes(rep: number): Note[];
}

export const RINGTONES = {
  classic: {
    name: "Classic alarm",
    period: 1.6,
    notes: () => [0, 0.3, 0.6].flatMap((t) => [{ f: 988, at: t, dur: 0.16 }, { f: 1319, at: t + 0.1, dur: 0.14 }]),
  },
  chime: {
    name: "Chime",
    period: 2.5,
    notes: () => [
      { f: 880, at: 0, dur: 1.2, wave: "sine" },
      { f: 1320, at: 0.18, dur: 1.4, wave: "sine" },
    ],
  },
  digital: {
    name: "Digital watch",
    period: 1.2,
    notes: () => [0, 0.12, 0.24, 0.36].map((t) => ({ f: 2000, at: t, dur: 0.07, wave: "square" as const, gain: 0.35 })),
  },
  gentle: {
    name: "Gentle rise",
    period: 2.4,
    // Starts quiet and gets louder each time it repeats.
    notes: (rep) =>
      [C5, E5, G5, C6].map((f, i) => ({ f, at: i * 0.28, dur: 0.9, wave: "sine" as const, gain: Math.min(1, 0.25 + rep * 0.15) })),
  },
  marimba: {
    name: "Marimba",
    period: 2,
    notes: () => [C5, E5, G5, E5, C6, E6].map((f, i) => ({ f, at: i * 0.14, dur: 0.35, wave: "sine" as const })),
  },
  rooster: {
    name: "Rooster crow",
    period: 3,
    // "Cock-a-doodle-doo!"
    notes: () => [
      { f: 600, to: 900, at: 0, dur: 0.18, wave: "sawtooth", gain: 0.5 },
      { f: 700, to: 1000, at: 0.22, dur: 0.14, wave: "sawtooth", gain: 0.5 },
      { f: 800, to: 1150, at: 0.4, dur: 0.2, wave: "sawtooth", gain: 0.5 },
      { f: 1150, to: 700, at: 0.64, dur: 0.9, wave: "sawtooth", gain: 0.5 },
    ],
  },
} satisfies Record<string, Ringtone>;

export type RingtoneId = keyof typeof RINGTONES;
export const RINGTONE_IDS = Object.keys(RINGTONES) as RingtoneId[];

/** Plays a ringtone once (previews and to-do reminders). */
export function playRingtone(id: RingtoneId, volume: number): void {
  logSound({ kind: "ringtone", id, volume, known: id in RINGTONES });
  play((RINGTONES[id] ?? RINGTONES.classic).notes(0), volume);
}

/** Rings until stopped (or for at most `maxSeconds`). Returns the stop function. */
export function ringAlarm(id: RingtoneId, volume: number, maxSeconds = 60): () => void {
  const tone: Ringtone = RINGTONES[id] ?? RINGTONES.classic;
  logSound({ kind: "ring", id, volume });
  let rep = 0;
  const ring = () => play(tone.notes(rep++), volume);
  ring();
  const timer = setInterval(ring, tone.period * 1000);
  const timeout = setTimeout(() => clearInterval(timer), maxSeconds * 1000);
  return () => {
    logSound({ kind: "ring-stop", id });
    clearInterval(timer);
    clearTimeout(timeout);
  };
}

/**
 * "Field phone": a focus session starts. An original two-tone electronic ring in the
 * style of an operations-room phone (bi-bi-bu-do, twice), unlike any ringtone, so it can
 * be told from a break starting without seeing the pet.
 */
const FIELD_PHONE: Ringtone = {
  name: "Field phone",
  period: 1.6,
  notes: () =>
    [0, 0.8].flatMap((t) => [
      { f: 1568, at: t, dur: 0.07, wave: "square" as const, gain: 0.3 },
      { f: 1568, at: t + 0.11, dur: 0.07, wave: "square" as const, gain: 0.3 },
      { f: 1175, at: t + 0.24, dur: 0.12, wave: "triangle" as const, gain: 0.8 },
      { f: 784, at: t + 0.4, dur: 0.24, wave: "triangle" as const, gain: 0.8 },
    ]),
};

/** The focus-session sounds' choices: Field phone first, then the ringtones. */
export const FOCUS_TONE_CHOICES: { id: FocusTone; name: string }[] = [
  { id: "fieldPhone", name: FIELD_PHONE.name },
  ...RINGTONE_IDS.map((id) => ({ id, name: (RINGTONES[id] as Ringtone).name })),
  { id: "off", name: "Off" },
];

/** A focus starting or a break starting (Focus → Sounds); "off" plays nothing. */
export function playFocusTone(id: FocusTone, volume: number, what: "focus" | "break"): void {
  if (id === "off") return;
  logSound({ kind: "focus-tone", what, id, volume });
  const tone = id === "fieldPhone" ? FIELD_PHONE : ((RINGTONES[id] as Ringtone | undefined) ?? FIELD_PHONE);
  play(tone.notes(0), volume);
}

/** Small UI sounds (petting). */
export const sounds = {
  pop: () => {
    logSound({ kind: "pop" });
    play([{ f: 660, at: 0, dur: 0.08 }], 0.4);
  },
};

/** An anniversary's music for `seconds` (fading out at the end). Returns a function that stops it early. */
export function playMusic(piece: Piece, seconds: number, volume: number): () => void {
  logSound({ kind: "music", piece: piece.id, seconds, volume });
  const c = audio();
  if (!c || volume <= 0) return () => {};
  const out = playPiece(c, piece, c.currentTime + 0.05, seconds, volume);
  return () => {
    logSound({ kind: "music-stop", piece: piece.id });
    const now = c.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.linearRampToValueAtTime(0.0001, now + 0.4);
    setTimeout(() => out.disconnect(), 500);
  };
}
