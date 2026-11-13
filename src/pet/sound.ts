/**
 * Synthesized sounds and ringtones (WebAudio), so the app needs no audio files.
 * Characters or skins can ship recorded sounds later.
 */
import { msg } from "../i18n";
import { playPiece, type Piece } from "../celebrate/music";
import { rampVolume } from "../features/modes/modes";
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
  /** Full loudness for the whole note (a gated pulse), instead of dying away. */
  hold?: boolean;
  /** Also through a small room's echo (`room`), so it rings on after the note. */
  room?: boolean;
}

let roomEcho: { ctx: AudioContext; input: AudioNode } | null = null;

/**
 * A small room's echo: a reverb whose tail starts about 15 dB under the note and dies away
 * in a quarter of a second (matched to the recording of the Field phone).
 */
function room(a: AudioContext): AudioNode {
  if (roomEcho?.ctx !== a) {
    const len = Math.round(a.sampleRate * 0.4);
    const ir = a.createBuffer(1, len, a.sampleRate);
    const d = ir.getChannelData(0);
    let energy = 0;
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / a.sampleRate / 0.05);
      energy += d[i] * d[i];
    }
    for (let i = 0; i < len; i++) d[i] /= Math.sqrt(energy);
    const conv = a.createConvolver();
    conv.normalize = false;
    conv.buffer = ir;
    const wet = a.createGain();
    wet.gain.value = 0.2;
    conv.connect(wet).connect(a.destination);
    roomEcho = { ctx: a, input: conv };
  }
  return roomEcho.input;
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
    if (n.hold) {
      // 4 ms in and out, like a switched electronic ringer (and no clicks).
      g.gain.linearRampToValueAtTime(peak, t0 + n.at + 0.004);
      g.gain.setValueAtTime(peak, t0 + n.at + n.dur - 0.004);
      g.gain.linearRampToValueAtTime(0, t0 + n.at + n.dur);
    } else {
      g.gain.linearRampToValueAtTime(peak, t0 + n.at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    }
    osc.connect(g).connect(a.destination);
    if (n.room) g.connect(room(a));
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
    name: msg("Classic alarm"),
    period: 1.6,
    notes: () => [0, 0.3, 0.6].flatMap((t) => [{ f: 988, at: t, dur: 0.16 }, { f: 1319, at: t + 0.1, dur: 0.14 }]),
  },
  chime: {
    name: msg("Chime"),
    period: 2.5,
    notes: () => [
      { f: 880, at: 0, dur: 1.2, wave: "sine" },
      { f: 1320, at: 0.18, dur: 1.4, wave: "sine" },
    ],
  },
  digital: {
    name: msg("Digital watch"),
    period: 1.2,
    notes: () => [0, 0.12, 0.24, 0.36].map((t) => ({ f: 2000, at: t, dur: 0.07, wave: "square" as const, gain: 0.35 })),
  },
  gentle: {
    name: msg("Gentle rise"),
    period: 2.4,
    // Starts quiet and gets louder each time it repeats.
    notes: (rep) =>
      [C5, E5, G5, C6].map((f, i) => ({ f, at: i * 0.28, dur: 0.9, wave: "sine" as const, gain: Math.min(1, 0.25 + rep * 0.15) })),
  },
  marimba: {
    name: msg("Marimba"),
    period: 2,
    notes: () => [C5, E5, G5, E5, C6, E6].map((f, i) => ({ f, at: i * 0.14, dur: 0.35, wave: "sine" as const })),
  },
  rooster: {
    name: msg("Rooster crow"),
    period: 3,
    // "Cock-a-doodle-doo!"
    notes: () => [
      { f: 600, to: 900, at: 0, dur: 0.18, wave: "sawtooth", gain: 0.5 },
      { f: 700, to: 1000, at: 0.22, dur: 0.14, wave: "sawtooth", gain: 0.5 },
      { f: 800, to: 1150, at: 0.4, dur: 0.2, wave: "sawtooth", gain: 0.5 },
      { f: 1150, to: 700, at: 0.64, dur: 0.9, wave: "sawtooth", gain: 0.5 },
    ],
  },
  trill: {
    name: msg("Office trill"),
    period: 3,
    // The electronic office-phone ringer (AT&T Merlin style): three sine tones together,
    // switched on and off every 22 ms, 24 times (about a second).
    notes: () =>
      Array.from({ length: 24 }, (_, i) =>
        [
          { f: 755, gain: 0.6 },
          { f: 2260, gain: 0.35 },
          { f: 3800, gain: 0.2 },
        ].map(({ f, gain }) => ({ f, at: i * 0.044, dur: 0.022, wave: "sine" as const, gain, hold: true })),
      ).flat(),
  },
} satisfies Record<string, Ringtone>;

export type RingtoneId = keyof typeof RINGTONES;
export const RINGTONE_IDS = Object.keys(RINGTONES) as RingtoneId[];

/** Plays a ringtone once (previews and to-do reminders). */
export function playRingtone(id: RingtoneId, volume: number): void {
  logSound({ kind: "ringtone", id, volume, known: id in RINGTONES });
  play((RINGTONES[id] ?? RINGTONES.classic).notes(0), volume);
}

/**
 * Rings until stopped (or for at most `maxSeconds`). `rampUp` (Quiet mode): it starts at a
 * quarter of `volume` and rises to it over 30 seconds. Returns the stop function.
 */
export function ringAlarm(id: RingtoneId, volume: number, maxSeconds = 60, rampUp = false): () => void {
  const tone: Ringtone = RINGTONES[id] ?? RINGTONES.classic;
  logSound({ kind: "ring", id, volume, rampUp });
  let rep = 0;
  const started = Date.now();
  const ring = () => play(tone.notes(rep++), rampUp ? rampVolume(volume, (Date.now() - started) / 1000) : volume);
  ring();
  const timer = setInterval(ring, tone.period * 1000);
  const timeout = setTimeout(() => clearInterval(timer), maxSeconds * 1000);
  return () => {
    logSound({ kind: "ring-stop", id });
    clearInterval(timer);
    clearTimeout(timeout);
  };
}

/** A gated electronic ringer's chirp: sine tones at once ([Hz, loudness]), with room echo. */
const chirp = (at: number, tones: [number, number][]): Note[] =>
  tones.map(([f, gain]) => ({ f, at, dur: 0.03, wave: "sine", gain, hold: true, room: true }));

/**
 * "Field phone": a focus session starts. One ring (about 1.3 s) of the operations-room
 * desk phone, timed and tuned from a recording: two pairs of chirps on 692 Hz's odd
 * harmonics, then 18 chirps a second, four on 985 Hz's and eight softer on 492 Hz's, each
 * echoing in the room. It can be told from a break starting without seeing the pet.
 */
const FIELD_PHONE: Ringtone = {
  name: msg("Field phone"),
  period: 2.5,
  notes: () => [
    ...[0, 0.049, 0.22, 0.27].flatMap((t) =>
      chirp(t, [
        [695, 0.3],
        [2075, 0.33],
        [3459, 0.065],
      ]),
    ),
    ...[0, 1, 2, 3].flatMap((i) =>
      chirp(0.66 + i * 0.0545, [
        [985, 0.5],
        [2952, 0.47],
      ]),
    ),
    ...[4, 5, 6, 7, 8, 9, 10, 11].flatMap((i) =>
      chirp(0.66 + i * 0.0545, [
        [1476, 0.3],
        [2462, 0.21],
        [492, 0.085],
      ]),
    ),
  ],
};

/** The focus-session sounds' choices: Field phone first, then the ringtones. */
export const FOCUS_TONE_CHOICES: { id: FocusTone; name: string }[] = [
  { id: "fieldPhone", name: FIELD_PHONE.name },
  ...RINGTONE_IDS.map((id) => ({ id, name: (RINGTONES[id] as Ringtone).name })),
  { id: "off", name: msg("Off") },
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
  /** Pet Post: a delivery is in (shorter and softer than the chime that asks). */
  received: (volume: number) => {
    logSound({ kind: "received", volume });
    play(
      [
        { f: 784, at: 0, dur: 0.09 },
        { f: 1175, at: 0.09, dur: 0.16 },
      ],
      volume * 0.6,
    );
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

/**
 * A game's answer: "right" a quick rising two-note "ding-dong", "wrong" a short low falling
 * "boop". About a third of a second each.
 */
export function playAnswerSound(kind: "right" | "wrong", volume: number): void {
  logSound({ kind: "answer", id: kind, volume });
  if (kind === "right") {
    play(
      [
        { f: 784, at: 0, dur: 0.16, wave: "triangle", gain: 0.8 },
        { f: 1175, at: 0.12, dur: 0.24, wave: "triangle", gain: 0.8 },
      ],
      volume,
    );
  } else {
    play([{ f: 233, to: 165, at: 0, dur: 0.32, wave: "square", gain: 0.35 }], volume);
  }
}

/** Pet Crossing's sounds (src/features/games/crossing), each well under a second but the last two. */
export type CrossingSound = "start" | "hop" | "bump" | "splash" | "timeup" | "tick" | "level" | "over" | "cleared";

const CROSSING_SOUNDS: Record<CrossingSound, Note[]> = {
  // Off we go: two quick notes up.
  start: [
    { f: 523, at: 0, dur: 0.09 },
    { f: 784, at: 0.09, dur: 0.16 },
  ],
  // A hop: a short blip sliding up.
  hop: [{ f: 520, to: 820, at: 0, dur: 0.07, wave: "sine", gain: 0.5 }],
  // Bumped: a low thud with a buzz on top.
  bump: [
    { f: 190, to: 70, at: 0, dur: 0.22, wave: "square", gain: 0.4 },
    { f: 95, to: 50, at: 0, dur: 0.28, wave: "sine", gain: 0.9 },
  ],
  // Into the river: a plop falling away, and two small bubbles.
  splash: [
    { f: 620, to: 110, at: 0, dur: 0.26, wave: "sine", gain: 0.8 },
    { f: 880, to: 1320, at: 0.2, dur: 0.07, wave: "sine", gain: 0.35 },
    { f: 1040, to: 1560, at: 0.3, dur: 0.07, wave: "sine", gain: 0.3 },
  ],
  // Time's up: three notes down, like a clock running out.
  timeup: [
    { f: 660, at: 0, dur: 0.12, wave: "square", gain: 0.3 },
    { f: 523, at: 0.13, dur: 0.12, wave: "square", gain: 0.3 },
    { f: 392, at: 0.26, dur: 0.3, wave: "square", gain: 0.3 },
  ],
  // The last five seconds, one a second.
  tick: [{ f: 1320, at: 0, dur: 0.05, wave: "square", gain: 0.2, hold: true }],
  // At the goal: up the chord.
  level: [
    { f: C5, at: 0, dur: 0.1 },
    { f: E5, at: 0.09, dur: 0.1 },
    { f: G5, at: 0.18, dur: 0.1 },
    { f: C6, at: 0.27, dur: 0.32 },
  ],
  // Game over: slowly down.
  over: [
    { f: 392, at: 0, dur: 0.28 },
    { f: 330, at: 0.26, dur: 0.28 },
    { f: 262, at: 0.52, dur: 0.3 },
    { f: 196, at: 0.8, dur: 0.7 },
  ],
  // All twenty levels: a little fanfare.
  cleared: [
    { f: C5, at: 0, dur: 0.12, wave: "square", gain: 0.35 },
    { f: C5, at: 0.14, dur: 0.12, wave: "square", gain: 0.35 },
    { f: C5, at: 0.28, dur: 0.12, wave: "square", gain: 0.35 },
    { f: E5, at: 0.42, dur: 0.2, wave: "square", gain: 0.35 },
    { f: G5, at: 0.64, dur: 0.2, wave: "square", gain: 0.35 },
    { f: C6, at: 0.86, dur: 0.7, wave: "square", gain: 0.35 },
    { f: E6, at: 0.86, dur: 0.7, gain: 0.5 },
  ],
};

export function playCrossingSound(id: CrossingSound, volume: number): void {
  logSound({ kind: "crossing", id, volume });
  play(CROSSING_SOUNDS[id], volume);
}
