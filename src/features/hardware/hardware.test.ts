import { describe, expect, it } from "vitest";
import { mergeSettings } from "../../platform/types";
import {
  alertOn,
  alertText,
  cardRows,
  CONFIRM_MS,
  COOLDOWN_MS,
  DEFAULT_HARDWARE,
  DISK_EVERY_MS,
  formatRate,
  formatTemp,
  hardwareSettings,
  HW_ALERTS,
  HwWatch,
  overLimit,
  type HardwareSettings,
  type HwReading,
} from "./hardware";

const GB = 1024 ** 3;
const S = (patch: Partial<HardwareSettings> = {}): HardwareSettings => ({ ...DEFAULT_HARDWARE, ...patch });

describe("[hw.settings] hardware settings", () => {
  it("shows CPU, memory and the network by default, alerts follow what can be read, 1 minute, ℃", () => {
    expect(mergeSettings({}).hardware).toEqual(DEFAULT_HARDWARE);
    expect(DEFAULT_HARDWARE.show).toEqual(["cpu", "memory", "network"]);
    expect(DEFAULT_HARDWARE.every).toBe(60);
    expect(DEFAULT_HARDWARE.unit).toBe("C");
  });

  it("keeps limits in range, drops unknown items and odd intervals", () => {
    const s = hardwareSettings({ show: ["network", "nope", "cpu"], limits: { cpuTemp: 180, memory: 30, disk: "x" }, every: 7, unit: "K", alerts: { cpuTemp: false, gpuTemp: "yes" } });
    expect(s.show).toEqual(["cpu", "network"]);
    expect(s.limits.cpuTemp).toBe(105);
    expect(s.limits.memory).toBe(70);
    expect(s.limits.disk).toBe(5);
    expect(s.every).toBe(60);
    expect(s.unit).toBe("C");
    expect(s.alerts).toEqual({ cpuTemp: false });
  });

  it("lets you show nothing at all", () => {
    expect(hardwareSettings({ show: [] }).show).toEqual([]);
  });

  it("turns an alert on by itself only when this computer can read it", () => {
    expect(alertOn(S(), "cpuTemp", true)).toBe(true);
    expect(alertOn(S(), "cpuTemp", false)).toBe(false);
    expect(alertOn(S({ alerts: { cpuTemp: true } }), "cpuTemp", false)).toBe(true);
    expect(alertOn(S({ alerts: { cpuTemp: false } }), "cpuTemp", true)).toBe(false);
  });
});

describe("[hw.card] the hover card", () => {
  const r: HwReading = {
    cpu: 97.4,
    cpuTemp: 92,
    memory: { used: 8 * GB, total: 16 * GB },
    network: { down: 1.25 * 1024 * 1024, up: 56 * 1024 },
    disk: { free: 18 * GB, total: 450 * GB, name: "C:" },
    battery: { percent: 14, plugged: false },
  };

  it("shows the ticked items in order, usage and temperature of a chip on one row", () => {
    const rows = cardRows(r, S({ show: ["cpu", "cpuTemp", "memory", "network"] }));
    expect(rows.map((x) => `${x.label} ${x.value}`)).toEqual(["CPU 97% · 92℃", "Memory 50%", "↓ 1.3 MB/s", "↑ 56 KB/s"]);
    expect(rows[0].level).toBe("hot");
    expect(rows[1].level).toBe("");
  });

  it("says ℉ when asked, and — for what can't be read", () => {
    const rows = cardRows({ cpu: 10 }, S({ show: ["cpuTemp", "gpu", "fan"], unit: "F" }));
    expect(rows.map((x) => x.value)).toEqual(["—", "—", "—"]);
    expect(cardRows(r, S({ show: ["cpuTemp"], unit: "F" }))[0].value).toBe("198℉");
  });

  it("colors near a limit orange and over it red", () => {
    const at = (cpuTemp: number) => cardRows({ cpuTemp }, S({ show: ["cpuTemp"] }))[0].level;
    expect(at(70)).toBe("");
    expect(at(82)).toBe("warm");
    expect(at(90)).toBe("hot");
    expect(cardRows(r, S({ show: ["disk", "battery"] })).map((x) => x.level)).toEqual(["hot", "hot"]);
    expect(cardRows({ battery: { percent: 14, plugged: true } }, S({ show: ["battery"] }))[0]).toMatchObject({ value: "14% ⚡", level: "" });
  });

  it("shows nothing when nothing is ticked", () => {
    expect(cardRows(r, S({ show: [] }))).toEqual([]);
  });

  it("formats speeds and temperatures", () => {
    expect(formatRate(0)).toBe("0 KB/s");
    expect(formatRate(5 * 1024)).toBe("5 KB/s");
    expect(formatRate(300 * 1024 * 1024)).toBe("300 MB/s");
    expect(formatTemp(100, "F")).toBe("212℉");
  });
});

describe("[hw.alerts] alerts", () => {
  const limits = DEFAULT_HARDWARE.limits;
  const all = [...HW_ALERTS];

  it("knows over, far over and fine", () => {
    expect(overLimit("cpuTemp", { cpuTemp: 89 }, limits)).toBe("");
    expect(overLimit("cpuTemp", { cpuTemp: 92 }, limits)).toBe("over");
    expect(overLimit("cpuTemp", { cpuTemp: 100 }, limits)).toBe("emergency");
    expect(overLimit("cpuTemp", { cpuTemp: 104 }, { ...limits, cpuTemp: 100 })).toBe("over");
    expect(overLimit("cpuTemp", { cpuTemp: 105 }, { ...limits, cpuTemp: 100 })).toBe("emergency");
    expect(overLimit("memory", { memory: { used: 95, total: 100 } }, limits)).toBe("over");
    expect(overLimit("disk", { disk: { free: 4, total: 100, name: "C:" } }, limits)).toBe("over");
    expect(overLimit("battery", { battery: { percent: 10, plugged: true } }, limits)).toBe("");
    expect(overLimit("battery", { battery: { percent: 10, plugged: false } }, limits)).toBe("over");
  });

  it("looks again 30 s later and alerts only if it's still over", () => {
    const w = new HwWatch();
    expect(w.check({ cpuTemp: 92 }, all, limits, 0)).toEqual({ due: [], recheck: true });
    expect(w.check({ cpuTemp: 92 }, all, limits, CONFIRM_MS)).toEqual({ due: [{ alert: "cpuTemp", over: "over" }], recheck: true });
    // A spike that's gone by the second look: nothing.
    const v = new HwWatch();
    v.check({ cpuTemp: 92 }, all, limits, 0);
    expect(v.check({ cpuTemp: 70 }, all, limits, CONFIRM_MS)).toEqual({ due: [], recheck: false });
  });

  it("says it at once when far over, then rests that item for 30 minutes", () => {
    const w = new HwWatch();
    expect(w.check({ cpuTemp: 101 }, all, limits, 0).due).toEqual([{ alert: "cpuTemp", over: "emergency" }]);
    w.shown("cpuTemp", 0);
    expect(w.check({ cpuTemp: 101 }, all, limits, COOLDOWN_MS - 1).due).toEqual([]);
    expect(w.check({ cpuTemp: 101 }, all, limits, COOLDOWN_MS).due).toHaveLength(1);
  });

  it("keeps an alert it couldn't say (in a call) until it can, if it's still so", () => {
    const w = new HwWatch();
    w.check({ memory: { used: 95, total: 100 } }, all, limits, 0);
    expect(w.check({ memory: { used: 95, total: 100 } }, all, limits, CONFIRM_MS).due).toHaveLength(1);
    // Not shown: still due next time.
    expect(w.check({ memory: { used: 95, total: 100 } }, all, limits, 5 * CONFIRM_MS).due).toHaveLength(1);
    w.drop("memory");
    expect(w.check({ memory: { used: 95, total: 100 } }, all, limits, 6 * CONFIRM_MS).due).toHaveLength(0);
  });

  it("ignores alerts that are off, and reads the disk only every 10 minutes", () => {
    const w = new HwWatch();
    expect(w.watched(S({ alerts: { cpuTemp: false } }), () => true)).toEqual(["gpuTemp", "memory", "disk", "battery"]);
    expect(w.watched(S(), () => false)).toEqual([]);
    expect(w.itemsToRead(["disk", "memory"], 0)).toEqual(["disk", "memory"]);
    w.check({ disk: { free: 50, total: 100, name: "C:" } }, ["disk"], limits, 0);
    expect(w.itemsToRead(["disk", "memory"], 60_000)).toEqual(["memory"]);
    expect(w.itemsToRead(["disk", "memory"], DISK_EVERY_MS)).toEqual(["disk", "memory"]);
    expect(w.check({ cpuTemp: 101 }, ["memory"], limits, 0).due).toEqual([]);
  });

  it("says what set it off, in your unit", () => {
    expect(alertText("cpuTemp", "over", { cpuTemp: 92 }, S({ unit: "F" }))).toContain("198℉");
    expect(alertText("disk", "over", { disk: { free: 18 * GB, total: 450 * GB, name: "C:" } }, S())).toContain("C:");
  });
});
