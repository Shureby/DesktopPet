/**
 * Reminder modes (docs/INTERACTIONS.md, "Modes"): how loud and lively the pet is right now.
 * Lively, Normal, Work and Quiet each change a few things (`ModePreset`); Auto follows a
 * weekly schedule of time slots, one table for work days and one for days off. A mode
 * picked by hand, or "Quiet for 1 hour", comes before the schedule.
 *
 * Pure functions on the settings and a date, so they can be tested without the app.
 */
import type { DayMask } from "../../platform/types";

export type ModeId = "lively" | "normal" | "work" | "quiet";
export type ModeChoice = "auto" | ModeId;
/** In this order everywhere (menus, lists, the table): from your settings as they are to the quietest. */
export const MODE_IDS: ModeId[] = ["normal", "lively", "work", "quiet"];

export const MODE_NAMES: Record<ModeId, string> = { lively: "Lively", normal: "Normal", work: "Work", quiet: "Quiet" };
export const MODE_ICONS: Record<ModeId, string> = { lively: "✨", normal: "🙂", work: "👔", quiet: "🌙" };

/** "HH:MM" to "HH:MM" (an end at or before the start is the next day) in one mode. */
export interface ModeSlot {
  start: string;
  end: string;
  mode: ModeId;
}

/** What a mode changes; Normal changes nothing. */
export interface ModePreset {
  /** Alarms, timers and to-do rings at this share of their own volume (0.25–1). */
  volume: number;
  /** Alarms and timers start at a quarter of that and rise to it over 30 seconds. */
  rampUp: boolean;
  /** Alarms ring at most this long (seconds); 0: as long as set. */
  ringSeconds: number;
  /** The pet may come to the middle for a reminder (if it's set to); off: it perks up where it is. */
  petRuns: boolean;
  /** To-do reminders ring (off: only the bubble). */
  todoRing: boolean;
  /** Anniversaries play now, or wait (a 🎉 badge) until the mode allows it. */
  celebrate: "play" | "postpone";
  /** Anniversaries play their music even when it's off in Settings. */
  music: boolean;
  /** The pet talks on its own now and then (bored, hungry…). */
  chatter: boolean;
  /** Petting sounds and the focus-session sounds. */
  sounds: boolean;
  /** The pet keeps calm: sits, sleeps, no running about. */
  calm: boolean;
}

export interface ModeSettings {
  choice: ModeChoice;
  /** A mode for a while ("Quiet for 1 hour"); Auto again after `until`. */
  override: { mode: ModeId; until: number } | null;
  /** Which days are work days (Sunday = bit 0, like Date.getDay()). */
  workDays: DayMask;
  workday: ModeSlot[];
  dayOff: ModeSlot[];
  /** "YYYY-MM-DD": that day counts as a day off ("Today is a day off"). */
  dayOffOn: string | null;
  /** "YYYY-MM-DD": every day up to and including it is a day off (a holiday). */
  holidayUntil: string | null;
  presets: Record<ModeId, ModePreset>;
  /** The pet has said once what modes are ("New: modes!…"). */
  introduced: boolean;
}

const PLAIN: ModePreset = {
  volume: 1,
  rampUp: false,
  ringSeconds: 0,
  petRuns: true,
  todoRing: true,
  celebrate: "play",
  music: false,
  chatter: true,
  sounds: true,
  calm: false,
};

export const DEFAULT_PRESETS: Record<ModeId, ModePreset> = {
  lively: { ...PLAIN, music: true },
  normal: PLAIN,
  work: { ...PLAIN, volume: 0.5, ringSeconds: 15, petRuns: false, celebrate: "postpone", chatter: false, sounds: false },
  quiet: { ...PLAIN, rampUp: true, petRuns: false, todoRing: false, celebrate: "postpone", chatter: false, sounds: false, calm: true },
};

export const DEFAULT_WORKDAY: ModeSlot[] = [
  { start: "22:00", end: "07:00", mode: "quiet" },
  { start: "09:00", end: "17:30", mode: "work" },
];
export const DEFAULT_DAY_OFF: ModeSlot[] = [{ start: "23:00", end: "08:00", mode: "quiet" }];

export const DEFAULT_MODES: ModeSettings = {
  choice: "auto",
  override: null,
  workDays: 0b011_1110,
  workday: DEFAULT_WORKDAY,
  dayOff: DEFAULT_DAY_OFF,
  dayOffOn: null,
  holidayUntil: null,
  presets: DEFAULT_PRESETS,
  introduced: false,
};

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isMode = (m: unknown): m is ModeId => MODE_IDS.includes(m as ModeId);

/** What older settings had: Quiet hours, and the Focus tab's work hours. */
interface Legacy {
  quietHours?: { enabled?: boolean; start?: string; end?: string };
  pomodoro?: { workHours?: { enabled?: boolean; days?: number; start?: string; end?: string } };
}

/**
 * The modes as stored, made whole; for settings from before 0.37.0, from what they had:
 * Quiet hours become Quiet slots (both tables) and the Focus tab's work hours a Work slot on
 * its days. With neither on, the default schedule.
 */
export function modeSettings(stored: unknown, legacy: Legacy = {}): ModeSettings {
  const d = DEFAULT_MODES;
  if (!stored || typeof stored !== "object") {
    const q = legacy.quietHours;
    const w = legacy.pomodoro?.workHours;
    const quiet = q?.enabled && HM.test(q.start ?? "") && HM.test(q.end ?? "") ? [{ start: q.start!, end: q.end!, mode: "quiet" as const }] : [];
    const work = w?.enabled && HM.test(w.start ?? "") && HM.test(w.end ?? "") ? [{ start: w.start!, end: w.end!, mode: "work" as const }] : [];
    if (!quiet.length && !work.length) return structuredClone(d);
    return {
      ...structuredClone(d),
      workDays: w?.enabled && typeof w.days === "number" ? w.days & 0x7f : d.workDays,
      workday: [...quiet, ...work],
      dayOff: [...quiet],
    };
  }
  const s = stored as Partial<ModeSettings>;
  const slots = (list: unknown, fallback: ModeSlot[]): ModeSlot[] =>
    Array.isArray(list)
      ? list.filter((x): x is ModeSlot => !!x && HM.test(x.start) && HM.test(x.end) && isMode(x.mode)).map((x) => ({ start: x.start, end: x.end, mode: x.mode }))
      : structuredClone(fallback);
  const o = s.override;
  const presets = {} as Record<ModeId, ModePreset>;
  for (const id of MODE_IDS) presets[id] = preset(s.presets?.[id], d.presets[id]);
  return {
    choice: s.choice === "auto" || isMode(s.choice) ? s.choice : d.choice,
    override: o && isMode(o.mode) && Number.isFinite(o.until) ? { mode: o.mode, until: o.until } : null,
    workDays: typeof s.workDays === "number" ? s.workDays & 0x7f : d.workDays,
    workday: slots(s.workday, d.workday),
    dayOff: slots(s.dayOff, d.dayOff),
    dayOffOn: typeof s.dayOffOn === "string" && DATE.test(s.dayOffOn) ? s.dayOffOn : null,
    holidayUntil: typeof s.holidayUntil === "string" && DATE.test(s.holidayUntil) ? s.holidayUntil : null,
    presets,
    introduced: s.introduced === true,
  };
}

function preset(stored: Partial<ModePreset> | undefined, d: ModePreset): ModePreset {
  const p = { ...d, ...stored };
  const vol = Number(p.volume);
  const secs = Math.round(Number(p.ringSeconds));
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    volume: Number.isFinite(vol) ? Math.min(1, Math.max(0.25, vol)) : d.volume,
    rampUp: bool(p.rampUp, d.rampUp),
    ringSeconds: Number.isFinite(secs) ? Math.min(600, Math.max(0, secs)) : d.ringSeconds,
    petRuns: bool(p.petRuns, d.petRuns),
    todoRing: bool(p.todoRing, d.todoRing),
    celebrate: p.celebrate === "postpone" ? "postpone" : "play",
    music: bool(p.music, d.music),
    chatter: bool(p.chatter, d.chatter),
    sounds: bool(p.sounds, d.sounds),
    calm: bool(p.calm, d.calm),
  };
}

/** "YYYY-MM-DD" for a local date. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const minutes = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};

/** Whether `day` (local midnight) uses the days-off table. */
export function isDayOff(m: ModeSettings, day: Date): boolean {
  const key = dayKey(day);
  if (m.dayOffOn === key) return true;
  if (m.holidayUntil && key <= m.holidayUntil) return true;
  return !((m.workDays >> day.getDay()) & 1);
}

/** When several slots overlap, the quieter one wins. */
const RANK: Record<ModeId, number> = { quiet: 3, work: 2, lively: 1, normal: 0 };

/** The schedule's mode at `now` (Normal where no slot covers it). */
export function scheduledMode(m: ModeSettings, now: Date): ModeId {
  const t = now.getHours() * 60 + now.getMinutes();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const table = (day: Date) => (isDayOff(m, day) ? m.dayOff : m.workday);
  let best: ModeId = "normal";
  const take = (mode: ModeId) => {
    if (RANK[mode] > RANK[best]) best = mode;
  };
  for (const s of table(today)) {
    const a = minutes(s.start);
    const b = minutes(s.end);
    if (a < b ? t >= a && t < b : t >= a) take(s.mode);
  }
  // A slot past midnight belongs to the day it starts on.
  for (const s of table(yesterday)) {
    const a = minutes(s.start);
    const b = minutes(s.end);
    if (a >= b && t < b) take(s.mode);
  }
  return best;
}

export interface ModeNow {
  mode: ModeId;
  /** Picked by hand, for a while ("Quiet for 1 hour"), from the schedule. */
  why: "manual" | "override" | "schedule";
  /** When it changes next (null: not by itself). */
  until: number | null;
}

/** The mode now and why: a mode picked by hand, then one for a while, then the schedule. */
export function modeNow(m: ModeSettings, now: Date): ModeNow {
  // A mode for a while (from the menu) goes over both the schedule and a mode picked for good.
  if (m.override && m.override.until > now.getTime()) return { mode: m.override.mode, why: "override", until: m.override.until };
  if (m.choice !== "auto") return { mode: m.choice, why: "manual", until: null };
  const mode = scheduledMode(m, now);
  return { mode, why: "schedule", until: nextChange(m, now, mode) };
}

/** What comes after a mode for a while runs out: Auto (the schedule) or the mode picked for good. */
export function baseMode(m: ModeSettings, now: Date): ModeNow {
  return modeNow({ ...m, override: null }, now);
}

/**
 * Until when a mode picked from the menu lasts: until what's underneath next changes (the
 * schedule's next slot), or the end of the day if nothing changes by itself.
 */
export function overrideUntil(m: ModeSettings, now: Date): number {
  return baseMode(m, now).until ?? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}

/**
 * "Quiet until tomorrow morning": when tomorrow's night ends on the schedule (the first
 * quarter hour after midnight that isn't Quiet), or 8:00 if the night isn't Quiet.
 */
export function tomorrowMorning(m: ModeSettings, now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  for (let q = 0; q < 16 * 4; q++) {
    const t = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), 0, q * 15);
    if (scheduledMode(m, t) !== "quiet") return q === 0 ? midnight.getTime() + 8 * 3_600_000 : t.getTime();
  }
  return midnight.getTime() + 8 * 3_600_000;
}

/** The next slot boundary (within two days) where the schedule's mode differs from `mode`. */
function nextChange(m: ModeSettings, now: Date, mode: ModeId): number | null {
  const times = new Set<number>();
  for (let day = -1; day <= 2; day++) {
    for (const s of [...m.workday, ...m.dayOff]) {
      for (const hm of [s.start, s.end]) {
        const [h, min] = hm.split(":").map(Number);
        const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, h, min).getTime();
        if (t > now.getTime()) times.add(t);
      }
    }
    // Days change at midnight (a work day after a day off).
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day).getTime();
    if (midnight > now.getTime()) times.add(midnight);
  }
  for (const t of [...times].sort((a, b) => a - b)) {
    if (scheduledMode(m, new Date(t)) !== mode) return t;
  }
  return null;
}

/** The preset in force for a mode. */
export function presetOf(m: ModeSettings, mode: ModeId): ModePreset {
  return m.presets[mode] ?? DEFAULT_PRESETS[mode];
}

/**
 * The Focus tab's work hours follow the Work slots on work days (one span: the earliest
 * start to the latest end), so the schedule is the one place to set them. None: unchanged.
 */
export function workSpan(m: ModeSettings): { days: DayMask; start: string; end: string } | null {
  const work = m.workday.filter((s) => s.mode === "work" && minutes(s.start) < minutes(s.end));
  if (!work.length) return null;
  const start = work.reduce((a, s) => (minutes(s.start) < minutes(a) ? s.start : a), work[0].start);
  const end = work.reduce((a, s) => (minutes(s.end) > minutes(a) ? s.end : a), work[0].end);
  return { days: m.workDays, start, end };
}

/** Volume at `t` seconds into a ring that ramps up: a quarter, rising to full at 30 s. */
export function rampVolume(volume: number, t: number): number {
  return volume * Math.min(1, 0.25 + (0.75 * Math.max(0, t)) / 30);
}
