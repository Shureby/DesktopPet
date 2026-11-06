/**
 * The interface's languages (docs/INTERACTIONS.md, "Language and region"): English, Simplified
 * Chinese (as written in mainland China) and Traditional Chinese (as written in Taiwan).
 *
 * The English text is the key: `t("Open panel…")` looks it up in the Chinese dictionaries
 * (src/i18n/zh-CN.ts, zh-TW.ts) and falls back to the English. `{name}` in a text is filled
 * from `params`. Line sets (several lines to pick from at random) are looked up by an id with
 * `lines()`, as a language may have more or fewer of them.
 */
import zhCN from "./zh-CN";
import zhTW from "./zh-TW";

export type Language = "en" | "zh-CN" | "zh-TW";
/** What the settings say: a language, or "auto" (the system's). */
export type LanguageSetting = "auto" | Language;

export const LANGUAGES: Language[] = ["en", "zh-CN", "zh-TW"];

/** Each language's name in itself, for the menu that picks one. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", "zh-CN": "简体中文", "zh-TW": "繁體中文" };

export interface Dictionary {
  /** English text → its translation. */
  text: Record<string, string>;
  /** Line set id → its lines. */
  lines: Record<string, string[]>;
}

const DICTIONARIES: Record<Exclude<Language, "en">, Dictionary> = { "zh-CN": zhCN, "zh-TW": zhTW };

let current: Language = "en";
const listeners = new Set<(language: Language) => void>();

export function language(): Language {
  return current;
}

/** True for both Chinese languages (no spaces between words, no plurals). */
export function isChinese(l: Language = current): boolean {
  return l !== "en";
}

/**
 * Switches the interface to `l`: `lang` on the page (so Chinese text gets the right fonts and
 * glyph forms) and every listener told (windows redraw what they show).
 */
export function setLanguage(l: Language): void {
  if (typeof document !== "undefined") document.documentElement.lang = l;
  if (l === current) return;
  current = l;
  for (const fn of listeners) fn(l);
}

export function onLanguage(fn: (language: Language) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fills `{name}` in a text from `params` (left as is when there's no such param). */
export function fill(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (all, key: string) => (key in params ? String(params[key]) : all));
}

/**
 * Marks an English text in a table that's shown elsewhere through t() (so the dictionaries'
 * tests know it's a text to translate). Returns it unchanged.
 */
export function msg<T extends string>(en: T): T {
  return en;
}

/**
 * The text in the interface's language. A key may end in "|context" when one English word
 * needs two translations ("Date|calendar": 公历); the English shown leaves it out.
 */
export function t(en: string, params?: Record<string, string | number>): string {
  const dict = current === "en" ? undefined : DICTIONARIES[current];
  return fill(dict?.text[en] ?? en.replace(/\|[a-z]+$/, ""), params);
}

/** A set of lines in the interface's language (the English ones if it has none). */
export function lines(id: string, en: string[]): string[] {
  const dict = current === "en" ? undefined : DICTIONARIES[current];
  return dict?.lines[id] ?? en;
}

/** For the tests and the review table: every dictionary. */
export function dictionary(l: Exclude<Language, "en">): Dictionary {
  return DICTIONARIES[l];
}

/**
 * The language for a system language tag (BCP 47, as Windows and macOS give it): Chinese in
 * its script (zh-Hans, zh-CN, zh-SG, zh-MY: Simplified; zh-Hant, zh-TW, zh-HK, zh-MO:
 * Traditional), anything else English.
 */
export function languageOf(tag: string | null | undefined): Language {
  const parts = (tag ?? "").replace(/_/g, "-").toLowerCase().split("-");
  if (parts[0] !== "zh") return "en";
  if (parts.includes("hant") || parts.some((p) => ["tw", "hk", "mo"].includes(p))) return "zh-TW";
  return "zh-CN";
}

/** The language to show: the one chosen, or the system's first. */
export function resolveLanguage(setting: LanguageSetting | undefined, systemLanguages: string[]): Language {
  if (setting && setting !== "auto" && LANGUAGES.includes(setting)) return setting;
  return languageOf(systemLanguages[0]);
}
