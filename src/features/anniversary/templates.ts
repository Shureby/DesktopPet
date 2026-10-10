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
    label: "Birthday",
    icon: "🎂",
    preps: [
      { lead: "1w", label: "Buy a gift" },
      { lead: "1d", label: "Order a cake" },
    ],
    effect: true,
    falling: ["🎁"],
    balloons: 0.3,
    placeholder: "Whose birthday? e.g. Mum",
    music: "birthday",
    musicFixed: true,
  },
  wedding: {
    label: "Wedding anniversary",
    icon: "💍",
    preps: [
      { lead: "1w", label: "Book a restaurant" },
      { lead: "1d", label: "Buy flowers" },
    ],
    effect: true,
    falling: ["❤️", "🥂"],
    hearts: true,
    placeholder: "e.g. Our wedding",
    music: "canon",
    musicOptions: ["canon", "mendelssohn", "wagner"],
  },
  dating: {
    label: "Dating anniversary",
    icon: "💝",
    preps: [{ lead: "1d", label: "Plan a surprise" }],
    effect: true,
    falling: ["🌹", "❤️"],
    hearts: true,
    placeholder: "e.g. Us",
    music: "waltz",
  },
  pet: {
    label: "Pet's birthday",
    icon: "🐾",
    preps: [{ lead: "1d", label: "Buy treats" }],
    effect: true,
    falling: ["🦴"],
    balloons: 0.6,
    placeholder: "Your pet's name",
    music: "birthday",
    musicFixed: true,
  },
  work: { label: "Work anniversary", icon: "🏆", preps: [], effect: true, falling: ["🎉", "⭐"], placeholder: "e.g. Joined EzyAppCo", music: "waltz" },
  home: { label: "Home anniversary", icon: "🏠", preps: [], effect: true, falling: ["🎉", "🎈"], placeholder: "e.g. Moved in", music: "waltz" },
  remembrance: {
    label: "Remembrance",
    icon: "🕯️",
    preps: [{ lead: "1d", label: "Buy flowers" }],
    effect: false,
    falling: [],
    placeholder: "Who you remember",
    music: "aisi",
  },
  holiday: {
    label: "Holiday",
    icon: "🎉",
    preps: [],
    effect: true,
    falling: ["🎉", "🎊"],
    placeholder: "e.g. Mid-Autumn Festival",
    music: "festive",
  },
  custom: { label: "Custom", icon: "🌟", preps: [], effect: true, falling: ["🎉", "🎊"], placeholder: "Name", music: "waltz" },
};

export const KINDS = Object.keys(TEMPLATES) as AnniversaryKind[];

/** A holiday to pick (Holiday): its name, icon, day and suggested reminders. */
export interface Holiday {
  name: string;
  icon: string;
  rule: DateRule;
  preps: AnniversaryPrep[];
  music: string;
}

const lunar = (month: number, day: number): DateRule => ({ calendar: "lunar", month, day });
const weekday = (month: number, nth: number, day: number): DateRule => ({ calendar: "weekday", month, day: 1, nth, weekday: day });

/** The holidays Holiday offers, by their day in the year. */
export const HOLIDAYS: Holiday[] = [
  { name: "Lunar New Year", icon: "🧧", rule: lunar(1, 1), preps: [{ lead: "1w", label: "Buy New Year gifts" }], music: "festive" },
  { name: "Lantern Festival", icon: "🏮", rule: lunar(1, 15), preps: [], music: "festive" },
  { name: "Dragon Boat Festival", icon: "🐉", rule: lunar(5, 5), preps: [{ lead: "3d", label: "Buy zongzi" }], music: "festive" },
  { name: "Qixi", icon: "💝", rule: lunar(7, 7), preps: [{ lead: "1w", label: "Buy a gift" }], music: "festive" },
  { name: "Mid-Autumn Festival", icon: "🥮", rule: lunar(8, 15), preps: [{ lead: "1w", label: "Buy mooncakes" }], music: "festive" },
  { name: "Double Ninth Festival", icon: "🌼", rule: lunar(9, 9), preps: [{ lead: "1d", label: "Call the elders" }], music: "festive" },
  // The 30th is the 29th in a short month: always the last day of the year.
  { name: "Lunar New Year's Eve", icon: "🥟", rule: lunar(12, 30), preps: [{ lead: "1d", label: "Book the reunion dinner" }], music: "festive" },
  { name: "Mother's Day", icon: "💐", rule: weekday(5, 2, 0), preps: [{ lead: "1w", label: "Buy flowers" }], music: "waltz" },
  { name: "Father's Day", icon: "👔", rule: weekday(6, 3, 0), preps: [{ lead: "1w", label: "Buy a gift" }], music: "waltz" },
  { name: "Father's Day (Australia, NZ)", icon: "👔", rule: weekday(9, 1, 0), preps: [{ lead: "1w", label: "Buy a gift" }], music: "waltz" },
  { name: "Thanksgiving (US)", icon: "🦃", rule: weekday(11, 4, 4), preps: [{ lead: "1w", label: "Plan the dinner" }], music: "waltz" },
  { name: "Thanksgiving (Canada)", icon: "🦃", rule: weekday(10, 2, 1), preps: [{ lead: "1w", label: "Plan the dinner" }], music: "waltz" },
];

export function templateOf(kind: string): AnniversaryTemplate {
  return TEMPLATES[(kind in TEMPLATES ? kind : "custom") as AnniversaryKind];
}

export const ICONS = ["🎂", "🎁", "💍", "💐", "🌹", "💝", "❤️", "🥂", "🍾", "🎉", "🎊", "🎈", "🏠", "🎓", "👶", "🐾", "🏆", "✈️", "🌟", "🕯️"];

/** How long before the day a reminder comes (the store knows the same codes). */
export const LEADS: [string, string][] = [
  ["1d", "1 day"],
  ["2d", "2 days"],
  ["3d", "3 days"],
  ["1w", "1 week"],
  ["2w", "2 weeks"],
  ["1m", "1 month"],
];

export function leadLabel(lead: string): string {
  return LEADS.find(([k]) => k === lead)?.[1] ?? lead;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** "36th" for birthdays and the like, "7 years" where a count reads better. */
export function yearsText(kind: string, years: number): string {
  if (kind === "dating" || kind === "remembrance" || kind === "work" || kind === "home") return `${years} year${years === 1 ? "" : "s"}`;
  return ordinal(years);
}

/** The pet's words on the day: a line, and a smaller one under it (or ""). */
export function celebrationLines(a: Pick<Anniversary, "kind" | "name" | "icon">, years: number | null): [string, string] {
  const y = years ?? 0;
  switch (a.kind) {
    case "birthday":
      return [y ? `🎉 Happy ${ordinal(y)} birthday, ${a.name}!` : `🎉 Happy birthday, ${a.name}!`, ""];
    case "wedding":
      return [y ? `🥂 Happy ${ordinal(y)} wedding anniversary!` : "🥂 Happy wedding anniversary!", a.name];
    case "dating":
      return [y ? `💝 ${yearsText("dating", y)} together today!` : "💝 Happy anniversary!", a.name];
    case "pet":
      return [`🐾 Happy birthday, ${a.name}!`, y ? `${ordinal(y)} birthday` : ""];
    case "work":
      return [y ? `🏆 ${yearsText("work", y)} at work today!` : "🏆 Happy work anniversary!", a.name];
    case "home":
      return [y ? `🏠 ${yearsText("home", y)} in your home!` : "🏠 Happy home anniversary!", a.name];
    case "remembrance":
      return [`🕯️ Remembering ${a.name} today.`, y ? yearsText("remembrance", y) : ""];
    case "holiday":
      return [`${a.icon} Happy ${a.name}!`, ""];
    default:
      return [`${a.icon} Today is ${a.name}!`, y ? yearsText("custom", y) : ""];
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
  const t = templateOf(a.kind);
  // With drawn balloons rising, a 🎈 icon doesn't fall as well.
  const icons = [a.icon, ...t.falling.filter((i) => i !== a.icon)].filter((i) => !(t.balloons !== undefined && i === "🎈"));
  return { mode: "fireworks", icons, hearts: t.hearts, balloons: t.balloons };
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
  const t = templateOf(a.kind);
  const chosen = t.musicFixed ? undefined : musicChoices(a.kind).find((p) => p.id === a.music);
  return chosen ?? pieceById(t.music) ?? PIECES[0];
}

/** How an anniversary's day is found each year (see DateRule). */
export type CalendarKind = "solar" | "lunar" | "weekday";

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

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Lunar 8/15", "Lunar leap 4/8", "2nd Sunday of May"; null for a plain date (its day says it). */
export function ruleText(rule: DateRule): string | null {
  if (rule.calendar === "lunar") return `Lunar ${rule.leap ? "leap " : ""}${rule.month}/${rule.day}`;
  if (rule.calendar === "weekday") {
    const nth = rule.nth ?? 1;
    return `${nth < 0 ? "Last" : ordinal(nth)} ${WEEKDAY_NAMES[rule.weekday ?? 0]} of ${MONTH_NAMES[rule.month - 1]}`;
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
  if (days === 0) return "Today 🎉";
  if (days === 1) return "Tomorrow";
  if (days <= 60) return `in ${days} days`;
  const months = Math.round(days / 30.4);
  return `in ${months} month${months === 1 ? "" : "s"}`;
}

/** The day of a reminder `lead` before `on` (mirrors prep_day in schedule.rs). */
export function prepDay(on: Date, lead: string): Date | null {
  const days = ({ "1d": 1, "2d": 2, "3d": 3, "1w": 7, "2w": 14 } as Record<string, number>)[lead];
  if (days !== undefined) return new Date(on.getFullYear(), on.getMonth(), on.getDate() - days);
  if (lead !== "1m") return null;
  const last = new Date(on.getFullYear(), on.getMonth(), 0).getDate();
  return new Date(on.getFullYear(), on.getMonth() - 1, Math.min(on.getDate(), last));
}
