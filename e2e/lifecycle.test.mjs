import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { App, appProcesses, check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Quits ePet (waiting for it to be gone), `ms` passes, and it starts again with its data. */
async function offFor(ms) {
  await ctx.app.quit();
  for (let i = 0; i < 20 && appProcesses() > 0; i++) await sleep(500);
  assert.equal(appProcesses(), 0, "ePet has quit");
  await sleep(ms);
  ctx.app = await App.launch({ keepData: true });
}

/** Whether ePet starts with the computer, as the OS has it (not just the setting). */
function startsWithComputer() {
  if (process.platform === "win32") {
    const out = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"], { encoding: "utf8" }).stdout ?? "";
    return out.toLowerCase().includes("desktoppet");
  }
  const dir = join(homedir(), ".config", "autostart");
  return existsSync(dir) && readdirSync(dir).some((f) => readFileSync(join(dir, f), "utf8").includes("desktoppet"));
}

check("install.first-launch", "first start: the pet window shows and the pet lands on the bottom of the work area", async () => {
  const app = ctx.app;
  assert.equal(await app.visible("pet"), true);
  await app.b.waitUntil(async () => (await app.pet()).state !== "fall", { timeout: 15_000 });
  const p = await app.pet();
  const floor = p.area.y + p.area.h;
  assert.ok(Math.abs(p.y - floor) <= 3 * p.dpr, `on the floor: feet at ${p.y}, work area ends at ${floor}`);
});

check("install.single-instance", "started again while running: no second pet, the panel opens", async () => {
  const app = ctx.app;
  await app.closeWindow("panel");
  assert.equal(appProcesses(), 1);
  const second = spawn(app.exe, [], { stdio: "ignore", env: { ...process.env, EPET_E2E: "1" } });
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 15_000);
    second.on("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  assert.ok(exited, "the second start ends by itself");
  assert.equal(appProcesses(), 1, "still one ePet");
  await app.panelTab();
});

check("install.autostart", "Start with my computer adds ePet to the computer's startup, and unticking removes it", async () => {
  const app = ctx.app;
  await app.panel("settings");
  const box = () =>
    app.b.execute(() => [...document.querySelectorAll("label.check")].find((l) => l.textContent.includes("Start with my computer")).querySelector("input"));
  const click = () =>
    app.b.execute(() => [...document.querySelectorAll("label.check")].find((l) => l.textContent.includes("Start with my computer")).querySelector("input").click());
  assert.ok(await box());
  const before = startsWithComputer();
  if (before) {
    await click();
    await app.sleep(1500);
  }
  assert.equal(startsWithComputer(), false);
  await app.panel("settings");
  await click();
  await app.b.waitUntil(async () => startsWithComputer(), { timeout: 5000 });
  await app.b.waitUntil(async () => (await app.settings()).autostart === true, { timeout: 5000 });
  await app.panel("settings");
  await click();
  await app.b.waitUntil(async () => !startsWithComputer(), { timeout: 5000 });
  await app.b.waitUntil(async () => (await app.settings()).autostart === false, { timeout: 5000 });
});

check("stability.windows", "the panel and the game opened and closed 10 times: nothing hangs, both still work", async () => {
  const app = ctx.app;
  for (let i = 0; i < 10; i++) {
    await app.run("pet", "Open panel…");
    await app.panelTab();
    await app.closeWindow("panel");
    await app.run("pet", "Play Safe Landing");
    await app.toWindow("game.html");
    await app.closeWindow("game");
  }
  await app.run("pet", "Add to-do…");
  assert.equal(await app.panelTab(), "todos");
  await app.type(".todos input[type=text]", "still here");
  await app.press(".todos input[type=text]", ["Enter"]);
  await app.waitText(".todos .list li", "still here");
  const frames = (await app.pet()).frames;
  await app.sleep(1000);
  assert.ok((await app.pet()).frames > frames + 10, "the pet keeps going");
  assert.deepEqual(await app.b.execute(() => window.__epet.errors), []);
  assert.equal(appProcesses(), 1);
});

check("alarm.off-while-shut", "due while ePet wasn't running: past the snoozes' grace nothing rings (“ePet wasn't running”, to-dos Overdue); within it the alarm rings at once, its snoozes counted", async () => {
  let app = ctx.app;
  // Snoozes of 30 s × 3: a 90-second grace.
  await app.setSettings((s) => {
    s.alerts.alarm = { ...s.alerts.alarm, ring: false, ringSeconds: 30, snoozeMinutes: 0.5, autoSnoozeMax: 3 };
    return s;
  });
  ctx.mood = (await app.pet()).mood;
  const due = Date.now() + 4000;
  const alarm = await app.invoke("add_alarm", { label: "Gone", at: due, repeat: "none", days: null });
  const timer = await app.invoke("add_alarm", { label: "Timer: 1 min", at: due, repeat: "none", days: null });
  await app.invoke("add_todo", { todo: { title: "Was due", allDay: false, repeat: "none", dueAt: due } });
  // Off for longer than the grace.
  await offFor(4000 + 95_000);
  app = ctx.app;
  await app.sleep(4000);
  assert.equal(await app.bubble().then((b) => b?.includes("Gone") ?? false), false, "doesn't ring");
  const list = await app.invoke("list_alarms");
  for (const a of [alarm, timer]) {
    const x = list.find((y) => y.id === a.id);
    assert.ok(x.offAt && !x.missedAt && !x.enabled, JSON.stringify(x));
  }
  assert.ok(!(await app.badges()).some((b) => b.text.startsWith("⏰")), "no Missed badge");
  assert.deepEqual(await app.invoke("list_unseen"), []);
  await app.panel("alarms");
  await app.waitText("details.finished .finished-row .sub", "ePet wasn't running");
  await app.panel("todos");
  await app.waitText(".when.overdue", "Overdue");
  // Within the grace: off for 65 s → it rings when ePet starts, "Snoozed 2×".
  await app.toPet();
  const due2 = Date.now() + 3000;
  const late = await app.invoke("add_alarm", { label: "Late", at: due2, repeat: "none", days: null });
  await ctx.app.quit();
  for (let i = 0; i < 20 && appProcesses() > 0; i++) await sleep(500);
  await sleep(due2 + 62_000 - Date.now());
  ctx.app = app = await App.launch({ keepData: true });
  const said = await app.waitBubble("Late", 15_000);
  assert.match(said, new RegExp(`Snoozed 2× · first rang ${(await app.clock(due2)).replace(/\s/g, "\\s")}`));
  await app.answer("Done");
  assert.equal((await app.invoke("list_alarms")).find((a) => a.id === late.id).enabled, false);
}, { timeout: 300_000 });

check("mood.offline", "the time ePet was off doesn't lower the mood", async () => {
  const app = ctx.app;
  // (alarm.off-while-shut kept ePet off for over two minutes.)
  assert.ok(ctx.mood, "follows alarm.off-while-shut");
  const now = (await app.pet()).mood;
  assert.ok(now.affection >= ctx.mood.affection - 0.5, `affection ${ctx.mood.affection} → ${now.affection}`);
  assert.ok(now.fullness >= ctx.mood.fullness - 0.5, `fullness ${ctx.mood.fullness} → ${now.fullness}`);
});

check("tray.quit", "Quit in the tray closes every window and ends ePet", async () => {
  const app = ctx.app;
  await app.run("pet", "Open panel…");
  await app.panelTab();
  await app.toPet();
  await app.invoke("e2e_tray", { id: "quit" }).catch(() => {});
  for (let i = 0; i < 20 && appProcesses() > 0; i++) await sleep(500);
  assert.equal(appProcesses(), 0, "ePet has ended");
});
