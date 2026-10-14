import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeSettings } from "../platform/types";
import { dictionary, fill, languageOf, lines, resolveLanguage, setLanguage, t, type Language } from "./index";
import { clock, joinDot, shortDate, shortDateYear, weekdayName, weekOrder } from "./format";
import { formatWhen } from "../panel/dom";
import { datePartText } from "../panel/dateField";
import { lateness, lateNote } from "../features/alarm/late";
import { yearsText } from "../features/anniversary/templates";
import { LINE_SETS, placeholders, sourceKeys } from "./keys";
import { regionOf, resolveRegion } from "./region";
import { timeRange } from "../features/alarm/ringing";
import { formatDuration, timerLabel } from "../features/alarm/timers";
import { ruleText } from "../features/anniversary/templates";
import { lateBy } from "../features/alarm/late";

const keys = sourceKeys(join(__dirname, ".."));
/** Params some texts get besides those in the English (a number where English says "36th"…). */
const EXTRA_PARAMS = ["n", "m", "cnMonth", "cnDay"];

afterEach(() => setLanguage("en"));

describe("[i18n.dictionaries] the translations", () => {
  for (const lang of ["zh-CN", "zh-TW"] as const) {
    const d = dictionary(lang);
    it(`${lang}: every text the interface shows is translated, and nothing else`, () => {
      expect(keys.length).toBeGreaterThan(500);
      expect(keys.filter((k) => !(k.text in d.text)).map((k) => `${k.where}: ${k.text}`)).toEqual([]);
      const used = new Set(keys.map((k) => k.text));
      expect(Object.keys(d.text).filter((k) => !used.has(k))).toEqual([]);
    });

    it(`${lang}: the same {placeholders} (a Chinese one may use the number instead of "36th")`, () => {
      const wrong = Object.entries(d.text).filter(([en, zh]) => {
        const allowed = new Set([...placeholders(en), ...EXTRA_PARAMS]);
        return placeholders(zh).some((p) => !allowed.has(p)) || placeholders(en).length > placeholders(zh).length + 1;
      });
      expect(wrong).toEqual([]);
    });

    it(`${lang}: every line set, at least three lines`, () => {
      for (const id of LINE_SETS) expect(d.lines[id]?.length ?? 0, id).toBeGreaterThanOrEqual(3);
    });
  }

  it("English is the key; the Chinese replaces it; {name}s are filled", () => {
    expect(t("Open panel…")).toBe("Open panel…");
    setLanguage("zh-CN");
    expect(t("Open panel…")).toBe("打开面板…");
    expect(t("Alarm {time}", { time: "16:30" })).toBe("闹钟 16:30");
    setLanguage("zh-TW");
    expect(t("Open panel…")).toBe("開啟面板…");
    expect(t("Not a known text")).toBe("Not a known text");
    expect(lines("avoid.shownAnyway", ["en"])).not.toEqual(["en"]);
    expect(fill("{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });
});

describe("[i18n.formats] dates and times as each language writes them", () => {
  const at = new Date(2026, 9, 13, 16, 30).getTime(); // a Tuesday
  const as = (l: Language) => setLanguage(l);

  it("the mainland: 24 hours, Monday first", () => {
    as("zh-CN");
    expect(clock(at)).toBe("16:30");
    expect(shortDate(at)).toBe("10月13日（周二）");
    expect(shortDateYear(at)).toBe("2026年10月13日（周二）");
    expect(clock(new Date(2026, 9, 13, 7, 5).getTime())).toBe("07:05");
    expect(formatWhen(at + 4 * 86_400_000, at)).toBe("10月17日（周六）16:30");
    // No space between the bracket and the dot.
    expect(joinDot("农历九月初三", shortDate(at), "3 天后")).toBe("农历九月初三 · 10月13日（周二）· 3 天后");
    expect(weekdayName(0)).toBe("星期日");
    expect(weekOrder()[0]).toBe(1);
    expect(timeRange(at, at + 15 * 60_000)).toBe("16:30 → 16:45");
  });

  it("Taiwan: 上午/下午 first, Sunday first", () => {
    as("zh-TW");
    expect(clock(at)).toBe("下午4:30");
    expect(shortDate(at)).toBe("10月13日（週二）");
    expect(clock(new Date(2026, 9, 13, 7, 5).getTime())).toBe("上午7:05");
    // No space between Chinese and a 上午/下午 time.
    expect(t("Focusing until {time}", { time: clock(at) })).toBe("專注到下午4:30");
    expect(weekOrder()[0]).toBe(0);
    // A shared 下午 is written once, at the front.
    expect(timeRange(at, at + 15 * 60_000)).toBe("下午4:30 → 4:45");
  });

  it("durations, lateness and lunar dates in Chinese; stored labels stay English", () => {
    as("zh-CN");
    expect(formatDuration(90)).toBe("1 小时 30 分钟");
    expect(formatDuration(1.5)).toBe("1 分钟 30 秒");
    expect(lateBy(65 * 60_000)).toBe("1 小时 5 分钟");
    expect(timerLabel(90)).toBe("Timer: 1 h 30 min");
    // Why it rang late, translated too; years counted by the kind.
    expect(lateNote(lateness("alarm", at, at + 7 * 60_000, "presenting")!)).toBe("原定 16:30 · 晚了 7 分钟——你在演示");
    expect(yearsText("birthday", 67)).toBe("67 岁");
    expect(yearsText("remembrance", 100)).toBe("100 周年");
    expect(yearsText("holiday", 3)).toBe("第 3 年");
    expect(t("Next: {date} ({until})", { date: shortDateYear(at), until: t("Today") })).toBe("下一次：2026年10月13日（周二）· 今天");
    expect(t("Date|calendar")).toBe("公历");
    expect(datePartText("2026-10-14", "day", "zh-CN")).toBe("14日");
    expect(datePartText("2026-10-14", "year", "zh-CN")).toBe("2026年");
    expect(ruleText({ calendar: "lunar", month: 8, day: 15 })).toBe("农历八月十五");
    expect(ruleText({ calendar: "lunar", month: 12, day: 23 })).toBe("农历腊月廿三");
    expect(ruleText({ calendar: "weekday", month: 5, day: 1, nth: 2, weekday: 0 })).toBe("五月的第 2 个星期日");
    as("zh-TW");
    expect(ruleText({ calendar: "lunar", month: 12, day: 8 })).toBe("農曆臘月初八");
    expect(yearsText("wedding", 3)).toBe("3 週年");
    setLanguage("en");
    expect(t("Date|calendar")).toBe("Date");
    expect(joinDot("Oct 13", null, "in 3 days")).toBe("Oct 13 · in 3 days");
    expect(yearsText("birthday", 36)).toBe("36th");
    expect(shortDate(at)).toBe(new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));
  });
});

describe("[i18n.auto] the system's language and region", () => {
  it("Chinese by script and place; anything else English", () => {
    expect(languageOf("zh-Hans-CN")).toBe("zh-CN");
    expect(languageOf("zh-SG")).toBe("zh-CN");
    expect(languageOf("zh-Hant-TW")).toBe("zh-TW");
    expect(languageOf("zh-HK")).toBe("zh-TW");
    expect(languageOf("en-SG")).toBe("en");
    expect(languageOf(undefined)).toBe("en");
    expect(resolveLanguage("auto", ["zh-TW", "en"])).toBe("zh-TW");
    expect(resolveLanguage("en", ["zh-TW"])).toBe("en");
  });

  it("the region from the country; Macau with Hong Kong; others Other", () => {
    expect(regionOf("sg")).toBe("SG");
    expect(regionOf("MO")).toBe("HK");
    expect(regionOf("AU")).toBe("other");
    expect(regionOf(null)).toBe("other");
    expect(resolveRegion("TW", "SG")).toBe("TW");
    expect(resolveRegion("auto", "MY")).toBe("MY");
  });

  it("settings from before 0.43 are Auto; nonsense is Auto", () => {
    expect(mergeSettings({}).locale).toEqual({ language: "auto", region: "auto" });
    expect(mergeSettings({ locale: { language: "zh-TW", region: "HK" } }).locale).toEqual({ language: "zh-TW", region: "HK" });
    expect(mergeSettings({ locale: { language: "fr" as never, region: "XX" as never } }).locale).toEqual({ language: "auto", region: "auto" });
  });
});
