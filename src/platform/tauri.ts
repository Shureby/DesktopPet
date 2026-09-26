import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { mergeSettings, type Backend, type BackendEvents, type PanelTab, type Settings } from "./types";

/** Settings are owned by the UI: Rust stores the JSON blob and reads only what it needs. */
async function getSettings(): Promise<Settings> {
  const stored = await invoke<Partial<Settings>>("get_settings");
  return mergeSettings(stored);
}

/** Backend implemented by the Rust side (src-tauri). Command names mirror `commands.rs`. */
export const tauriBackend: Backend = {
  kind: "tauri",
  getSettings,
  setSettings: async (patch: Partial<Settings>) => {
    const settings = { ...(await getSettings()), ...patch };
    await invoke("set_settings", { settings });
    return settings;
  },

  listTodos: () => invoke("list_todos"),
  addTodo: (title, dueAt) => invoke("add_todo", { title, dueAt }),
  updateTodo: (id, patch) => invoke("update_todo", { id, patch }),
  deleteTodo: (id) => invoke("delete_todo", { id }),

  listAlarms: () => invoke("list_alarms"),
  addAlarm: (label, at, repeat) => invoke("add_alarm", { label, at, repeat }),
  setAlarmEnabled: (id, enabled) => invoke("set_alarm_enabled", { id, enabled }),
  deleteAlarm: (id) => invoke("delete_alarm", { id }),
  snoozeAlarm: (id, minutes) => invoke("snooze_alarm", { id, minutes }),

  pomodoroStart: () => invoke("pomodoro_start"),
  pomodoroSkip: () => invoke("pomodoro_skip"),
  pomodoroStop: () => invoke("pomodoro_stop"),
  pomodoroStatus: () => invoke("pomodoro_status"),
  pomodoroStats: (days) => invoke("pomodoro_stats", { days }),

  recordScore: (game, character, score) => invoke("record_score", { game, character, score }),
  topScores: (game, limit) => invoke("top_scores", { game, limit }),
  unlockAchievement: (id) => invoke("unlock_achievement", { id }),
  storefront: () => invoke("storefront_name"),

  desktopSnapshot: () => invoke("desktop_snapshot"),
  petFrame: (x, y, ignoreCursor) => invoke("pet_frame", { x, y, ignoreCursor }),
  listUserCharacters: () => invoke("list_user_characters"),
  openUserCharactersFolder: () => invoke("open_user_characters_folder"),
  assetUrl: (path) => convertFileSrc(path),

  openPanel: (tab?: PanelTab) => invoke("open_panel", { tab: tab ?? null }),
  openGame: (game) => invoke("open_game", { game }),
  closeGame: () => invoke("close_game"),
  setAutostart: async (enabled) => {
    const autostart = await import("@tauri-apps/plugin-autostart");
    if (enabled) await autostart.enable();
    else await autostart.disable();
  },

  async on<K extends keyof BackendEvents>(event: K, cb: (payload: BackendEvents[K]) => void) {
    return listen<BackendEvents[K]>(event, (e) => cb(e.payload));
  },
  emit: (event, payload) => emit(event, payload),
};
