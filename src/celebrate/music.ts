/**
 * Music for anniversaries, synthesized with Web Audio like the ringtones (no audio files).
 * Each piece lasts 30 or 60 s, so it repeats exactly within the longest celebration (60 s).
 * Melodies are public domain (Happy Birthday, Pachelbel's Canon, Ode to Joy, Jasmine
 * Flower, Chopin's funeral march, Taps) or written for ePet.
 */

export type Instrument =
  | "musicbox"
  | "celesta"
  | "piano"
  | "pluck"
  | "bell"
  | "gong"
  | "brass"
  | "strings"
  | "flute"
  | "xiao"
  | "erhu"
  | "wood";

/** A note: when (beats), how long (beats), pitch(es) like "C#4", loudness 0..1. */
interface Ev {
  t: number;
  d: number;
  p: string | string[];
  v: number;
}

interface Track {
  inst: Instrument;
  gain: number;
  events: Ev[];
}

export interface Piece {
  id: string;
  name: string;
  mood: "happy" | "mourning";
  /** 30 or 60: it repeats exactly within 60 s. */
  seconds: number;
  beats: number;
  /** Reverb mix 0..1. */
  reverb: number;
  /** Loudness trim so every piece sounds about as loud (average level, measured by rendering it). */
  level: number;
  /** Grows louder through the piece by this much (0.15: the end is 15% louder than the start). */
  swell?: number;
  tracks: Track[];
}

type Step = [string | string[] | null, number, number?];

/** Notes one after another from `start` (beats); null is a rest. */
function seq(start: number, steps: Step[], v = 0.8): Ev[] {
  const out: Ev[] = [];
  let t = start;
  for (const [p, d, vel] of steps) {
    if (p !== null) out.push({ t, d, p, v: vel ?? v });
    t += d;
  }
  return out;
}

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as const;

export function freq(p: string): number {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(p);
  if (!m) return 440;
  const midi = 12 * (Number(m[3]) + 1) + NOTE[m[1] as keyof typeof NOTE] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
}

function transpose(p: string, semis: number): string {
  const names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(p);
  if (!m) return p;
  let midi = 12 * (Number(m[3]) + 1) + NOTE[m[1] as keyof typeof NOTE] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + semis;
  const oct = Math.floor(midi / 12) - 1;
  midi = ((midi % 12) + 12) % 12;
  return `${names[midi]}${oct}`;
}

/** Oom-pah-pah (3/4) or bass-chord-chord-chord (4/4) under chords [root, ...upper]. */
function comp(start: number, beatsPerBar: number, bars: string[][], v = 0.22): Ev[] {
  const out: Ev[] = [];
  bars.forEach((chord, i) => {
    const t = start + i * beatsPerBar;
    out.push({ t, d: 1, p: chord[0], v: v + 0.06 });
    for (let b = 1; b < beatsPerBar; b++) out.push({ t: t + b, d: 1, p: chord.slice(1), v });
  });
  return out;
}

/** Eighth-note arpeggios over chords (root first), 8 per 4/4 bar. */
function arpeggio(start: number, bars: string[][], v = 0.3, beatsPerBar = 4): Ev[] {
  const out: Ev[] = [];
  bars.forEach((chord, i) => {
    const [r, a, b] = chord;
    const up = [r, a, b, transpose(r, 12), transpose(a, 12), transpose(r, 12), b, a];
    for (let k = 0; k < beatsPerBar * 2; k++) out.push({ t: start + i * beatsPerBar + k / 2, d: 0.5, p: up[k % up.length], v });
  });
  return out;
}

/** One sustained chord per bar (a soft string pad). */
function pad(start: number, beatsPerBar: number, bars: string[][], v = 0.35): Ev[] {
  return bars.map((chord, i) => ({ t: start + i * beatsPerBar, d: beatsPerBar, p: chord, v }));
}

/** Quarter-note broken chords: root, fifth, octave, fifth (calmer than eighth-note arpeggios). */
function broken(start: number, bars: string[][], v = 0.25): Ev[] {
  return bars.flatMap(([r, a], i) =>
    [r, a, transpose(r, 12), a].map((p, k) => ({ t: start + i * 4 + k, d: 1, p, v })),
  );
}

// --- The pieces ------------------------------------------------------------

const birthdayTune = (start: number, oct = 0): Ev[] => {
  const o = (p: string) => transpose(p, oct);
  return seq(start, [
    [o("G4"), 0.75], [o("G4"), 0.25],
    [o("A4"), 1], [o("G4"), 1], [o("C5"), 1],
    [o("B4"), 2], [o("G4"), 0.75], [o("G4"), 0.25],
    [o("A4"), 1], [o("G4"), 1], [o("D5"), 1],
    [o("C5"), 2], [o("G4"), 0.75], [o("G4"), 0.25],
    [o("G5"), 1], [o("E5"), 1], [o("C5"), 1],
    [o("B4"), 1], [o("A4"), 1], [o("F5"), 0.75], [o("F5"), 0.25],
    [o("E5"), 1], [o("C5"), 1], [o("D5"), 1],
    [o("C5"), 3],
  ]);
};

const BIRTHDAY: Piece = {
  id: "birthday",
  level: 0.363,
  name: "Happy Birthday",
  mood: "happy",
  seconds: 30,
  beats: 50,
  reverb: 0.22,
  tracks: [
    { inst: "musicbox", gain: 0.9, events: birthdayTune(0) },
    { inst: "musicbox", gain: 0.8, events: birthdayTune(25, 12) },
    { inst: "piano", gain: 0.55, events: birthdayTune(25) },
    {
      inst: "piano",
      gain: 0.2,
      events: comp(26, 3, [
        ["C3", "E4", "G4"], ["G2", "F4", "G4"], ["G2", "F4", "B4"], ["C3", "E4", "G4"],
        ["C3", "E4", "Bb4"], ["F2", "F4", "A4"], ["G2", "F4", "G4"], ["C3", "E4", "G4"],
      ]),
    },
    { inst: "bell", gain: 0.18, events: seq(48, [["C6", 2]]) },
  ],
};

const canonBass = (start: number) =>
  seq(start, ["D3", "A2", "B2", "F#2", "G2", "D2", "G2", "A2"].map((p): Step => [p, 2]), 0.7);

const CANON: Piece = {
  id: "canon",
  level: 0.954,
  name: "Canon in D (Pachelbel)",
  mood: "happy",
  seconds: 30,
  beats: 32,
  reverb: 0.35,
  tracks: [
    { inst: "strings", gain: 0.35, events: [...canonBass(0), ...canonBass(16)] },
    {
      inst: "pluck",
      gain: 0.1,
      events: arpeggio(0, [
        ["D3", "F#3", "A3"], ["A2", "C#3", "E3"], ["B2", "D3", "F#3"], ["F#2", "A2", "C#3"],
        ["G2", "B2", "D3"], ["D3", "F#3", "A3"], ["G2", "B2", "D3"], ["A2", "C#3", "E3"],
      ].flatMap((c) => [c]), 0.4, 2).concat(
        arpeggio(16, [
          ["D3", "F#3", "A3"], ["A2", "C#3", "E3"], ["B2", "D3", "F#3"], ["F#2", "A2", "C#3"],
          ["G2", "B2", "D3"], ["D3", "F#3", "A3"], ["G2", "B2", "D3"], ["A2", "C#3", "E3"],
        ], 0.4, 2),
      ),
    },
    { inst: "strings", gain: 0.6, events: seq(0, ["F#5", "E5", "D5", "C#5", "B4", "A4", "B4", "C#5"].map((p): Step => [p, 2])) },
    {
      inst: "piano",
      gain: 0.42,
      events: seq(16, [
        "D4", "F#4", "A4", "G4", "F#4", "D4", "F#4", "E4", "D4", "B3", "D4", "A4", "G4", "B4", "A4", "G4",
        "F#4", "D4", "E4", "C#5", "D5", "F#5", "A5", "A4", "B4", "G4", "A4", "F#4", "D4", "D5", "D5", "C#5",
      ].map((p): Step => [p, 0.5])),
    },
  ],
};

const odeA = (end: "D" | "C"): Step[] => [
  ["E5", 1], ["E5", 1], ["F5", 1], ["G5", 1],
  ["G5", 1], ["F5", 1], ["E5", 1], ["D5", 1],
  ["C5", 1], ["C5", 1], ["D5", 1], ["E5", 1],
  ...(end === "D" ? ([["E5", 1.5], ["D5", 0.5], ["D5", 2]] as Step[]) : ([["D5", 1.5], ["C5", 0.5], ["C5", 2]] as Step[])),
];

const ODE: Piece = {
  id: "ode",
  level: 1.725,
  name: "Ode to Joy (Beethoven)",
  mood: "happy",
  seconds: 30,
  beats: 64,
  reverb: 0.25,
  tracks: [
    {
      inst: "brass",
      gain: 0.55,
      events: seq(0, [
        ...odeA("D"),
        ...odeA("C"),
        ["D5", 1], ["D5", 1], ["E5", 1], ["C5", 1],
        ["D5", 1], ["E5", 0.5], ["F5", 0.5], ["E5", 1], ["C5", 1],
        ["D5", 1], ["E5", 0.5], ["F5", 0.5], ["E5", 1], ["D5", 1],
        ["C5", 1], ["D5", 1], ["G4", 2],
        ...odeA("C"),
      ]),
    },
    {
      inst: "strings",
      gain: 0.22,
      events: pad(0, 4, [
        ["C3", "G3", "E4"], ["G2", "D3", "B3"], ["C3", "G3", "E4"], ["G2", "D3", "B3"],
        ["C3", "G3", "E4"], ["G2", "D3", "B3"], ["C3", "G3", "E4"], ["G2", "C3", "E3"],
        ["G2", "D3", "B3"], ["C3", "G3", "E4"], ["G2", "D3", "B3"], ["C3", "G3", "E4"],
        ["C3", "G3", "E4"], ["G2", "D3", "B3"], ["C3", "G3", "E4"], ["C3", "G3", "E4"],
      ]),
    },
  ],
};

const jasmine = (): Step[] => {
  return [
    ["E4", 1], ["E4", 0.5], ["G4", 0.5], ["A4", 0.5], ["C5", 0.5], ["C5", 0.5], ["A4", 0.5],
    ["G4", 1], ["G4", 0.5], ["A4", 0.5], ["G4", 2],
    ["E4", 1], ["E4", 0.5], ["G4", 0.5], ["A4", 0.5], ["C5", 0.5], ["C5", 0.5], ["A4", 0.5],
    ["G4", 1], ["G4", 0.5], ["A4", 0.5], ["G4", 2],
    ["G4", 1], ["G4", 1], ["G4", 1], ["E4", 0.5], ["G4", 0.5],
    ["A4", 1], ["A4", 1], ["G4", 2],
    ["E4", 1], ["D4", 0.5], ["E4", 0.5], ["G4", 1], ["E4", 0.5], ["D4", 0.5],
    ["C4", 1], ["C4", 0.5], ["D4", 0.5], ["C4", 2],
  ];
};

const JASMINE: Piece = {
  id: "jasmine",
  level: 0.621,
  name: "Jasmine Flower 茉莉花",
  mood: "happy",
  seconds: 30,
  beats: 32,
  reverb: 0.3,
  tracks: [
    { inst: "flute", gain: 0.7, events: seq(0, jasmine()) },
    {
      inst: "pluck",
      gain: 0.22,
      events: arpeggio(0, [
        ["C3", "G3", "E4"], ["C3", "G3", "E4"], ["C3", "G3", "E4"], ["C3", "G3", "E4"],
        ["C3", "G3", "E4"], ["A2", "E3", "C4"], ["C3", "G3", "E4"], ["C3", "G3", "C4"],
      ], 0.25),
    },
    { inst: "pluck", gain: 0.15, events: seq(0.5, jasmine().map(([p, d]): Step => [typeof p === "string" ? transpose(p, 12) : p, d]), 0.35) },
  ],
};

const festiveTune: Step[] = [
  ["G4", 0.5], ["A4", 0.5], ["C5", 1], ["A4", 0.5], ["G4", 0.5], ["E4", 1],
  ["D4", 0.5], ["E4", 0.5], ["G4", 0.5], ["A4", 0.5], ["G4", 2],
  ["C5", 0.5], ["D5", 0.5], ["E5", 1], ["D5", 0.5], ["C5", 0.5], ["A4", 1],
  ["G4", 0.5], ["A4", 0.5], ["C5", 0.5], ["D5", 0.5], ["C5", 2],
  ["E5", 1], ["D5", 0.5], ["E5", 0.5], ["G5", 1], ["E5", 1],
  ["D5", 0.5], ["C5", 0.5], ["D5", 0.5], ["E5", 0.5], ["D5", 2],
  ["C5", 0.5], ["A4", 0.5], ["G4", 0.5], ["A4", 0.5], ["C5", 1], ["D5", 1],
  ["C5", 3], [null, 1],
];

const festiveChords = [
  ["C3", "G3", "E4"], ["G2", "D3", "B3"], ["A2", "E3", "C4"], ["C3", "G3", "E4"],
  ["C3", "G3", "E4"], ["G2", "D3", "B3"], ["A2", "E3", "C4"], ["C3", "G3", "E4"],
];

const FESTIVE: Piece = {
  id: "festive",
  level: 0.701,
  name: "Festive (original, Chinese style)",
  mood: "happy",
  seconds: 30,
  beats: 64,
  reverb: 0.2,
  tracks: [
    { inst: "flute", gain: 0.65, events: [...seq(0, festiveTune), ...seq(32, festiveTune.map(([p, d]): Step => [typeof p === "string" ? transpose(p, 12) : p, d]))] },
    { inst: "pluck", gain: 0.18, events: [...broken(0, festiveChords), ...broken(32, festiveChords)] },
    { inst: "gong", gain: 0.1, events: [{ t: 32, d: 4, p: "C3", v: 0.5 }, { t: 63, d: 1, p: "C3", v: 0.5 }] },
  ],
};

const WALTZ: Piece = {
  id: "waltz",
  level: 0.387,
  name: "Music-box waltz (original)",
  mood: "happy",
  seconds: 30,
  beats: 60,
  reverb: 0.25,
  tracks: [
    {
      inst: "musicbox",
      gain: 1,
      events: seq(0, [
        ["B4", 1], ["D5", 1], ["G5", 1], ["F#5", 2], ["E5", 1], ["D5", 1], ["B4", 1], ["G4", 1], ["A4", 3],
        ["C5", 1], ["E5", 1], ["A5", 1], ["G5", 2], ["F#5", 1], ["E5", 1], ["C5", 1], ["A4", 1], ["B4", 3],
        ["B4", 1], ["D5", 1], ["G5", 1], ["B5", 2], ["A5", 1], ["G5", 1], ["E5", 1], ["C5", 1], ["D5", 3],
        ["C5", 1], ["A4", 1], ["F#4", 1], ["G4", 1], ["B4", 1], ["D5", 1], ["A4", 2], ["F#4", 1], ["G4", 3],
        ["D5", 1], ["B4", 1], ["G4", 1], ["D5", 1], ["B4", 1], ["G4", 1], [["G4", "B4", "D5", "G5"], 3], [null, 3],
      ]),
    },
    {
      inst: "piano",
      gain: 0.12,
      events: comp(0, 3, [
        ["G2", "B3", "D4"], ["D2", "A3", "C4"], ["G2", "B3", "D4"], ["D2", "F#3", "C4"],
        ["A2", "C4", "E4"], ["D2", "F#3", "C4"], ["C3", "E3", "G3"], ["G2", "B3", "D4"],
        ["G2", "B3", "D4"], ["G2", "B3", "D4"], ["C3", "E3", "G3"], ["D2", "F#3", "A3"],
        ["D2", "F#3", "C4"], ["G2", "B3", "D4"], ["D2", "F#3", "C4"], ["G2", "B3", "D4"],
        ["G2", "B3", "D4"], ["D2", "F#3", "C4"], ["G2", "B3", "D4"],
      ], 0.18),
    },
  ],
};

const AISI: Piece = {
  id: "aisi",
  level: 0.593,
  name: "Remembrance (original, Chinese style)",
  mood: "mourning",
  seconds: 60,
  beats: 48,
  reverb: 0.5,
  tracks: [
    {
      inst: "xiao",
      gain: 0.7,
      events: seq(0, [
        ["A4", 2], ["G4", 1], ["E4", 1],
        ["D4", 1.5], ["E4", 0.5], ["A3", 2],
        ["C4", 1], ["D4", 1], ["E4", 1.5], ["G4", 0.5],
        ["E4", 3], [null, 1],
        ["A4", 1.5], ["C5", 0.5], ["D5", 1], ["C5", 1],
        ["A4", 1], ["G4", 1], ["E4", 2],
        ["G4", 1], ["E4", 0.5], ["D4", 0.5], ["C4", 1], ["D4", 1],
        ["E4", 4],
        ["D4", 1], ["E4", 1], ["G4", 1], ["A4", 1],
        ["C5", 1.5], ["A4", 0.5], ["G4", 1], ["E4", 1],
        ["D4", 1], ["C4", 1], ["D4", 1.5], ["E4", 0.5],
        ["A3", 4],
      ], 0.7),
    },
    {
      inst: "erhu",
      gain: 0.35,
      events: seq(16, [
        ["A3", 1.5], ["C4", 0.5], ["D4", 1], ["C4", 1],
        ["A3", 1], ["G3", 1], ["E3", 2],
        ["G3", 1], ["E3", 0.5], ["D3", 0.5], ["C3", 1], ["D3", 1],
        ["E3", 4],
      ], 0.6),
    },
    {
      inst: "strings",
      gain: 0.3,
      events: seq(0, [
        [["A2", "E3"], 16], [["D3", "A3"], 8], [["A2", "E3"], 8], [["C3", "G3"], 8], [["A2", "E3"], 8],
      ], 0.5),
    },
    { inst: "gong", gain: 0.14, events: [0, 8, 16, 24, 32, 40].map((t) => ({ t, d: 6, p: "A2", v: 0.45 })) },
    { inst: "bell", gain: 0.08, events: [4, 20, 36].map((t) => ({ t, d: 4, p: "E5", v: 0.4 })) },
  ],
};

const funeralBars = (lo: string[], hi: string[]): Step[] => [
  [lo[0], 1], [lo[0], 0.75], [lo[0], 0.25], [lo[0], 2],
  [hi[0], 0.75], [hi[1], 0.25], [hi[1], 0.75], [hi[2], 0.25], [hi[2], 0.75], [hi[3], 0.25], [hi[2], 1],
];

const CHOPIN: Piece = {
  id: "chopin",
  level: 0.429,
  name: "Funeral March (Chopin)",
  mood: "mourning",
  seconds: 30,
  beats: 32,
  reverb: 0.4,
  tracks: [
    {
      inst: "piano",
      gain: 0.7,
      events: seq(0, [
        ...funeralBars(["Bb3"], ["Db4", "C4", "Bb3", "A3"]),
        ...funeralBars(["Bb3"], ["Db4", "C4", "Bb3", "A3"]),
        ...funeralBars(["Db4"], ["F4", "Eb4", "Db4", "C4"]),
        ...funeralBars(["Bb3"], ["Db4", "C4", "Bb3", "A3"]),
      ]),
    },
    {
      inst: "piano",
      gain: 0.1,
      events: Array.from({ length: 32 }, (_, i) => ({
        t: i,
        d: 1,
        p: i % 2 === 0 ? ["Bb1", "F2", "Db3"] : ["Gb1", "Db2", "Bb2"],
        v: 0.35,
      })),
    },
  ],
};

const TAPS: Piece = {
  id: "taps",
  level: 1.583,
  name: "Taps (bugle call)",
  mood: "mourning",
  seconds: 30,
  beats: 30,
  reverb: 0.55,
  tracks: [
    {
      inst: "brass",
      gain: 0.6,
      events: seq(0, [
        ["G3", 0.75], ["G3", 0.25], ["C4", 3],
        ["G3", 0.75], ["C4", 0.25], ["E4", 3],
        ["G3", 0.75], ["C4", 0.25], ["E4", 1], ["G3", 0.75], ["C4", 0.25], ["E4", 1],
        ["G3", 0.75], ["C4", 0.25], ["E4", 3],
        ["C4", 0.75], ["E4", 0.25], ["G4", 3],
        ["E4", 0.75], ["C4", 0.25], ["G3", 3],
        ["G3", 0.75], ["G3", 0.25], ["C4", 4], [null, 1],
      ], 0.7),
    },
    { inst: "strings", gain: 0.12, events: seq(0, [[["C3", "G3"], 12], [["C3", "E3"], 12], [["C3", "G3"], 6]], 0.4) },
  ],
};

const REFLECTION: Piece = {
  id: "reflection",
  level: 0.767,
  name: "Reflection (original, piano)",
  mood: "mourning",
  seconds: 60,
  beats: 60,
  reverb: 0.45,
  tracks: [
    {
      inst: "piano",
      gain: 0.7,
      events: seq(0, [
        ["E5", 2], ["D5", 1], ["C5", 1], ["C5", 2], ["A4", 2], ["G4", 2], ["C5", 1], ["E5", 1], ["D5", 4],
        ["E5", 2], ["D5", 1], ["C5", 1], ["A4", 2], ["C5", 2], ["B4", 2], ["D5", 2], ["G#4", 4],
        ["A4", 2], ["B4", 1], ["C5", 1], ["F5", 2], ["E5", 1], ["D5", 1], ["D5", 2], ["B4", 2], ["C5", 2], ["E5", 2],
        ["A5", 2], ["F5", 1], ["D5", 1], ["B4", 2], ["G#4", 2], ["A4", 4],
      ], 0.65),
    },
    {
      inst: "piano",
      gain: 0.16,
      events: arpeggio(0, [
        ["A2", "E3", "C4"], ["F2", "C3", "A3"], ["C3", "G3", "E4"], ["G2", "D3", "B3"],
        ["A2", "E3", "C4"], ["F2", "C3", "A3"], ["G2", "D3", "B3"], ["E2", "B2", "G#3"],
        ["A2", "E3", "C4"], ["D3", "A3", "F4"], ["G2", "D3", "B3"], ["C3", "G3", "E4"],
        ["F2", "C3", "A3"], ["E2", "B2", "G#3"], ["A2", "E3", "C4"],
      ], 0.22),
    },
  ],
};

// --- Fuller versions (chosen by listening): the accompaniment taken back up now that the click
// that made it sound like drumming is fixed, plus a swell and a little colour.

/** A copy of `base` with its tracks changed by `edit` (tracks are copied first). */
function fuller(base: Piece, level: number, edit: (tracks: Track[]) => Track[]): Piece {
  const tracks = base.tracks.map((t) => ({ ...t, events: [...t.events] }));
  return { ...base, level, swell: 0.15, tracks: edit(tracks) };
}


const [BIRTHDAY_FULL, CANON_FULL, FESTIVE_FULL, WALTZ_FULL, CHOPIN_FULL, REFLECTION_FULL] = [
  fuller(BIRTHDAY, 0.32, (t) => {
    t[3].gain = 0.3;
    t[4] = { inst: "celesta", gain: 0.25, events: [{ t: 48, d: 2, p: ["C6", "E6", "G6"], v: 0.6 }] };
    return t;
  }),
  fuller(CANON, 0.649, (t) => {
    t[1].gain = 0.18;
    t[3].gain = 0.6;
    t.push({ inst: "celesta", gain: 0.15, events: seq(16, ["F#4", "E4", "D4", "C#4", "B3", "A3", "B3", "C#4"].map((p): Step => [p, 2]), 0.5) });
    return t;
  }),
  fuller(FESTIVE, 0.668, (t) => {
    t[1].events = [...t[1].events.filter((e) => e.t < 32), ...arpeggio(32, festiveChords, 0.3)];
    t.push({ inst: "wood", gain: 0.1, events: Array.from({ length: 8 }, (_, i) => [1, 3].map((b) => ({ t: 32 + i * 4 + b, d: 0.2, p: "C6", v: 0.5 }))).flat() });
    return t;
  }),
  fuller(WALTZ, 0.358, (t) => {
    t[1].gain = 0.2;
    return t;
  }),
  fuller(CHOPIN, 0.333, (t) => {
    t[1].gain = 0.2;
    return t;
  }),
  fuller(REFLECTION, 0.741, (t) => {
    t[1].gain = 0.22;
    t.push({
      inst: "strings",
      gain: 0.15,
      events: pad(32, 4, [
        ["A2", "E3", "C4"], ["D3", "A3", "F4"], ["G2", "D3", "B3"], ["C3", "G3", "E4"],
        ["F2", "C3", "A3"], ["E2", "B2", "G#3"], ["A2", "E3", "C4"],
      ], 0.3),
    });
    return t;
  }),
];

export const PIECES: Piece[] = [
  BIRTHDAY_FULL,
  CANON_FULL,
  ODE,
  JASMINE,
  FESTIVE_FULL,
  WALTZ_FULL,
  AISI,
  CHOPIN_FULL,
  TAPS,
  REFLECTION_FULL,
];

export function pieceById(id: string | null | undefined): Piece | undefined {
  return PIECES.find((p) => p.id === id);
}

// --- Synthesis -----------------------------------------------------------

/**
 * Struck sound: up to `peak` in `attack`, then dies away (time constant `decay`); at `end` it's
 * damped to silence. The level at `end` is worked out here: reading `gain.value` would give
 * the parameter's value now, not at `end`, and jump back up there (a click after every note).
 */
function env(g: GainNode, t: number, peak: number, attack: number, decay: number, end: number) {
  const left = Math.max(0.0001, peak * Math.exp(-Math.max(0, end - t - attack) / decay));
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setTargetAtTime(0.0001, t + attack, decay);
  g.gain.setValueAtTime(left, end);
  g.gain.linearRampToValueAtTime(0.0001, end + 0.08);
}

function osc(ctx: BaseAudioContext, type: OscillatorType, f: number, t: number, stop: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.start(t);
  o.stop(stop);
  return o;
}

function noise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.max(1, Math.round(ctx.sampleRate * seconds)), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/** One note of an instrument into `out`. */
function voice(ctx: BaseAudioContext, out: AudioNode, inst: Instrument, f: number, t: number, dur: number, vel: number) {
  const partials = (list: [number, number, number][], tail: number, attack = 0.005) => {
    for (const [ratio, amp, decay] of list) {
      const o = osc(ctx, "sine", f * ratio, t, t + tail + 0.1);
      const g = ctx.createGain();
      env(g, t, amp * vel, attack, decay, t + tail);
      o.connect(g).connect(out);
    }
  };
  switch (inst) {
    case "musicbox":
      partials([[1, 0.5, 0.6], [2, 0.14, 0.3], [3, 0.05, 0.2], [4.2, 0.04, 0.12]], 2.2);
      break;
    case "celesta":
      // Like a music box but with only in-tune overtones, so it never clashes with chords.
      partials([[1, 0.4, 0.8], [2, 0.12, 0.4], [4, 0.04, 0.2]], 2.6);
      break;
    case "piano": {
      const d = Math.min(2.2, Math.max(0.5, 1.4 * (440 / f) ** 0.35));
      const end = t + Math.max(dur, 0.2) + 0.25;
      partials([[1, 0.42, d], [2, 0.18, d * 0.6], [3, 0.09, d * 0.4], [4, 0.04, d * 0.3], [5, 0.02, d * 0.2]], end - t, 0.006);
      break;
    }
    case "pluck": {
      const o = osc(ctx, "triangle", f * 1.006, t, t + 1.8);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.04);
      const g = ctx.createGain();
      env(g, t, 0.45 * vel, 0.003, 0.35, t + 1.6);
      o.connect(g).connect(out);
      partials([[2, 0.08, 0.15]], 1);
      break;
    }
    case "bell":
      partials([[1, 0.3, 1.4], [2, 0.18, 1], [2.76, 0.14, 0.7], [5.4, 0.08, 0.35], [8.93, 0.04, 0.2]], 4);
      break;
    case "gong": {
      partials([[1, 0.5, 2.2], [1.48, 0.25, 1.6], [2.1, 0.18, 1.1], [2.8, 0.1, 0.8]], 6, 0.02);
      const n = ctx.createBufferSource();
      n.buffer = noise(ctx, 0.4);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 500;
      const g = ctx.createGain();
      env(g, t, 0.05 * vel, 0.01, 0.08, t + 0.35);
      n.connect(lp).connect(g).connect(out);
      n.start(t);
      break;
    }
    case "wood": {
      const o = osc(ctx, "sine", 1100, t, t + 0.12);
      const g = ctx.createGain();
      env(g, t, 0.3 * vel, 0.004, 0.03, t + 0.1);
      o.connect(g).connect(out);
      break;
    }
    case "brass":
    case "strings":
    case "erhu": {
      const end = t + dur;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      const g = ctx.createGain();
      const attack = inst === "brass" ? 0.05 : inst === "strings" ? 0.35 : 0.12;
      const release = inst === "brass" ? 0.12 : 0.5;
      const peak = (inst === "strings" ? 0.12 : 0.2) * vel;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.setValueAtTime(peak * 0.85, Math.max(t + attack, end - 0.02));
      g.gain.linearRampToValueAtTime(0.0001, end + release);
      lp.frequency.setValueAtTime(inst === "brass" ? 900 : 1600, t);
      if (inst === "brass") lp.frequency.linearRampToValueAtTime(2600, t + 0.08);
      lp.connect(g).connect(out);
      const detunes = inst === "strings" ? [-7, 7] : [0];
      for (const c of detunes) {
        const o = osc(ctx, "sawtooth", f, t, end + release + 0.05);
        o.detune.value = c;
        if (inst === "erhu") {
          // Slides into the note and sings with vibrato.
          o.frequency.setValueAtTime(f * 0.97, t);
          o.frequency.linearRampToValueAtTime(f, t + 0.1);
        }
        if (inst !== "strings") {
          const lfo = osc(ctx, "sine", inst === "erhu" ? 6 : 5, t, end + release);
          const depth = ctx.createGain();
          depth.gain.setValueAtTime(0, t);
          depth.gain.linearRampToValueAtTime(f * (inst === "erhu" ? 0.012 : 0.004), t + 0.4);
          lfo.connect(depth).connect(o.frequency);
        }
        o.connect(lp);
      }
      break;
    }
    case "flute":
    case "xiao": {
      const end = t + dur;
      const g = ctx.createGain();
      const peak = 0.3 * vel;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.08);
      g.gain.setValueAtTime(peak * 0.9, Math.max(t + 0.08, end - 0.02));
      g.gain.linearRampToValueAtTime(0.0001, end + 0.15);
      const o = osc(ctx, "sine", f, t, end + 0.2);
      if (inst === "flute") {
        const o2 = osc(ctx, "triangle", f * 2, t, end + 0.2);
        const g2 = ctx.createGain();
        g2.gain.value = 0.12;
        o2.connect(g2).connect(g);
      }
      const lfo = osc(ctx, "sine", 5.2, t, end + 0.2);
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(f * 0.006, t + 0.35);
      lfo.connect(depth).connect(o.frequency);
      o.connect(g);
      // Breath.
      const n = ctx.createBufferSource();
      n.buffer = noise(ctx, dur + 0.2);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f * 2;
      bp.Q.value = 1.5;
      const ng = ctx.createGain();
      ng.gain.value = inst === "xiao" ? 0.12 : 0.06;
      n.connect(bp).connect(ng).connect(g);
      n.start(t);
      g.connect(out);
      break;
    }
  }
}

function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.round(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(ctx.destination.channelCount >= 2 ? 2 : 1, len, ctx.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  }
  return b;
}

/**
 * Plays `piece` from `start` (context time) for `seconds` (repeating; the piece's length
 * divides 60), fading out over the last 2 s. Returns the node to disconnect to stop early.
 */
export function playPiece(ctx: BaseAudioContext, piece: Piece, start: number, seconds: number, volume: number): GainNode {
  const master = ctx.createGain();
  const level = volume * piece.level;
  master.gain.setValueAtTime(level, start);
  master.gain.setValueAtTime(level, start + Math.max(0, seconds - 2));
  master.gain.linearRampToValueAtTime(0.0001, start + seconds);
  // A limiter, so no piece ever clips.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;
  master.connect(limiter).connect(ctx.destination);
  const dry = ctx.createGain();
  dry.gain.value = 1 - piece.reverb * 0.5;
  const wet = ctx.createGain();
  wet.gain.value = piece.reverb;
  const verb = ctx.createConvolver();
  verb.buffer = impulse(ctx, 2.6);
  dry.connect(master);
  verb.connect(wet).connect(master);
  const bus = ctx.createGain();
  bus.connect(dry);
  bus.connect(verb);
  const spb = piece.seconds / piece.beats;
  for (let rep = 0; rep * piece.seconds < seconds; rep++) {
    const t0 = start + rep * piece.seconds;
    for (const track of piece.tracks) {
      const tg = ctx.createGain();
      tg.gain.value = track.gain;
      tg.connect(bus);
      for (const e of track.events) {
        const t = t0 + e.t * spb;
        if (t >= start + seconds) continue;
        const v = e.v * (1 + (piece.swell ?? 0) * (e.t / piece.beats));
        for (const p of Array.isArray(e.p) ? e.p : [e.p]) voice(ctx, tg, track.inst, freq(p), t, e.d * spb, v);
      }
    }
  }
  return master;
}
