/**
 * Reminder modes (src/features/modes/modes.ts, docs/INTERACTIONS.md "Modes"): Quiet and Work
 * change how alarms and to-dos ring and put anniversaries off; Auto follows the schedule;
 * the menus switch mode; Settings → Modes edits it and the Focus tab's work hours follow it.
 */
import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const MIN = 60_000;

/** "HH:MM" `ms` from now (local time). */
function hm(ms) {
  const d = new Date(Date.now() + ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
const md = () => ({ month: new Date().getMonth() + 1, day: new Date().getDate() });

/** Nothing set; alarms and to-dos ring at known volumes; the modes as given (Normal, no slots). */
async function reset(modes = {}) {
  const app = ctx.app;
  await app.toPet();
  await app.b.execute(() => [...document.querySelectorAll("#bubble .actions button")].find((b) => /Done|Skip|Later/.test(b.textContent))?.click());
  for (const a of await app.invoke("list_alarms")) await app.invoke("delete_alarm", { id: a.id });
  for (const t of await app.invoke("list_todos")) await app.invoke("delete_todo", { id: t.id });
  for (const a of await app.invoke("list_anniversaries")) await app.invoke("delete_anniversary", { id: a.id });
  await app.invoke("pomodoro_stop");
  await app.closeWindow("panel");
  await app.closeWindow("celebrate");
  await app.setSettings((s) => {
    s.alerts.alarm = { ...s.alerts.alarm, ring: true, ringtone: "classic", volume: 0.8, petRuns: true, ringSeconds: 30, autoSnoozeMax: 0 };
    s.alerts.todo = { ...s.alerts.todo, ring: true, ringtone: "chime", volume: 0.6, petRuns: true };
    s.celebrate = { enabled: true, seconds: 10, music: false, musicVolume: 0.5 };
    s.modes = { ...s.modes, choice: "normal", override: null, dayOffOn: null, holidayUntil: null, workDays: 0b111_1111, workday: [], dayOff: [], ...modes };
    return s;
  });
  await app.until(() => document.getElementById("bubble").hidden, [], 20_000).catch(() => {});
}

const addAlarm = (ms) => ctx.app.invoke("add_alarm", { label: "", at: Date.now() + ms, repeat: "none", days: null });
const addTodo = (title, ms) => ctx.app.invoke("add_todo", { todo: { title, allDay: false, repeat: "none", dueAt: Date.now() + ms } });
const mode = async () => (await ctx.app.pet()).reminderMode;

check("modes.quiet", "Quiet: the pet keeps calm with a 🌙 badge; alarms still ring, starting soft and getting louder; to-dos don't ring", async () => {
  const app = ctx.app;
  await reset({ choice: "quiet" });
  await app.b.waitUntil(async () => (await app.pet()).mode === "quiet", { timeout: 5000 });
  assert.ok((await app.badges()).some((b) => b.text === "🌙 Quiet"));
  let since = Date.now();
  await addAlarm(1500);
  await app.waitBubble("Alarm", 10_000);
  const ring = (await app.sounds(since)).find((s) => s.kind === "ring");
  assert.deepEqual([ring?.volume, ring?.rampUp], [0.8, true]);
  await app.answer("Done");
  since = Date.now();
  await addTodo("Water the plants", 1500);
  await app.waitBubble("Water the plants", 10_000);
  await app.sleep(500);
  assert.ok(!(await app.sounds(since)).some((s) => s.kind === "ringtone"), "a to-do doesn't ring in Quiet");
  await app.answer("Later");
}, { timeout: 60_000 });

check("modes.work", "Work: a 👔 badge; alarms ring at half volume and for 15 s at most; to-dos ring at half volume", async () => {
  const app = ctx.app;
  await reset({ choice: "work" });
  await app.b.waitUntil(async () => (await app.badges()).some((b) => b.text === "👔 Work"), { timeout: 5000 });
  let since = Date.now();
  await addAlarm(1500);
  await app.waitBubble("Alarm", 10_000);
  const shown = Date.now();
  const ring = (await app.sounds(since)).find((s) => s.kind === "ring");
  assert.deepEqual([ring?.volume, ring?.rampUp], [0.4, false]);
  // Rings 15 s (not the 30 set), then counts as unanswered.
  await app.until(() => document.getElementById("bubble").hidden, [], 25_000);
  const lasted = Date.now() - shown;
  assert.ok(lasted > 10_000 && lasted < 22_000, `rang ${lasted} ms`);
  since = Date.now();
  await addTodo("Send the report", 1500);
  await app.waitBubble("Send the report", 10_000);
  const tone = (await app.sounds(since)).find((s) => s.kind === "ringtone");
  assert.equal(tone?.volume, 0.3);
  await app.answer("Later");
}, { timeout: 90_000 });

check("modes.schedule", "Auto follows the schedule (the badge says until when); “Today is a day off” and “Quiet for 1 hour” from the menu", async () => {
  const app = ctx.app;
  // A Quiet slot around now, on work days (every day is one here).
  await reset({ choice: "auto", workday: [{ start: hm(-30 * MIN), end: hm(30 * MIN), mode: "quiet" }] });
  await app.b.waitUntil(async () => (await mode()).mode === "quiet", { timeout: 5000 });
  const badge = (await app.badges()).find((b) => b.text === "🌙 Quiet");
  assert.ok(badge?.info.includes("until"), badge?.info);
  const item = (await app.menu("pet")).find((i) => typeof i === "object" && i.text.startsWith("Switch mode"));
  assert.match(item.text, /^Switch mode \(now: 🌙 Quiet until .+\)$/);
  // A day off today: the days-off table (empty), so Normal.
  await app.run("pet", "Switch mode", "Today is a day off");
  await app.b.waitUntil(async () => (await mode()).mode === "normal", { timeout: 5000 });
  assert.ok(!(await app.badges()).some((b) => b.text.startsWith("🌙")));
  await app.run("tray", "Switch mode", "Today is a day off");
  await app.b.waitUntil(async () => (await mode()).mode === "quiet", { timeout: 5000 });
  // Quiet for 1 hour, over a Normal schedule; Auto again ends it.
  await app.setSettings((s) => ((s.modes.workday = []), s));
  await app.b.waitUntil(async () => (await mode()).mode === "normal", { timeout: 5000 });
  await app.run("tray", "Switch mode", "Quiet for 1 hour");
  await app.b.waitUntil(async () => (await mode()).why === "override", { timeout: 5000 });
  const m = await mode();
  assert.equal(m.mode, "quiet");
  assert.ok(Math.abs(m.until - (Date.now() + 60 * MIN)) < 30_000);
  await app.run("pet", "Switch mode", "Auto");
  await app.b.waitUntil(async () => (await mode()).mode === "normal", { timeout: 5000 });
});

check("modes.postpone", "in Work an anniversary waits (a 🎉 badge, nothing plays); back to Normal the pet asks “Celebrate now?” and Celebrate plays it", async () => {
  const app = ctx.app;
  await reset({ choice: "work" });
  await app.invoke("add_anniversary", { anniversary: { kind: "birthday", icon: "🎂", since: null, preps: [], effect: true, music: null, name: "Mum", ...md() } });
  await app.present();
  await app.b.waitUntil(async () => (await app.badges()).some((b) => b.text === "🎉 Mum"), { timeout: 10_000 });
  assert.ok(!(await app.bubble())?.includes("Happy"), "not played in Work");
  await app.setSettings((s) => ((s.modes.choice = "normal"), s));
  assert.match(await app.waitBubble("Celebrate now?", 10_000), /🎂 Mum/);
  await app.answer("Celebrate");
  await app.waitBubble("Happy birthday, Mum", 10_000);
  assert.ok(!(await app.badges()).some((b) => b.text.startsWith("🎉")));
}, { timeout: 60_000 });

check("modes.panel", "Settings → Modes: the mode now, the week, a mode picked there; a Work slot added sets the Focus tab's work hours", async () => {
  const app = ctx.app;
  await reset({ choice: "auto" });
  await app.panel("settings");
  await app.until(() => document.querySelectorAll(".modes .week-row").length === 7);
  await app.waitText(".modes .mode-now", "Now: 🙂 Normal");
  await app.b.execute(() => {
    const s = document.querySelector(".modes .mode-choice");
    s.value = "work";
    s.dispatchEvent(new Event("change"));
  });
  await app.b.waitUntil(async () => (await app.settings()).modes.choice === "work", { timeout: 5000 });
  await app.b.waitUntil(async () => (await app.badges()).some((b) => b.text === "👔 Work"), { timeout: 5000 });
  await app.toWindow("panel.html");
  await app.b.execute(() => {
    const s = document.querySelector(".modes .mode-choice");
    s.value = "auto";
    s.dispatchEvent(new Event("change"));
  });
  // A slot on work days: 12:00–13:00 Work; the Focus tab's work hours follow it.
  await app.click(".modes .slots.workday .add-slot", "Add a time slot");
  await app.b.waitUntil(async () => (await app.settings()).modes.workday.length === 1, { timeout: 5000 });
  const s = await app.settings();
  assert.deepEqual(s.modes.workday, [{ start: "12:00", end: "13:00", mode: "work" }]);
  assert.deepEqual([s.pomodoro.workHours.start, s.pomodoro.workHours.end], ["12:00", "13:00"]);
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  await app.tab("focus");
  await app.waitText(".work-hours .work-span", await app.clock(noon.getTime()));
});
