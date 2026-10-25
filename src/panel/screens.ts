/**
 * Settings → Screens the pet lives on (docs/INTERACTIONS.md, "Screens"): the screens as they
 * are arranged, a tick on each; Identify shows each screen's number on it.
 */
import { t } from "../i18n";
import { isLastScreen, screenNumbers, screensOf, type ScreenInfo } from "../features/screens/screens";
import type { Backend, Settings } from "../platform/types";
import { h } from "./dom";

/** The diagram's greatest height (CSS px); its width is the card's. The screens are scaled to fit both. */
const H = 170;

export function screensSection(backend: Backend, get: () => Settings, save: (patch: Partial<Settings>) => Promise<void>): Node {
  const root = h("div", { class: "box screens" });
  let screens: ScreenInfo[] = [];
  /** A word on what a button just did ("Detected 3 screens."), for a few seconds. */
  let status = "";
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (text: string) => {
    status = text;
    paint();
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      status = "";
      paint();
    }, 4000);
  };
  let width = 0;

  const paint = () => {
    if (!screens.length) return;
    // The card's inner width (before it's on the page: a guess).
    const W = Math.max(160, (width || 420) - 2);
    const off = get().screens.off;
    const numbers = screenNumbers(screens);
    const frames = screens.map((s) => s.frame);
    const minX = Math.min(...frames.map((f) => f.x));
    const minY = Math.min(...frames.map((f) => f.y));
    const spanW = Math.max(...frames.map((f) => f.x + f.w)) - minX;
    const spanH = Math.max(...frames.map((f) => f.y + f.h)) - minY;
    // Fits the card's width; taller than H if that's what it takes for the smallest screen to
    // hold its number and tick (screens stacked top to bottom).
    const minH = Math.min(...frames.map((f) => f.h));
    const k = Math.min((W - 16) / spanW, Math.max((H - 16) / spanH, 58 / minH));
    // As tall as the screens need (side by side: lower than H).
    const mapH = Math.round(spanH * k + 16);
    const left = (W - spanW * k) / 2;
    const top = (mapH - spanH * k) / 2;
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
          class: `screen${on ? " on" : ""}${w < 110 ? " narrow" : ""}${f.h * k < 58 ? " small" : ""}`,
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
      h("div", { class: "screen-map", style: `height:${mapH}px` }, ...monitors),
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
          h(
            "button",
            {
              class: "identify",
              title: t("Shows each screen's number on it, to tell which is which"),
              onclick: () =>
                void backend.identifyScreens(numbers).then(
                  () => say(t("Each screen shows its number for 2 seconds.")),
                  () => say(t("Couldn't show the numbers.")),
                ),
            },
            t("Identify"),
          ),
          h(
            "button",
            { class: "detect", title: t("Looks for screens again, after you plug one in or move them"), onclick: () => void detect(true) },
            t("Detect again"),
          ),
        ),
        h(
          "span",
          { class: `hint found${status ? " status" : ""}` },
          status || (screens.length === 1 ? t("1 screen found") : t("{n} screens found · new screens are ticked", { n: screens.length })),
        ),
      ),
    );
  };

  const detect = async (again = false) => {
    screens = screensOf(await backend.desktopSnapshot());
    if (again) say(screens.length === 1 ? t("✓ Looked again: 1 screen.") : t("✓ Looked again: {n} screens.", { n: screens.length }));
    else paint();
  };
  // The diagram follows the card's width (a narrow panel, a resized window).
  new ResizeObserver(() => {
    const w = Math.round(root.clientWidth - 24);
    if (w > 0 && Math.abs(w - width) > 1) {
      width = w;
      paint();
    }
  }).observe(root);
  void detect();
  return root;
}
