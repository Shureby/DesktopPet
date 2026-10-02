import { nextPhase, startFocus, tick } from "../features/pomodoro/logic";
import { currentWorkPeriod, runCutoff } from "../features/pomodoro/workHours";
import { endOfDay, nextAfterTick, todoRemindsAt } from "../features/todo/repeat";
import {
  DEFAULT_SETTINGS,
  EVERY_DAY,
  mergeSettings,
  repeatMask,
  type Alarm,
  type Backend,
  type BackendEvents,
  type DayMask,
  type DayStat,
  type PomodoroStatus,
  type Repeat,
  type Unseen,
  type Score,
  type Settings,
  type Todo,
} from "./types";

/**
 * In-browser backend used by `npm run dev` without Tauri (and for UI tests).
 * State lives in localStorage; pages talk over a BroadcastChannel; the pet
 * page runs the scheduler. Fake "windows" are any `.fake-window` elements.
 */
/** The mock's to-dos also keep what the store keeps in columns of its own. */
type MockTodo = Todo & { anchorAt?: number | null; remindAt?: number | null };

interface MockState {
  settings: Settings;
  todos: MockTodo[];
  alarms: Alarm[];
  pomodoro: PomodoroStatus;
  sessions: { at: number; minutes: number; completed: boolean }[];
  scores: Score[];
  moods?: Record<string, unknown>;
  nextId: number;
  /** The work period the tomato clock was last started in (or found running in). */
  autoPeriod?: number;
  /** "While I was hidden you missed…" (the unseen table in the Rust store). */
  unseen?: Unseen[];
  /** To-dos whose reminder was given (the Rust store's notified_at). */
  notified?: number[];
}

/** Like the app's AppState: the user hid the pet (it may still come out for a reminder). */
let petHidden = false;
/** Like the Rust store's take_due (LATE_TOLERANCE_MS). */
const LATE_TOLERANCE = 60_000;

/** Whether the hidden pet comes out for this (Settings → Alerts). */
function comesOut(s: MockState, kind: "todo" | "alarm", title: string): boolean {
  const h = s.settings.hiddenAlerts;
  return kind === "todo" ? h.todos : title.startsWith("Timer: ") ? h.timers : h.alarms;
}

/** Like the store's alarm_times: the first ring, a repeating alarm's time of day and its days. */
function alarmTimes(at: number, repeat: Repeat, days: DayMask): Pick<Alarm, "nextFire" | "timeHm" | "repeatDays"> {
  const repeatDays = repeat === "days" ? days & EVERY_DAY : 0;
  if (repeat === "days" && !repeatDays) throw new Error("pick at least one day");
  const d = new Date(at);
  const timeHm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const nextFire = repeat === "none" ? at : (nextOccurrence(timeHm, repeatMask(repeat, repeatDays), at - 1) ?? at);
  return { nextFire, repeatDays, timeHm: repeat === "none" ? null : timeHm };
}

const KEY = "desktoppet-mock";
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("desktoppet") : null;
const local = new EventTarget();
let cursor: { x: number; y: number } | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("pointermove", (e) => (cursor = { x: e.clientX, y: e.clientY }));
}

function load(): MockState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as MockState;
      // To-dos saved before 0.24.0 have no day/repeat fields (the store's v10 defaults).
      const todos = (s.todos ?? []).map((t) => ({ ...t, allDay: t.allDay ?? false, repeat: t.repeat ?? "none" }));
      return { ...s, todos, settings: mergeSettings(s.settings) };
    }
  } catch {
    // Storage unavailable or corrupt: start fresh.
  }
  return {
    settings: { ...DEFAULT_SETTINGS },
    todos: [],
    alarms: [],
    pomodoro: { phase: "idle", round: 0, endsAt: null },
    sessions: [],
    scores: [],
    nextId: 1,
  };
}

function save(s: MockState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Ignore quota/private-mode errors in the mock.
  }
}

function mutate<T>(fn: (s: MockState) => T): T {
  const s = load();
  const out = fn(s);
  save(s);
  return out;
}

function fire<K extends keyof BackendEvents>(event: K, payload: BackendEvents[K]) {
  local.dispatchEvent(new CustomEvent(event, { detail: payload }));
  channel?.postMessage({ event, payload });
}
channel?.addEventListener("message", (m: MessageEvent) => {
  local.dispatchEvent(new CustomEvent(m.data.event, { detail: m.data.payload }));
});

function dayKey(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Next time after `after` at `timeHm` on one of `days` (a DayMask); like schedule.rs. */
function nextOccurrence(timeHm: string, days: number, after: number): number | null {
  if (!days) return null;
  const [h, m] = timeHm.split(":").map(Number);
  const d = new Date(after);
  d.setHours(h, m, 0, 0);
  while (d.getTime() <= after || !(days & (1 << d.getDay()))) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const daysOf = (a: Alarm) => repeatMask(a.repeat, a.repeatDays ?? 0);
const cutoffOf = (s: MockState) =>
  s.pomodoro.runStartedAt ? runCutoff(s.settings.pomodoro.workHours, s.pomodoro.runStartedAt) : null;

function setPomodoro(s: MockState, next: PomodoroStatus, now: number) {
  const prev = s.pomodoro;
  if (prev.phase === "focus" && prev.endsAt !== null) {
    const planned = s.settings.pomodoro.focusMin;
    const done = now >= prev.endsAt;
    const minutes = done ? planned : Math.max(0, planned - (prev.endsAt - now) / 60_000);
    s.sessions.push({ at: now, minutes, completed: done });
  }
  s.pomodoro = next;
}

/** Runs due reminders and pomodoro transitions once a second (call from one page only). */
export function startMockScheduler(): () => void {
  const id = setInterval(() => {
    const now = Date.now();
    const events: [keyof BackendEvents, unknown][] = [];
    mutate((s) => {
      // The same rules as take_due in the Rust store: what came due while ePet wasn't running
      // doesn't ring late, except an alarm still within its snooze time.
      const ring = (kind: "todo" | "alarm", id: number, title: string, allDay = false) => {
        const peek = petHidden && comesOut(s, kind, title);
        events.push(["reminder", { kind, id, title, peek, allDay }]);
      };
      s.notified ??= [];
      for (const t of s.todos) {
        if (t.done || t.dueAt === null || s.notified.includes(t.id)) continue;
        const at = t.remindAt ?? todoRemindsAt(t, s.settings.todoDayTime) ?? t.dueAt;
        if (at > now) continue;
        // A day's to-do reminds any time that day; one with a time only on time.
        if (t.allDay ? now < endOfDay(t.dueAt) : now - at <= LATE_TOLERANCE) ring("todo", t.id, t.title, t.allDay);
        s.notified.push(t.id);
        t.remindAt = null;
      }
      const alert = s.settings.alerts.alarm;
      const snoozeMs = alert.snoozeMinutes * 60_000;
      for (const a of s.alarms) {
        if (a.enabled && a.nextFire !== null && a.nextFire <= now) {
          const fireAt = a.nextFire;
          const cycleStart = a.snoozes > 0 ? (a.rangAt ?? fireAt) : fireAt;
          const snoozesItself = !a.label.startsWith("Timer: ") && alert.autoSnoozeMax > 0 && snoozeMs > 0;
          const onTime = now - fireAt <= LATE_TOLERANCE;
          const next = a.repeat !== "none" && a.timeHm ? nextOccurrence(a.timeHm, daysOf(a), now) : null;
          a.skippedFire = null;
          if (onTime || (snoozesItself && now - cycleStart <= snoozeMs * alert.autoSnoozeMax)) {
            ring("alarm", a.id, a.label);
            if (a.snoozes === 0) {
              a.missedAt = null;
              a.missedSeenAt = null;
            }
            if (!onTime) a.snoozes = Math.max(a.snoozes, Math.min(alert.autoSnoozeMax, Math.floor((now - cycleStart) / snoozeMs)));
            a.rangAt = cycleStart;
            a.offAt = null;
            a.nextFire = next;
            a.enabled = next !== null;
          } else if (next !== null) {
            a.nextFire = next;
            a.snoozes = 0;
          } else {
            // Finished without ringing: "ePet wasn't running".
            a.nextFire = null;
            a.enabled = false;
            a.offAt = cycleStart;
          }
        }
      }
      // Work hours: start it once per work period (see tick_pomodoro in store.rs).
      const period = currentWorkPeriod(s.settings.pomodoro.workHours, now);
      let next: PomodoroStatus | null = null;
      if (period !== null && s.autoPeriod !== period) {
        s.autoPeriod = period;
        if (s.pomodoro.phase === "idle") next = startFocus(now, s.settings.pomodoro);
      }
      next ??= tick(s.pomodoro, now, s.settings.pomodoro, cutoffOf(s));
      if (next) {
        setPomodoro(s, next, now);
        events.push(["pomodoro", next]);
        if (petHidden && s.settings.hiddenAlerts.focus) events.push(["pet-peek", "focus"]);
      }
    });
    for (const [e, p] of events) fire(e, p as never);
    if (events.some(([e]) => e === "reminder")) {
      fire("todos-changed", null);
      fire("alarms-changed", null);
    }
  }, 1000);
  return () => clearInterval(id);
}

export const mockBackend: Backend = {
  kind: "mock",
  async getSettings() {
    return load().settings;
  },
  async setSettings(patch) {
    const settings = mutate((s) => (s.settings = { ...s.settings, ...patch }));
    fire("settings", settings);
    return settings;
  },

  async listTodos() {
    return load().todos;
  },
  async addTodo({ title, dueAt, allDay = false, repeat = "none" }) {
    if (!title.trim()) throw new Error("title is empty");
    const todo = mutate((s) => {
      const t: MockTodo = {
        id: s.nextId++,
        title: title.trim(),
        dueAt,
        done: false,
        createdAt: Date.now(),
        doneAt: null,
        allDay: allDay && dueAt !== null,
        repeat: dueAt === null ? "none" : repeat,
        anchorAt: dueAt,
      };
      s.todos.push(t);
      return t;
    });
    fire("todos-changed", null);
    return todo;
  },
  async updateTodo(id, patch) {
    mutate((s) => {
      const t = s.todos.find((x) => x.id === id);
      if (!t) return;
      const now = Date.now();
      const rearm = () => (s.notified = (s.notified ?? []).filter((n) => n !== id));
      if (patch.title !== undefined) t.title = patch.title.trim();
      // A new date re-arms the reminder, and a repeating one counts from it.
      if (patch.dueAt !== undefined) {
        t.dueAt = patch.dueAt;
        t.anchorAt = patch.dueAt;
        t.remindAt = null;
        rearm();
      }
      if (patch.allDay !== undefined) t.allDay = patch.allDay;
      if (patch.repeat !== undefined) {
        t.repeat = patch.repeat;
        t.anchorAt = t.dueAt;
      }
      if (t.dueAt === null) {
        t.allDay = false;
        t.repeat = "none";
      }
      if (patch.remindAt !== undefined) {
        t.remindAt = patch.remindAt;
        rearm();
      }
      if (patch.done === true && !t.done && t.repeat !== "none") {
        // Ticking off a repeating to-do (see tick_repeating in store.rs).
        const next = nextAfterTick(t, t.anchorAt ?? t.dueAt ?? now, now);
        if (next !== null) {
          s.todos.push({ ...t, id: s.nextId++, done: true, doneAt: now, createdAt: now, repeat: "none" });
          t.dueAt = next;
          t.remindAt = null;
          rearm();
          return;
        }
      }
      if (patch.done !== undefined && patch.done !== t.done) {
        t.done = patch.done;
        t.doneAt = patch.done ? now : null;
      }
    });
    fire("todos-changed", null);
  },
  async clearDoneTodos() {
    const n = mutate((s) => {
      const before = s.todos.length;
      s.todos = s.todos.filter((t) => !t.done);
      return before - s.todos.length;
    });
    fire("todos-changed", null);
    return n;
  },
  async deleteTodo(id) {
    mutate((s) => (s.todos = s.todos.filter((t) => t.id !== id)));
    fire("todos-changed", null);
  },

  async listAlarms() {
    return load().alarms;
  },
  async addAlarm(label, at, repeat, days = 0) {
    const t = alarmTimes(at, repeat, days);
    const alarm = mutate((s) => {
      const a: Alarm = {
        id: s.nextId++,
        label,
        ...t,
        repeat,
        enabled: true,
        snoozes: 0,
        missedAt: null,
        missedSeenAt: null,
        skippedFire: null,
        rangAt: null,
        createdAt: Date.now(),
      };
      s.alarms.push(a);
      return a;
    });
    fire("alarms-changed", null);
    return alarm;
  },
  async updateAlarm(id, label, at, repeat, days = 0) {
    const t = alarmTimes(at, repeat, days);
    const alarm = mutate((s) => {
      const a = s.alarms.find((x) => x.id === id);
      if (!a) return null;
      Object.assign(a, { label: label.trim(), ...t, repeat, enabled: true, snoozes: 0, rangAt: null, skippedFire: null, offAt: null });
      return { ...a };
    });
    if (!alarm) throw new Error("that alarm no longer exists");
    fire("alarms-changed", null);
    return alarm;
  },
  async setAlarmEnabled(id, enabled) {
    mutate((s) => {
      const a = s.alarms.find((x) => x.id === id);
      if (!a) return;
      a.enabled = enabled;
      a.skippedFire = null;
      if (a.repeat !== "none") a.snoozes = 0;
      if (enabled && a.timeHm) a.nextFire = nextOccurrence(a.timeHm, daysOf(a), Date.now());
      // One-shot alarms keep their time so they can be switched back on.
      if (!enabled && a.repeat !== "none") a.nextFire = null;
      if (enabled && a.repeat === "none" && (a.nextFire ?? 0) <= Date.now()) a.enabled = false;
    });
    fire("alarms-changed", null);
  },
  async skipAlarmOnce(id) {
    mutate((s) => {
      const a = s.alarms.find((x) => x.id === id);
      if (!a || a.repeat === "none" || !a.enabled || a.nextFire === null || !a.timeHm) return;
      a.skippedFire = a.nextFire;
      a.snoozes = 0;
      a.nextFire = nextOccurrence(a.timeHm, daysOf(a), Math.max(a.nextFire, Date.now()));
    });
    fire("alarms-changed", null);
  },
  async unskipAlarm(id) {
    mutate((s) => {
      const a = s.alarms.find((x) => x.id === id);
      if (!a || !a.timeHm) return;
      a.skippedFire = null;
      if (a.enabled) a.nextFire = nextOccurrence(a.timeHm, daysOf(a), Date.now());
    });
    fire("alarms-changed", null);
  },
  async dismissAlarm(id) {
    mutate((s) => {
      const a = s.alarms.find((x) => x.id === id);
      if (!a) return;
      if (a.repeat !== "none") a.snoozes = 0;
      if (a.missedAt) a.missedSeenAt ??= Date.now();
      if (a.repeat !== "none" && a.timeHm) {
        a.nextFire = nextOccurrence(a.timeHm, daysOf(a), Date.now());
        a.enabled = true;
      } else {
        a.nextFire = null;
        a.enabled = false;
      }
    });
    fire("alarms-changed", null);
  },
  async recordUnseen(item) {
    mutate((s) => {
      s.unseen ??= [];
      if (!s.unseen.some((u) => u.kind === item.kind && u.refId === item.refId && u.at === item.at)) {
        s.unseen.push({ ...item, id: s.nextId++ });
      }
    });
  },
  async listUnseen() {
    return [...(load().unseen ?? [])].sort((a, b) => a.at - b.at || a.id - b.id);
  },
  async clearUnseen() {
    mutate((s) => {
      const now = Date.now();
      for (const u of s.unseen ?? []) {
        const a = u.kind === "alarm" ? s.alarms.find((x) => x.id === u.refId) : undefined;
        if (a?.missedAt) a.missedSeenAt ??= now;
      }
      s.unseen = [];
    });
    fire("alarms-changed", null);
  },
  async endPeek() {},
  async markAlarmMissed(id) {
    mutate((s) => {
      const a = s.alarms.find((x) => x.id === id);
      if (a) {
        a.missedAt = Date.now();
        a.missedSeenAt = null;
        if (a.repeat !== "none") a.snoozes = 0;
      }
    });
    fire("alarms-changed", null);
  },
  async acknowledgeMissed(id) {
    mutate((s) => {
      const a = s.alarms.find((x) => x.id === id);
      if (a?.missedAt) a.missedSeenAt ??= Date.now();
    });
    fire("alarms-changed", null);
  },
  async clearFinishedAlarms() {
    const now = Date.now();
    const n = mutate((s) => {
      const before = s.alarms.length;
      s.alarms = s.alarms.filter((a) => a.repeat !== "none" || (a.nextFire !== null && (a.enabled || a.nextFire > now)));
      return before - s.alarms.length;
    });
    fire("alarms-changed", null);
    return n;
  },
  async deleteAlarm(id) {
    mutate((s) => (s.alarms = s.alarms.filter((a) => a.id !== id)));
    fire("alarms-changed", null);
  },
  async snoozeAlarm(id, minutes) {
    const found = mutate((s) => {
      const a = s.alarms.find((x) => x.id === id);
      if (a) {
        a.enabled = true;
        a.nextFire = Date.now() + minutes * 60_000;
        a.snoozes = (a.snoozes ?? 0) + 1;
      }
      return !!a;
    });
    if (!found) throw new Error("that alarm no longer exists");
    fire("alarms-changed", null);
  },

  async pomodoroStart() {
    const now = Date.now();
    const st = mutate((s) => {
      setPomodoro(s, startFocus(now, s.settings.pomodoro), now);
      return s.pomodoro;
    });
    fire("pomodoro", st);
    return st;
  },
  async pomodoroSkip() {
    const now = Date.now();
    const st = mutate((s) => {
      setPomodoro(s, nextPhase(s.pomodoro, now, s.settings.pomodoro, cutoffOf(s)), now);
      return s.pomodoro;
    });
    fire("pomodoro", st);
    return st;
  },
  async pomodoroStop() {
    const now = Date.now();
    const st = mutate((s) => {
      setPomodoro(s, { phase: "idle", round: 0, endsAt: null, runStartedAt: null }, now);
      return s.pomodoro;
    });
    fire("pomodoro", st);
    return st;
  },
  async pomodoroStatus() {
    return load().pomodoro;
  },
  async pomodoroStats(days) {
    const s = load();
    const out: DayStat[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = dayKey(Date.now() - i * 86_400_000);
      const list = s.sessions.filter((x) => dayKey(x.at) === key);
      out.push({
        day: key,
        completed: list.filter((x) => x.completed).length,
        focusMinutes: Math.round(list.reduce((sum, x) => sum + x.minutes, 0)),
      });
    }
    return out;
  },

  async recordScore(game, character, score) {
    mutate((s) => s.scores.push({ game, character, score, at: Date.now() }));
  },
  async topScores(game, limit) {
    return load()
      .scores.filter((s) => s.game === game)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  },
  async unlockAchievement(id) {
    console.info(`[mock] achievement unlocked: ${id}`);
  },

  async storefront() {
    return "browser";
  },
  async desktopSnapshot() {
    const windows = [...document.querySelectorAll<HTMLElement>(".fake-window")].map((el, i) => {
      const r = el.getBoundingClientRect();
      return { id: el.id || `fake-${i}`, x: r.x, y: r.y, w: r.width, h: r.height };
    });
    // Front-to-back like a real window list: later DOM elements render on top.
    windows.reverse();
    return { areas: [{ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }], windows, scale: 1 };
  },
  async petFrame() {
    return cursor;
  },
  async loadMood(character) {
    return load().moods?.[character] ?? null;
  },
  async saveMood(character, mood) {
    mutate((s) => (s.moods = { ...s.moods, [character]: mood }));
    fire("mood", { character, mood });
  },
  async listUserCharacters() {
    return [];
  },
  async openUserCharactersFolder() {
    alert("In the desktop app this opens the folder for your own characters.");
  },
  assetUrl: (path) => path,

  async openPanel(tab) {
    window.open(`panel.html${tab ? `#${tab}` : ""}`, "desktoppet-panel", "width=440,height=620");
  },
  async openGame(game) {
    window.open(`game.html#${game}`, "desktoppet-game");
    fire("game", { state: "started", game });
  },
  async closeGame() {
    fire("game", { state: "ended", game: "" });
    window.close();
  },
  async setPetVisible(visible) {
    petHidden = !visible;
    fire("pet-visibility", visible);
  },
  async setAutostart() {},

  async on(event, cb) {
    const handler = (e: Event) => cb((e as CustomEvent).detail);
    local.addEventListener(event, handler);
    return () => local.removeEventListener(event, handler);
  },
  async emit(event, payload) {
    fire(event, payload);
  },
};
