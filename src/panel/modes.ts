/**
 * Settings → Modes (docs/INTERACTIONS.md, "Modes"): the mode now, Auto or a mode by hand,
 * the week at a glance, the time slots for work days and days off, and what each mode
 * changes.
 */
import { weekdayShort } from "../i18n/format";
import { msg, t } from "../i18n";
import { clock } from "../features/alarm/ringing";
import {
  dayKey,
  DEFAULT_PRESETS,
  MODE_ICONS,
  MODE_IDS,
  MODE_NAMES,
  modeNow,
  scheduledMode,
  slotOverlaps,
  workSpan,
  type ModeChoice,
  type ModeId,
  type ModePreset,
  type ModeSettings,
  type ModeSlot,
} from "../features/modes/modes";
import type { Settings } from "../platform/types";
import { dayPicker, week } from "./dayPicker";
import { h } from "./dom";
import { dateField } from "./dateField";
import { timeField } from "./timeField";
import { icon } from "../ui/icons";


function debounce<T>(f: (v: T) => void, ms = 400): (v: T) => void {
  let it: ReturnType<typeof setTimeout> | undefined;
  return (v: T) => {
    clearTimeout(it);
    it = setTimeout(() => f(v), ms);
  };
}

const minutes = (v: string) => {
  const [hh, mm] = v.split(":").map(Number);
  return hh * 60 + mm;
};
/** "HH:MM" for minutes of the day. */
const hm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** "HH:MM" an hour later (23:30 → 00:30). */
export function addHour(hm: string): string {
  const [hh, mm] = hm.split(":").map(Number);
  return `${String((hh + 1) % 24).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
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

/** One row per day of this week (Mon–Sun, Sun–Sat in Taiwan), coloured by mode, 0–24 h. */
function weekBars(m: ModeSettings, now: Date): Node {
  const first = week()[0];
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() - first + 7) % 7));
  const rows = week().map((_, i) => {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
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
      h("span", { class: "week-day" }, weekdayShort(day.getDay())),
      h(
        "span",
        { class: "week-bar" },
        ...runs.map((r) =>
          h("span", {
            class: `slot ${r.mode}`,
            style: `left:${(r.from / 96) * 100}%;width:${((r.to - r.from) / 96) * 100}%`,
            title: `${t(MODE_NAMES[r.mode])} · ${quarter(r.from)}–${quarter(r.to)}`,
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
    h("div", { class: "week-legend" }, ...MODE_IDS.map((id) => h("span", { class: `key ${id}` }, `${MODE_ICONS[id]} ${t(MODE_NAMES[id])}`))),
  );
}

type PresetRow = { label: string; key: keyof ModePreset; info: string; options?: [string, ModePreset[keyof ModePreset]][] };
const PRESET_ROWS: PresetRow[] = [
  {
    label: msg("Ring volume"),
    key: "volume",
    info: msg("How loud alarms, timers and to-do reminders ring in this mode, as a share of the volume set under Alarms & timers / To-do reminders."),
    options: [["100%", 1], ["50%", 0.5], ["25%", 0.25]],
  },
  {
    label: msg("Start soft, get louder"),
    key: "rampUp",
    info: msg("Alarms and timers start at a quarter of their volume and get louder over 30 seconds, up to the Ring volume."),
  },
  {
    label: msg("Alarms ring for"),
    key: "ringSeconds",
    info: msg("How long an alarm or timer rings before it counts as unanswered. “As set” uses Ring for under Alarms & timers; a shorter time here wins."),
    options: [[msg("As set"), 0], [msg("15 s"), 15], [msg("30 s"), 30], [msg("1 min"), 60]],
  },
  {
    label: msg("Comes to the middle"),
    key: "petRuns",
    info: msg("When something rings, the pet runs to the middle of the screen (if that's on for alarms or to-dos). Off: it perks up where it is."),
  },
  { label: msg("To-dos ring"), key: "todoRing", info: msg("To-do reminders play their ringtone. Off: just the bubble. Alarms and timers always ring.") },
  {
    label: msg("Celebrations"),
    key: "celebrate",
    info: msg("Now: fireworks or the candle play on the day. Later: they wait with a 🎉 badge by the pet; when a mode with “Now” begins, the pet asks whether to celebrate."),
    options: [[msg("Now|celebrate"), "play"], [msg("Later|celebrate"), "postpone"]],
  },
  {
    label: msg("Anniversary music"),
    key: "music",
    info: msg("On: anniversaries play their music in this mode even if “Play music with it” is off in Settings. “As set”: follows that setting."),
    options: [[msg("As set"), false], [msg("On"), true]],
  },
  {
    label: msg("Talks on its own"),
    key: "chatter",
    info: msg("The pet says things now and then without being asked: bored, hungry, happy to see you. Reminders and replies to petting still show."),
  },
  { label: msg("Petting & focus sounds"), key: "sounds", info: msg("The little sound when you pet it, and the sounds when a focus or a break starts.") },
  { label: msg("Keeps calm"), key: "calm", info: msg("The pet stays calm: it sits, naps and walks slowly instead of running, climbing and jumping.") },
];

const MODE_INFO: Record<ModeId, string> = {
  normal: msg("Your settings as they are, so nothing here to change. To change them, use the cards below (Alarms & timers, To-do reminders…)."),
  lively: msg("Like Normal, with anniversary music on."),
  work: msg("For work hours: softer, shorter rings; the pet stays put and quiet; anniversaries wait."),
  quiet: msg("For nights and meetings: the pet keeps calm, to-dos don't ring, anniversaries wait. Alarms and timers still ring, softly at first."),
};

/** One box for every ⓘ: shown beside the one hovered or focused (a click focuses it). */
let tipBox: HTMLElement | null = null;
/** "ⓘ": what the thing beside it does, on hover, focus or click. */
export function infoTip(text: string): HTMLElement {
  const b = h("button", { type: "button", class: "info", "aria-label": text }, icon("info"));
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

/**
 * `load` reads the settings as stored: every change starts from them, not from what this page
 * last saw (another window may have saved since, and a late "settings" event could be older).
 */
export function modesSection(get: () => Settings, save: (patch: Partial<Settings>) => Promise<void>, load: () => Promise<Settings>): Node {
  const root = h("div", { class: "box modes" });
  const top = h("div", { class: "modes-top" });
  /** Saves; `redraw: false` (a time being edited) refreshes only the mode now and the week. */
  /** Changes saved one after another; one failing doesn't stop the next (it says so). */
  let saving = Promise.resolve();
  let failed = "";
  /**
   * Saves a change made to the modes as stored now. `redraw: false` (a time being edited)
   * refreshes only the mode now, the week and the slots' notes.
   */
  const update = (patch: Partial<ModeSettings> | ((m: ModeSettings) => Partial<ModeSettings>), redraw = true) => {
    saving = saving
      .then(async () => {
        const s = await load();
        const change = typeof patch === "function" ? patch(s.modes) : patch;
        await save(modesPatch(s, { ...s.modes, ...change }));
        failed = "";
      })
      .catch((e) => {
        failed = t("Couldn't save: {error}", { error: e instanceof Error ? e.message : String(e) });
        redraw = true;
      })
      .then(() => {
        if (redraw) render();
        else {
          renderTop();
          paintNotes();
        }
      });
    return saving;
  };
  /** Each slot's "(next day)" and overlap line, painted from the slots as saved (paintNotes). */
  let notes: { which: "workday" | "dayOff"; i: number; nextDay: HTMLElement; overlap: HTMLElement }[] = [];
  const paintNotes = () => {
    const m = get().modes;
    const lose = { workday: slotOverlaps(m.workday), dayOff: slotOverlaps(m.dayOff) };
    const range = (a: number, b: number) => `${hmText(hm(a))}–${hmText(hm(b))}`;
    for (const n of notes) {
      const slot = m[n.which][n.i];
      if (!slot) continue;
      // Kept in place when off, so the rows' mode menus line up.
      n.nextDay.classList.toggle("on", minutes(slot.end) <= minutes(slot.start));
      const o = lose[n.which].find((x) => x.loser === n.i);
      n.overlap.hidden = !o;
      if (o) {
        const w = m[n.which][o.winner];
        n.overlap.replaceChildren(
          icon("warning"),
          ` ${t("Overlaps {mode} {start}–{end}: {mode} wins {range}", { mode: t(MODE_NAMES[w.mode]), start: hmText(w.start), end: hmText(w.end), range: range(o.from, o.to) })}`,
        );
      }
    }
  };
  /** A short note under a table ("A slot needs an end after its start…"). */
  let notice: { which: "workday" | "dayOff"; text: string } | null = null;

  const slotRows = (which: "workday" | "dayOff") => {
    const list = get().modes[which];
    return h(
      "div",
      { class: `slots ${which}` },
      ...list.map((slot, i) => {
        // On the slots as stored (an earlier edit may not have redrawn the list).
        const change = (patch: Partial<ModeSlot>, redraw = true) => {
          let fixed = false;
          void update((m) => {
            const slots = m[which].map((x, j) => (j === i ? { ...x, ...patch } : x));
            // From 9:00 to 9:00 would be all day without saying so: it ends an hour later.
            const s = slots[i];
            if (s && s.start === s.end) {
              slots[i] = { ...s, end: addHour(s.start) };
              fixed = true;
            }
            return { [which]: slots };
          }, redraw).then(() => {
            if (!fixed) return;
            notice = { which, text: t("A slot needs an end after its start: it ends an hour later.") };
            render();
            setTimeout(() => {
              notice = null;
              render();
            }, 5000);
          });
        };
        const laterStart = debounce((start: string) => change({ start }, false));
        const laterEnd = debounce((end: string) => change({ end }, false));
        const nextDay = h("span", { class: "hint next-day" }, t("(next day)"));
        const overlap = h("p", { class: "warning overlap" });
        notes.push({ which, i, nextDay, overlap });
        const row = h(
          "div",
          { class: "row wrap slot-row" },
          timeField(slot.start, laterStart, t("From")),
          "–",
          timeField(slot.end, laterEnd, t("Until")),
          nextDay,
          h(
            "select",
            { class: "slot-mode", onchange: (e: Event) => change({ mode: (e.target as HTMLSelectElement).value as ModeId }) },
            ...MODE_IDS.map((id) => h("option", { value: id, selected: id === slot.mode }, `${MODE_ICONS[id]} ${t(MODE_NAMES[id])}`)),
          ),
          h("button", { class: "mini remove", title: t("Remove"), onclick: () => void update((m) => ({ [which]: m[which].filter((_, j) => j !== i) })) }, icon("close")),
        );
        return h("div", { class: "slot" }, row, overlap);
      }),
      h(
        "button",
        {
          class: "link add-slot",
          // After the last slot, an hour long (12:00–13:00 in an empty table).
          onclick: () =>
            void update((m) => {
              const start = m[which].at(-1)?.end ?? "12:00";
              return { [which]: [...m[which], { start, end: addHour(start), mode: which === "workday" ? "work" : "quiet" }] };
            }),
        },
        t("+ Add a time slot"),
      ),
      ...(notice?.which === which ? [h("p", { class: "warning slot-notice" }, notice.text)] : []),
    );
  };

  const presetTable = () => {
    const m = get().modes;
    const setPreset = (id: ModeId, key: keyof ModePreset, value: unknown) =>
      void update((fresh) => ({ presets: { ...fresh.presets, [id]: { ...fresh.presets[id], [key]: value } } }));
    return h(
      "table",
      { class: "presets" },
      h("tr", {}, h("th", {}), ...MODE_IDS.map((id) => h("th", {}, `${MODE_ICONS[id]} ${t(MODE_NAMES[id])}`, infoTip(t(MODE_INFO[id]))))),
      ...PRESET_ROWS.map((row) =>
        h(
          "tr",
          {},
          h("td", {}, t(row.label), infoTip(t(row.info))),
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
                ...row.options.map(([text, v], i) => h("option", { value: String(i), selected: v === value }, t(text))),
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
    const why =
      n.why === "manual"
        ? t("picked here")
        : n.why === "override"
          ? t("for a while, until {time}", { time: clock(n.until!) })
          : n.until
            ? t("schedule, until {time}", { time: clock(n.until) })
            : t("schedule");
    top.replaceChildren(
      h(
        "div",
        { class: "row spread" },
        h("strong", { class: "mode-now" }, t("Now: {mode}", { mode: `${MODE_ICONS[n.mode]} ${t(MODE_NAMES[n.mode])}` }), h("small", { class: "hint" }, ` · ${why}`)),
        h(
          "select",
          { class: "mode-choice", onchange: (e: Event) => void update({ choice: (e.target as HTMLSelectElement).value as ModeChoice, override: null }) },
          h("option", { value: "auto", selected: m.choice === "auto" }, t("Auto (schedule)")),
          ...MODE_IDS.map((id) => h("option", { value: id, selected: m.choice === id }, `${MODE_ICONS[id]} ${t(MODE_NAMES[id])}`)),
        ),
      ),
      ...(n.why === "override" ? [h("button", { class: "link end-override", onclick: () => void update({ override: null }) }, t("Back to the schedule now"))] : []),
      weekBars(m, now),
    );
  };

  /** "Days off until [date] ✕": a holiday, every day up to that one uses the days-off table. */
  const holidayRow = () => {
    const until = get().modes.holidayUntil;
    const today = dayKey(new Date());
    if (!until || until < today) {
      const inAWeek = dayKey(new Date(Date.now() + 7 * 86_400_000));
      return h("button", { class: "link holiday-add", onclick: () => void update({ holidayUntil: inAWeek }) }, t("+ Days off until…"));
    }
    return h(
      "div",
      { class: "row holiday" },
      h("span", { class: "label" }, t("Days off until")),
      dateField(until, debounce((holidayUntil: string) => void update({ holidayUntil }, false)), t("Days off until")),
      h("button", { class: "mini remove", title: t("No more days off"), onclick: () => void update({ holidayUntil: null }) }, icon("close")),
    );
  };

  const render = () => {
    notes = [];
    const m = get().modes;
    const today = dayKey(new Date());
    renderTop();
    root.replaceChildren(
      top,
      h("hr"),
      h("div", { class: "row spread" }, h("span", { class: "label nowrap" }, t("Work days")), dayPicker(m.workDays, (workDays) => void update({ workDays }))),
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", class: "day-off-today", checked: m.dayOffOn === today, onchange: () => void update({ dayOffOn: m.dayOffOn === today ? null : today }) }),
        t("Today is a day off"),
      ),
      holidayRow(),
      h("div", { class: "subhead" }, t("On work days")),
      slotRows("workday"),
      h("div", { class: "subhead" }, t("On days off")),
      slotRows("dayOff"),
      h("p", { class: "hint" }, t("Times not in a slot are Normal. A slot that ends before it starts runs past midnight. Where slots overlap, the quieter wins.")),
      h("hr"),
      h(
        "div",
        { class: "row spread" },
        h("div", { class: "subhead" }, t("What each mode changes")),
        h("button", { class: "link reset-presets", onclick: () => void update({ presets: structuredClone(DEFAULT_PRESETS) }) }, t("Reset to defaults")),
      ),
      presetTable(),
    );
    if (failed) root.prepend(h("p", { class: "warning save-failed" }, failed));
    paintNotes();
  };
  render();
  return root;
}
