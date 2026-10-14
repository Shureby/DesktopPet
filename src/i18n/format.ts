/**
 * Dates and times as the interface's language writes them (docs/INTERACTIONS.md, "Language
 * and region"): English follows the system's own settings (12 or 24 hours, day or month
 * first); Simplified Chinese the mainland's ("16:30", "10月13日周二"); Traditional Chinese
 * Taiwan's ("下午4:30", "10月13日 週二").
 *
 * Every date and time shown goes through here. Never put one into stored text (labels): it
 * would stay in the language and format of the day it was written.
 */
import { language, type Language } from "./index";

/** The locale for Intl: the system's for English, the language's for Chinese. */
export function intlLocale(l: Language = language()): string | undefined {
  return l === "en" ? undefined : l;
}

function fmt(ms: number, opts: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleString(intlLocale(), opts);
}

/** "4:30 PM", "07:05" (the mainland's 24 hours, two digits), "下午4:30". */
export function clock(ms: number): string {
  const hour = language() === "zh-CN" ? "2-digit" : "numeric";
  return new Date(ms).toLocaleTimeString(intlLocale(), { hour, minute: "2-digit" });
}

/** The weekday after a Chinese date, set apart: "10月13日（周二）". */
const withWeekday = (date: string, ms: number) => `${date}（${fmt(ms, { weekday: "short" })}）`;

/** "Tue, Oct 13", "10月13日（周二）", "10月13日（週二）". */
export function shortDate(ms: number): string {
  if (language() !== "en") return withWeekday(monthDay(ms), ms);
  return fmt(ms, { weekday: "short", month: "short", day: "numeric" });
}

/** "Tue, Oct 13, 2026" (with the year), "2026年10月13日（周二）". */
export function shortDateYear(ms: number): string {
  if (language() !== "en") return withWeekday(fmt(ms, { year: "numeric", month: "long", day: "numeric" }), ms);
  return fmt(ms, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

/** "a · b · c"; in Chinese no space after a closing "）": "10月17日（周六）· 3 天后". */
export function joinDot(...parts: (string | null | undefined)[]): string {
  const zh = language() !== "en";
  return parts.filter((p): p is string => !!p).reduce((a, b) => `${a}${zh && a.endsWith("）") ? "· " : " · "}${b}`);
}

/** A date and a time: "Tue, Oct 13 4:30 PM", "10月13日（周二）16:30" (no space after the bracket). */
export function dateTime(date: string, time: string): string {
  return language() === "en" ? `${date} ${time}` : `${date}${time}`;
}

/** "Oct 13", "10月13日". */
export function monthDay(ms: number): string {
  return fmt(ms, { month: "short", day: "numeric" });
}

/** "Tue 4:30 PM", "周二 16:30". */
export function weekdayTime(ms: number): string {
  if (language() !== "en") return `${fmt(ms, { weekday: "short" })} ${clock(ms)}`;
  return fmt(ms, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** "Tuesday", "星期二". */
export function longWeekday(ms: number): string {
  return fmt(ms, { weekday: "long" });
}

const SUNDAY = new Date(2023, 0, 1).getTime(); // a Sunday
const dayMs = (day: number) => SUNDAY + day * 86_400_000;

/** Day `day` of the week (0 Sunday … 6 Saturday): "Sunday", "星期日", "星期日". */
export function weekdayName(day: number): string {
  return longWeekday(dayMs(day));
}

/** "Sun", "周日", "週日". */
export function weekdayShort(day: number): string {
  return fmt(dayMs(day), { weekday: "short" });
}

/** One letter or character: "S", "日". */
export function weekdayNarrow(day: number): string {
  return fmt(dayMs(day), { weekday: "narrow" });
}

/** Month `m` (1–12): "October", "十月"; short: "Oct", "10月". */
export function monthName(m: number, width: "long" | "short" = "long"): string {
  return new Date(2000, m - 1, 1).toLocaleDateString(intlLocale(), { month: width });
}

/**
 * The days of the week in the order the language lists them: Monday first (English as
 * before, and the mainland), Sunday first in Taiwan.
 */
export function weekOrder(l: Language = language()): number[] {
  return l === "zh-TW" ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
}
