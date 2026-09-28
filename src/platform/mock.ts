import { nextPhase, startFocus, tick } from "../features/pomodoro/logic";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type Alarm,
  type Backend,
  type BackendEvents,
  type DayStat,
  type PomodoroStatus,
  type Score,
  type Settings,
  type Todo,
} from "./types";

/**
 * In-browser backend used by `npm run dev` without Tauri (and for UI tests).
 * State lives in localStorage; pages talk over a BroadcastChannel; the pet
 * page runs the scheduler. Fake "windows" are any `.fake-window` elements.
 */
interface MockState {
  settings: Settings;
  todos: Todo[];
  alarms: Alarm[];
  pomodoro: PomodoroStatus;
  sessions: { at: number; minutes: number; completed: boolean }[];
  scores: Score[];
  moods?: Record<string, unknown>;
  nextId: number;
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
      return { ...s, settings: mergeSettings(s.settings) };
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

function nextOccurrence(timeHm: string, repeat: Alarm["repeat"], after: number): number {
  const [h, m] = timeHm.split(":").map(Number);
  const d = new Date(after);
  d.setHours(h, m, 0, 0);
  while (d.getTime() <= after || (repeat === "weekdays" && (d.getDay() === 0 || d.getDay() === 6))) {
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

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
      for (const t of s.todos) {
        if (!t.done && t.dueAt !== null && t.dueAt <= now) {
          events.push(["reminder", { kind: "todo", id: t.id, title: t.title }]);
          t.dueAt = null;
        }
      }
      for (const a of s.alarms) {
        if (a.enabled && a.nextFire !== null && a.nextFire <= now) {
          events.push(["reminder", { kind: "alarm", id: a.id, title: a.label }]);
          a.rangAt = a.nextFire;
          if (a.repeat !== "none" && a.timeHm) a.nextFire = nextOccurrence(a.timeHm, a.repeat, now);
          else {
            a.nextFire = null;
            a.enabled = false;
          }
        }
      }
      const next = tick(s.pomodoro, now, s.settings.pomodoro);
      if (next) {
        setPomodoro(s, next, now);
        events.push(["pomodoro", next]);
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
  async addTodo(title, dueAt) {
    const todo = mutate((s) => {
      const t: Todo = { id: s.nextId++, title, dueAt, done: false, createdAt: Date.now(), doneAt: null };
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
      if (patch.done !== undefined && patch.done !== t.done) t.doneAt = patch.done ? Date.now() : null;
      Object.assign(t, patch);
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
  async addAlarm(label, at, repeat) {
    const alarm = mutate((s) => {
      const d = new Date(at);
      const timeHm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const a: Alarm = {
        id: s.nextId++,
        label,
        nextFire: at,
        timeHm: repeat === "none" ? null : timeHm,
        repeat,
        enabled: true,
        snoozes: 0,
        missedAt: null,
        rangAt: null,
        createdAt: Date.now(),
      };
      s.alarms.push(a);
      return a;
    });
    fire("alarms-changed", null);
    return alarm;
  },
  async setAlarmEnabled(id, enabled) {
    mutate((s) => {
      const a = s.alarms.find((x) => x.id === id);
      if (!a) return;
      a.enabled = enabled;
      if (enabled && a.timeHm) a.nextFire = nextOccurrence(a.timeHm, a.repeat, Date.now());
      // One-shot alarms keep their time so they can be switched back on.
      if (!enabled && a.repeat !== "none") a.nextFire = null;
      if (enabled && a.repeat === "none" && (a.nextFire ?? 0) <= Date.now()) a.enabled = false;
    });
    fire("alarms-changed", null);
  },
  async dismissAlarm(id) {
    mutate((s) => {
      const a = s.alarms.find((x) => x.id === id);
      if (!a) return;
      a.snoozes = 0;
      a.missedAt = null;
      if (a.repeat !== "none" && a.timeHm) {
        a.nextFire = nextOccurrence(a.timeHm, a.repeat, Date.now());
        a.enabled = true;
      } else {
        a.nextFire = null;
        a.enabled = false;
      }
    });
    fire("alarms-changed", null);
  },
  async markAlarmMissed(id) {
    mutate((s) => {
      const a = s.alarms.find((x) => x.id === id);
      if (a) {
        a.missedAt = Date.now();
        a.snoozes = 0;
      }
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
      setPomodoro(s, nextPhase(s.pomodoro, now, s.settings.pomodoro), now);
      return s.pomodoro;
    });
    fire("pomodoro", st);
    return st;
  },
  async pomodoroStop() {
    const now = Date.now();
    const st = mutate((s) => {
      setPomodoro(s, { phase: "idle", round: 0, endsAt: null }, now);
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
