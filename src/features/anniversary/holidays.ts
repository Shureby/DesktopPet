/**
 * The holidays the Holiday template offers, by region (docs/INTERACTIONS.md, "Language and
 * region"): Mainland China, Taiwan, Hong Kong, Singapore, Malaysia, and the rest of the world.
 * Picking one fills in its name (in the interface's language), icon, day and reminders.
 *
 * Days that can't be worked out (Hari Raya, Deepavali…) come from holiday-dates.json as they're
 * announced; Easter is computed. The Rust side reads the same file (schedule.rs).
 */
import type { AnniversaryPrep } from "../../platform/types";
import { msg } from "../../i18n";
import type { Region } from "../../i18n/region";
import tables from "./holiday-dates.json";
import type { DateRule } from "./templates";

export interface Holiday {
  /** The English name (shown through t()). */
  name: string;
  icon: string;
  rule: DateRule;
  preps: AnniversaryPrep[];
  music: string;
  regions: Region[];
  /** A day of remembrance: kept as a Remembrance (candle and flowers, no fireworks). */
  solemn?: boolean;
}

/** A holiday listed in holiday-dates.json, by its key there. */
export type TableKey = "qingming" | "hariRayaPuasa" | "hariRayaHaji" | "vesak" | "deepavali" | "thaipusam" | "dongzhi";

/** Its number for DateRule.month (1-based, in the file's order). */
export function tableNumber(key: TableKey): number {
  return tables.tables.indexOf(key) + 1;
}

/** The day of holiday number `table` in `year`; null if not announced (mirrors table_date in schedule.rs). */
export function tableDate(table: number, year: number): Date | null {
  const key = tables.tables[table - 1] as TableKey | undefined;
  const md = key ? (tables.dates as Record<string, Record<string, string>>)[key]?.[String(year)] : undefined;
  if (!md) return null;
  const [m, d] = md.split("-").map(Number);
  return new Date(year, m - 1, d);
}

/** Easter Sunday (Gregorian; mirrors easter in schedule.rs). */
export function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return new Date(year, Math.floor(n / 31) - 1, (n % 31) + 1);
}

const solar = (month: number, day: number): DateRule => ({ calendar: "solar", month, day });
const lunar = (month: number, day: number): DateRule => ({ calendar: "lunar", month, day });
const weekday = (month: number, nth: number, day: number): DateRule => ({ calendar: "weekday", month, day: 1, nth, weekday: day });
const table = (key: TableKey): DateRule => ({ calendar: "table", month: tableNumber(key), day: 1 });
const fromEaster = (days: number): DateRule => ({ calendar: "easter", month: 1, day: 1, nth: days });

const CHINESE: Region[] = ["CN", "TW", "HK", "SG", "MY", "other"];
const GREATER_CHINA: Region[] = ["CN", "TW", "HK", "other"];
const gift = (label: string, lead = "1w"): AnniversaryPrep[] => [{ lead, label }];

/** Every region's holidays, roughly in the order of the year. */
export const HOLIDAYS: Holiday[] = [
  { name: msg("New Year's Day"), icon: "🎆", rule: solar(1, 1), preps: [], music: "festive", regions: ["CN", "TW", "HK", "SG", "MY"] },
  { name: msg("Thaipusam"), icon: "🪔", rule: table("thaipusam"), preps: [], music: "festive", regions: ["MY"] },
  { name: msg("Lunar New Year's Eve"), icon: "🥟", rule: lunar(12, 30), preps: gift(msg("Book the reunion dinner"), "1d"), music: "festive", regions: CHINESE },
  { name: msg("Lunar New Year"), icon: "🧧", rule: lunar(1, 1), preps: gift(msg("Buy New Year gifts")), music: "festive", regions: CHINESE },
  { name: msg("Lantern Festival"), icon: "🏮", rule: lunar(1, 15), preps: [], music: "festive", regions: GREATER_CHINA },
  { name: msg("Peace Memorial Day"), icon: "🕊️", rule: solar(2, 28), preps: [], music: "aisi", regions: ["TW"], solemn: true },
  { name: msg("Hari Raya Puasa"), icon: "🌙", rule: table("hariRayaPuasa"), preps: [], music: "festive", regions: ["SG", "MY"] },
  { name: msg("Good Friday"), icon: "✝️", rule: fromEaster(-2), preps: [], music: "aisi", regions: ["HK", "SG"], solemn: true },
  { name: msg("Easter"), icon: "🐣", rule: fromEaster(0), preps: [], music: "waltz", regions: ["HK", "other"] },
  { name: msg("Children's Day"), icon: "🧸", rule: solar(4, 4), preps: gift(msg("Buy a gift"), "3d"), music: "festive", regions: ["TW"] },
  { name: msg("Qingming Festival"), icon: "🌿", rule: table("qingming"), preps: [{ lead: "3d", label: msg("Plan the visit to the graves") }], music: "aisi", regions: ["CN", "TW", "HK", "other"], solemn: true },
  { name: msg("Labour Day"), icon: "🛠️", rule: solar(5, 1), preps: [], music: "festive", regions: ["CN", "HK", "SG", "MY"] },
  { name: msg("Buddha's Birthday"), icon: "🪷", rule: lunar(4, 8), preps: [], music: "festive", regions: ["HK"] },
  { name: msg("Vesak Day"), icon: "🪷", rule: table("vesak"), preps: [], music: "festive", regions: ["SG", "MY"] },
  { name: msg("Mother's Day"), icon: "💐", rule: weekday(5, 2, 0), preps: gift(msg("Buy flowers")), music: "waltz", regions: ["CN", "TW", "HK", "SG", "MY", "other"] },
  { name: msg("Hari Raya Haji"), icon: "🕌", rule: table("hariRayaHaji"), preps: [], music: "festive", regions: ["SG", "MY"] },
  { name: msg("Children's Day"), icon: "🧸", rule: solar(6, 1), preps: gift(msg("Buy a gift"), "3d"), music: "festive", regions: ["CN"] },
  { name: msg("Dragon Boat Festival"), icon: "🐉", rule: lunar(5, 5), preps: gift(msg("Buy zongzi"), "3d"), music: "festive", regions: GREATER_CHINA },
  { name: msg("Father's Day"), icon: "👔", rule: weekday(6, 3, 0), preps: gift(msg("Buy a gift")), music: "waltz", regions: ["CN", "HK", "SG", "MY", "other"] },
  { name: msg("HKSAR Establishment Day"), icon: "🇭🇰", rule: solar(7, 1), preps: [], music: "festive", regions: ["HK"] },
  { name: msg("Qixi"), icon: "💝", rule: lunar(7, 7), preps: gift(msg("Buy a gift")), music: "festive", regions: GREATER_CHINA },
  { name: msg("Father's Day"), icon: "👔", rule: solar(8, 8), preps: gift(msg("Buy a gift")), music: "waltz", regions: ["TW"] },
  { name: msg("National Day"), icon: "🇸🇬", rule: solar(8, 9), preps: [], music: "festive", regions: ["SG"] },
  { name: msg("Ghost Festival"), icon: "🏮", rule: lunar(7, 15), preps: [{ lead: "1d", label: msg("Prepare the offerings") }], music: "aisi", regions: ["TW"], solemn: true },
  { name: msg("Merdeka Day"), icon: "🇲🇾", rule: solar(8, 31), preps: [], music: "festive", regions: ["MY"] },
  { name: msg("Teachers' Day"), icon: "🍎", rule: solar(9, 10), preps: gift(msg("Thank a teacher"), "1d"), music: "festive", regions: ["CN"] },
  { name: msg("Malaysia Day"), icon: "🇲🇾", rule: solar(9, 16), preps: [], music: "festive", regions: ["MY"] },
  { name: msg("Mid-Autumn Festival"), icon: "🥮", rule: lunar(8, 15), preps: gift(msg("Buy mooncakes")), music: "festive", regions: CHINESE },
  { name: msg("Teachers' Day"), icon: "🍎", rule: solar(9, 28), preps: gift(msg("Thank a teacher"), "1d"), music: "festive", regions: ["TW"] },
  { name: msg("National Day"), icon: "🇨🇳", rule: solar(10, 1), preps: [], music: "festive", regions: ["CN", "HK"] },
  { name: msg("Double Ninth Festival"), icon: "🌼", rule: lunar(9, 9), preps: gift(msg("Call the elders"), "1d"), music: "festive", regions: GREATER_CHINA },
  { name: msg("Double Tenth Day"), icon: "🎆", rule: solar(10, 10), preps: [], music: "festive", regions: ["TW"] },
  { name: msg("Deepavali"), icon: "🪔", rule: table("deepavali"), preps: [], music: "festive", regions: ["SG", "MY"] },
  { name: msg("Thanksgiving (Canada)"), icon: "🦃", rule: weekday(10, 2, 1), preps: gift(msg("Plan the dinner")), music: "waltz", regions: ["other"] },
  { name: msg("Thanksgiving (US)"), icon: "🦃", rule: weekday(11, 4, 4), preps: gift(msg("Plan the dinner")), music: "waltz", regions: ["other"] },
  { name: msg("Father's Day (Australia, NZ)"), icon: "👔", rule: weekday(9, 1, 0), preps: gift(msg("Buy a gift")), music: "waltz", regions: ["other"] },
  { name: msg("Winter Solstice"), icon: "🥣", rule: table("dongzhi"), preps: [], music: "festive", regions: ["HK", "TW", "SG", "MY"] },
  { name: msg("Laba Festival"), icon: "🥣", rule: lunar(12, 8), preps: [], music: "festive", regions: ["CN"] },
  { name: msg("Little New Year"), icon: "🧹", rule: lunar(12, 23), preps: [], music: "festive", regions: ["CN"] },
  { name: msg("Christmas"), icon: "🎄", rule: solar(12, 25), preps: gift(msg("Buy presents"), "2w"), music: "waltz", regions: ["HK", "SG", "MY", "other"] },
];

/** The holidays of a region, in the order of the year. */
export function holidaysFor(region: Region): Holiday[] {
  return HOLIDAYS.filter((h) => h.regions.includes(region));
}
