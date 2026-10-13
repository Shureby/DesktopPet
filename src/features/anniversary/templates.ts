import { easter, tableDate } from "./holidays";
import { lunarDayName, lunarMonthName } from "../../i18n/chinese";
import { monthName, weekdayName } from "../../i18n/format";
import { msg, t } from "../../i18n";
import type { Anniversary, AnniversaryPrep } from "../../platform/types";
import { PIECES, pieceById, type Piece } from "../../celebrate/music";
import { lunarInYear } from "./lunar";

/**
 * Anniversary templates (docs/INTERACTIONS.md, "Anniversaries"): picking one fills in the
 * icon, the reminders before the day and whether it plays an effect; the pet's words on the
 * day come from it too. Everything stays editable.
 */
export type AnniversaryKind = "birthday" | "wedding" | "dating" | "pet" | "work" | "home" | "remembrance" | "holiday" | "custom";

export interface AnniversaryTemplate {
  label: string;
  icon: string;
  preps: AnniversaryPrep[];
  /** Fireworks for a happy day; a remembrance's candle and flowers are off by default. */
  effect: boolean;
  /** What falls with the fireworks, after the anniversary's own icon. */
  falling: string[];
  /** Some fireworks burst as a pair of hearts side by side (red with pink or gold). */
  hearts?: boolean;
  /** Balloons rise from the bottom; this share of them are shaped like pets' heads. */
  balloons?: number;
  placeholder: string;
  /** The music on the day (src/celebrate/music.ts): the default, or the only one when `musicFixed`. */
  music: string;
  musicFixed?: boolean;
  /** The only pieces it can choose from (otherwise any of its mood). */
  musicOptions?: string[];
}

export const TEMPLATES: Record<AnniversaryKind, AnniversaryTemplate> = {
  birthday: {
    label: msg("Birthday"),
    icon: "🎂",
    preps: [
      { lead: "1w", label: msg("Buy a gift") },
      { lead: "1d", label: msg("Order a cake") },
    ],
    effect: true,
    falling: ["🎁"],
    balloons: 0.3,
    placeholder: msg("Whose birthday? e.g. Mum"),
    music: "birthday",
    musicFixed: true,
  },
  wedding: {
    label: msg("Wedding anniversary"),
    icon: "💍",
    preps: [
      { lead: "1w", label: msg("Book a restaurant") },
      { lead: "1d", label: msg("Buy flowers") },
    ],
    effect: true,
    falling: ["❤️", "🥂"],
    hearts: true,
    placeholder: msg("e.g. Our wedding"),
    music: "canon",
    musicOptions: ["canon", "mendelssohn", "wagner"],
  },
  dating: {
    label: msg("Dating anniversary"),
    icon: "💝",
    preps: [{ lead: "1d", label: msg("Plan a surprise") }],
    effect: true,
    falling: ["🌹", "❤️"],
    hearts: true,
    placeholder: msg("e.g. Us"),
    music: "waltz",
  },
  pet: {
    label: msg("Pet's birthday"),
    icon: "🐾",
    preps: [{ lead: "1d", label: msg("Buy treats") }],
    effect: true,
    falling: ["🦴"],
    balloons: 0.6,
    placeholder: msg("Your pet's name"),
    music: "birthday",
    musicFixed: true,
  },
  work: { label: msg("Work anniversary"), icon: "🏆", preps: [], effect: true, falling: ["🎉", "⭐"], placeholder: msg("e.g. Joined EzyAppCo"), music: "waltz" },
  home: { label: msg("Home anniversary"), icon: "🏠", preps: [], effect: true, falling: ["🎉", "🎈"], placeholder: msg("e.g. Moved in"), music: "waltz" },
  remembrance: {
    label: msg("Remembrance"),
    icon: "🕯️",
    preps: [{ lead: "1d", label: msg("Buy flowers") }],
    effect: false,
    falling: [],
    placeholder: msg("Who you remember"),
    music: "aisi",
  },
  holiday: {
    label: msg("Holiday"),
    icon: "🎉",
    preps: [],
    effect: true,
    falling: ["🎉", "🎊"],
    placeholder: msg("e.g. Mid-Autumn Festival"),
    music: "festive",
  },
  custom: { label: msg("Custom"), icon: "🌟", preps: [], effect: true, falling: ["🎉", "🎊"], placeholder: msg("Name"), music: "waltz" },
};

export const KINDS = Object.keys(TEMPLATES) as AnniversaryKind[];

export function templateOf(kind: string): AnniversaryTemplate {
  return TEMPLATES[(kind in TEMPLATES ? kind : "custom") as AnniversaryKind];
}

export const ICONS = ["🎂", "🎁", "💍", "💐", "🌹", "💝", "❤️", "🥂", "🍾", "🎉", "🎊", "🎈", "🏠", "🎓", "👶", "🐾", "🏆", "✈️", "🌟", "🕯️"];

/** How long before the day a reminder comes (the store knows the same codes). */
export const LEADS: [string, string][] = [
  ["1d", msg("1 day")],
  ["2d", msg("2 days")],
  ["3d", msg("3 days")],
  ["1w", msg("1 week")],
  ["2w", msg("2 weeks")],
  ["1m", msg("1 month")],
];

export function leadLabel(lead: string): string {
  const label = LEADS.find(([k]) => k === lead)?.[1];
  return label ? t(label) : lead;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** "36th" for birthdays and the like, "7 years" where a count reads better. */
export function yearsText(kind: string, years: number): string {
  if (kind === "dating" || kind === "remembrance" || kind === "work" || kind === "home")
    return years === 1 ? t("{n} year", { n: years }) : t("{n} years", { n: years });
  return t("{ord}", { ord: ordinal(years), n: years });
}

/** The pet's words on the day: a line, and a smaller one under it (or ""). */
export function celebrationLines(a: Pick<Anniversary, "kind" | "name" | "icon">, years: number | null): [string, string] {
  const y = years ?? 0;
  switch (a.kind) {
    case "birthday":
      return [y ? t("🎉 Happy {ord} birthday, {name}!", { ord: ordinal(y), n: y, name: a.name }) : t("🎉 Happy birthday, {name}!", { name: a.name }), ""];
    case "wedding":
      return [y ? t("🥂 Happy {ord} wedding anniversary!", { ord: ordinal(y), n: y }) : t("🥂 Happy wedding anniversary!"), a.name];
    case "dating":
      return [y ? t("💝 {years} together today!", { years: yearsText("dating", y) }) : t("💝 Happy anniversary!"), a.name];
    case "pet":
      return [t("🐾 Happy birthday, {name}!", { name: a.name }), y ? t("{ord} birthday", { ord: ordinal(y), n: y }) : ""];
    case "work":
      return [y ? t("🏆 {years} at work today!", { years: yearsText("work", y) }) : t("🏆 Happy work anniversary!"), a.name];
    case "home":
      return [y ? t("🏠 {years} in your home!", { years: yearsText("home", y) }) : t("🏠 Happy home anniversary!"), a.name];
    case "remembrance":
      return [t("🕯️ Remembering {name} today.", { name: a.name }), y ? yearsText("remembrance", y) : ""];
    case "holiday":
      return [t("{icon} Happy {name}!", { icon: a.icon, name: a.name }), ""];
    default:
      return [t("{icon} Today is {name}!", { icon: a.icon, name: a.name }), y ? yearsText("custom", y) : ""];
  }
}

/** What the day plays: fireworks (with these icons falling) or a candle and flowers. */
export function celebrationEffect(a: Pick<Anniversary, "kind" | "icon">): {
  mode: "fireworks" | "candle";
  icons: string[];
  hearts?: boolean;
  balloons?: number;
} {
  if (a.kind === "remembrance") return { mode: "candle", icons: [] };
  const tpl = templateOf(a.kind);
  // With drawn balloons rising, a 🎈 icon doesn't fall as well.
  const icons = [a.icon, ...tpl.falling.filter((i) => i !== a.icon)].filter((i) => !(tpl.balloons !== undefined && i === "🎈"));
  return { mode: "fireworks", icons, hearts: tpl.hearts, balloons: tpl.balloons };
}

/** The pieces it can choose from: its template's list (a wedding), else happy ones, or for a remembrance the mourning ones. */
export function musicChoices(kind: string): Piece[] {
  const options = templateOf(kind).musicOptions;
  if (options) return PIECES.filter((p) => options.includes(p.id));
  const mood = kind === "remembrance" ? "mourning" : "happy";
  return PIECES.filter((p) => p.mood === mood);
}

/** The piece it plays: the template's own when fixed, else its choice (if it suits), else the default. */
export function musicFor(a: Pick<Anniversary, "kind" | "music">): Piece {
  const tpl = templateOf(a.kind);
  const chosen = tpl.musicFixed ? undefined : musicChoices(a.kind).find((p) => p.id === a.music);
  return chosen ?? pieceById(tpl.music) ?? PIECES[0];
}

/** How an anniversary's day is found each year (see DateRule). */
export type CalendarKind = "solar" | "lunar" | "weekday" | "table" | "easter";

/**
 * An anniversary's day: a date ("solar": month/day), a lunar date (month/day in the lunar
 * calendar, `leap` for a leap month) or a day of the week ("weekday": the `nth` (1–4, -1 for
 * the last) `weekday` (0 = Sunday) of `month`, e.g. Mother's Day).
 */
export type DateRule = Pick<Anniversary, "month" | "day"> & Partial<Pick<Anniversary, "calendar" | "leap" | "nth" | "weekday">>;

/** The day of the `nth` (1–4, or -1: the last) `weekday` (0 = Sunday) of a month. */
export function nthWeekday(year: number, month: number, nth: number, weekday: number): Date {
  if (nth < 0) {
    const last = new Date(year, month, 0);
    return new Date(year, month - 1, last.getDate() - ((last.getDay() - weekday + 7) % 7));
  }
  const first = new Date(year, month - 1, 1).getDay();
  return new Date(year, month - 1, 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7);
}

/**
 * When it comes round in a year: Gregorian year `year` for a date or a day of the week, lunar
 * year `year` for a lunar date (null outside 1900–2099). Feb 29 is Feb 28 in other years.
 */
function inYear(rule: DateRule, year: number): Date | null {
  switch (rule.calendar ?? "solar") {
    case "lunar":
      return lunarInYear(year, rule.month, rule.day, rule.leap === true);
    case "weekday":
      return nthWeekday(year, rule.month, rule.nth ?? 1, rule.weekday ?? 0);
    case "table":
      return tableDate(rule.month, year);
    case "easter": {
      const e = easter(year);
      return new Date(e.getFullYear(), e.getMonth(), e.getDate() + (rule.nth ?? 0));
    }
    default: {
      const last = new Date(year, rule.month, 0).getDate();
      return new Date(year, rule.month - 1, Math.min(rule.day, last));
    }
  }
}

/**
 * The next time it comes round, on or after `now`'s day (mirrors anniversary_on_or_after in
 * schedule.rs); null past the lunar table (2099).
 */
export function nextAnniversary(rule: DateRule, now = Date.now()): Date | null {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const y = today.getFullYear();
  // A lunar year starts in January or February: last lunar year's end may still be ahead.
  const years = rule.calendar === "lunar" ? [y - 1, y, y + 1] : [y, y + 1];
  for (const year of years) {
    const d = inYear(rule, year);
    if (d && d >= today) return d;
  }
  return null;
}

/** "Lunar 8/15" (农历八月十五), "Lunar leap 4/8", "2nd Sunday of May"; null for a plain date (its day says it). */
export function ruleText(rule: DateRule): string | null {
  if (rule.calendar === "lunar") {
    const params = { month: rule.month, day: rule.day, cnMonth: lunarMonthName(rule.month), cnDay: lunarDayName(rule.day) };
    return rule.leap ? t("Lunar leap {month}/{day}", params) : t("Lunar {month}/{day}", params);
  }
  if (rule.calendar === "weekday") {
    const nth = rule.nth ?? 1;
    const params = { nth: ordinal(nth), n: nth, weekday: weekdayName(rule.weekday ?? 0), month: monthName(rule.month), m: rule.month };
    return nth < 0 ? t("Last {weekday} of {month}", params) : t("{nth} {weekday} of {month}", params);
  }
  if (rule.calendar === "table") return t("as announced each year");
  if (rule.calendar === "easter") {
    const n = rule.nth ?? 0;
    return n === 0 ? t("Easter Sunday") : n < 0 ? t("{n} days before Easter", { n: -n }) : t("{n} days after Easter", { n });
  }
  return null;
}

/** Whole days from today to `date`. */
export function daysUntil(date: Date, now = Date.now()): number {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((date.getTime() - today.getTime()) / 86_400_000);
}

/** "Today", "Tomorrow", "in 3 days", "in 5 months". */
export function untilText(days: number): string {
  if (days === 0) return t("Today 🎉");
  if (days === 1) return t("Tomorrow");
  if (days <= 60) return t("in {n} days", { n: days });
  const months = Math.round(days / 30.4);
  return months === 1 ? t("in {n} month", { n: months }) : t("in {n} months", { n: months });
}

/** The day of a reminder `lead` before `on` (mirrors prep_day in schedule.rs). */
export function prepDay(on: Date, lead: string): Date | null {
  const days = ({ "1d": 1, "2d": 2, "3d": 3, "1w": 7, "2w": 14 } as Record<string, number>)[lead];
  if (days !== undefined) return new Date(on.getFullYear(), on.getMonth(), on.getDate() - days);
  if (lead !== "1m") return null;
  const last = new Date(on.getFullYear(), on.getMonth(), 0).getDate();
  return new Date(on.getFullYear(), on.getMonth() - 1, Math.min(on.getDate(), last));
}
