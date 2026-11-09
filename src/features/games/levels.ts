import { t } from "../../i18n";
import { h } from "../../panel/dom";

/** How well the pet plays (24 Points, tic-tac-toe): picked by you, before a game. */
export type Level = "easy" | "normal" | "strong";

export const LEVELS: readonly Level[] = ["easy", "normal", "strong"];

export function levelName(l: Level): string {
  return l === "easy" ? t("Easy") : l === "normal" ? t("Normal") : t("Won't go easy");
}

/** A level saved by any version: "follows its mood" (before 0.64) and anything else is Normal. */
export function parseLevel(v: unknown): Level {
  return LEVELS.find((l) => l === v) ?? "normal";
}

/**
 * "{name}'s level: Easy | Normal | Won't go easy" — three buttons before a game starts;
 * once it has started, just the level it is playing at.
 */
export function levelPicker(name: string, level: Level, open: boolean, pick: (l: Level) => void): HTMLElement {
  if (!open) return h("span", { class: "t24-count game-level" }, t("{name}'s level: {level}", { name, level: levelName(level) }));
  return h(
    "div",
    { class: "game-levels", role: "group", "aria-label": t("{name}'s level", { name }) },
    h("span", { class: "game-levels-label" }, t("{name}'s level", { name })),
    ...LEVELS.map((l) =>
      h(
        "button",
        { class: l === level ? "selected" : "", "data-level": l, "aria-pressed": String(l === level), onclick: () => pick(l) },
        levelName(l),
      ),
    ),
  );
}
