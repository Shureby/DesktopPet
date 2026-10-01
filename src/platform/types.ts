import product from "../../product.config.json";
import type { Rect, WindowRect } from "../engine/geometry";
import type { RingtoneId } from "../pet/sound";

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
  /** Small UI sounds: petting, tomato-clock phase changes. */
  sound: boolean;
  alerts: { alarm: AlertSettings; todo: AlertSettings };
  /** Custom timer lengths in minutes, most recent first (at most three). */
  recentTimers: number[];
  quietHours: { enabled: boolean; start: string; end: string };
  hiddenAlerts: HiddenAlerts;
  /** A 🔔 badge by the pet for alarms ringing within `minutes` (1–120). */
  upcomingAlarms: { show: boolean; minutes: number };
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
  hiddenAlerts: { alarms: true, timers: true, todos: true, focus: false },
  upcomingAlarms: { show: true, minutes: 60 },
  pomodoro: {
    focusMin: 25,
    shortBreakMin: 5,
    longBreakMin: 15,
    roundsBeforeLong: 4,
    autoContinue: true,
    workHours: { enabled: false, days: WEEKDAYS, start: "09:00", end: "17:30" },
    holdGames: true,
  },
  autostart: false,
};

/** The 🔔 badge's look-ahead: whole minutes, 1–120 (60 if it isn't a number). */
export function clampUpcomingMinutes(m: unknown): number {
  const n = Math.round(Number(m));
  return Number.isFinite(n) ? Math.min(120, Math.max(1, n)) : DEFAULT_SETTINGS.upcomingAlarms.minutes;
}

/** Fills in defaults for settings saved by older versions (nested objects merge too). */
export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const s = stored ?? {};
  const d = DEFAULT_SETTINGS;
  return {
    ...d,
    ...s,
    quietHours: { ...d.quietHours, ...s.quietHours },
    hiddenAlerts: { ...d.hiddenAlerts, ...s.hiddenAlerts },
    recentTimers: Array.isArray(s.recentTimers) ? s.recentTimers.filter((m) => typeof m === "number" && m > 0).slice(0, 3) : [],
    upcomingAlarms: (() => {
      const u = { ...d.upcomingAlarms, ...s.upcomingAlarms };
      return { show: u.show !== false, minutes: clampUpcomingMinutes(u.minutes) };
    })(),
    pomodoro: { ...d.pomodoro, ...s.pomodoro, workHours: { ...d.pomodoro.workHours, ...s.pomodoro?.workHours } },
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
}

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
}

export type PanelTab = "todos" | "alarms" | "focus" | "characters" | "games" | "settings";

export interface BackendEvents {
  reminder: ReminderEvent;
  pomodoro: PomodoroStatus;
  settings: Settings;
  "todos-changed": null;
  "alarms-changed": null;
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
}

export type PetActivity =
  | { type: "todoAdded"; title: string; dueAt: number | null }
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
  addTodo(title: string, dueAt: number | null): Promise<Todo>;
  updateTodo(id: number, patch: Partial<Pick<Todo, "title" | "dueAt" | "done">>): Promise<void>;
  deleteTodo(id: number): Promise<void>;
  /** Removes all ticked-off to-dos; returns how many. */
  clearDoneTodos(): Promise<number>;

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
  /** The hidden pet has answered its reminder and walked off: hide it again. */
  endPeek(): Promise<void>;
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
