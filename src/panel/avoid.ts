/**
 * Settings → Modes → "Step aside automatically" (docs/INTERACTIONS.md, "Stepping aside"):
 * what the pet leaves the screen for, and whether ePet always stays out of screenshots.
 */
import { AVOID_LABELS, type AvoidReason, type AvoidSettings } from "../features/avoid/avoid";
import type { Backend, Settings } from "../platform/types";
import { h } from "./dom";
import { infoTip } from "./modes";

const OPTIONS: { key: keyof AvoidSettings; label: string; info: string }[] = [
  {
    key: "fullscreen",
    label: "Full-screen apps (games, videos)",
    info: "When an app covers the pet's whole screen, the pet leaves it. Alarms and timers still ring, softly at first; to-dos wait. It comes back about 10 seconds after.",
  },
  {
    key: "presenting",
    label: "Presentations",
    info: "During a PowerPoint or Keynote slide show the pet leaves and nothing rings, except important alarms. ePet is also left out of screen sharing.",
  },
  {
    key: "calls",
    label: "Video calls (camera or microphone in use)",
    info: "While any app uses the camera or the microphone, the pet leaves and nothing rings, except important alarms. ePet is also left out of screen sharing and recordings.",
  },
  {
    key: "alwaysHide",
    label: "Always hide ePet from screenshots and recordings",
    info: "ePet never shows in screenshots, recordings or screen sharing, even outside calls and slide shows. You still see it. Off: it's left out only during calls and slide shows.",
  },
];

/** The line saying what the pet is doing now ("Stepped aside: in a call"), kept current. */
let statusLine: HTMLElement | null = null;
let listening = false;

function paintStatus(reason: AvoidReason | null): void {
  if (!statusLine) return;
  statusLine.textContent = reason ? `Now: stepped aside (${AVOID_LABELS[reason]})` : "";
  statusLine.hidden = !reason;
}

/** `load` reads the settings as stored, so a change never undoes one saved elsewhere. */
export function avoidSection(backend: Backend, get: () => Settings, save: (patch: Partial<Settings>) => Promise<void>, load: () => Promise<Settings>): Node {
  statusLine = h("p", { class: "hint avoid-now", hidden: true });
  void backend.avoidStatus().then((st) => paintStatus(st.reason), () => {});
  if (!listening) {
    listening = true;
    void backend.on("avoid", (reason) => paintStatus(reason));
  }
  const a = get().avoid;
  return h(
    "div",
    { class: "box avoid" },
    h("div", { class: "subhead" }, "Step aside automatically"),
    h("p", { class: "hint" }, "The pet leaves the screen while you…"),
    ...OPTIONS.map((o) =>
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          name: `avoid-${o.key}`,
          checked: a[o.key],
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            void load().then((s) => save({ avoid: { ...s.avoid, [o.key]: on } }));
          },
        }),
        o.label,
        infoTip(o.info),
      ),
    ),
    h("p", { class: "hint" }, "Important alarms (tick “Important” on an alarm) always ring in full, and bring the pet out."),
    statusLine,
  );
}
