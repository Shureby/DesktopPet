/**
 * Settings → Screens the pet lives on (docs/INTERACTIONS.md, "Screens"): the screens as they
 * are arranged, a tick on each; Identify shows each screen's number on it.
 */
import { t } from "../i18n";
import { isLastScreen, screenNumbers, screensOf, type ScreenInfo } from "../features/screens/screens";
import type { Backend, Settings } from "../platform/types";
import { h } from "./dom";

/** The diagram's size (CSS px); the screens are scaled to fit. */
const W = 460;
const H = 170;

export function screensSection(backend: Backend, get: () => Settings, save: (patch: Partial<Settings>) => Promise<void>): Node {
  const root = h("div", { class: "box screens" });
  let screens: ScreenInfo[] = [];

  const paint = () => {
    const off = get().screens.off;
    const numbers = screenNumbers(screens);
    const frames = screens.map((s) => s.frame);
    const minX = Math.min(...frames.map((f) => f.x));
    const minY = Math.min(...frames.map((f) => f.y));
    const spanW = Math.max(...frames.map((f) => f.x + f.w)) - minX;
    const spanH = Math.max(...frames.map((f) => f.y + f.h)) - minY;
    const k = Math.min((W - 16) / spanW, (H - 16) / spanH);
    const left = (W - spanW * k) / 2;
    const top = (H - spanH * k) / 2;
    const toggle = async (id: string, on: boolean) => {
      const now = get().screens.off.filter((x) => x !== id);
      await save({ screens: { off: on ? now : [...now, id] } });
      paint();
    };
    const monitors = screens.map((s, i) => {
      const on = !off.includes(s.id);
      const last = isLastScreen(screens, off, s.id);
      const f = s.frame;
      const w = f.w * k;
      const size = `${f.w}×${f.h}${s.primary && w >= 110 ? ` · ${t("main")}` : ""}`;
      return h(
        "div",
        {
          class: `screen${on ? " on" : ""}${w < 110 ? " narrow" : ""}`,
          "data-id": s.id,
          style: `left:${left + (f.x - minX) * k}px;top:${top + (f.y - minY) * k}px;width:${w - 4}px;height:${f.h * k - 4}px`,
          title: s.name ? `${s.name} · ${size}` : size,
        },
        h("span", { class: "n" }, numbers[i]),
        h("span", { class: "size" }, size),
        h(
          "label",
          { title: last ? t("The pet needs at least one screen.") : "" },
          h("input", {
            type: "checkbox",
            checked: on,
            disabled: last,
            onchange: (e: Event) => void toggle(s.id, (e.target as HTMLInputElement).checked),
          }),
          t("Here"),
        ),
      );
    });
    root.replaceChildren(
      h("div", { class: "screen-map", style: `height:${H}px` }, ...monitors),
      h(
        "p",
        { class: "hint" },
        t("The pet walks and comes out (alarms, anniversaries) only on the ticked screens. Carry it to another one and it plays there for a while, then comes back by itself."),
      ),
      h(
        "div",
        { class: "row spread" },
        h(
          "span",
          { class: "buttons" },
          h("button", { class: "identify", onclick: () => void backend.identifyScreens(numbers) }, t("Identify")),
          h("button", { class: "detect", onclick: () => void detect() }, t("Detect again")),
        ),
        h(
          "span",
          { class: "hint found" },
          screens.length === 1 ? t("1 screen found") : t("{n} screens found · new screens are ticked", { n: screens.length }),
        ),
      ),
    );
  };

  const detect = async () => {
    screens = screensOf(await backend.desktopSnapshot());
    paint();
  };
  void detect();
  return root;
}
