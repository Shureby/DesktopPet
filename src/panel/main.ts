import { version } from "../../package.json";
import product from "../../product.config.json";
import { isHungry, moodTier, parseMood, type Mood } from "../brain/mood";
import { ABILITIES } from "../characters/abilities";
import { loadBundled, loadUser, type CharacterRegistry, type LoadedCharacter } from "../characters/registry";
import { SpriteAtlas } from "../engine/sprites";
import { formatRemaining, gameHeld } from "../features/pomodoro/logic";
import { clock, DEFAULT_ALARM_LABEL } from "../features/alarm/ringing";
import {
  durationInput,
  forgetCustomTimer,
  formatDuration,
  isTimer,
  parseDuration,
  PRESET_MINUTES,
  rememberCustomTimer,
  replaceCustomTimer,
  timerLabel,
  timerName,
} from "../features/alarm/timers";
import { parseQuickAdd } from "../features/todo/quickAdd";
import { GAMES } from "../features/games/catalog";
import {
  backend,
  clampUpcomingMinutes,
  WEEKDAYS,
  type Alarm,
  type AlertSettings,
  type DayMask,
  type HiddenAlerts,
  type PanelTab,
  type Settings,
  type WorkHours,
} from "../platform";
import { playRingtone, RINGTONE_IDS, RINGTONES, type RingtoneId } from "../pet/sound";
import "../styles/panel.css";
import {
  bigTime,
  hiddenWarning,
  choiceForDays,
  daysForChoice,
  finishedAt,
  finishedStatus,
  repeatFor,
  repeatText,
  showsDays,
  skipWhen,
  sortAlarms,
  timerTimes,
  type RepeatChoice,
} from "./alarmText";
import { dayPicker } from "./dayPicker";
import { formatHm, timeField } from "./timeField";
import { formatWhen, h } from "./dom";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "todos", label: "To-dos" },
  { id: "alarms", label: "Alarms" },
  { id: "focus", label: "Focus" },
  { id: "characters", label: "Characters" },
  { id: "games", label: "Games" },
  { id: "settings", label: "Settings" },
];

let current: PanelTab = "todos";
let settings: Settings;
let registry: CharacterRegistry;
const view = document.getElementById("view")!;
const nav = document.getElementById("tabs")!;
let cleanup: (() => void)[] = [];
/** The new alarm being set up, kept across re-renders of the Alarms tab. */
let alarmDraft: { time: string; choice: RepeatChoice; days: DayMask; label: string } | null = null;

/** Runs `f` once things have been quiet for `ms` (a dragged time field changes many times). */
function debounced<T>(f: (v: T) => void, ms = 300): (v: T) => void {
  let id: ReturnType<typeof setTimeout> | undefined;
  return (v: T) => {
    clearTimeout(id);
    id = setTimeout(() => f(v), ms);
  };
}

function nowHm(): string {
  const d = new Date();
  return formatHm(d.getHours(), d.getMinutes());
}

function select(tab: PanelTab) {
  // Opening the Alarms tab starts a new alarm at the current time; re-renders keep the draft.
  if (tab === "alarms") alarmDraft = null;
  current = tab;
  for (const b of nav.querySelectorAll("button")) b.classList.toggle("active", b.dataset.tab === tab);
  cleanup.forEach((f) => f());
  cleanup = [];
  void render();
}

async function render() {
  const renderers: Record<PanelTab, () => Promise<Node>> = {
    todos: renderTodos,
    alarms: renderAlarms,
    focus: renderFocus,
    characters: renderCharacters,
    games: renderGames,
    settings: renderSettings,
  };
  const tab = current;
  const node = await renderers[tab]();
  if (tab === current) view.replaceChildren(node);
}

// --- To-dos -----------------------------------------------------------------

async function renderTodos(): Promise<Node> {
  const todos = await backend.listTodos();
  const input = h("input", { type: "text", placeholder: "e.g. call mom at 3pm · stretch in 20m · standup tomorrow 9:30", autofocus: true });
  const hint = h("div", { class: "hint" });
  const updateHint = () => {
    const q = parseQuickAdd(input.value);
    hint.textContent = input.value.trim() ? (q.dueAt ? `⏰ ${formatWhen(q.dueAt)} — “${q.title}”` : `No reminder — “${q.title}”`) : "";
  };
  input.addEventListener("input", updateHint);
  const add = async () => {
    if (!input.value.trim()) return;
    const q = parseQuickAdd(input.value);
    await backend.addTodo(q.title, q.dueAt);
    // The pet confirms what it heard.
    void backend.emit("pet-event", { type: "todoAdded", title: q.title, dueAt: q.dueAt });
    input.value = "";
    updateHint();
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && void add());
  queueMicrotask(() => input.focus());

  const open = todos.filter((t) => !t.done).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
  // Most recently ticked off first.
  const done = todos.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0) || b.id - a.id);
  const row = (t: (typeof todos)[number]) =>
    h(
      "li",
      { class: t.done ? "done" : "" },
      h("input", {
        type: "checkbox",
        checked: t.done,
        onchange: () => {
          void backend.updateTodo(t.id, { done: !t.done });
          if (!t.done) void backend.emit("pet-event", { type: "todoDone" });
        },
      }),
      h("span", { class: "title" }, t.title),
      // Its reminder time has passed (answered or not, or while ePet wasn't running).
      t.dueAt && !t.done
        ? t.dueAt < Date.now()
          ? h("span", { class: "when overdue" }, `Overdue · ${formatWhen(t.dueAt)}`)
          : h("span", { class: "when" }, formatWhen(t.dueAt))
        : null,
      t.done && t.doneAt ? h("span", { class: "when" }, `Done · ${formatWhen(t.doneAt)}`) : null,
      h("button", { class: "icon", title: "Delete", onclick: () => void backend.deleteTodo(t.id) }, "✕"),
    );

  return h(
    "section",
    {},
    h("div", { class: "row" }, input, h("button", { class: "primary", onclick: add }, "Add")),
    hint,
    open.length ? h("ul", { class: "list" }, ...open.map(row)) : h("p", { class: "empty" }, "Nothing to do. Your pet approves."),
    done.length ? finishedSection(`Done (${done.length})`, done.map(row), () => backend.clearDoneTodos()) : null,
    h("p", { class: "hint" }, "Done to-dos are cleared automatically each day."),
  );
}

// --- Alarms -----------------------------------------------------------------

async function renderAlarms(): Promise<Node> {
  const alarms = await backend.listAlarms();
  alarmDraft ??= { time: nowHm(), choice: "none", days: WEEKDAYS, label: "" };
  const draft = alarmDraft;
  const label = h("input", {
    type: "text",
    placeholder: "Label",
    title: "A name for it (optional)",
    value: draft.label,
    oninput: (e: Event) => (draft.label = (e.target as HTMLInputElement).value),
  });
  // Starts at the current time, so it's quick to set one for a little later.
  const time = timeField(draft.time, (v) => (draft.time = v), "Alarm time");
  // Opened from "Set alarm…": start with the time field ready to type.
  // (Only when nothing else has focus, so a re-render never steals it mid-typing.)
  queueMicrotask(() => {
    if (!document.activeElement || document.activeElement === document.body) time.focus();
  });
  const addButton = h("button", { class: "primary", onclick: () => void add() }, "Add");
  // Only Weekdays, Weekends and Custom days show the days. Picking days by hand names them:
  // Mon–Fri is Weekdays, Sat + Sun is Weekends, anything else Custom days.
  const days = dayPicker(draft.days, (m) => {
    draft.days = m;
    draft.choice = choiceForDays(m);
    repeat.value = draft.choice;
    refresh();
  });
  const daysRow = h("div", { class: "row days-row" }, days);
  const refresh = () => {
    daysRow.hidden = !showsDays(draft.choice);
    // Custom days with none picked would never ring.
    addButton.disabled = draft.choice === "days" && !draft.days;
  };
  const repeat = h(
    "select",
    {
      class: "repeat",
      onchange: (e: Event) => {
        const choice = (e.target as HTMLSelectElement).value as RepeatChoice;
        draft.days = daysForChoice(choice, draft.choice, draft.days, new Date().getDay());
        draft.choice = choice;
        days.setMask(draft.days);
        refresh();
      },
    },
    ...(
      [
        ["none", "Once"],
        ["daily", "Every day"],
        ["weekdays", "Weekdays"],
        ["weekends", "Weekends"],
        ["days", "Custom days"],
      ] as const
    ).map(([v, text]) => h("option", { value: v, selected: draft.choice === v }, text)),
  );
  refresh();
  const add = async () => {
    const [hh, mm] = time.value.split(":").map(Number);
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    // No time in the label: it is shown from the alarm's own time, in the system's format.
    // A repeating alarm's first ring is its first day at or after this (the store works it out).
    const r = repeatFor(draft.choice, draft.days);
    await backend.addAlarm(label.value.trim() || DEFAULT_ALARM_LABEL, d.getTime(), r.repeat, r.days);
    draft.label = "";
    label.value = "";
  };
  // Custom length, with a live preview of how it's understood. `editing` is the saved
  // custom length being changed with ✎; starting a timer then replaces it in place.
  let editing: number | undefined;
  const startTimer = async (m: number, replacing?: number) => {
    await backend.addAlarm(timerLabel(m), Date.now() + m * 60_000, "none");
    const saved = settings.recentTimers;
    const recentTimers = replacing === undefined ? rememberCustomTimer(saved, m) : replaceCustomTimer(saved, replacing, m);
    if (recentTimers.join() !== saved.join()) await save({ recentTimers });
  };
  const short = (m: number) =>
    formatDuration(m).replace(/ hours?\b/, "h").replace(" min", "m").replace(" s", "s").replace(/ /g, "");
  const timer = (m: number) => h("button", { onclick: () => void startTimer(m) }, short(m));
  const customTimer = (m: number) =>
    h(
      "span",
      { class: "custom-chip" },
      h("button", { class: "custom", title: "Your custom timer", onclick: () => void startTimer(m) }, short(m)),
      h(
        "button",
        {
          class: "icon",
          title: "Change this one",
          onclick: () => {
            editing = m;
            customInput.value = durationInput(m);
            showHint();
            customInput.focus();
            customInput.select();
          },
        },
        "✎",
      ),
      h(
        "button",
        {
          class: "icon",
          title: "Forget this one",
          onclick: () => void save({ recentTimers: forgetCustomTimer(settings.recentTimers, m) }),
        },
        "✕",
      ),
    );
  const customInput = h("input", { type: "text", placeholder: "Custom: 20 · 1:30 · 90s", class: "custom-timer" });
  const customHint = h("span", { class: "hint" });
  const showHint = () => {
    const m = parseDuration(customInput.value);
    if (editing !== undefined) customHint.textContent = `${short(editing)} → ${m === null ? "…" : short(m)}`;
    else customHint.textContent = customInput.value.trim() ? (m === null ? "…" : `= ${formatDuration(m)}`) : "";
  };
  const startCustom = () => {
    const m = parseDuration(customInput.value);
    if (m === null) {
      customHint.textContent = "Try 20, 1:30 or 90s";
      return;
    }
    const replacing = editing;
    editing = undefined;
    customInput.value = "";
    customHint.textContent = "";
    void startTimer(m, replacing);
  };
  customInput.addEventListener("input", showHint);
  customInput.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && startCustom());
  const now = Date.now();
  // A one-shot alarm is finished once its time has passed (repeating ones never finish).
  const isFinished = (a: Alarm) => a.repeat === "none" && (a.nextFire === null || a.nextFire <= now);
  const timers = alarms.filter((a) => isTimer(a) && !isFinished(a));
  // Soonest ring first (like the pet's 🔔 badge), the ones switched off last.
  const clocks = sortAlarms(alarms.filter((a) => !isTimer(a) && !isFinished(a)));
  // Most recently finished first.
  const finished = alarms
    .filter(isFinished)
    .sort((a, b) => (finishedAt(b) ?? 0) - (finishedAt(a) ?? 0) || b.id - a.id);

  // Live countdowns for running timers.
  const countdowns: [HTMLElement, number][] = [];
  const tickCountdowns = () => {
    for (const [el, at] of countdowns) el.textContent = formatRemaining(at - Date.now());
  };
  const id = setInterval(tickCountdowns, 500);
  cleanup.push(() => clearInterval(id));

  // Timers: the countdown is the big number, like a phone's timer screen.
  const timerRow = (a: Alarm) => {
    const left = h("span", { class: "big countdown" });
    if (a.nextFire) countdowns.push([left, a.nextFire]);
    return h(
      "li",
      { class: "clock-row" },
      left,
      h(
        "div",
        { class: "info" },
        h("span", { class: "title" }, `⏱ ${timerName(a)} timer`),
        h("span", { class: "sub" }, timerTimes(a)),
        a.snoozes > 0 ? h("span", { class: "chip" }, `💤 snoozed ${a.snoozes}×`) : null,
      ),
      h("button", { onclick: () => void backend.deleteAlarm(a.id) }, "Cancel"),
    );
  };

  const alarmRow = (a: Alarm) =>
    h(
      "li",
      { class: `clock-row ${a.enabled ? "" : "off"}` },
      h("span", { class: "big" }, bigTime(a)),
      h(
        "div",
        { class: "info" },
        h("span", { class: "title" }, a.label),
        h("span", { class: "sub" }, alarmSubtitle(a)),
        a.enabled && a.snoozes > 0 && a.nextFire
          ? h(
              "span",
              { class: "chip" },
              `💤 ${clock(a.nextFire)} (${a.snoozes}/${Math.max(a.snoozes, settings.alerts.alarm.autoSnoozeMax)})`,
            )
          : null,
        a.enabled && a.skippedFire && a.skippedFire > Date.now()
          ? h(
              "span",
              { class: "chip skip" },
              `⏭ Skips ${skipWhen(a.skippedFire)} · `,
              h("button", { class: "link", onclick: () => void backend.unskipAlarm(a.id) }, "Undo"),
            )
          : null,
      ),
      h("button", { class: "icon delete", title: "Delete", onclick: () => void backend.deleteAlarm(a.id) }, "✕"),
      toggle(a.enabled, a.label, (input) => {
        // Switching off a repeating alarm asks, like a phone: skip just the next ring, or all?
        if (a.enabled && a.repeat !== "none") {
          input.checked = true;
          askTurnOff(a);
        } else void backend.setAlarmEnabled(a.id, !a.enabled);
      }),
    );

  const finishedRow = (a: Alarm) =>
    h(
      "li",
      { class: "clock-row finished-row" },
      // An alarm shows the time it was set for, not a later snoozed ring.
      h("span", { class: "big" }, isTimer(a) ? "⏱" : bigTime(a)),
      h(
        "div",
        { class: "info" },
        h("span", { class: "title" }, isTimer(a) ? `${timerName(a)} timer` : a.label),
        h("span", { class: `sub ${a.missedAt ? "missed" : ""}` }, finishedStatus(a)),
      ),
      h("button", { class: "icon", title: "Delete", onclick: () => void backend.deleteAlarm(a.id) }, "✕"),
    );

  const section = h(
    "section",
    {},
    h("h3", {}, "Quick timer"),
    h(
      "div",
      { class: "row wrap" },
      ...PRESET_MINUTES.map((m) => timer(m)),
      ...settings.recentTimers.filter((m) => !PRESET_MINUTES.includes(m)).map(customTimer),
    ),
    h("div", { class: "row custom-row" }, customInput, h("button", { onclick: startCustom }, "Start"), customHint),
    h("h3", {}, "New alarm"),
    h("div", { class: "row" }, time, repeat, label, addButton),
    daysRow,
    timers.length ? h("h3", {}, "Timers") : null,
    timers.length ? h("ul", { class: "list clocks" }, ...timers.map(timerRow)) : null,
    h("h3", {}, "Alarms"),
    clocks.length ? h("ul", { class: "list clocks" }, ...clocks.map(alarmRow)) : h("p", { class: "empty" }, "No alarms set."),
    finished.length ? finishedSection(`Finished (${finished.length})`, finished.map(finishedRow), () => backend.clearFinishedAlarms()) : null,
    h("p", { class: "hint" }, "Finished alarms and timers are cleared automatically each day."),
  );
  tickCountdowns();
  return section;
}

/** "Every day", "Once · Tomorrow", "Weekdays · Off"… */
function alarmSubtitle(a: Alarm): string {
  const parts = [repeatText(a)];
  if (!a.enabled) parts.push("Off");
  else if (a.nextFire && a.snoozes === 0) {
    const day = formatWhen(a.nextFire).replace(/\s*\d{1,2}:\d{2}.*$/, "");
    if (a.repeat === "none" || day !== "Today") parts.push(day);
  }
  return parts.join(" · ");
}

/**
 * A small dialog like a phone's: a title, a line under it, the choices, then Cancel (also Esc
 * or a click outside). Used by "Skip once" and by games during a focus session.
 */
function ask(title: string, sub: string, choices: { text: string; action: () => Promise<void>; primary?: boolean }[]): void {
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  const choice = (text: string, action: (() => Promise<void>) | null, cls = "") =>
    h(
      "button",
      {
        class: cls,
        onclick: () => {
          close();
          if (action) void action();
        },
      },
      text,
    );
  const box = h(
    "div",
    { class: "ask", role: "dialog", "aria-modal": "true" },
    h("p", { class: "title" }, title),
    h("p", { class: "sub" }, sub),
    ...choices.map((c) => choice(c.text, c.action, c.primary ? "primary" : "")),
    choice("Cancel", null, "cancel"),
  );
  const overlay = h("div", { class: "ask-overlay", onclick: (e: Event) => e.target === overlay && close() }, box);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  (box.querySelector("button") as HTMLButtonElement | null)?.focus();
}

/**
 * Switching off a repeating alarm: "Skip once · Sep 30 7:00 PM (Today)", "Turn off repeating
 * alarm" or Cancel. Once a ring is skipped, only the last two.
 */
function askTurnOff(a: Alarm): void {
  const skipped = a.skippedFire !== null && a.skippedFire > Date.now();
  ask(a.label, repeatText(a), [
    ...(!skipped && a.nextFire
      ? [{ text: `Skip once · ${skipWhen(a.nextFire)}`, action: () => backend.skipAlarmOnce(a.id), primary: true }]
      : []),
    { text: "Turn off repeating alarm", action: () => backend.setAlarmEnabled(a.id, false) },
  ]);
}

/** Play, or during a focus session ask first (Focus → "Ask before games"). */
async function playGame(game: string): Promise<void> {
  const status = await backend.pomodoroStatus();
  if (!gameHeld(settings.pomodoro, status)) return backend.openGame(game);
  ask(`Focusing until ${clock(status.endsAt ?? Date.now())}`, "Play anyway?", [
    { text: "Play anyway", action: () => backend.openGame(game), primary: true },
  ]);
}

/** A phone-style on/off switch (not a checkbox: a tick reads as "done"). */
function toggle(on: boolean, name: string, onChange: (input: HTMLInputElement) => void): Node {
  return h(
    "label",
    { class: "switch", title: on ? "On: will ring" : "Off" },
    h("input", {
      type: "checkbox",
      role: "switch",
      checked: on,
      "aria-label": `${name} on/off`,
      onchange: (e: Event) => onChange(e.target as HTMLInputElement),
    }),
    h("span", { class: "slider" }),
  );
}

/** Collapsible list of finished items with a "Clear" button. */
function finishedSection(title: string, rows: Node[], clear: () => Promise<number>): Node {
  return h(
    "details",
    { class: "finished" },
    h(
      "summary",
      {},
      title,
      h(
        "button",
        {
          class: "clear",
          onclick: (e: Event) => {
            e.preventDefault();
            void clear();
          },
        },
        "Clear",
      ),
    ),
    h("ul", { class: "list" }, ...rows),
  );
}

// --- Focus sessions (Pomodoro) ---------------------------------------------------

async function renderFocus(): Promise<Node> {
  const status = await backend.pomodoroStatus();
  const stats = await backend.pomodoroStats(7);
  const c = settings.pomodoro;
  const clock = h("div", { class: "now-clock" });
  const label = h("div", { class: "now-phase" });
  const names = { idle: "Ready when you are", focus: "Focus", short_break: "Short break", long_break: "Long break" };
  const tickClock = () => {
    label.textContent = `${names[status.phase]}${status.phase !== "idle" ? ` · round ${status.round + (status.phase === "focus" ? 1 : 0)}/${c.roundsBeforeLong}` : ""}`;
    clock.textContent = status.endsAt ? formatRemaining(status.endsAt - Date.now()) : `${c.focusMin}:00`;
  };
  tickClock();
  const id = setInterval(tickClock, 500);
  cleanup.push(() => clearInterval(id));

  const num = (key: keyof typeof c, text: string, min: number, max: number) =>
    h(
      "label",
      {},
      text,
      h("input", {
        type: "number",
        min,
        max,
        value: c[key] as number,
        onchange: (e: Event) => void save({ pomodoro: { ...settings.pomodoro, [key]: Number((e.target as HTMLInputElement).value) } }),
      }),
    );
  const check = (key: "autoContinue" | "holdGames", text: string) =>
    h(
      "label",
      { class: "check" },
      h("input", { type: "checkbox", checked: c[key], onchange: () => void save({ pomodoro: { ...settings.pomodoro, [key]: !c[key] } }) }),
      text,
    );
  const max = Math.max(1, ...stats.map((s) => s.completed));
  const sessions = stats.reduce((n, s) => n + s.completed, 0);
  const minutes = stats.reduce((n, s) => n + s.focusMinutes, 0);

  // Compact, so the settings fit in the panel's default size without scrolling.
  return h(
    "section",
    { class: "focus-page" },
    h(
      "div",
      { class: "box now" },
      h("div", { class: "now-icon" }, status.phase.includes("break") ? "☕" : "🍅"),
      h("div", {}, label, clock),
      h(
        "div",
        { class: "now-buttons" },
        ...(status.phase === "idle"
          ? [h("button", { class: "primary", onclick: () => void backend.pomodoroStart() }, "Start focus")]
          : [h("button", { onclick: () => void backend.pomodoroSkip() }, "Skip"), h("button", { onclick: () => void backend.pomodoroStop() }, "Stop")]),
      ),
    ),
    h("h3", { class: "split" }, "Last 7 days", h("small", {}, `${sessions} session${sessions === 1 ? "" : "s"} · ${formatHoursMinutes(minutes)}`)),
    h(
      "div",
      { class: "bars" },
      ...stats.map((s) =>
        h(
          "div",
          { class: "bar", title: `${s.completed} sessions · ${s.focusMinutes} min` },
          h("div", { class: "fill", style: `height:${(s.completed / max) * 100}%` }),
          h("span", {}, new Date(s.day + "T12:00").toLocaleDateString([], { weekday: "narrow" })),
        ),
      ),
    ),
    h("h3", {}, "Timing (minutes)"),
    h(
      "div",
      { class: "timing" },
      num("focusMin", "Focus", 1, 180),
      num("shortBreakMin", "Short break", 1, 60),
      num("longBreakMin", "Long break", 1, 90),
      num("roundsBeforeLong", "Long every", 1, 12),
    ),
    check("autoContinue", "Start the next round automatically"),
    check("holdGames", "Ask before games during a focus session"),
    workHoursSection(),
  );
}

/** "5 h 0 min", "45 min". */
function formatHoursMinutes(minutes: number): string {
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** Focus → Work hours: work days and times; hidden while off (docs/INTERACTIONS.md). */
function workHoursSection(): Node {
  const w = settings.pomodoro.workHours;
  const update = (patch: Partial<WorkHours>) =>
    save({ pomodoro: { ...settings.pomodoro, workHours: { ...settings.pomodoro.workHours, ...patch } } });
  const later = debounced(update);
  return h(
    "div",
    { class: "work-hours" },
    h("h3", {}, "Work hours"),
    h(
      "div",
      { class: "box" },
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", checked: w.enabled, onchange: () => void update({ enabled: !w.enabled }) }),
        "Focus on work days: start by itself, stop after work",
      ),
      w.enabled
        ? h(
            "div",
            { class: "row spread" },
            dayPicker(w.days, (days) => later({ days })),
            h(
              "span",
              { class: "row" },
              timeField(w.start, (start) => later({ start }), "Work starts"),
              "–",
              timeField(w.end, (end) => later({ end }), "Work ends"),
            ),
          )
        : null,
      w.enabled
        ? h("p", { class: "hint" }, "Starts once a day when work starts (stopped by hand, it stays stopped). No new focus after work ends.")
        : null,
    ),
  );
}

// --- Characters -------------------------------------------------------------

async function preview(c: LoadedCharacter): Promise<HTMLCanvasElement> {
  const atlas = await SpriteAtlas.load(c.def.sprite, c.asset);
  const scale = Math.max(1, Math.floor(72 / Math.max(atlas.width, atlas.height)));
  const canvas = h("canvas", { width: atlas.width * scale + 8, height: atlas.height * scale + 8 });
  const ctx = canvas.getContext("2d")!;
  const idle = c.def.animations.idle.frames[0];
  atlas.draw(ctx, idle, canvas.width / 2, canvas.height - 4, scale, 1);
  return canvas;
}

const TIER_TEXT = { adoring: "Adores you", content: "Content", grumpy: "Grumpy", sulking: "Sulking" } as const;

function moodCard(m: Mood): Node {
  const bar = (label: string, value: number, cls: string) =>
    h(
      "div",
      { class: "meter", title: `${label} ${Math.round(value)}%` },
      h("span", {}, label),
      h("div", { class: "track" }, h("div", { class: `fill ${cls}`, style: `width:${Math.round(value)}%` })),
    );
  return h(
    "div",
    { class: "mood-card" },
    bar("♥", m.affection, "love"),
    bar("🍽", m.fullness, isHungry(m) ? "food hungry" : "food"),
    h("span", { class: "tier" }, `${TIER_TEXT[moodTier(m)]}${isHungry(m) ? " · hungry" : ""}`),
  );
}

async function renderCharacters(): Promise<Node> {
  const cards = await Promise.all(
    registry.list().map(async (c) =>
      h(
        "button",
        { class: `card ${c.def.id === settings.character ? "selected" : ""}`, onclick: () => void save({ character: c.def.id }) },
        await preview(c),
        h("strong", {}, c.def.displayName, c.source === "user" ? h("em", {}, " (custom)") : null),
        h("p", {}, c.def.description),
        h("div", { class: "chips" }, ...c.def.abilities.map((a) => h("span", { class: "chip", title: ABILITIES[a.id]?.description ?? "" }, a.id))),
        h("p", { class: "style" }, `🥊 ${c.def.moveset.style}`),
        moodCard(parseMood(await backend.loadMood(c.def.id))),
      ),
    ),
  );
  return h(
    "section",
    {},
    h("div", { class: "cards" }, ...cards),
    registry.issues.length
      ? h(
          "details",
          { class: "issues" },
          h("summary", {}, `${registry.issues.length} character(s) could not be loaded`),
          ...registry.issues.map((i) => h("pre", {}, `${i.source}\n  ${i.errors.join("\n  ")}`)),
        )
      : null,
    h(
      "p",
      { class: "hint" },
      "More animals are on the way. Make your own: copy a character folder, edit character.json, and drop it in ",
      h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), void backend.openUserCharactersFolder()) }, "your characters folder"),
      ".",
    ),
  );
}

// --- Games ------------------------------------------------------------------

async function renderGames(): Promise<Node> {
  const items = await Promise.all(
    GAMES.map(async (g) => {
      const top = g.available ? await backend.topScores(g.id, 3) : [];
      return h(
        "li",
        { class: "game" },
        h("div", {}, h("strong", {}, g.name), h("p", {}, g.description), top.length ? h("p", { class: "hint" }, `🏆 ${top.map((s) => `${s.score} (${s.character})`).join(" · ")}`) : null),
        g.available ? h("button", { class: "primary", onclick: () => void playGame(g.id) }, "Play") : h("span", { class: "soon" }, "Coming soon"),
      );
    }),
  );
  return h("section", {}, h("ul", { class: "games" }, ...items));
}

// --- Settings ---------------------------------------------------------------

async function renderSettings(): Promise<Node> {
  const slider = (key: "size" | "speed") => {
    const out = h("output", {}, `${settings[key].toFixed(2)}×`);
    return h(
      "label",
      { class: "row" },
      h("span", { class: "label" }, key === "size" ? "Size" : "Speed"),
      h("input", {
        type: "range",
        min: 0.5,
        max: 2,
        step: 0.05,
        value: settings[key],
        oninput: (e: Event) => (out.textContent = `${Number((e.target as HTMLInputElement).value).toFixed(2)}×`),
        onchange: (e: Event) => void save({ [key]: Number((e.target as HTMLInputElement).value) }),
      }),
      out,
    );
  };
  const q = settings.quietHours;
  // Grouped by what they're about: the pet, alarms & timers, to-dos, then the rest.
  return h(
    "section",
    { class: "settings" },
    h("h3", {}, "Pet"),
    h(
      "div",
      { class: "box" },
      slider("size"),
      slider("speed"),
      h("hr"),
      h(
        "div",
        { class: "row spread" },
        h(
          "label",
          { class: "check" },
          h("input", { type: "checkbox", checked: q.enabled, onchange: () => void save({ quietHours: { ...q, enabled: !q.enabled } }) }),
          "Quiet hours",
        ),
        h(
          "span",
          { class: "row" },
          timeField(q.start, debounced((start: string) => void save({ quietHours: { ...settings.quietHours, start } })), "Quiet from"),
          "–",
          timeField(q.end, debounced((end: string) => void save({ quietHours: { ...settings.quietHours, end } })), "Quiet until"),
        ),
      ),
      h("p", { class: "hint" }, "The pet stays calm: no running around. Reminders still come through."),
      h("hr"),
      ...hiddenAlertsRows(),
    ),
    h("h3", {}, "Alarms & timers"),
    alertBox("alarm"),
    h("h3", {}, "To-do reminders"),
    alertBox("todo"),
    h("h3", {}, "General"),
    h(
      "div",
      { class: "box" },
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          checked: settings.autostart,
          onchange: async () => {
            await backend.setAutostart(!settings.autostart);
            await save({ autostart: !settings.autostart });
          },
        }),
        "Start with my computer",
      ),
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", checked: settings.sound, onchange: () => void save({ sound: !settings.sound }) }),
        "Other sounds (petting, focus sessions)",
      ),
    ),
    h(
      "footer",
      {},
      `${product.productName} ${version} · ${product.publisher} · ${await backend.storefront()} build · `,
      h("a", { href: product.website, target: "_blank" }, product.website),
    ),
  );
}

/**
 * Pet → "When hidden, it comes out for" (docs/INTERACTIONS.md). There are no system
 * notifications, so anything unticked can't reach you while the pet is hidden: say so in red.
 */
function hiddenAlertsRows(): Node[] {
  const ha = settings.hiddenAlerts;
  const box = (key: keyof HiddenAlerts, text: string) =>
    h(
      "label",
      { class: "check" },
      h("input", { type: "checkbox", checked: ha[key], onchange: () => void save({ hiddenAlerts: { ...ha, [key]: !ha[key] } }) }),
      text,
    );
  const warning = hiddenWarning(ha);
  return [
    h("div", { class: "subhead" }, "When hidden, it comes out for"),
    h(
      "div",
      { class: "pair hidden-alerts" },
      box("alarms", "Alarms"),
      box("timers", "Timers"),
      box("todos", "To-do reminders"),
      box("focus", "Focus sessions"),
    ),
    warning ? h("p", { class: "warning" }, h("strong", {}, `❗ ${warning}`), " Show your pet, or tick them above, to get them again.") : null,
    h("p", { class: "hint" }, "It comes out, rings, and goes back once you answer. Anything nobody answered waits until you show it."),
  ].filter((n) => n !== null) as Node[];
}

/** One alert kind: ring (tone, preview, volume), and for alarms how long and what if nobody answers. */
function alertBox(kind: "alarm" | "todo"): Node {
  const a = settings.alerts[kind];
  const update = (patch: Partial<AlertSettings>) => save({ alerts: { ...settings.alerts, [kind]: { ...a, ...patch } } });
  const tone = h(
    "select",
    { onchange: (e: Event) => void update({ ringtone: (e.target as HTMLSelectElement).value as RingtoneId }) },
    ...RINGTONE_IDS.map((id) => h("option", { value: id, selected: id === a.ringtone }, RINGTONES[id].name)),
  );
  const volume = h("input", {
    type: "range",
    min: 0,
    max: 1,
    step: 0.05,
    value: a.volume,
    title: "Volume",
    onchange: (e: Event) => void update({ volume: Number((e.target as HTMLInputElement).value) }),
  });
  return h(
    "div",
    { class: "box alert" },
    h(
      "div",
      { class: "row" },
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: a.ring, onchange: () => void update({ ring: !a.ring }) }), "Ring"),
      tone,
      h("button", { title: "Preview", onclick: () => playRingtone(tone.value as RingtoneId, Number(volume.value)) }, "▶"),
      h("span", { class: "hint" }, "🔈"),
      volume,
    ),
    kind === "alarm" ? unansweredRow(a, update) : null,
    h(
      "label",
      { class: "check" },
      h("input", { type: "checkbox", checked: a.petRuns, onchange: () => void update({ petRuns: !a.petRuns }) }),
      "Pet comes to the middle of the screen",
    ),
    kind === "alarm" ? upcomingRow() : null,
    kind === "alarm" ? h("p", { class: "hint" }, "Timers never snooze: a missed one leaves a quiet ⏱ note by the pet for an hour.") : null,
  );
}

/** Alarm-only: a 🔔 badge by the pet for alarms coming up soon. */
function upcomingRow(): Node {
  const u = settings.upcomingAlarms;
  return h(
    "label",
    { class: "check upcoming" },
    h("input", { type: "checkbox", checked: u.show, onchange: () => void save({ upcomingAlarms: { ...u, show: !u.show } }) }),
    "Show alarms due within",
    h("input", {
      type: "number",
      min: 1,
      max: 120,
      value: u.minutes,
      disabled: !u.show,
      title: "1–120 minutes",
      onchange: (e: Event) => {
        const input = e.target as HTMLInputElement;
        const minutes = clampUpcomingMinutes(input.value);
        input.value = String(minutes);
        void save({ upcomingAlarms: { ...u, minutes } });
      },
    }),
    "min by the pet",
  );
}

const RING_LENGTHS = [
  [30, "30 seconds"],
  [60, "1 minute"],
  [120, "2 minutes"],
  [300, "5 minutes"],
] as const;

/** Snooze length × automatic snoozes; 0 snoozes = just stop and mark it missed. */
const UNANSWERED = [
  [5, 3, "Snooze 5 min × 3"],
  [10, 3, "Snooze 10 min × 3"],
  [5, 5, "Snooze 5 min × 5"],
  [5, 0, "Mark as missed"],
] as const;

/** Alarm-only: how long to ring and what happens when nobody answers, side by side. */
function unansweredRow(a: AlertSettings, update: (p: Partial<AlertSettings>) => void): Node {
  const current = UNANSWERED.findIndex(([m, n]) => (n === 0 ? a.autoSnoozeMax === 0 : m === a.snoozeMinutes && n === a.autoSnoozeMax));
  return h(
    "div",
    { class: "pair labelled" },
    h(
      "label",
      {},
      "Ring for",
      h(
        "select",
        { onchange: (e: Event) => update({ ringSeconds: Number((e.target as HTMLSelectElement).value) }) },
        ...RING_LENGTHS.map(([sec, text]) => h("option", { value: sec, selected: sec === a.ringSeconds }, text)),
      ),
    ),
    h(
      "label",
      {},
      "If nobody answers",
      h(
        "select",
        {
          onchange: (e: Event) => {
            const [minutes, max] = UNANSWERED[Number((e.target as HTMLSelectElement).value)];
            update({ snoozeMinutes: minutes, autoSnoozeMax: max });
          },
        },
        ...UNANSWERED.map(([, , text], i) => h("option", { value: i, selected: i === current }, text)),
      ),
    ),
  );
}

async function save(patch: Partial<Settings>) {
  settings = await backend.setSettings(patch);
}

async function main() {
  document.title = product.productName;
  registry = loadBundled();
  try {
    loadUser(await backend.listUserCharacters(), backend.assetUrl, registry);
  } catch {
    // Missing folder is fine.
  }
  settings = await backend.getSettings();
  for (const t of TABS) nav.append(h("button", { "data-tab": t.id, onclick: () => select(t.id) }, t.label));

  await backend.on("todos-changed", () => current === "todos" && void render());
  await backend.on("alarms-changed", () => current === "alarms" && void render());
  await backend.on("pomodoro", () => current === "focus" && void render());
  await backend.on("settings", (s) => {
    settings = s;
    // Not while a time field or day picker is being used: rebuilding would drop the drag.
    if (document.activeElement?.closest(".time-field, .day-picker")) return;
    if (["characters", "focus", "settings", "alarms"].includes(current)) void render();
  });
  await backend.on("panel-tab", (tab) => select(tab));
  await backend.on("mood", () => current === "characters" && void render());

  const initial = location.hash.slice(1) as PanelTab;
  select(TABS.some((t) => t.id === initial) ? initial : "todos");
}

void main();
