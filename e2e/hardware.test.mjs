/**
 * Hardware (src/features/hardware, src-tauri/src/hardware, docs/INTERACTIONS.md "Hardware"):
 * what this computer reads, the alerts, and Settings → Hardware. The pet's hover card is in
 * mouse.test.mjs (it needs a real mouse).
 */
import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const ALL = ["cpu", "cpuFreq", "cpuTemp", "fan", "memory", "gpu", "gpuTemp", "vram", "disk", "network", "battery"];
const GB = 1024 ** 3;

/** The pet's readings made up (null: the computer's), and a look for alerts now. */
const pretend = (reading) => ctx.app.b.execute((r) => window.__epet.pretendHardware(r), reading);
const pretendBusy = (busy) => ctx.app.invoke("pretend_busy", { busy });

async function reset(mode = "normal", alerts = {}) {
  const app = ctx.app;
  await app.toPet();
  await pretendBusy(null);
  // Nothing over a limit while the settings change (a change looks again).
  await pretend({});
  await app.setSettings((s) => {
    s.modes = { ...s.modes, choice: mode, override: null };
    s.hardware = { show: ["cpu", "memory", "network"], alerts, limits: { cpuTemp: 90, gpuTemp: 85, memory: 90, disk: 5, battery: 15 }, unit: "C", every: 60 };
    return s;
  });
  await app.answer("Got it").catch(() => {});
  await app.sleep(300);
}

check("hw.read", "the app reads CPU, memory, the system disk and the network without drivers; only what's asked for", async () => {
  const app = ctx.app;
  const r = await app.invoke("hw_read", { items: ALL });
  assert.ok(r.cpu >= 0 && r.cpu <= 100, JSON.stringify(r));
  assert.ok(r.memory.used > 0 && r.memory.used < r.memory.total, JSON.stringify(r.memory));
  assert.ok(r.disk.free > 0 && r.disk.free < r.disk.total && r.disk.name, JSON.stringify(r.disk));
  assert.ok(r.network.down >= 0 && r.network.up >= 0, JSON.stringify(r.network));
  for (const t of ["cpuTemp", "gpuTemp"]) if (r[t] !== undefined) assert.ok(r[t] > 5 && r[t] < 125, `${t}: ${r[t]}`);
  if (process.platform === "win32") assert.ok(r.cpuFreq > 100, `CPU frequency: ${r.cpuFreq}`);
  const only = await app.invoke("hw_read", { items: ["memory"] });
  assert.deepEqual(Object.keys(only), ["memory"]);
});

check("hw.alerts", "far over a limit the pet says so at once (“Got it” only); just over, it looks again 30 s later; Quiet mode says nothing; in a call it waits and says it after", async () => {
  const app = ctx.app;
  await reset();
  // Far over (100℃ with a 90℃ limit): at once.
  await pretend({ cpuTemp: 101 });
  const hot = await app.waitBubble("The CPU is very hot", 5000);
  assert.match(hot, /101℃/);
  assert.deepEqual(await app.b.execute(() => [...document.querySelectorAll("#bubble .actions button")].map((b) => b.textContent)), ["Got it"]);
  await app.answer("Got it");
  // Just over: nothing at first, then after 30 s.
  await pretend({ gpuTemp: 88 });
  await app.sleep(3000);
  assert.equal((await app.pet()).hwAlert, "cpuTemp", "not yet");
  await app.b.waitUntil(async () => (await app.pet()).hwAlert === "gpuTemp", { timeout: 40_000, interval: 500 });
  assert.match(await app.bubble(), /The graphics card is hot: 88℃.*over 85℃/);
  await app.answer("Got it");
  // A spike gone by the second look: nothing.
  await pretend({ memory: { used: 95, total: 100 } });
  await app.sleep(2000);
  await pretend({ memory: { used: 50, total: 100 } });
  await app.sleep(35_000);
  assert.equal((await app.pet()).hwAlert, "gpuTemp");
  // In a call: held; back, still over, it says it.
  await pretendBusy({ fullscreen: false, presenting: false, call: true });
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
  await pretend({ memory: { used: 95, total: 100 } });
  await app.sleep(35_000);
  assert.equal((await app.pet()).hwAlert, "gpuTemp", "nothing said during the call");
  await pretendBusy(null);
  await app.b.waitUntil(async () => (await app.pet()).hwAlert === "memory", { timeout: 60_000, interval: 500 });
  assert.match(await app.bubble(), /Memory is nearly full: 95%/);
  await app.answer("Got it");
  // Quiet mode: nothing.
  await reset("quiet");
  await app.b.waitUntil(async () => (await app.pet()).reminderMode.mode === "quiet", { timeout: 5000 });
  await pretend({ battery: { percent: 3, plugged: false } });
  await app.sleep(4000);
  assert.equal((await app.pet()).hwAlert, "memory");
  // An alert turned off: nothing either.
  await reset("normal", { battery: false });
  await pretend({ battery: { percent: 3, plugged: false } });
  await app.sleep(4000);
  assert.equal((await app.pet()).hwAlert, "memory");
  await pretend(null);
}, { timeout: 240_000 });

check("hw.settings", "Settings → Hardware: CPU, memory and network ticked; limits stay in range (−/+ and typing); ℃/℉; what this computer can't read is greyed, and an alert forced on for it says it won't fire", async () => {
  const app = ctx.app;
  await reset();
  const can = await app.invoke("hw_read", { items: ALL });
  await app.panel("settings");
  await app.waitText("h3[data-section=hardware]", "Hardware");
  const ticked = () => app.b.execute(() => [...document.querySelectorAll(".hardware .hw-item")].filter((l) => l.querySelector("input").checked).map((l) => l.dataset.item));
  assert.deepEqual(await ticked(), ["cpu", "memory", "network"]);
  // Greyed: exactly what the app couldn't read.
  await app.b.waitUntil(
    async () => {
      const grey = await app.b.execute(() => [...document.querySelectorAll(".hardware .hw-item.unreadable")].map((l) => l.dataset.item));
      return JSON.stringify(grey) === JSON.stringify(ALL.filter((i) => can[i] === undefined));
    },
    { timeout: 5000 },
  );
  // Tick the network off and the GPU on.
  await app.b.execute(() => document.querySelector(".hardware .hw-item[data-item=network] input").click());
  await app.sleep(400);
  await app.b.execute(() => document.querySelector(".hardware .hw-item[data-item=gpu] input").click());
  await app.sleep(400);
  assert.deepEqual((await app.settings()).hardware.show, ["cpu", "memory", "gpu"]);
  // Limits: + at the top does nothing; typing 180 keeps 105; ℉ shows the same in ℉.
  const limit = (a) => app.b.execute((x) => document.querySelector(`.hardware [data-alert=${x}] input.hw-limit`).value, a);
  await app.b.execute(() => {
    const i = document.querySelector(".hardware [data-alert=cpuTemp] input.hw-limit");
    i.value = "180";
    i.dispatchEvent(new Event("change"));
  });
  await app.sleep(400);
  assert.equal((await app.settings()).hardware.limits.cpuTemp, 105);
  assert.equal(await limit("cpuTemp"), "105");
  assert.equal(await app.b.execute(() => document.querySelector(".hardware [data-alert=cpuTemp] .plus").disabled), true);
  await app.b.execute(() => document.querySelector(".hardware [data-alert=cpuTemp] .minus").click());
  await app.sleep(400);
  assert.equal((await app.settings()).hardware.limits.cpuTemp, 104);
  await app.b.execute(() => {
    const s = document.querySelector(".hardware select.hw-unit");
    s.value = "F";
    s.dispatchEvent(new Event("change"));
  });
  await app.sleep(400);
  assert.equal((await app.settings()).hardware.unit, "F");
  assert.equal(await limit("cpuTemp"), "219");
  assert.equal((await app.settings()).hardware.limits.cpuTemp, 104, "kept in ℃");
  // An alert this computer can't read: off at first; turned on, it says it won't fire.
  const cant = ["cpuTemp", "gpuTemp", "battery"].find((a) => can[a] === undefined);
  if (cant) {
    const box = () => app.b.execute((x) => document.querySelector(`.hardware [data-alert=${x}] input[type=checkbox]`).checked, cant);
    assert.equal(await box(), false);
    assert.equal(await app.b.execute((x) => !!document.querySelector(`.hardware [data-alert=${x}] .hw-cant`), cant), false);
    await app.b.execute((x) => document.querySelector(`.hardware [data-alert=${x}] input[type=checkbox]`).click(), cant);
    await app.sleep(400);
    assert.equal(await box(), true);
    await app.waitText(`.hardware [data-alert=${cant}] .hw-cant`, "can't read this");
    assert.equal((await app.settings()).hardware.alerts[cant], true);
  }
  // The interval.
  await app.b.execute(() => {
    const s = document.querySelector(".hardware select.hw-every");
    s.value = "300";
    s.dispatchEvent(new Event("change"));
  });
  await app.sleep(400);
  assert.equal((await app.settings()).hardware.every, 300);
  await reset();
});
