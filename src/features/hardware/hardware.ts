import { msg, t } from "../../i18n";

/**
 * Hardware (docs/INTERACTIONS.md, "Hardware"): what the pet's hover card shows, and the
 * alerts when something runs too hot or too full. The app reads only what's asked for,
 * only when asked (src-tauri/src/hardware); an item this computer can't read is missing.
 */

export type HwItem = "cpu" | "cpuFreq" | "cpuTemp" | "fan" | "memory" | "gpu" | "gpuTemp" | "vram" | "disk" | "network" | "battery";

/** In the order the card and Settings list them. */
export const HW_ITEMS: readonly HwItem[] = ["cpu", "cpuFreq", "cpuTemp", "fan", "memory", "gpu", "gpuTemp", "vram", "disk", "network", "battery"];

export const HW_LABELS: Record<HwItem, string> = {
  cpu: msg("CPU usage"),
  cpuFreq: msg("CPU frequency"),
  cpuTemp: msg("CPU temperature"),
  fan: msg("Fan speed"),
  memory: msg("Memory usage"),
  gpu: msg("GPU usage"),
  gpuTemp: msg("GPU temperature"),
  vram: msg("Video memory"),
  disk: msg("System disk free space"),
  network: msg("Network up/down"),
  battery: msg("Battery"),
};

export interface Used {
  used: number;
  total: number;
}

/** One reading (bytes, MHz, °C, percent); an item is missing when it can't be read. */
export interface HwReading {
  cpu?: number;
  cpuFreq?: number;
  cpuTemp?: number;
  fan?: number;
  memory?: Used;
  gpu?: number;
  gpuTemp?: number;
  vram?: Used;
  disk?: { free: number; total: number; name: string };
  /** Bytes per second. */
  network?: { down: number; up: number };
  battery?: { percent: number; plugged: boolean };
}

/** What can raise an alert. */
export type HwAlert = "cpuTemp" | "gpuTemp" | "memory" | "disk" | "battery";

export const HW_ALERTS: readonly HwAlert[] = ["cpuTemp", "gpuTemp", "memory", "disk", "battery"];

/** Each alert's limit: °C for temperatures, percent used for memory, percent free for the disk, percent left for the battery. */
export const LIMIT_RANGE: Record<HwAlert, { min: number; max: number; default: number }> = {
  cpuTemp: { min: 60, max: 105, default: 90 },
  gpuTemp: { min: 60, max: 100, default: 85 },
  memory: { min: 70, max: 99, default: 90 },
  disk: { min: 1, max: 30, default: 5 },
  battery: { min: 5, max: 50, default: 15 },
};

/** How often the alerts look (seconds). */
export const EVERY_CHOICES = [30, 60, 120, 300, 600] as const;

export type TempUnit = "C" | "F";

export interface HardwareSettings {
  /** What the hover card shows (none: no card). */
  show: HwItem[];
  /** Your choice per alert; missing: on when this computer can read it. */
  alerts: Partial<Record<HwAlert, boolean>>;
  limits: Record<HwAlert, number>;
  unit: TempUnit;
  /** Seconds between looks for the alerts. */
  every: number;
}

export const DEFAULT_HARDWARE: HardwareSettings = {
  show: ["cpu", "memory", "network"],
  alerts: {},
  limits: { cpuTemp: 90, gpuTemp: 85, memory: 90, disk: 5, battery: 15 },
  unit: "C",
  every: 60,
};

export function clampLimit(a: HwAlert, v: unknown): number {
  const r = LIMIT_RANGE[a];
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(r.max, Math.max(r.min, n)) : r.default;
}

/** The settings as stored (missing or odd values: the defaults). */
export function hardwareSettings(stored: unknown): HardwareSettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const show = Array.isArray(s.show) ? HW_ITEMS.filter((i) => (s.show as unknown[]).includes(i)) : [...DEFAULT_HARDWARE.show];
  const storedAlerts = (s.alerts && typeof s.alerts === "object" ? s.alerts : {}) as Record<string, unknown>;
  const alerts: Partial<Record<HwAlert, boolean>> = {};
  for (const a of HW_ALERTS) if (typeof storedAlerts[a] === "boolean") alerts[a] = storedAlerts[a] as boolean;
  const storedLimits = (s.limits && typeof s.limits === "object" ? s.limits : {}) as Record<string, unknown>;
  const limits = Object.fromEntries(HW_ALERTS.map((a) => [a, storedLimits[a] === undefined ? LIMIT_RANGE[a].default : clampLimit(a, storedLimits[a])])) as Record<HwAlert, number>;
  const every = Number(s.every);
  return {
    show,
    alerts,
    limits,
    unit: s.unit === "F" ? "F" : "C",
    every: (EVERY_CHOICES as readonly number[]).includes(every) ? every : DEFAULT_HARDWARE.every,
  };
}

/** Whether an item's value is in a reading. */
export function readable(r: HwReading, item: HwItem): boolean {
  return r[item] !== undefined;
}

/** An alert is on when you turned it on, or you never chose and this computer can read it. */
export function alertOn(s: HardwareSettings, a: HwAlert, canRead: boolean): boolean {
  return s.alerts[a] ?? canRead;
}

// --- Words and numbers ------------------------------------------------------------

export function toUnit(celsius: number, unit: TempUnit): number {
  return unit === "F" ? (celsius * 9) / 5 + 32 : celsius;
}

export function fromUnit(value: number, unit: TempUnit): number {
  return unit === "F" ? ((value - 32) * 5) / 9 : value;
}

export function formatTemp(celsius: number, unit: TempUnit): string {
  return `${Math.round(toUnit(celsius, unit))}${unit === "F" ? "℉" : "℃"}`;
}

const GB = 1024 ** 3;

export function formatGB(bytes: number): string {
  const g = bytes / GB;
  return `${g >= 100 ? Math.round(g) : Math.round(g * 10) / 10} GB`;
}

/** "1.2 MB/s", "56 KB/s", "0 KB/s". */
export function formatRate(bytesPerSecond: number): string {
  const kb = Math.max(0, bytesPerSecond) / 1024;
  if (kb < 1000) return `${kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb)} KB/s`;
  const mb = kb / 1024;
  return mb < 1000 ? `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB/s` : `${Math.round((mb / 1024) * 10) / 10} GB/s`;
}

export function formatGHz(mhz: number): string {
  return `${(mhz / 1000).toFixed(1)} GHz`;
}

const pct = (n: number) => `${Math.round(n)}%`;

// --- The hover card ---------------------------------------------------------------

/** "warm": getting there (orange); "hot": over the line (red). */
export type HwLevel = "" | "warm" | "hot";

export interface CardRow {
  item: HwItem;
  label: string;
  value: string;
  level: HwLevel;
}

const worse = (a: HwLevel, b: HwLevel): HwLevel => (a === "hot" || b === "hot" ? "hot" : a || b);

function usageLevel(p: number): HwLevel {
  return p >= 95 ? "hot" : p >= 80 ? "warm" : "";
}

/** Near the limit (90% of it) is warm; at it, hot. */
function limitLevel(v: number, limit: number): HwLevel {
  return v >= limit ? "hot" : v >= limit * 0.9 ? "warm" : "";
}

/**
 * The card's rows for the ticked items, in order. Usage and temperature of the same chip
 * share a row ("CPU 37% · 62℃"); the network has a row each way. Something this computer
 * can't read shows "—".
 */
export function cardRows(r: HwReading, s: HardwareSettings): CardRow[] {
  const shown = new Set(s.show);
  const rows: CardRow[] = [];
  const DASH = "—";
  const chip = (item: "cpu" | "gpu", tempItem: "cpuTemp" | "gpuTemp", label: string) => {
    const parts: string[] = [];
    let level: HwLevel = "";
    if (shown.has(item)) {
      const v = r[item];
      parts.push(v === undefined ? DASH : pct(v));
      if (v !== undefined) level = usageLevel(v);
    }
    if (shown.has(tempItem)) {
      const v = r[tempItem];
      parts.push(v === undefined ? DASH : formatTemp(v, s.unit));
      if (v !== undefined) level = worse(level, limitLevel(v, s.limits[tempItem]));
    }
    if (parts.length) rows.push({ item: shown.has(item) ? item : tempItem, label, value: parts.join(" · "), level });
  };
  for (const item of HW_ITEMS) {
    if (!shown.has(item)) continue;
    switch (item) {
      case "cpu":
        chip("cpu", "cpuTemp", "CPU");
        break;
      case "cpuTemp":
        if (!shown.has("cpu")) chip("cpu", "cpuTemp", "CPU");
        break;
      case "gpu":
        chip("gpu", "gpuTemp", "GPU");
        break;
      case "gpuTemp":
        if (!shown.has("gpu")) chip("gpu", "gpuTemp", "GPU");
        break;
      case "cpuFreq":
        rows.push({ item, label: t("CPU freq"), value: r.cpuFreq === undefined ? DASH : formatGHz(r.cpuFreq), level: "" });
        break;
      case "fan":
        rows.push({ item, label: t("Fan"), value: r.fan === undefined ? DASH : `${Math.round(r.fan)} RPM`, level: "" });
        break;
      case "memory": {
        const m = r.memory;
        const p = m && m.total > 0 ? (m.used / m.total) * 100 : undefined;
        rows.push({ item, label: t("Memory"), value: p === undefined ? DASH : pct(p), level: p === undefined ? "" : limitLevel(p, s.limits.memory) });
        break;
      }
      case "vram": {
        const v = r.vram;
        rows.push({
          item,
          label: t("VRAM"),
          value: v ? `${formatGB(v.used).replace(" GB", "")}/${formatGB(v.total)}` : DASH,
          level: v && v.total > 0 ? usageLevel((v.used / v.total) * 100) : "",
        });
        break;
      }
      case "disk": {
        const d = r.disk;
        const free = d && d.total > 0 ? (d.free / d.total) * 100 : undefined;
        const limit = s.limits.disk;
        rows.push({
          item,
          label: d ? t("Disk {name}", { name: d.name }) : t("Disk"),
          value: d ? t("{size} free", { size: formatGB(d.free) }) : DASH,
          level: free === undefined ? "" : free < limit ? "hot" : free < limit * 2 ? "warm" : "",
        });
        break;
      }
      case "network": {
        const n = r.network;
        rows.push({ item, label: "↓", value: n ? formatRate(n.down) : DASH, level: "" });
        rows.push({ item, label: "↑", value: n ? formatRate(n.up) : DASH, level: "" });
        break;
      }
      case "battery": {
        const b = r.battery;
        const limit = s.limits.battery;
        rows.push({
          item,
          label: t("Battery"),
          value: b ? `${pct(b.percent)}${b.plugged ? " ⚡" : ""}` : DASH,
          level: !b || b.plugged ? "" : b.percent <= limit ? "hot" : b.percent <= limit * 2 ? "warm" : "",
        });
        break;
      }
    }
  }
  return rows;
}

// --- Alerts -----------------------------------------------------------------------

/** What each alert needs read. */
export const ALERT_ITEM: Record<HwAlert, HwItem> = { cpuTemp: "cpuTemp", gpuTemp: "gpuTemp", memory: "memory", disk: "disk", battery: "battery" };

/** Over a limit for this long before the pet says so (a moment's spike is fine). */
export const CONFIRM_MS = 30_000;
/** One alert per item per half hour. */
export const COOLDOWN_MS = 30 * 60_000;
/** The disk fills slowly: looked at every 10 minutes. */
export const DISK_EVERY_MS = 10 * 60_000;

/** "over": past the limit; "emergency": far past it, said at once. */
export type Over = "" | "over" | "emergency";

/** Whether a reading is over an alert's limit. */
export function overLimit(a: HwAlert, r: HwReading, limits: Record<HwAlert, number>): Over {
  const limit = limits[a];
  switch (a) {
    case "cpuTemp":
    case "gpuTemp": {
      const v = r[a];
      if (v === undefined || v < limit) return "";
      // 10 degrees past it, or 100℃, but never closer than 5 degrees to the limit.
      return v >= Math.max(limit + 5, Math.min(limit + 10, 100)) ? "emergency" : "over";
    }
    case "memory": {
      const m = r.memory;
      return m && m.total > 0 && (m.used / m.total) * 100 >= limit ? "over" : "";
    }
    case "disk": {
      const d = r.disk;
      return d && d.total > 0 && (d.free / d.total) * 100 < limit ? "over" : "";
    }
    case "battery": {
      const b = r.battery;
      if (!b || b.plugged || b.percent > limit) return "";
      return b.percent <= Math.min(5, limit) ? "emergency" : "over";
    }
  }
}

/**
 * Decides when to alert: over a limit → look again in 30 s → still over → alert (far
 * over: at once). Then that item rests for 30 minutes. The caller says whether it showed
 * the alert (`shown`), or drops what's waiting (`drop`, in Quiet mode).
 */
export class HwWatch {
  /** When each item was first seen over its limit (and is still waiting to be said). */
  private pending = new Map<HwAlert, number>();
  private lastShown = new Map<HwAlert, number>();
  private diskAt = -Infinity;

  /** The alerts that are on (`readable`: what this computer could read last time). */
  watched(s: HardwareSettings, canRead: (a: HwAlert) => boolean): HwAlert[] {
    return HW_ALERTS.filter((a) => alertOn(s, a, canRead(a)));
  }

  /** What to read now: the disk only every 10 minutes, unless it's waiting to be checked again. */
  itemsToRead(watched: HwAlert[], now: number): HwItem[] {
    return watched.filter((a) => a !== "disk" || this.pending.has("disk") || now - this.diskAt >= DISK_EVERY_MS).map((a) => ALERT_ITEM[a]);
  }

  /** The alerts due now, worst first, and whether to look again in 30 s. */
  check(r: HwReading, watched: HwAlert[], limits: Record<HwAlert, number>, now: number): { due: { alert: HwAlert; over: Over }[]; recheck: boolean } {
    if (r.disk) this.diskAt = now;
    const due: { alert: HwAlert; over: Over }[] = [];
    for (const a of HW_ALERTS) {
      if (!watched.includes(a)) {
        this.pending.delete(a);
        continue;
      }
      if (r[ALERT_ITEM[a]] === undefined) continue; // not read this time (the disk) or can't be
      const over = overLimit(a, r, limits);
      if (!over) {
        this.pending.delete(a);
        continue;
      }
      if (now - (this.lastShown.get(a) ?? -Infinity) < COOLDOWN_MS) {
        this.pending.delete(a);
        continue;
      }
      const since = this.pending.get(a);
      if (since === undefined) this.pending.set(a, now);
      if (over === "emergency" || (since !== undefined && now - since >= CONFIRM_MS - 1000)) due.push({ alert: a, over });
    }
    due.sort((x, y) => (x.over === y.over ? 0 : x.over === "emergency" ? -1 : 1));
    const waiting = [...this.pending.keys()].some((a) => !due.some((d) => d.alert === a));
    return { due, recheck: waiting || due.length > 0 };
  }

  shown(a: HwAlert, now: number): void {
    this.pending.delete(a);
    this.lastShown.set(a, now);
  }

  drop(a: HwAlert): void {
    this.pending.delete(a);
  }
}

/** What the pet says for an alert (the reading that set it off, in your unit). */
export function alertText(a: HwAlert, over: Over, r: HwReading, s: HardwareSettings): string {
  const limit = s.limits[a];
  switch (a) {
    case "cpuTemp":
      return over === "emergency"
        ? t("🌡 The CPU is very hot: {temp}! Save your work and see what's keeping it busy.", { temp: formatTemp(r.cpuTemp ?? limit, s.unit) })
        : t("🌡 The CPU is hot: {temp}! It's been over {limit} for half a minute. What's keeping it busy?", {
            temp: formatTemp(r.cpuTemp ?? limit, s.unit),
            limit: formatTemp(limit, s.unit),
          });
    case "gpuTemp":
      return over === "emergency"
        ? t("🎮 The graphics card is very hot: {temp}! Give it a break?", { temp: formatTemp(r.gpuTemp ?? limit, s.unit) })
        : t("🎮 The graphics card is hot: {temp}! It's been over {limit} for half a minute.", {
            temp: formatTemp(r.gpuTemp ?? limit, s.unit),
            limit: formatTemp(limit, s.unit),
          });
    case "memory": {
      const m = r.memory;
      return t("🧠 Memory is nearly full: {pct}. Closing apps you aren't using will help.", { pct: pct(m && m.total ? (m.used / m.total) * 100 : limit) });
    }
    case "disk": {
      const d = r.disk;
      return t("💾 {disk} has only {pct} free ({size}). Time for a clean-up.", {
        disk: d?.name ?? "",
        pct: pct(d && d.total ? (d.free / d.total) * 100 : limit),
        size: formatGB(d?.free ?? 0),
      });
    }
    case "battery":
      return t("🔋 Battery at {pct} and not plugged in. Time to find the charger!", { pct: pct(r.battery?.percent ?? limit) });
  }
}
