/** Whether `now` falls within [start, end) given "HH:MM" strings; handles ranges past midnight. */
export function inQuietHours(now: Date, start: string, end: string): boolean {
  const toMin = (hm: string) => {
    const [h, m] = hm.split(":").map(Number);
    return h * 60 + m;
  };
  const t = now.getHours() * 60 + now.getMinutes();
  const s = toMin(start);
  const e = toMin(end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}
