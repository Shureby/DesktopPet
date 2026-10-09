/**
 * Settings → Modes (docs/INTERACTIONS.md, "Modes"): the mode now, Auto or a mode by hand,
 * the week at a glance, the time slots for work days and days off, and what each mode
 * changes.
 */
import { clock } from "../features/alarm/ringing";
import {
  dayKey,
  DEFAULT_PRESETS,
  MODE_ICONS,
  MODE_IDS,
  MODE_NAMES,
  modeNow,
  scheduledMode,
  workSpan,
  type ModeChoice,
  type ModeId,
  type ModePreset,
  type ModeSettings,
  type ModeSlot,
} from "../features/modes/modes";
import type { Settings } from "../platform/types";
import { dayPicker, WEEK } from "./dayPicker";
import { h } from "./dom";
import { timeField } from "./timeField";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function debounce<T>(f: (v: T) => void, ms = 400): (v: T) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (v: T) => {
    clearTimeout(t);
    t = setTimeout(() => f(v), ms);
  };
}

/** "9:00 AM" for "09:00" (the system's 12/24-hour setting). */
export function hmText(hm: string): string {
  const [hh, mm] = hm.split(":").map(Number);
  return clock(new Date(2000, 0, 1, hh, mm).getTime());
}

/**
 * The modes saved, and the Focus tab's work hours with them: they follow the Work slots on
 * work days, so the schedule is the one place to set them (and ePet's own clock, in Rust,
 * keeps reading `pomodoro.workHours`).
 */
export function modesPatch(s: Settings, modes: ModeSettings): Partial<Settings> {
  const span = workSpan(modes);
  return { modes, pomodoro: span ? { ...s.pomodoro, workHours: { ...s.pomodoro.workHours, ...span } } : s.pomodoro };
}

/** One row per day of this week (Mon–Sun), coloured by mode, 0–24 h. */
function weekBars(m: ModeSettings, now: Date): Node {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const rows = WEEK.map((_, i) => {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    // Every quarter of an hour, joined into runs of one mode.
    const runs: { from: number; to: number; mode: ModeId }[] = [];
    for (let q = 0; q < 96; q++) {
      const mode = scheduledMode(m, new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, q * 15));
      const last = runs.at(-1);
      if (last && last.mode === mode) last.to = q + 1;
      else runs.push({ from: q, to: q + 1, mode });
    }
    const quarter = (q: number) => hmText(`${String(Math.floor(q / 4) % 24).padStart(2, "0")}:${String((q % 4) * 15).padStart(2, "0")}`);
    const today = dayKey(day) === dayKey(now);
    return h(
      "div",
      { class: `week-row${today ? " today" : ""}` },
      h("span", { class: "week-day" }, DAY_NAMES[day.getDay()]),
      h(
        "span",
        { class: "week-bar" },
        ...runs.map((r) =>
          h("span", {
            class: `slot ${r.mode}`,
            style: `left:${(r.from / 96) * 100}%;width:${((r.to - r.from) / 96) * 100}%`,
            title: `${MODE_NAMES[r.mode]} · ${quarter(r.from)}–${quarter(r.to)}`,
          }),
        ),
        today ? h("span", { class: "now-line", style: `left:${((now.getHours() * 60 + now.getMinutes()) / 1440) * 100}%` }) : null,
      ),
    );
  });
  return h(
    "div",
    { class: "week" },
    ...rows,
    h("div", { class: "week-legend" }, ...MODE_IDS.map((id) => h("span", { class: `key ${id}` }, `${MODE_ICONS[id]} ${MODE_NAMES[id]}`))),
  );
}

type PresetRow = { label: string; key: keyof ModePreset; info: string; options?: [string, ModePreset[keyof ModePreset]][] };
const PRESET_ROWS: PresetRow[] = [
  {
    label: "Ring volume",
    key: "volume",
    info: "How loud alarms, timers and to-do reminders ring in this mode, as a share of the volume set under Alarms & timers / To-do reminders.",
    options: [["100%", 1], ["50%", 0.5], ["25%", 0.25]],
  },
  {
    label: "Start soft, get louder",
    key: "rampUp",
    info: "Alarms and timers start at a quarter of their volume and get louder over 30 seconds, up to the Ring volume.",
  },
  {
    label: "Alarms ring for",
    key: "ringSeconds",
    info: "How long an alarm or timer rings before it counts as unanswered. “As set” uses Ring for under Alarms & timers; a shorter time here wins.",
    options: [["As set", 0], ["15 s", 15], ["30 s", 30], ["1 min", 60]],
  },
  {
    label: "Comes to the middle",
    key: "petRuns",
    info: "When something rings, the pet runs to the middle of the screen (if that's on for alarms or to-dos). Off: it perks up where it is.",
  },
  { label: "To-dos ring", key: "todoRing", info: "To-do reminders play their ringtone. Off: just the bubble. Alarms and timers always ring." },
  {
    label: "Anniversaries",
    key: "celebrate",
    info: "Now: fireworks or the candle play on the day. Later: they wait with a 🎉 badge by the pet; when a mode with “Now” begins, the pet asks whether to celebrate.",
    options: [["Now", "play"], ["Later", "postpone"]],
  },
  {
    label: "Anniversary music",
    key: "music",
    info: "On: anniversaries play their music even if music is off under To-do reminders. “As set”: as set there.",
    options: [["As set", false], ["On", true]],
  },
  {
    label: "Talks on its own",
    key: "chatter",
    info: "The pet says things now and then without being asked: bored, hungry, happy to see you. Reminders and replies to petting still show.",
  },
  { label: "Petting & focus sounds", key: "sounds", info: "The little sound when you pet it, and the sounds when a focus or a break starts." },
  { label: "Keeps calm", key: "calm", info: "The pet stays calm: it sits, naps and walks slowly instead of running, climbing and jumping." },
];

const MODE_INFO: Record<ModeId, string> = {
  normal: "Your settings as they are, so nothing here to change. To change them, use the cards below (Alarms & timers, To-do reminders…).",
  lively: "Like Normal, with anniversary music on.",
  work: "For work hours: softer, shorter rings; the pet stays put and quiet; anniversaries wait.",
  quiet: "For nights and meetings: the pet keeps calm, to-dos don't ring, anniversaries wait. Alarms and timers still ring, softly at first.",
};

/** One box for every ⓘ: shown beside the one hovered or focused (a click focuses it). */
let tipBox: HTMLElement | null = null;
/** "ⓘ": what the thing beside it does, on hover, focus or click. */
export function infoTip(text: string): HTMLElement {
  const b = h("button", { type: "button", class: "info", "aria-label": text }, "ⓘ");
  const show = () => {
    tipBox ??= document.body.appendChild(h("div", { class: "info-tip", role: "tooltip" }));
    tipBox.textContent = text;
    tipBox.hidden = false;
    const r = b.getBoundingClientRect();
    const w = Math.min(260, window.innerWidth - 16);
    tipBox.style.width = `${w}px`;
    tipBox.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))}px`;
    const below = r.bottom + 6;
    tipBox.style.top = `${below + tipBox.offsetHeight > window.innerHeight - 8 ? r.top - tipBox.offsetHeight - 6 : below}px`;
  };
  const hide = () => {
    if (tipBox && document.activeElement !== b) tipBox.hidden = true;
  };
  b.addEventListener("mouseenter", show);
  b.addEventListener("mouseleave", hide);
  b.addEventListener("focus", show);
  b.addEventListener("blur", () => tipBox && (tipBox.hidden = true));
  b.addEventListener("click", (e) => {
    e.preventDefault();
    b.focus();
    show();
  });
  return b;
}

export function modesSection(get: () => Settings, save: (patch: Partial<Settings>) => Promise<void>): Node {
  const root = h("div", { class: "box modes" });
  const top = h("div", { class: "modes-top" });
  /** Saves; `redraw: false` (a time being edited) refreshes only the mode now and the week. */
  const update = async (patch: Partial<ModeSettings>, redraw = true) => {
    const s = get();
    await save(modesPatch(s, { ...s.modes, ...patch }));
    if (redraw) render();
    else renderTop();
  };
  let timeEdits = Promise.resolve();

  const slotRows = (which: "workday" | "dayOff") => {
    const list = get().modes[which];
    const set = (slots: ModeSlot[], redraw = true) => void update({ [which]: slots }, redraw);
    return h(
      "div",
      { class: `slots ${which}` },
      ...list.map((slot, i) => {
        // Read afresh: an earlier edit may not have redrawn the list. Edits are saved in turn.
        const change = (patch: Partial<ModeSlot>, redraw = true) => {
          timeEdits = timeEdits.then(() => update({ [which]: get().modes[which].map((x, j) => (j === i ? { ...x, ...patch } : x)) }, redraw));
        };
        const laterStart = debounce((start: string) => change({ start }, false));
        const laterEnd = debounce((end: string) => change({ end }, false));
        return h(
          "div",
          { class: "row slot-row" },
          timeField(slot.start, laterStart, "From"),
          "–",
          timeField(slot.end, laterEnd, "Until"),
          h(
            "select",
            { class: "slot-mode", onchange: (e: Event) => change({ mode: (e.target as HTMLSelectElement).value as ModeId }) },
            ...MODE_IDS.map((id) => h("option", { value: id, selected: id === slot.mode }, `${MODE_ICONS[id]} ${MODE_NAMES[id]}`)),
          ),
          h("button", { class: "mini remove", title: "Remove", onclick: () => set(get().modes[which].filter((_, j) => j !== i)) }, "✕"),
        );
      }),
      h(
        "button",
        { class: "link add-slot", onclick: () => set([...get().modes[which], { start: "12:00", end: "13:00", mode: which === "workday" ? "work" : "quiet" }]) },
        "+ Add a time slot",
      ),
    );
  };

  const presetTable = () => {
    const m = get().modes;
    const setPreset = (id: ModeId, key: keyof ModePreset, value: unknown) =>
      void update({ presets: { ...m.presets, [id]: { ...m.presets[id], [key]: value } } });
    return h(
      "table",
      { class: "presets" },
      h("tr", {}, h("th", {}), ...MODE_IDS.map((id) => h("th", {}, `${MODE_ICONS[id]} ${MODE_NAMES[id]}`, infoTip(MODE_INFO[id])))),
      ...PRESET_ROWS.map((row) =>
        h(
          "tr",
          {},
          h("td", {}, row.label, infoTip(row.info)),
          ...MODE_IDS.map((id) => {
            const value = m.presets[id][row.key];
            // Normal is your settings as they are: shown, not changed here.
            const disabled = id === "normal";
            if (!row.options)
              return h(
                "td",
                {},
                h("input", { type: "checkbox", checked: !!value, disabled, name: `${id}-${row.key}`, onchange: () => setPreset(id, row.key, !value) }),
              );
            return h(
              "td",
              {},
              h(
                "select",
                {
                  disabled,
                  name: `${id}-${row.key}`,
                  onchange: (e: Event) => setPreset(id, row.key, row.options![Number((e.target as HTMLSelectElement).value)][1]),
                },
                ...row.options.map(([text, v], i) => h("option", { value: String(i), selected: v === value }, text)),
              ),
            );
          }),
        ),
      ),
    );
  };

  /** The mode now, Auto or a mode by hand, and the week. */
  const renderTop = () => {
    const m = get().modes;
    const now = new Date();
    const n = modeNow(m, now);
    const why = n.why === "manual" ? "picked by hand" : n.why === "override" ? `for a while, until ${clock(n.until!)}` : n.until ? `schedule, until ${clock(n.until)}` : "schedule";
    top.replaceChildren(
      h(
        "div",
        { class: "row spread" },
        h("strong", { class: "mode-now" }, `Now: ${MODE_ICONS[n.mode]} ${MODE_NAMES[n.mode]}`, h("small", { class: "hint" }, ` · ${why}`)),
        h(
          "select",
          { class: "mode-choice", onchange: (e: Event) => void update({ choice: (e.target as HTMLSelectElement).value as ModeChoice, override: null }) },
          h("option", { value: "auto", selected: m.choice === "auto" }, "Auto (schedule)"),
          ...MODE_IDS.map((id) => h("option", { value: id, selected: m.choice === id }, `${MODE_ICONS[id]} ${MODE_NAMES[id]}`)),
        ),
      ),
      ...(n.why === "override" ? [h("button", { class: "link end-override", onclick: () => void update({ override: null }) }, "Back to the schedule now")] : []),
      weekBars(m, now),
    );
  };

  const render = () => {
    const m = get().modes;
    const today = dayKey(new Date());
    renderTop();
    root.replaceChildren(
      top,
      h("hr"),
      h("div", { class: "row spread" }, h("span", { class: "label nowrap" }, "Work days"), dayPicker(m.workDays, (workDays) => void update({ workDays }))),
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", class: "day-off-today", checked: m.dayOffOn === today, onchange: () => void update({ dayOffOn: m.dayOffOn === today ? null : today }) }),
        "Today is a day off",
      ),
      h("div", { class: "subhead" }, "On work days"),
      slotRows("workday"),
      h("div", { class: "subhead" }, "On days off"),
      slotRows("dayOff"),
      h("p", { class: "hint" }, "Times not in a slot are Normal. A slot that ends before it starts runs past midnight. Where slots overlap, the quieter wins."),
      h("hr"),
      h(
        "div",
        { class: "row spread" },
        h("div", { class: "subhead" }, "What each mode changes"),
        h("button", { class: "link reset-presets", onclick: () => void update({ presets: structuredClone(DEFAULT_PRESETS) }) }, "Reset to defaults"),
      ),
      presetTable(),
    );
  };
  render();
  return root;
}
