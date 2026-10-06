import { version } from "../../package.json";
import product from "../../product.config.json";
import { isHungry, moodTier, parseMood, type Mood } from "../brain/mood";
import { ABILITIES } from "../characters/abilities";
import { copyOf, loadAll, type CharacterRegistry, type LoadedCharacter } from "../characters/registry";
import { SpriteAtlas } from "../engine/sprites";
import { formatRemaining, gameHeld } from "../features/pomodoro/logic";
import { alarmName, clock, DEFAULT_ALARM_LABEL } from "../features/alarm/ringing";
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
import { TODO_REPEATS } from "../features/todo/repeat";
import {
  daysUntil,
  ICONS,
  KINDS,
  LEADS,
  leadLabel,
  nextAnniversary,
  TEMPLATES,
  untilText,
  yearsText,
  musicChoices,
  musicFor,
  type AnniversaryKind,
} from "../features/anniversary/templates";
import { GAMES } from "../features/games/catalog";
import {
  backend,
  clampUpcomingMinutes,
  WEEKDAYS,
  type Alarm,
  type AlertSettings,
  type Anniversary,
  type AnniversaryPrep,
  type NewAnniversary,
  type HiddenAlerts,
  type PanelTab,
  type Settings,
  type Todo,
  type TodoPatch,
  type TodoRepeat,
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
  draftFor,
  type AlarmDraft,
} from "./alarmText";
import { dayPicker } from "./dayPicker";
import { formatHm, parseHm, timeField } from "./timeField";
import { formatDay, formatWhen, h } from "./dom";
import { dateField, ymdOf, ymdToMs } from "./dateField";
import { repeatBadge, splitTodos, todoHint, todoWhen } from "./todoText";

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
/** The alarm being set up or edited (✎), kept across re-renders of the Alarms tab. */
let alarmDraft: AlarmDraft | null = null;

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
  if (tab === "todos") {
    todoDraft = null;
    annDraft = null;
    todoSub = "todos";
  }
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

/**
 * The to-do being added or edited (✎), kept across re-renders of the To-dos tab. `date` is
 * "YYYY-MM-DD" (null: no day), `time` "HH:MM" (null: any time that day). `touched`: the
 * date/time/repeat row was changed by hand, so typing no longer refills it.
 */
interface TodoDraft {
  text: string;
  date: string | null;
  time: string | null;
  repeat: TodoRepeat;
  touched: boolean;
  editing: number | null;
}
let todoDraft: TodoDraft | null = null;

const newTodoDraft = (): TodoDraft => ({ text: "", date: null, time: null, repeat: "none", touched: false, editing: null });

/** The next whole hour, for "+ Time". */
function nextHourHm(): string {
  return formatHm((new Date().getHours() + 1) % 24, 0);
}

/** The To-dos tab's sub-page: the to-dos (where it opens) or 🎂 Anniversaries. */
let todoSub: "todos" | "anniversaries" = "todos";

/** [To-dos] [🎂 Anniversaries · 1]: the count is how many come within a week. */
function todoSubtabs(anniversaries: Anniversary[]): Node {
  const soon = anniversaries.filter((a) => daysUntil(nextAnniversary(a.month, a.day)) <= 7).length;
  const tab = (id: typeof todoSub, label: string, count = 0) =>
    h(
      "button",
      {
        class: todoSub === id ? "on" : "",
        onclick: () => {
          todoSub = id;
          void render();
        },
      },
      label,
      count ? h("span", { class: "n" }, String(count)) : null,
    );
  return h("div", { class: "subtabs" }, tab("todos", "To-dos"), tab("anniversaries", "🎂 Anniversaries", soon));
}

async function renderTodos(): Promise<Node> {
  const anniversaries = await backend.listAnniversaries();
  if (todoSub === "anniversaries") return renderAnniversaries(anniversaries);
  const todos = await backend.listTodos();
  // The to-do being edited was deleted or ticked off elsewhere: back to a new one.
  if (todoDraft?.editing != null && !todos.some((t) => t.id === todoDraft?.editing && !t.done)) todoDraft = null;
  todoDraft ??= newTodoDraft();
  const draft = todoDraft;
  const editingTodo = todos.find((t) => t.id === draft.editing) ?? null;
  const startEdit = (t: Todo) => {
    todoDraft = {
      text: t.title,
      date: t.dueAt === null ? null : ymdOf(t.dueAt),
      time: t.dueAt === null || t.allDay ? null : formatHm(new Date(t.dueAt).getHours(), new Date(t.dueAt).getMinutes()),
      repeat: t.repeat,
      touched: true,
      editing: t.id,
    };
    void render();
  };
  const stopEdit = () => {
    todoDraft = null;
    void render();
  };

  // What the form will save: typed text is parsed for a new to-do; an edited one keeps its words.
  const parsed = () => parseQuickAdd(draft.text);
  const title = () => (editingTodo ? draft.text.trim() : parsed().title);
  const dueAt = () => {
    if (draft.date === null) return null;
    const day = ymdToMs(draft.date);
    if (draft.time === null) return day;
    const { h: hh, m } = parseHm(draft.time);
    return day + (hh * 60 + m) * 60_000;
  };
  const allDay = () => draft.date !== null && draft.time === null;
  const repeat = () => (draft.date === null ? "none" : draft.repeat);

  const input = h("input", {
    type: "text",
    placeholder: editingTodo ? "To-do" : "e.g. bins every tue · call mom at 3pm · pay bills monthly 1st",
    value: draft.text,
  });
  const hint = h("div", { class: "hint" });
  const whenRow = h("div", { class: "row when-row" });
  const showHint = () => {
    hint.textContent = todoHint(title(), dueAt(), allDay(), repeat(), settings.todoDayTime);
  };
  const changed = () => {
    draft.touched = true;
    paintWhen();
    showHint();
  };
  const mini = (label: string, onclick: () => void) => h("button", { class: "mini", title: label, onclick }, "✕");
  /** 📅 date (or "+ Date"), time (or "+ Time"), repeat. */
  const paintWhen = () => {
    const parts: Node[] = [];
    if (draft.date === null) {
      parts.push(h("button", { class: "add-when", onclick: () => ((draft.date = ymdOf(Date.now())), changed()) }, "+ Date"));
    } else {
      const df = dateField(draft.date, (v) => ((draft.date = v), (draft.touched = true), showHint()), "Day");
      df.append(mini("No date", () => ((draft.date = null), (draft.time = null), changed())));
      parts.push(df);
      if (draft.time === null) {
        parts.push(h("button", { class: "add-when", onclick: () => ((draft.time = nextHourHm()), changed()) }, "+ Time"));
      } else {
        const tf = timeField(draft.time, (v) => ((draft.time = v), (draft.touched = true), showHint()), "Time");
        tf.append(mini("No time (any time that day)", () => ((draft.time = null), changed())));
        parts.push(tf);
      }
    }
    parts.push(
      h(
        "select",
        {
          class: "repeat",
          title: draft.date === null ? "Pick a day to repeat from" : "Repeat",
          disabled: draft.date === null,
          onchange: (e: Event) => ((draft.repeat = (e.target as HTMLSelectElement).value as TodoRepeat), changed()),
        },
        ...TODO_REPEATS.map(([v, text]) => h("option", { value: v, selected: repeat() === v }, text)),
      ),
    );
    whenRow.replaceChildren(...parts);
  };
  // Typing fills the row (a day, a time, "every tue"…) until it's changed by hand.
  input.addEventListener("input", () => {
    draft.text = input.value;
    if (!editingTodo && !draft.text.trim()) Object.assign(draft, { date: null, time: null, repeat: "none", touched: false });
    else if (!editingTodo && !draft.touched) {
      const q = parsed();
      draft.date = q.dueAt === null ? null : ymdOf(q.dueAt);
      draft.time = q.dueAt === null || q.allDay ? null : formatHm(new Date(q.dueAt).getHours(), new Date(q.dueAt).getMinutes());
      draft.repeat = q.repeat;
    }
    paintWhen();
    showHint();
  });
  const add = async () => {
    const name = title();
    if (!name) return;
    const due = dueAt();
    if (editingTodo) {
      // Only what changed: a new day restarts a repeating to-do's count from it.
      const patch: TodoPatch = { title: name, allDay: allDay() };
      if (due !== editingTodo.dueAt) patch.dueAt = due;
      if (repeat() !== editingTodo.repeat) patch.repeat = repeat();
      await backend.updateTodo(editingTodo.id, patch);
      stopEdit();
      return;
    }
    await backend.addTodo({ title: name, dueAt: due, allDay: allDay(), repeat: repeat() });
    // The pet confirms what it heard.
    void backend.emit("pet-event", { type: "todoAdded", title: name, dueAt: due, allDay: allDay() });
    todoDraft = newTodoDraft();
    void render();
  };
  input.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && void add());
  queueMicrotask(() => {
    if (!document.activeElement || document.activeElement === document.body) input.focus();
  });
  paintWhen();
  showHint();

  const { today, upcoming, done } = splitTodos(todos, settings.todoDayTime);
  const row = (t: Todo) => {
    const when = t.done ? null : todoWhen(t);
    const badge = t.done ? "" : repeatBadge(t.repeat);
    return h(
      "li",
      { class: `${t.done ? "done" : ""} ${t.id === draft.editing ? "editing" : ""}` },
      h("input", {
        type: "checkbox",
        checked: t.done,
        onchange: () => {
          void backend.updateTodo(t.id, { done: !t.done });
          if (!t.done) void backend.emit("pet-event", { type: "todoDone" });
        },
      }),
      h("span", { class: "title" }, t.title),
      // Its reminder time (or day) has passed, answered or not, or while ePet wasn't running.
      when || badge
        ? h(
            "span",
            { class: `when ${when?.overdue ? "overdue" : ""}` },
            badge ? h("span", { class: "rep" }, badge) : null,
            when?.text ?? "",
          )
        : null,
      t.done && t.doneAt ? h("span", { class: "when" }, `Done · ${formatWhen(t.doneAt)}`) : null,
      t.done ? null : h("button", { class: "icon edit", title: "Edit", onclick: () => startEdit(t) }, "✎"),
      h("button", { class: "icon delete", title: "Delete", onclick: () => void backend.deleteTodo(t.id) }, "✕"),
    );
  };

  return h(
    "section",
    { class: "todos" },
    todoSubtabs(anniversaries),
    editingTodo
      ? h(
          "div",
          { class: "edit-head" },
          h("h3", {}, `Edit to-do · ${editingTodo.title}`),
          h("button", { class: "link", onclick: stopEdit }, "Cancel"),
        )
      : null,
    h("div", { class: "row" }, input, h("button", { class: "primary", onclick: add }, editingTodo ? "Save" : "Add")),
    whenRow,
    hint,
    h("h3", {}, `Today (${today.length})`),
    today.length ? h("ul", { class: "list" }, ...today.map(row)) : h("p", { class: "empty" }, "Nothing for today. Your pet approves."),
    upcoming.length ? upcomingSection(upcoming, row) : null,
    done.length ? finishedSection(`Done (${done.length})`, done.map(row), () => backend.clearDoneTodos()) : null,
    h("p", { class: "hint" }, "Done to-dos are cleared automatically each day. Ticking a repeating one moves it to its next day; untick it in Done to undo."),
  );
}

// --- Anniversaries (the To-dos tab's second sub-page) ----------------------------

/** The anniversary being added or edited (✎); the touched flags keep what was changed by hand. */
interface AnniversaryDraft {
  kind: AnniversaryKind;
  icon: string;
  name: string;
  date: string;
  since: string;
  preps: AnniversaryPrep[];
  effect: boolean;
  /** The piece chosen in the form; null: the type's default. */
  music: string | null;
  iconTouched: boolean;
  prepsTouched: boolean;
  effectTouched: boolean;
  editing: number | null;
}
let annDraft: AnniversaryDraft | null = null;

function newAnniversaryDraft(kind: AnniversaryKind = "birthday"): AnniversaryDraft {
  const t = TEMPLATES[kind];
  return {
    kind,
    icon: t.icon,
    name: "",
    date: ymdOf(Date.now()).replace(/^\d{4}/, "2000"),
    since: "",
    preps: t.preps.map((p) => ({ ...p })),
    effect: t.effect,
    music: null,
    iconTouched: false,
    prepsTouched: false,
    effectTouched: false,
    editing: null,
  };
}

function renderAnniversaries(list: Anniversary[]): Node {
  if (annDraft?.editing != null && !list.some((a) => a.id === annDraft?.editing)) annDraft = null;
  annDraft ??= newAnniversaryDraft();
  const draft = annDraft;
  const editingAnn = list.find((a) => a.id === draft.editing) ?? null;
  const redraw = () => void render();
  const stopEdit = () => {
    annDraft = null;
    redraw();
  };

  // Type: fills in what wasn't changed by hand.
  const type = h(
    "select",
    {
      class: "ann-type",
      onchange: (e: Event) => {
        const kind = (e.target as HTMLSelectElement).value as AnniversaryKind;
        const t = TEMPLATES[kind];
        draft.kind = kind;
        if (!draft.iconTouched) draft.icon = t.icon;
        if (!draft.prepsTouched) draft.preps = t.preps.map((p) => ({ ...p }));
        if (!draft.effectTouched) draft.effect = t.effect;
        // A happy piece doesn't carry over to a remembrance, nor the other way.
        if (!musicChoices(kind).some((p) => p.id === draft.music)) draft.music = null;
        redraw();
      },
    },
    ...KINDS.map((k) => h("option", { value: k, selected: k === draft.kind }, `${TEMPLATES[k].icon} ${TEMPLATES[k].label}`)),
  );
  const grid = h(
    "div",
    { class: "icon-grid", hidden: true },
    ...ICONS.map((icon) =>
      h(
        "button",
        {
          class: icon === draft.icon ? "on" : "",
          title: icon,
          onclick: () => {
            draft.icon = icon;
            draft.iconTouched = true;
            redraw();
          },
        },
        icon,
      ),
    ),
  );
  const iconButton = h("button", { class: "icon-pick", title: "Choose an icon", onclick: () => (grid.hidden = !grid.hidden) }, draft.icon);
  const name = h("input", {
    type: "text",
    class: "ann-name",
    placeholder: TEMPLATES[draft.kind].placeholder,
    value: draft.name,
    oninput: (e: Event) => (draft.name = (e.target as HTMLInputElement).value),
  });
  const date = dateField(draft.date, (v) => (draft.date = v), "Day", { year: false });
  const since = h("input", {
    type: "number",
    class: "since",
    min: 1900,
    max: new Date().getFullYear(),
    placeholder: "year",
    value: draft.since,
    title: "The year it began (optional), for “36th”",
    oninput: (e: Event) => (draft.since = (e.target as HTMLInputElement).value),
  });
  const prepRows = draft.preps.map((p, i) =>
    h(
      "div",
      { class: "row prep" },
      h(
        "select",
        {
          class: "lead",
          onchange: (e: Event) => ((p.lead = (e.target as HTMLSelectElement).value), (draft.prepsTouched = true)),
        },
        ...LEADS.map(([k, label]) => h("option", { value: k, selected: k === p.lead }, label)),
      ),
      h("input", {
        type: "text",
        placeholder: "e.g. Order a cake",
        value: p.label,
        oninput: (e: Event) => ((p.label = (e.target as HTMLInputElement).value), (draft.prepsTouched = true)),
      }),
      h(
        "button",
        {
          class: "mini",
          title: "Remove",
          onclick: () => {
            draft.preps.splice(i, 1);
            draft.prepsTouched = true;
            redraw();
          },
        },
        "✕",
      ),
    ),
  );
  const remembrance = draft.kind === "remembrance";
  const effect = h(
    "label",
    { class: "check" },
    h("input", {
      type: "checkbox",
      checked: draft.effect,
      onchange: () => ((draft.effect = !draft.effect), (draft.effectTouched = true)),
    }),
    remembrance ? "Candle and flowers on the day 🕯️" : "Fireworks on the day 🎆",
    settings.celebrate.enabled ? null : h("small", { class: "hint" }, " · off in Settings"),
  );
  // Music: Birthday and Wedding always play their own; the others choose by mood.
  const piece = musicFor(draft);
  const musicOff = settings.celebrate.music ? null : h("small", { class: "hint" }, " · off in Settings");
  const music = TEMPLATES[draft.kind].musicFixed
    ? h("div", { class: "row" }, h("span", { class: "lbl" }, "Music"), h("span", { class: "fixed-music" }, `🎵 ${piece.name}`), musicOff)
    : h(
        "div",
        { class: "row" },
        h("span", { class: "lbl" }, "Music"),
        h(
          "select",
          {
            class: "ann-music",
            onchange: (e: Event) => (draft.music = (e.target as HTMLSelectElement).value),
          },
          ...musicChoices(draft.kind).map((p) => h("option", { value: p.id, selected: p.id === piece.id }, p.name)),
        ),
        musicOff,
      );
  /** What the form holds, as it would be saved. */
  const formAnniversary = (): NewAnniversary => {
    const [, mm, dd] = draft.date.split("-").map(Number);
    const year = Number(draft.since);
    return {
      kind: draft.kind,
      icon: draft.icon,
      name: draft.name.trim(),
      month: mm,
      day: dd,
      since: Number.isInteger(year) && year >= 1900 && year <= new Date().getFullYear() ? year : null,
      preps: draft.preps.filter((p) => p.label.trim()),
      effect: draft.effect,
      music: TEMPLATES[draft.kind].musicFixed ? null : draft.music,
    };
  };
  // "▶ Preview" plays the day's celebration as the form stands (unsaved is fine; no name yet
  // borrows the template's name for it).
  const preview = () => {
    const a = formAnniversary();
    void backend.previewCelebration({ ...a, name: a.name || TEMPLATES[draft.kind].label });
  };
  const save = async () => {
    const a = formAnniversary();
    if (!a.name) {
      name.focus();
      return;
    }
    if (editingAnn) await backend.updateAnniversary(editingAnn.id, a);
    else await backend.addAnniversary(a);
    annDraft = null;
    redraw();
  };
  const startEdit = (a: Anniversary) => {
    annDraft = {
      kind: (a.kind in TEMPLATES ? a.kind : "custom") as AnniversaryKind,
      icon: a.icon,
      name: a.name,
      date: `2000-${String(a.month).padStart(2, "0")}-${String(a.day).padStart(2, "0")}`,
      since: a.since === null ? "" : String(a.since),
      preps: a.preps.map((p) => ({ ...p })),
      effect: a.effect,
      music: a.music,
      iconTouched: true,
      prepsTouched: true,
      effectTouched: true,
      editing: a.id,
    };
    redraw();
  };

  const upcoming = list
    .map((a) => ({ a, on: nextAnniversary(a.month, a.day) }))
    .sort((x, y) => x.on.getTime() - y.on.getTime() || x.a.id - y.a.id);
  const row = ({ a, on }: { a: Anniversary; on: Date }) => {
    const days = daysUntil(on);
    const years = a.since !== null && on.getFullYear() - a.since > 0 ? on.getFullYear() - a.since : null;
    const when = `${on.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${untilText(days)}`;
    return h(
      "li",
      { class: `ann ${a.id === draft.editing ? "editing" : ""}` },
      h("span", { class: "ann-icon" }, a.icon),
      h(
        "span",
        { class: "main" },
        h("span", { class: "title" }, a.name),
        h("span", { class: "sub" }, h("span", { class: days <= 7 ? "soon" : "" }, when), years ? ` · ${yearsText(a.kind, years)}` : ""),
        a.preps.length
          ? h("span", { class: "preps" }, a.preps.map((p) => `${leadLabel(p.lead)} before: ${p.label}`).join(" · "))
          : null,
      ),
      h(
        "button",
        { class: "icon edit", title: "Preview its day's celebration", onclick: () => void backend.previewCelebration(a) },
        "▶",
      ),
      h("button", { class: "icon edit", title: "Edit", onclick: () => startEdit(a) }, "✎"),
      h("button", { class: "icon delete", title: "Delete (its to-dos stay)", onclick: () => void backend.deleteAnniversary(a.id) }, "✕"),
    );
  };

  return h(
    "section",
    { class: "todos anniversaries" },
    todoSubtabs(list),
    editingAnn
      ? h(
          "div",
          { class: "edit-head" },
          h("h3", {}, `Edit anniversary · ${editingAnn.name}`),
          h("button", { class: "link", onclick: stopEdit }, "Cancel"),
        )
      : h("h3", {}, "New anniversary"),
    h(
      "div",
      { class: "ann-form" },
      h("div", { class: "row" }, h("span", { class: "lbl" }, "Type"), type),
      h("div", { class: "row" }, iconButton, name),
      grid,
      h("div", { class: "row" }, h("span", { class: "lbl" }, "Date"), date, h("span", { class: "lbl short" }, "Since"), since),
      h("div", { class: "lbl" }, "Remind before"),
      ...prepRows,
      draft.preps.length < 3
        ? h(
            "button",
            {
              class: "link add-more",
              onclick: () => {
                draft.preps.push({ lead: "1d", label: "" });
                draft.prepsTouched = true;
                redraw();
              },
            },
            "+ Add another",
          )
        : null,
      effect,
      music,
      h(
        "div",
        { class: "row end" },
        h("button", { class: "preview", title: "Play its day's celebration now", onclick: preview }, "▶ Preview"),
        h("button", { class: "primary", onclick: () => void save() }, editingAnn ? "Save" : "Add"),
      ),
    ),
    h("h3", {}, "Anniversaries"),
    upcoming.length ? h("ul", { class: "list" }, ...upcoming.map(row)) : h("p", { class: "empty" }, "No anniversaries yet."),
    h("p", { class: "hint" }, "Each reminder becomes a to-do on its day. On the day itself your pet celebrates."),
  );
}

// --- Alarms -----------------------------------------------------------------

async function renderAlarms(): Promise<Node> {
  const alarms = await backend.listAlarms();
  // The alarm being edited was deleted (here or by the pet): back to a new one.
  if (alarmDraft?.editing != null && !alarms.some((a) => a.id === alarmDraft?.editing)) alarmDraft = null;
  alarmDraft ??= { time: nowHm(), choice: "none", days: WEEKDAYS, label: "", editing: null };
  const draft = alarmDraft;
  const editingAlarm = alarms.find((a) => a.id === draft.editing) ?? null;
  // ✎ fills the form; Save sets the alarm again, Cancel goes back to a new alarm.
  const startEdit = (a: Alarm) => {
    alarmDraft = draftFor(a);
    void render();
  };
  const stopEdit = () => {
    alarmDraft = null;
    void render();
  };
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
  const addButton = h("button", { class: "primary", onclick: () => void add() }, editingAlarm ? "Save" : "Add");
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
    const name = label.value.trim() || DEFAULT_ALARM_LABEL;
    if (editingAlarm) {
      // Set again: it switches on, and its old snooze or skipped ring is forgotten.
      await backend.updateAlarm(editingAlarm.id, name, d.getTime(), r.repeat, r.days);
      stopEdit();
      return;
    }
    await backend.addAlarm(name, d.getTime(), r.repeat, r.days);
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
      { class: `clock-row ${a.enabled ? "" : "off"} ${a.id === draft.editing ? "editing" : ""}` },
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
      h("button", { class: "icon edit", title: "Edit", onclick: () => startEdit(a) }, "✎"),
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
    editingAlarm
      ? h(
          "div",
          { class: "edit-head" },
          h("h3", {}, `Edit alarm · ${alarmName(editingAlarm)}`),
          h("button", { class: "link", onclick: stopEdit }, "Cancel"),
        )
      : h("h3", {}, "New alarm"),
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
const UPCOMING_OPEN_KEY = "todos.upcomingOpen";

/**
 * To-dos from tomorrow on, folded away by default ("Upcoming (2) · next Tue, 6 Oct"); open or
 * closed is remembered on this computer.
 */
function upcomingSection(list: Todo[], row: (t: Todo) => Node): Node {
  let open = false;
  try {
    open = localStorage.getItem(UPCOMING_OPEN_KEY) === "1";
  } catch {
    // No storage: folded.
  }
  const first = list[0].dueAt;
  const next = first === null ? "" : ` · next ${list[0].allDay ? formatDay(first) : formatWhen(first)}`;
  const section = h(
    "details",
    { class: "finished upcoming", open },
    h("summary", {}, h("span", {}, `Upcoming (${list.length})${next}`)),
    h("ul", { class: "list" }, ...list.map(row)),
  );
  section.addEventListener("toggle", () => {
    try {
      localStorage.setItem(UPCOMING_OPEN_KEY, section.open ? "1" : "0");
    } catch {
      // Not remembered; fine.
    }
  });
  return section;
}

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
  // "Make a copy": a new folder in the characters folder, opened, and loaded straight away.
  const copy = (c: LoadedCharacter) => {
    const { json } = copyOf(c, registry);
    void backend.copyCharacter(json, c.source === "user" ? (c.dir ?? null) : null);
  };
  const cards = await Promise.all(
    registry.list().map(async (c) =>
      h(
        "div",
        { class: "card-wrap" },
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
        h(
          "button",
          { class: "link copy", title: "Copy it into your characters folder to make your own", onclick: () => copy(c) },
          "⧉ Make a copy",
        ),
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
          { class: "issues", open: true },
          h("summary", {}, `${registry.issues.length} character(s) could not be loaded`),
          ...registry.issues.map((i) => h("pre", {}, `${i.source}\n  ${i.errors.join("\n  ")}`)),
        )
      : null,
    h(
      "p",
      { class: "hint" },
      "More animals are on the way. Make your own: “⧉ Make a copy” of one above, edit its character.json in ",
      h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), void backend.openUserCharactersFolder()) }, "your characters folder"),
      " (its README explains everything), then reload.",
    ),
    h("button", { class: "reload", title: "Read your characters folder again", onclick: () => void backend.reloadCharacters() }, "⟳ Reload characters"),
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
      box("anniversaries", "Anniversaries"),
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
    kind === "todo"
      ? h(
          "div",
          { class: "row day-time" },
          "To-dos without a time remind you at",
          timeField(settings.todoDayTime, debounced((todoDayTime: string) => void save({ todoDayTime })), "Day reminder time"),
        )
      : null,
    kind === "todo" ? celebrateRow() : null,
    kind === "alarm" ? h("p", { class: "hint" }, "Timers never snooze: a missed one leaves a quiet ⏱ note by the pet for an hour.") : null,
  );
}

/** Anniversaries on screen: on or off, and for how long (10–60 s). */
function celebrateRow(): Node {
  const c = settings.celebrate;
  return h(
    "div",
    {},
    h(
      "label",
      { class: "check celebrate" },
      h("input", { type: "checkbox", checked: c.enabled, onchange: () => void save({ celebrate: { ...c, enabled: !c.enabled } }) }),
      "Celebrate anniversaries on screen for",
      h("input", {
        type: "number",
        min: 10,
        max: 60,
        value: c.seconds,
        disabled: !c.enabled,
        title: "10–60 seconds",
        onchange: (e: Event) => {
          const input = e.target as HTMLInputElement;
          const seconds = Math.min(60, Math.max(10, Math.round(Number(input.value)) || 15));
          input.value = String(seconds);
          void save({ celebrate: { ...c, seconds } });
        },
      }),
      "s",
    ),
    h(
      "div",
      { class: "row celebrate-music" },
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", checked: c.music, onchange: () => void save({ celebrate: { ...c, music: !c.music } }) }),
        "Play music with it",
      ),
      h("span", { class: "hint" }, "🔈"),
      h("input", {
        type: "range",
        min: 0,
        max: 1,
        step: 0.05,
        value: c.musicVolume,
        disabled: !c.music,
        title: "Music volume",
        onchange: (e: Event) => void save({ celebrate: { ...c, musicVolume: Number((e.target as HTMLInputElement).value) } }),
      }),
    ),
    h(
      "p",
      { class: "hint" },
      "Fireworks, or a candle and flowers for a remembrance. Each anniversary can turn its own off; when this is off, your pet just says it. " +
        "The music is chosen with each anniversary (▶ Preview plays it).",
    ),
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
  registry = await loadAll(() => backend.listUserCharacters(), backend.assetUrl);
  settings = await backend.getSettings();
  for (const t of TABS) nav.append(h("button", { "data-tab": t.id, onclick: () => select(t.id) }, t.label));

  await backend.on("todos-changed", () => current === "todos" && void render());
  await backend.on("anniversaries-changed", () => current === "todos" && void render());
  await backend.on("characters-changed", async () => {
    registry = await loadAll(() => backend.listUserCharacters(), backend.assetUrl);
    if (current === "characters") void render();
  });
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
