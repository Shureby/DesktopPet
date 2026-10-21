import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { mergeSettings, type Backend, type BackendEvents, type PanelTab, type Settings, type TestClock, type AvoidStatus, type SystemLocale } from "./types";

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
  addTodo: (todo) => invoke("add_todo", { todo }),
  updateTodo: (id, patch) => invoke("update_todo", { id, patch }),
  deleteTodo: (id) => invoke("delete_todo", { id }),
  clearDoneTodos: () => invoke("clear_done_todos"),
  listAnniversaries: () => invoke("list_anniversaries"),
  addAnniversary: (anniversary) => invoke("add_anniversary", { anniversary }),
  updateAnniversary: (id, anniversary) => invoke("update_anniversary", { id, anniversary }),
  deleteAnniversary: (id) => invoke("delete_anniversary", { id }),
  previewCelebration: (anniversary) => invoke("preview_celebration", { anniversary }),
  showCelebration: (celebration) => invoke("show_celebration", { celebration }),
  closeCelebration: () => invoke("close_celebration"),

  listAlarms: () => invoke("list_alarms"),
  addAlarm: (label, at, repeat, days, important, autoSnooze) =>
    invoke("add_alarm", { label, at, repeat, days: days ?? null, important: important ?? null, autoSnooze: autoSnooze ?? null }),
  setAlarmEnabled: (id, enabled) => invoke("set_alarm_enabled", { id, enabled }),
  skipAlarmOnce: (id) => invoke("skip_alarm_once", { id }),
  unskipAlarm: (id) => invoke("unskip_alarm", { id }),
  updateAlarm: (id, label, at, repeat, days, important, autoSnooze) =>
    invoke("update_alarm", { id, label, at, repeat, days: days ?? null, important: important ?? null, autoSnooze: autoSnooze ?? null }),
  deleteAlarm: (id) => invoke("delete_alarm", { id }),
  clearFinishedAlarms: () => invoke("clear_finished_alarms"),
  snoozeAlarm: (id, minutes) => invoke("snooze_alarm", { id, minutes }),
  dismissAlarm: (id) => invoke("dismiss_alarm", { id }),
  markAlarmMissed: (id) => invoke("mark_alarm_missed", { id }),
  recordUnseen: (item) => invoke("record_unseen", { item }),
  listUnseen: () => invoke("list_unseen"),
  clearUnseen: () => invoke("clear_unseen"),
  petReady: () => invoke("pet_ready"),
  testClock: () => invoke<TestClock | null>("test_clock"),
  shiftClock: (ms) => invoke<number>("shift_clock", { ms }),
  endPeek: () => invoke("end_peek"),
  avoidStatus: () => invoke<AvoidStatus>("avoid_status"),
  pretendBusy: (busy) => invoke("pretend_busy", { busy }),
  peekForHeld: (todo, title) => invoke<boolean>("peek_for_held", { todo, title }),
  avoidHide: () => invoke("avoid_hide"),
  avoidShow: () => invoke("avoid_show"),
  avoidStay: () => invoke("avoid_stay"),
  e2eEnabled: () => invoke<boolean>("e2e_enabled").catch(() => false),
  systemLocale: () => invoke<SystemLocale>("system_locale").catch(() => ({ languages: [...navigator.languages], country: null })),
  e2eTray: (id) => invoke("e2e_tray", { id }),
  backupExport: (password, path) => invoke("backup_export", { password, path: path ?? null }),
  backupOpen: (path, password) => invoke("backup_open", { path, password }),
  backupRestore: (parts, mode, restart) => invoke("backup_restore", { parts, mode, restart: restart ?? null }),
  backupListAuto: () => invoke("backup_list_auto"),
  acknowledgeMissed: (id) => invoke("acknowledge_missed", { id }),
  postConfigure: (config) => invoke("post_configure", { config }),
  postStatus: () => invoke("post_status"),
  postDevices: () => invoke("post_devices"),
  postRefresh: () => invoke("post_refresh"),
  postAddDevice: (address, port) => invoke("post_add_device", { address, port: port ?? null }),
  postTailnet: () => invoke("post_tailnet"),
  postDoor: () => invoke("post_door"),
  postDoorRetry: () => invoke("post_door_retry"),
  postVerify: (fingerprint) => invoke("post_verify", { fingerprint }),
  postVerifyAsk: (fingerprint) => invoke("post_verify_ask", { fingerprint }),
  postVerifyAnswer: (fingerprint, show) => invoke("post_verify_answer", { fingerprint, show }),
  postVerifyDecided: (fingerprint, matched) => invoke("post_verify_decided", { fingerprint, matched }),
  postVerifyResult: (fingerprint) => invoke("post_verify_result", { fingerprint }),
  postClipboardText: () => invoke("post_clipboard_text"),
  postCopyText: (text) => invoke("post_copy_text", { text }),
  postShareOpen: (target, pin) => invoke("post_share_open", { fingerprint: target.fingerprint ?? null, link: target.link ?? null, pin: pin ?? null }),
  postShareGet: (ids) => invoke("post_share_get", { ids }),
  postShareCancel: () => invoke("post_share_cancel"),
  postSend: (to, paths, text, pin) => invoke("post_send", { to, paths, text: text ?? null, pin: pin ?? null }),
  postCancelSend: () => invoke("post_cancel_send"),
  postAnswer: (id, accept) => invoke("post_answer", { id, accept }),
  postPendingOffer: () => invoke("post_pending_offer"),
  postStopReceiving: () => invoke("post_stop_receiving"),
  postHistory: () => invoke("post_history"),
  postClearHistory: () => invoke("post_clear_history"),
  postOpenReceived: (id, reveal) => invoke("post_open_received", { id, reveal }),
  postWindowShown: () => invoke<boolean>("post_window_shown"),
  postAttention: () => invoke("post_attention"),
  postPick: (folder, title) => invoke("post_pick", { folder, title: title ?? null }),
  postMeasure: (paths) => invoke("post_measure", { paths }),
  postPickSaveDir: () => invoke("post_pick_save_dir"),
  postOpen: (path) => invoke("post_open", { path: path ?? null }),
  openPostWindow: (verify, tab) => invoke("open_post_window", { verify: verify ?? null, tab: tab ?? null }),
  postPeek: () => invoke<boolean>("post_peek"),

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
  petFrame: (x, y, w, h, ignoreCursor) => invoke("pet_frame", { x, y, w, h, ignoreCursor }),
  listUserCharacters: () => invoke("list_user_characters"),
  loadMood: (character) => invoke("load_mood", { character }),
  saveMood: (character, mood) => invoke("save_mood", { character, mood }),
  openUserCharactersFolder: () => invoke("open_user_characters_folder"),
  copyCharacter: (json, sourceDir) => invoke("copy_character", { json, sourceDir }),
  reloadCharacters: () => invoke("reload_characters"),
  assetUrl: (path) => convertFileSrc(path),

  openPanel: (tab?: PanelTab) => invoke("open_panel", { tab: tab ?? null }),
  openGame: (game) => invoke("open_game", { game }),
  closeGame: () => invoke("close_game"),
  setPetVisible: (visible) => invoke("set_pet_visible", { visible }),
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
