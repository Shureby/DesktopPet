import product from "../../product.config.json";
import type { Rect, WindowRect } from "../engine/geometry";
import type { RingtoneId } from "../pet/sound";
import { DEFAULT_MODES, modeSettings, type ModeSettings } from "../features/modes/modes";

export interface PomodoroConfig {
  focusMin: number;
  shortBreakMin: number;
  longBreakMin: number;
  roundsBeforeLong: number;
  /** Start the next focus/break automatically. */
  autoContinue: boolean;
  /** Work days and hours: starts by itself, no new focus after the end (docs/INTERACTIONS.md). */
  workHours: WorkHours;
  /** During a focus, playing a game asks first. */
  holdGames: boolean;
  /** What plays when a focus starts and when a break starts (each may be off). */
  sounds: FocusSounds;
}

/** A focus-session sound: "fieldPhone" (src/pet/sound.ts), any ringtone, or none. */
export type FocusTone = "fieldPhone" | "classic" | "chime" | "digital" | "gentle" | "marimba" | "rooster" | "trill" | "off";

export interface FocusSounds {
  focus: FocusTone;
  break: FocusTone;
  /** 0–1. */
  volume: number;
}

/** Days of the week as bits, Sunday = bit 0 … Saturday = bit 6 (like Date.getDay()). */
export type DayMask = number;
export const EVERY_DAY: DayMask = 0b111_1111;
export const WEEKDAYS: DayMask = 0b011_1110;

export interface WorkHours {
  enabled: boolean;
  days: DayMask;
  /** "HH:MM"; an end at or before the start is the next day. */
  start: string;
  end: string;
}

/** How the pet announces one kind of reminder. */
export interface AlertSettings {
  /** Pet runs to the middle of the screen (otherwise it just perks up where it is). */
  petRuns: boolean;
  ring: boolean;
  ringtone: RingtoneId;
  /** 0..1 */
  volume: number;
  /** How long an alarm rings before it counts as unanswered. */
  ringSeconds: number;
  /** Length of a snooze (the button and automatic snoozes). */
  snoozeMinutes: number;
  /** Automatic snoozes when nobody answers an alarm; 0 = just stop and mark it missed. Timers never auto-snooze. */
  autoSnoozeMax: number;
}

export interface Settings {
  character: string;
  /** Pet size multiplier. */
  size: number;
  /** Pet speed multiplier. */
  speed: number;
  /** Small UI sounds: petting (focus sessions have their own, `pomodoro.sounds`). */
  sound: boolean;
  alerts: { alarm: AlertSettings; todo: AlertSettings };
  /** Custom timer lengths in minutes, most recent first (at most three). */
  recentTimers: number[];
  /** Before 0.37.0; now Quiet slots in `modes` (kept only to read old settings). */
  quietHours: { enabled: boolean; start: string; end: string };
  /** Reminder modes and their weekly schedule (src/features/modes/modes.ts). */
  modes: ModeSettings;
  hiddenAlerts: HiddenAlerts;
  /** A 🔔 badge by the pet for alarms ringing within `minutes` (1–120). */
  upcomingAlarms: { show: boolean; minutes: number };
  /** "HH:MM": when to-dos without a time remind you on their day. */
  todoDayTime: string;
  /**
   * Anniversaries on screen (fireworks, or a remembrance's candle) and for how long (10–60 s);
   * music with it (off by default) and its volume (0–1).
   */
  celebrate: { enabled: boolean; seconds: number; music: boolean; musicVolume: number };
  pomodoro: PomodoroConfig;
  autostart: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  character: product.defaultCharacter,
  size: 1,
  speed: 1,
  sound: true,
  alerts: {
    alarm: { petRuns: true, ring: true, ringtone: "classic", volume: 0.7, ringSeconds: 60, snoozeMinutes: 5, autoSnoozeMax: 3 },
    todo: { petRuns: true, ring: true, ringtone: "chime", volume: 0.5, ringSeconds: 60, snoozeMinutes: 10, autoSnoozeMax: 0 },
  },
  recentTimers: [],
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  modes: DEFAULT_MODES,
  hiddenAlerts: { alarms: true, timers: true, todos: true, focus: false, anniversaries: true },
  upcomingAlarms: { show: true, minutes: 60 },
  todoDayTime: "09:00",
  celebrate: { enabled: true, seconds: 15, music: false, musicVolume: 0.5 },
  pomodoro: {
    focusMin: 25,
    shortBreakMin: 5,
    longBreakMin: 15,
    roundsBeforeLong: 4,
    autoContinue: true,
    workHours: { enabled: false, days: WEEKDAYS, start: "09:00", end: "17:30" },
    holdGames: true,
    sounds: { focus: "fieldPhone", break: "trill", volume: 0.5 },
  },
  autostart: false,
};

/** The 🔔 badge's look-ahead: whole minutes, 1–120 (60 if it isn't a number). */
export function clampUpcomingMinutes(m: unknown): number {
  const n = Math.round(Number(m));
  return Number.isFinite(n) ? Math.min(120, Math.max(1, n)) : DEFAULT_SETTINGS.upcomingAlarms.minutes;
}

const FOCUS_TONES: FocusTone[] = ["fieldPhone", "classic", "chime", "digital", "gentle", "marimba", "rooster", "trill", "off"];

/**
 * The focus sounds as stored, or for settings from before 0.36.0: "Other sounds" off (it
 * covered focus sessions then) keeps them silent.
 */
function focusSounds(s: Partial<Settings>): FocusSounds {
  const d = DEFAULT_SETTINGS.pomodoro.sounds;
  const stored = s.pomodoro?.sounds;
  if (!stored) return s.sound === false ? { ...d, focus: "off", break: "off" } : { ...d };
  const tone = (t: unknown, fallback: FocusTone) => (FOCUS_TONES.includes(t as FocusTone) ? (t as FocusTone) : fallback);
  const vol = Number(stored.volume);
  return {
    focus: tone(stored.focus, d.focus),
    break: tone(stored.break, d.break),
    volume: Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : d.volume,
  };
}

/** Fills in defaults for settings saved by older versions (nested objects merge too). */
export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const s = stored ?? {};
  const d = DEFAULT_SETTINGS;
  return {
    ...d,
    ...s,
    quietHours: { ...d.quietHours, ...s.quietHours },
    modes: modeSettings(s.modes, s),
    hiddenAlerts: { ...d.hiddenAlerts, ...s.hiddenAlerts },
    recentTimers: Array.isArray(s.recentTimers) ? s.recentTimers.filter((m) => typeof m === "number" && m > 0).slice(0, 3) : [],
    upcomingAlarms: (() => {
      const u = { ...d.upcomingAlarms, ...s.upcomingAlarms };
      return { show: u.show !== false, minutes: clampUpcomingMinutes(u.minutes) };
    })(),
    celebrate: (() => {
      const c = { ...d.celebrate, ...s.celebrate };
      const seconds = Math.round(Number(c.seconds));
      const vol = Number(c.musicVolume);
      return {
        enabled: c.enabled !== false,
        seconds: Number.isFinite(seconds) ? Math.min(60, Math.max(10, seconds)) : 15,
        music: c.music === true,
        musicVolume: Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : d.celebrate.musicVolume,
      };
    })(),
    todoDayTime: typeof s.todoDayTime === "string" && /^\d{2}:\d{2}$/.test(s.todoDayTime) ? s.todoDayTime : d.todoDayTime,
    pomodoro: {
      ...d.pomodoro,
      ...s.pomodoro,
      workHours: { ...d.pomodoro.workHours, ...s.pomodoro?.workHours },
      sounds: focusSounds(s),
    },
    alerts: {
      alarm: { ...d.alerts.alarm, ...s.alerts?.alarm },
      todo: { ...d.alerts.todo, ...s.alerts?.todo },
    },
  };
}

export interface Todo {
  id: number;
  title: string;
  /** Unix ms, or null for no reminder. */
  dueAt: number | null;
  done: boolean;
  createdAt: number;
  /** When it was ticked off (null while open). */
  doneAt: number | null;
  /**
   * Due on a day, not at a time: `dueAt` is that day's local midnight. It reminds at
   * `Settings.todoDayTime` and is overdue only from the next day.
   */
  allDay: boolean;
  repeat: TodoRepeat;
}

/** How a to-do comes back after it's ticked off (counted from its first date). */
export type TodoRepeat = "none" | "daily" | "weekly" | "fortnightly" | "monthly" | "quarterly" | "yearly";

/** A new to-do from the panel's form. */
export interface NewTodo {
  title: string;
  dueAt: number | null;
  allDay?: boolean;
  repeat?: TodoRepeat;
}

/** Changes to a to-do. `remindAt` is "Later" on a day's to-do: remind again then, same day. */
export type TodoPatch = Partial<Pick<Todo, "title" | "dueAt" | "done" | "allDay" | "repeat">> & { remindAt?: number };

/** "days": the days in `Alarm.repeatDays` (e.g. Mon, Wed, Fri). */
export type Repeat = "none" | "daily" | "weekdays" | "days";

/** The days an alarm rings on (0 for a one-off); `days` is used for "days". */
export function repeatMask(repeat: Repeat, days: DayMask): DayMask {
  return repeat === "daily" ? EVERY_DAY : repeat === "weekdays" ? WEEKDAYS : repeat === "days" ? days & EVERY_DAY : 0;
}

export interface Alarm {
  id: number;
  label: string;
  /** Next time it rings (unix ms), or null when disabled. */
  nextFire: number | null;
  /** "HH:MM" local time for repeating alarms. */
  timeHm: string | null;
  repeat: Repeat;
  enabled: boolean;
  /** Snoozes in the current ringing cycle. */
  snoozes: number;
  /** When it was marked missed (nobody answered, after its auto-snoozes). Kept in the history. */
  missedAt: number | null;
  /** When the user saw it was missed (clicked its badge); the badge only shows unseen ones. */
  missedSeenAt: number | null;
  /** The ring a repeating alarm skips ("Skip once"); it rings again at the one after. */
  skippedFire: number | null;
  /**
   * When the current ringing cycle began: the alarm's own time, not a later snoozed ring.
   * Finished one-offs lose `nextFire`, so this is what they show.
   */
  rangAt: number | null;
  /** When it was set (null for alarms saved before 0.14.0). Timers show "started 4:29 pm". */
  createdAt: number | null;
  /** The days a "days" alarm rings on (0 otherwise). */
  repeatDays: DayMask;
  /** It came due while ePet wasn't running and didn't ring (the time it was due). Not missed. */
  offAt?: number | null;
}

export type PomodoroPhase = "idle" | "focus" | "short_break" | "long_break";

export interface PomodoroStatus {
  phase: PomodoroPhase;
  /** Focus sessions completed in the current cycle. */
  round: number;
  endsAt: number | null;
  /** When this run of focus/break cycles began (work hours stop it at the next end of work). */
  runStartedAt?: number | null;
}

export interface DayStat {
  day: string;
  completed: number;
  focusMinutes: number;
}

export interface Score {
  game: string;
  character: string;
  score: number;
  at: number;
}

export interface DesktopSnapshot {
  areas: Rect[];
  windows: WindowRect[];
  /** Display scale factor of the monitor the pet is on. */
  scale: number;
}

export interface ReminderEvent {
  kind: "todo" | "alarm";
  id: number;
  title: string;
  /** The pet is hidden and was brought out just for this (docs/INTERACTIONS.md). */
  peek?: boolean;
  /** A to-do without a time ("Today: …"); several are told in one bubble. */
  allDay?: boolean;
}

/** A day to remember every year (docs/INTERACTIONS.md, "Anniversaries"). */
export interface Anniversary {
  id: number;
  /** The template it was made from (src/features/anniversary/templates.ts). */
  kind: string;
  icon: string;
  name: string;
  month: number;
  day: number;
  /** The year it began, for "36th". */
  since: number | null;
  preps: AnniversaryPrep[];
  /** Fireworks (a remembrance: a candle and flowers) on the day. */
  effect: boolean;
  /** The piece played on the day (src/celebrate/music.ts); null: the type's default. */
  music: string | null;
  createdAt: number;
}

/** "1 day before: Order a cake"; `lead` is "1d", "2d", "3d", "1w", "2w" or "1m". */
export interface AnniversaryPrep {
  lead: string;
  label: string;
}

export type NewAnniversary = Omit<Anniversary, "id" | "createdAt">;

/** Today is an anniversary: the pet celebrates (and the app may play the effect). */
export interface Celebration {
  anniversary: Anniversary;
  years: number | null;
  /** Play the fireworks / candle on screen. */
  effect: boolean;
  seconds: number;
  /** The pet is hidden and came out just for this. */
  peek?: boolean;
  /** "▶ Preview": it can be stopped, and a new one replaces it. */
  preview?: boolean;
}

/** "While I was hidden you missed…": something the hidden pet rang that nobody answered. */
export interface Unseen {
  id: number;
  kind: "alarm" | "timer" | "todo";
  /** The alarm, timer or to-do. */
  refId: number;
  title: string;
  /** When it was due (an alarm's own time, a timer's end, a to-do's reminder time). */
  at: number;
  snoozes: number;
}

/** Settings → Alerts → "When your pet is hidden, it comes out for…". */
export interface HiddenAlerts {
  alarms: boolean;
  timers: boolean;
  todos: boolean;
  /** When a focus session or break ends. */
  focus: boolean;
  /** An anniversary's celebration (the hidden pet otherwise waits until it's shown). */
  anniversaries: boolean;
}

export type PanelTab = "todos" | "alarms" | "focus" | "modes" | "characters" | "games" | "settings";

export interface BackendEvents {
  reminder: ReminderEvent;
  pomodoro: PomodoroStatus;
  settings: Settings;
  "todos-changed": null;
  "alarms-changed": null;
  "anniversaries-changed": null;
  /** Characters were copied or reloaded: read them again. */
  "characters-changed": null;
  /** Today is an anniversary (once a day, the first time you're at the computer). */
  celebrate: Celebration;
  game: { state: "started" | "ended"; game: string };
  "panel-tab": PanelTab;
  "pet-command": "show" | "hide" | "greet";
  /** The pet was shown or hidden (from its menu, the tray, …). */
  "pet-visibility": boolean;
  /** The hidden pet was brought out for a focus session or break ending. */
  "pet-peek": "focus";
  /** Mood saved for a character (the panel shows it). */
  mood: { character: string; mood: unknown };
  /** Something the user did elsewhere that the pet reacts to. */
  "pet-event": PetActivity;
  /** The test clock was set ahead: how far, in ms (test builds and end-to-end tests). */
  "clock-shift": number;
  /** A preview started playing (true) or is over (false): "▶ Preview" turns into "■ Stop". */
  "preview-playing": boolean;
  /** "■ Stop": the pet ends the preview now. */
  "preview-stop": null;
}

/** The test clock (src/platform/testClock.ts): how far ahead, and whether the tray offers it. */
export interface TestClock {
  shift: number;
  inTray: boolean;
}

/** What a backup holds (Settings → Backup shows it before restoring). */
export interface BackupSummary {
  appVersion: string;
  madeAt: number;
  device: { name: string; os: string };
  alarms: number;
  timers: number;
  todos: number;
  anniversaries: number;
  characters: number;
}

export interface BackupOpened {
  status: "ok" | "cancelled" | "needsPassword" | "wrongPassword";
  path: string | null;
  summary: BackupSummary | null;
}

/** What to restore. Timers are never restored (they belong to the computer they were set on). */
export interface RestoreParts {
  schedule: boolean;
  settings: boolean;
  pet: boolean;
  characters: boolean;
}

/** A backup ePet made itself: daily ("auto", the last 7) or before a restore. */
export interface SavedBackup {
  path: string;
  kind: "auto" | "beforeRestore";
  madeAt: number;
  size: number;
}

export type PetActivity =
  | { type: "todoAdded"; title: string; dueAt: number | null; allDay?: boolean }
  | { type: "todoDone" }
  | { type: "game"; won: boolean };

export interface UserCharacterFile {
  dir: string;
  json: string;
}

/** Everything the UI needs from the host. Implemented by Tauri and by an in-browser mock. */
export interface Backend {
  readonly kind: "tauri" | "mock";
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;

  listTodos(): Promise<Todo[]>;
  addTodo(todo: NewTodo): Promise<Todo>;
  /** Ticking off a repeating to-do logs this time as done and moves it on to its next day. */
  updateTodo(id: number, patch: TodoPatch): Promise<void>;
  deleteTodo(id: number): Promise<void>;
  /** Removes all ticked-off to-dos; returns how many. */
  clearDoneTodos(): Promise<number>;

  listAnniversaries(): Promise<Anniversary[]>;
  addAnniversary(a: NewAnniversary): Promise<Anniversary>;
  updateAnniversary(id: number, a: NewAnniversary): Promise<Anniversary>;
  /** The to-dos its reminders already made stay. */
  deleteAnniversary(id: number): Promise<void>;
  /** "▶ Preview": its day's celebration now (words and effect), marking nothing. */
  previewCelebration(a: NewAnniversary): Promise<void>;
  /** The pet plays a celebration: the app opens its effect's window over the pet's screen. */
  showCelebration(celebration: Celebration): Promise<void>;
  /** A preview stopped: its effect's window goes at once. */
  closeCelebration(): Promise<void>;

  listAlarms(): Promise<Alarm[]>;
  /** `days` is for repeat "days". */
  addAlarm(label: string, at: number, repeat: Repeat, days?: DayMask): Promise<Alarm>;
  /** Editing (✎): set again with a new label, time and repeat; it switches on. */
  updateAlarm(id: number, label: string, at: number, repeat: Repeat, days?: DayMask): Promise<Alarm>;
  setAlarmEnabled(id: number, enabled: boolean): Promise<void>;
  /** Repeating alarms: skip the next ring (or the rest of today's snoozes). */
  skipAlarmOnce(id: number): Promise<void>;
  /** Undo "Skip once": ring at the next regular time again. */
  unskipAlarm(id: number): Promise<void>;
  deleteAlarm(id: number): Promise<void>;
  /** Removes one-shot alarms and timers that already rang; returns how many. */
  clearFinishedAlarms(): Promise<number>;
  snoozeAlarm(id: number, minutes: number): Promise<void>;
  /**
   * "Done": ends the ringing/snooze cycle. One-offs and timers stay in the history (Finished);
   * repeating alarms go back to their schedule. Counts as having seen a missed alarm.
   */
  dismissAlarm(id: number): Promise<void>;
  /** Nobody answered: it stays missed (also sends an OS notification showing `name`). */
  markAlarmMissed(id: number): Promise<void>;
  /** The hidden pet rang something nobody answered (shown when the pet is shown again). */
  recordUnseen(item: Omit<Unseen, "id">): Promise<void>;
  listUnseen(): Promise<Unseen[]>;
  /** "Done" on the list; missed alarms in it count as seen. */
  clearUnseen(): Promise<void>;
  /** The pet listens for reminders now: until then the app takes nothing due (a slow start would lose it). */
  petReady(): Promise<void>;
  /** The test clock, or null in a release (test builds and end-to-end tests only). */
  testClock(): Promise<TestClock | null>;
  /** Sets the test clock `ms` ahead (or back, not before now); returns how far ahead it is. */
  shiftClock(ms: number): Promise<number>;
  /** The hidden pet has answered its reminder and walked off: hide it again. */
  endPeek(): Promise<void>;
  /** A debug build started for the end-to-end tests: the windows offer test hooks (e2e/). */
  e2eEnabled(): Promise<boolean>;
  /**
   * "Export backup…": asks where to save it (end-to-end tests may pass `path`), encrypted if
   * a password is given. Returns where it was saved, or null if cancelled.
   */
  backupExport(password: string | null, path?: string): Promise<string | null>;
  /** Reads a backup to restore (asks which, unless `path`); kept until restored. */
  backupOpen(path: string | null, password: string | null): Promise<BackupOpened>;
  /**
   * Restores the parts of the backup last opened, after backing this computer up; then ePet
   * starts again (end-to-end tests pass `restart: false`).
   */
  backupRestore(parts: RestoreParts, mode: "merge" | "replace", restart?: boolean): Promise<void>;
  /** The backups ePet made itself, newest first. */
  backupListAuto(): Promise<SavedBackup[]>;
  /** End-to-end tests only: a tray item the app handles itself ("show", "hide", "quit"). */
  e2eTray(id: string): Promise<void>;
  /** The user saw a missed alarm (clicked its badge): the badge goes, the history keeps it. */
  acknowledgeMissed(id: number): Promise<void>;

  pomodoroStart(): Promise<PomodoroStatus>;
  pomodoroSkip(): Promise<PomodoroStatus>;
  pomodoroStop(): Promise<PomodoroStatus>;
  pomodoroStatus(): Promise<PomodoroStatus>;
  pomodoroStats(days: number): Promise<DayStat[]>;

  recordScore(game: string, character: string, score: number): Promise<void>;
  topScores(game: string, limit: number): Promise<Score[]>;
  unlockAchievement(id: string): Promise<void>;
  /** "steam", "epic", "direct" (website) or "browser" (mock). */
  storefront(): Promise<string>;

  desktopSnapshot(): Promise<DesktopSnapshot>;
  /** Positions and sizes the pet window (physical px) and returns the cursor position. */
  petFrame(x: number, y: number, w: number, h: number, ignoreCursor: boolean): Promise<{ x: number; y: number } | null>;
  listUserCharacters(): Promise<UserCharacterFile[]>;
  /** Saved mood for a character (null if never saved). Parse with `parseMood`. */
  loadMood(character: string): Promise<unknown>;
  saveMood(character: string, mood: unknown): Promise<void>;
  /** Opens the folder where users drop their own characters. */
  openUserCharactersFolder(): Promise<void>;
  /**
   * "Make a copy": writes `json` into a new folder in the characters folder (with a user
   * character's images from `sourceDir`), opens it and reloads characters. Returns the folder.
   */
  copyCharacter(json: string, sourceDir: string | null): Promise<string>;
  /** Every window reads the characters again ("characters-changed"). */
  reloadCharacters(): Promise<void>;
  assetUrl(path: string): string;

  openPanel(tab?: PanelTab): Promise<void>;
  openGame(game: string): Promise<void>;
  closeGame(): Promise<void>;
  /** Shows or hides the pet window and announces it ("pet-visibility"). */
  setPetVisible(visible: boolean): Promise<void>;
  setAutostart(enabled: boolean): Promise<void>;

  on<K extends keyof BackendEvents>(event: K, cb: (payload: BackendEvents[K]) => void): Promise<() => void>;
  emit<K extends keyof BackendEvents>(event: K, payload: BackendEvents[K]): Promise<void>;
}
