/**
 * Settings → Hardware (docs/INTERACTIONS.md, "Hardware"): what the pet's hover card shows,
 * and the alerts (on or off, each one's limit, the temperature unit, how often to look).
 * What this computer can't read is greyed out; an alert turned on for it says it won't fire.
 */
import { msg, t } from "../i18n";
import {
  alertOn,
  clampLimit,
  EVERY_CHOICES,
  formatTemp,
  fromUnit,
  HW_ALERTS,
  HW_ITEMS,
  HW_LABELS,
  LIMIT_RANGE,
  toUnit,
  type HardwareSettings,
  type HwAlert,
  type HwReading,
} from "../features/hardware/hardware";
import type { Backend, Settings } from "../platform/types";
import { h } from "./dom";

const ALERT_LABELS: Record<HwAlert, string> = {
  cpuTemp: msg("CPU temperature over"),
  gpuTemp: msg("GPU temperature over"),
  memory: msg("Memory use over"),
  disk: msg("System disk free space under"),
  battery: msg("Battery (not plugged in) at or under"),
};

const EVERY_LABELS: Record<number, string> = {
  30: msg("30 seconds"),
  60: msg("1 minute"),
  120: msg("2 minutes"),
  300: msg("5 minutes"),
  600: msg("10 minutes"),
};

const isTemp = (a: HwAlert) => a === "cpuTemp" || a === "gpuTemp";

/** Where the limit is shown in °F, it moves a whole °C at a time (stored in °C). */
function shown(a: HwAlert, value: number, s: HardwareSettings): number {
  return isTemp(a) ? Math.round(toUnit(value, s.unit)) : value;
}

function unitText(a: HwAlert, s: HardwareSettings): string {
  return isTemp(a) ? (s.unit === "F" ? "℉" : "℃") : "%";
}

function rangeText(a: HwAlert, s: HardwareSettings): string {
  const r = LIMIT_RANGE[a];
  return isTemp(a) ? `${formatTemp(r.min, s.unit)}–${formatTemp(r.max, s.unit)}` : `${r.min}–${r.max}%`;
}

export function hardwareSection(backend: Backend, get: () => Settings, save: (patch: Partial<Settings>) => Promise<void>): Node {
  const box = h("div", { class: "box hardware" });
  /** One look at everything, to know what this computer can read (null: not yet). */
  let can: HwReading | null = null;
  const canRead = (item: keyof HwReading) => !can || can[item] !== undefined;
  const update = async (patch: Partial<HardwareSettings>) => {
    await save({ hardware: { ...get().hardware, ...patch } });
    paint();
  };

  const paint = () => {
    const s = get().hardware;
    const showRows = HW_ITEMS.map((item) =>
      h(
        "label",
        { class: `check hw-item${canRead(item) ? "" : " unreadable"}`, "data-item": item },
        h("input", {
          type: "checkbox",
          checked: s.show.includes(item),
          onchange: () => void update({ show: HW_ITEMS.filter((i) => (i === item ? !s.show.includes(i) : s.show.includes(i))) }),
        }),
        t(HW_LABELS[item]),
        canRead(item) ? null : h("span", { class: "hint" }, t("Can't read this on this computer")),
      ),
    );

    const alertRow = (a: HwAlert) => {
      const on = alertOn(s, a, canRead(a));
      const limit = s.limits[a];
      const set = (v: number) => void update({ limits: { ...s.limits, [a]: clampLimit(a, v) } });
      const input = h("input", {
        type: "number",
        class: "hw-limit",
        value: shown(a, limit, s),
        title: rangeText(a, s),
        "aria-label": t(ALERT_LABELS[a]),
        onchange: (e: Event) => {
          const typed = Number((e.target as HTMLInputElement).value);
          set(isTemp(a) ? Math.round(fromUnit(typed, s.unit)) : typed);
        },
      });
      return h(
        "div",
        { class: "hw-alert", "data-alert": a },
        h(
          "div",
          { class: "row" },
          h(
            "label",
            { class: "check" },
            h("input", { type: "checkbox", checked: on, onchange: () => void update({ alerts: { ...s.alerts, [a]: !on } }) }),
            t(ALERT_LABELS[a]),
          ),
          h(
            "span",
            { class: "stepper" },
            h("button", { type: "button", class: "minus", "aria-label": "−", disabled: limit <= LIMIT_RANGE[a].min, onclick: () => set(limit - 1) }, "−"),
            input,
            h("button", { type: "button", class: "plus", "aria-label": "+", disabled: limit >= LIMIT_RANGE[a].max, onclick: () => set(limit + 1) }, "+"),
          ),
          h("span", { class: "hint" }, unitText(a, s)),
        ),
        on && !canRead(a)
          ? h(
              "p",
              { class: "hw-cant" },
              t("This computer can't read this, so it won't alert even when on."),
              isTemp(a) ? h("br") : null,
              isTemp(a) ? t("Windows: open HWiNFO (with Shared Memory Support on) or LibreHardwareMonitor and this starts working.") : null,
            )
          : null,
      );
    };

    box.replaceChildren(
      h("div", { class: "subhead" }, t("Show when the mouse is on the pet")),
      h("div", { class: "hw-items" }, ...showRows),
      h("p", { class: "hint" }, t("Read only while the mouse is on the pet. Tick none and no card shows.")),
      h("hr"),
      h("div", { class: "subhead" }, t("Alerts")),
      ...HW_ALERTS.map(alertRow),
      h(
        "label",
        { class: "row spread" },
        h("span", { class: "label" }, t("Temperature unit")),
        h(
          "select",
          { class: "hw-unit", onchange: (e: Event) => void update({ unit: (e.target as HTMLSelectElement).value === "F" ? "F" : "C" }) },
          h("option", { value: "C", selected: s.unit === "C" }, "℃"),
          h("option", { value: "F", selected: s.unit === "F" }, "℉"),
        ),
      ),
      h(
        "label",
        { class: "row spread" },
        h("span", { class: "label" }, t("Check every")),
        h(
          "select",
          { class: "hw-every", onchange: (e: Event) => void update({ every: Number((e.target as HTMLSelectElement).value) }) },
          ...EVERY_CHOICES.map((n) => h("option", { value: n, selected: n === s.every }, t(EVERY_LABELS[n]))),
        ),
      ),
      h(
        "p",
        { class: "hint" },
        t("Over a limit, the pet looks again 30 seconds later and tells you if it still is (far over: at once), at most once every 30 minutes for each. ") +
          t("Not in Quiet mode; during a call or in full screen it waits. Only the alerts that are on are read; the disk every 10 minutes."),
      ),
    );
  };

  paint();
  void backend.hwRead([...HW_ITEMS]).then(
    (r) => {
      can = r;
      paint();
    },
    () => {},
  );
  return box;
}
