/** Chinese numerals for lunar dates: 正月 … 腊月, 初一 … 三十 (the same in both scripts but 腊/臘). */
import { language } from "./index";

const DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 正月, 二月 … 冬月, 腊月 (臘月 in Traditional). */
export function lunarMonthName(m: number): string {
  if (m === 1) return "正月";
  if (m === 11) return "冬月";
  if (m === 12) return language() === "zh-TW" ? "臘月" : "腊月";
  return `${DIGITS[m]}月`;
}

/** 初一 … 初十, 十一 … 二十, 廿一 … 廿九, 三十. */
export function lunarDayName(d: number): string {
  if (d <= 10) return `初${DIGITS[d]}`;
  if (d < 20) return `十${DIGITS[d - 10]}`;
  if (d === 20) return "二十";
  if (d < 30) return `廿${DIGITS[d - 20]}`;
  return "三十";
}

/** Years since an anniversary began: 67 岁 (歲) for a birthday, 第 3 年 for a holiday, 3 周年 (週年) otherwise. */
export function chineseYears(kind: string, n: number): string {
  const tw = language() === "zh-TW";
  if (kind === "birthday" || kind === "pet") return `${n} ${tw ? "歲" : "岁"}`;
  if (kind === "holiday" || kind === "custom") return `第 ${n} 年`;
  return `${n} ${tw ? "週年" : "周年"}`;
}
