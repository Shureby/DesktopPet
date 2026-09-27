import product from "../../product.config.json";
import { isHungry, moodTier, parseMood, type Mood } from "../brain/mood";
import { ABILITIES } from "../characters/abilities";
import { loadBundled, loadUser, type CharacterRegistry, type LoadedCharacter } from "../characters/registry";
import { SpriteAtlas } from "../engine/sprites";
import { formatRemaining } from "../features/pomodoro/logic";
import { timerLabel } from "../features/alarm/timers";
import { parseQuickAdd } from "../features/todo/quickAdd";
import { GAMES } from "../features/games/catalog";
import { backend, type AlertSettings, type PanelTab, type Repeat, type Settings } from "../platform";
import { playRingtone, RINGTONE_IDS, RINGTONES, type RingtoneId } from "../pet/sound";
import "../styles/panel.css";
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

function select(tab: PanelTab) {
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
  const done = todos.filter((t) => t.done).reverse();
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
      t.dueAt && !t.done ? h("span", { class: "when" }, formatWhen(t.dueAt)) : null,
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
  const label = h("input", { type: "text", placeholder: "Label (optional)" });
  const time = h("input", { type: "time", value: "07:30" });
  const repeat = h(
    "select",
    {},
    h("option", { value: "none" }, "Once"),
    h("option", { value: "daily" }, "Every day"),
    h("option", { value: "weekdays" }, "Weekdays"),
  );
  const add = async () => {
    const [hh, mm] = time.value.split(":").map(Number);
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    while (repeat.value === "weekdays" && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + 1);
    await backend.addAlarm(label.value.trim() || `Alarm ${time.value}`, d.getTime(), repeat.value as Repeat);
    label.value = "";
  };
  const timer = (m: number) => h("button", { onclick: () => void backend.addAlarm(timerLabel(m), Date.now() + m * 60_000, "none") }, `${m}m`);
  const repeatText: Record<Repeat, string> = { none: "Once", daily: "Every day", weekdays: "Weekdays" };
  const now = Date.now();
  // A one-shot alarm is finished once its time has passed (repeating ones never finish).
  const isFinished = (a: (typeof alarms)[number]) => a.repeat === "none" && (a.nextFire === null || a.nextFire <= now);
  const upcoming = alarms.filter((a) => !isFinished(a));
  const finished = alarms.filter(isFinished);
  const row = (a: (typeof alarms)[number]) =>
    h(
      "li",
      { class: a.enabled && !isFinished(a) ? "" : "done" },
      isFinished(a)
        ? null
        : h("input", { type: "checkbox", title: "On/off", checked: a.enabled, onchange: () => void backend.setAlarmEnabled(a.id, !a.enabled) }),
      h("span", { class: "title" }, a.label),
      h(
        "span",
        { class: "when" },
        a.missedAt
          ? `Missed ${formatWhen(a.missedAt)}`
          : isFinished(a)
            ? "Rang"
            : a.snoozes > 0 && a.nextFire
              ? `💤 ${formatWhen(a.nextFire)} (snooze ${a.snoozes}/${Math.max(a.snoozes, settings.alerts.alarm.autoSnoozeMax)})`
              : a.nextFire
                ? `${formatWhen(a.nextFire)} · ${repeatText[a.repeat]}`
                : repeatText[a.repeat],
      ),
      h("button", { class: "icon", title: "Delete", onclick: () => void backend.deleteAlarm(a.id) }, "✕"),
    );

  return h(
    "section",
    {},
    h("h3", {}, "Quick timer"),
    h("div", { class: "row wrap" }, ...[1, 5, 10, 15, 25, 30, 60].map(timer)),
    h("h3", {}, "New alarm"),
    h("div", { class: "row" }, time, repeat, label, h("button", { class: "primary", onclick: add }, "Add")),
    upcoming.length ? h("ul", { class: "list" }, ...upcoming.map(row)) : h("p", { class: "empty" }, "No alarms set."),
    finished.length ? finishedSection(`Finished (${finished.length})`, finished.map(row), () => backend.clearFinishedAlarms()) : null,
    h("p", { class: "hint" }, "Finished alarms and timers are cleared automatically each day."),
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
  const clock = h("div", { class: "clock" });
  const label = h("div", { class: "phase" });
  const names = { idle: "Ready when you are", focus: "Focus", short_break: "Short break", long_break: "Long break" };
  const tickClock = () => {
    label.textContent = `${names[status.phase]}${status.phase !== "idle" ? ` · round ${status.round + (status.phase === "focus" ? 1 : 0)}/${c.roundsBeforeLong}` : ""}`;
    clock.textContent = status.endsAt ? formatRemaining(status.endsAt - Date.now()) : `${c.focusMin}:00`;
  };
  tickClock();
  const id = setInterval(tickClock, 500);
  cleanup.push(() => clearInterval(id));

  const num = (key: keyof typeof c, min: number, max: number) =>
    h("input", {
      type: "number",
      min,
      max,
      value: c[key] as number,
      onchange: (e: Event) => void save({ pomodoro: { ...settings.pomodoro, [key]: Number((e.target as HTMLInputElement).value) } }),
    });
  const max = Math.max(1, ...stats.map((s) => s.completed));

  return h(
    "section",
    { class: "focus" },
    h("div", { class: "tomato-big" }, status.phase.includes("break") ? "☕" : "🍅"),
    label,
    clock,
    h(
      "div",
      { class: "row center" },
      ...(status.phase === "idle"
        ? [h("button", { class: "primary", onclick: () => void backend.pomodoroStart() }, "Start focus")]
        : [h("button", { onclick: () => void backend.pomodoroSkip() }, "Skip"), h("button", { onclick: () => void backend.pomodoroStop() }, "Stop")]),
    ),
    h("h3", {}, "Last 7 days"),
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
      { class: "grid2" },
      h("label", {}, "Focus", num("focusMin", 1, 180)),
      h("label", {}, "Short break", num("shortBreakMin", 1, 60)),
      h("label", {}, "Long break", num("longBreakMin", 1, 90)),
      h("label", {}, "Long break every", num("roundsBeforeLong", 1, 12)),
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", checked: c.autoContinue, onchange: () => void save({ pomodoro: { ...settings.pomodoro, autoContinue: !c.autoContinue } }) }),
        "Start the next round automatically",
      ),
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
        g.available ? h("button", { class: "primary", onclick: () => void backend.openGame(g.id) }, "Play") : h("span", { class: "soon" }, "Coming soon"),
      );
    }),
  );
  return h("section", {}, h("ul", { class: "games" }, ...items));
}

// --- Settings ---------------------------------------------------------------

async function renderSettings(): Promise<Node> {
  const slider = (key: "size" | "speed", min: number, max: number) => {
    const out = h("output", {}, `${settings[key].toFixed(2)}×`);
    return h(
      "label",
      {},
      key === "size" ? "Pet size" : "Pet speed",
      h("input", {
        type: "range",
        min,
        max,
        step: 0.05,
        value: settings[key],
        oninput: (e: Event) => (out.textContent = `${Number((e.target as HTMLInputElement).value).toFixed(2)}×`),
        onchange: (e: Event) => void save({ [key]: Number((e.target as HTMLInputElement).value) }),
      }),
      out,
    );
  };
  const q = settings.quietHours;
  return h(
    "section",
    { class: "settings" },
    slider("size", 0.5, 2),
    slider("speed", 0.5, 2),
    h("h3", {}, "Alerts"),
    alertRow("alarm", "Alarms & timers"),
    alertRow("todo", "To-do reminders"),
    h(
      "label",
      { class: "check" },
      h("input", { type: "checkbox", checked: settings.sound, onchange: () => void save({ sound: !settings.sound }) }),
      "Other sounds (petting, focus sessions)",
    ),
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
    h("h3", {}, "Quiet hours"),
    h("p", { class: "hint" }, "The pet stays calm (no running around). Reminders still come through."),
    h(
      "div",
      { class: "row" },
      h("input", { type: "checkbox", checked: q.enabled, onchange: () => void save({ quietHours: { ...q, enabled: !q.enabled } }) }),
      h("input", { type: "time", value: q.start, onchange: (e: Event) => void save({ quietHours: { ...q, start: (e.target as HTMLInputElement).value } }) }),
      "to",
      h("input", { type: "time", value: q.end, onchange: (e: Event) => void save({ quietHours: { ...q, end: (e.target as HTMLInputElement).value } }) }),
    ),
    h(
      "footer",
      {},
      `${product.productName} · ${product.publisher} · ${await backend.storefront()} build · `,
      h("a", { href: product.website, target: "_blank" }, product.website),
    ),
  );
}

/** One alert kind: pet comes to the centre, ring on/off, ringtone, preview, volume. */
function alertRow(kind: "alarm" | "todo", title: string): Node {
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
    "fieldset",
    { class: "alert" },
    h("legend", {}, title),
    h(
      "label",
      { class: "check" },
      h("input", { type: "checkbox", checked: a.petRuns, onchange: () => void update({ petRuns: !a.petRuns }) }),
      "Pet comes to the middle of the screen",
    ),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: a.ring, onchange: () => void update({ ring: !a.ring }) }), "Ring"),
    h(
      "div",
      { class: "row" },
      tone,
      h(
        "button",
        { title: "Preview", onclick: () => playRingtone(tone.value as RingtoneId, Number(volume.value)) },
        "▶",
      ),
      h("span", { class: "hint" }, "🔈"),
      volume,
    ),
    kind === "alarm" ? unansweredRow(a, update) : null,
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
  [5, 3, "Snooze 5 min, up to 3 times"],
  [10, 3, "Snooze 10 min, up to 3 times"],
  [5, 5, "Snooze 5 min, up to 5 times"],
  [5, 0, "Stop and mark as missed"],
] as const;

/** Alarm-only: how long to ring and what happens when nobody answers. */
function unansweredRow(a: AlertSettings, update: (p: Partial<AlertSettings>) => void): Node {
  const current = UNANSWERED.findIndex(([m, n]) => (n === 0 ? a.autoSnoozeMax === 0 : m === a.snoozeMinutes && n === a.autoSnoozeMax));
  return h(
    "div",
    { class: "unanswered" },
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
    h("p", { class: "hint" }, "Timers never snooze: if you miss one, a quiet ⏱ note waits by your pet for an hour."),
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
    if (current === "characters" || current === "focus" || current === "settings") void render();
  });
  await backend.on("panel-tab", (tab) => select(tab));
  await backend.on("mood", () => current === "characters" && void render());

  const initial = location.hash.slice(1) as PanelTab;
  select(TABS.some((t) => t.id === initial) ? initial : "todos");
}

void main();
