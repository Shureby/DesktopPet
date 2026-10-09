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

/** The mode's icon before the first badge: { text, info }, or null. */
const modeMark = () =>
  ctx.app.b.execute(() => {
    const m = document.querySelector("#badges .mode-mark");
    return m ? { text: m.textContent, info: m.dataset.info } : null;
  });
/** A 10-minute timer, so there's a badge for the mode's icon to go before. */
const addTimer = () => ctx.app.invoke("add_alarm", { label: "Timer: 10 min", at: Date.now() + 10 * MIN, repeat: "none", days: null });

const addAlarm = (ms) => ctx.app.invoke("add_alarm", { label: "", at: Date.now() + ms, repeat: "none", days: null });
const addTodo = (title, ms) => ctx.app.invoke("add_todo", { todo: { title, allDay: false, repeat: "none", dueAt: Date.now() + ms } });
const mode = async () => (await ctx.app.pet()).reminderMode;

check("modes.quiet", "Quiet: the pet keeps calm with a 🌙 badge; alarms still ring, starting soft and getting louder; to-dos don't ring", async () => {
  const app = ctx.app;
  await reset({ choice: "quiet" });
  await app.b.waitUntil(async () => (await app.pet()).mode === "quiet", { timeout: 5000 });
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

check("modes.work", "Work: alarms ring at half volume and for 15 s at most; to-dos ring at half volume", async () => {
  const app = ctx.app;
  await reset({ choice: "work" });
  await app.b.waitUntil(async () => (await mode()).mode === "work", { timeout: 5000 });
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

check("modes.schedule", "Auto follows the schedule; the mode's icon goes before the first badge (none without one), saying until when; the tray's tooltip says the mode; “Today is a day off” from the menu", async () => {
  const app = ctx.app;
  // A Quiet slot around now, on work days (every day is one here).
  await reset({ choice: "auto", workday: [{ start: hm(-30 * MIN), end: hm(30 * MIN), mode: "quiet" }] });
  await app.b.waitUntil(async () => (await mode()).mode === "quiet", { timeout: 5000 });
  assert.equal(await modeMark(), null, "no badge, no icon");
  await addTimer();
  await app.b.waitUntil(async () => (await modeMark())?.text === "🌙", { timeout: 5000 });
  assert.match((await modeMark()).info, /^Quiet mode · until .+\nOpen Modes$/);
  assert.match((await app.badges())[0].text, /^🌙⏱ /);
  const item = (await app.menu("pet")).find((i) => typeof i === "object" && i.text.startsWith("Switch mode"));
  assert.match(item.text, /^Switch mode \(now: 🌙 Quiet until .+\)$/);
  await app.b.waitUntil(async () => /· 🌙 Quiet until /.test((await app.pet()).trayTooltip), { timeout: 5000 });
  // A day off today: the days-off table (empty), so Normal: no icon.
  await app.run("pet", "Switch mode", "Today is a day off");
  await app.b.waitUntil(async () => (await mode()).mode === "normal", { timeout: 5000 });
  await app.b.waitUntil(async () => (await modeMark()) === null, { timeout: 5000 });
  await app.run("tray", "Switch mode", "Today is a day off");
  await app.b.waitUntil(async () => (await mode()).mode === "quiet", { timeout: 5000 });
});

check("modes.menu-for-a-while", "a mode picked from the menu lasts until the schedule next changes, then Auto again; Quiet for… 30 min to tomorrow morning; Auto ends it at once", async () => {
  const app = ctx.app;
  // Work now on the schedule, until in half an hour.
  await reset({ choice: "auto", workday: [{ start: hm(-30 * MIN), end: hm(30 * MIN), mode: "work" }] });
  await app.b.waitUntil(async () => (await mode()).mode === "work", { timeout: 5000 });
  const scheduleEnds = (await mode()).until;
  await app.run("pet", "Switch mode", "✨ Lively until");
  await app.b.waitUntil(async () => (await mode()).mode === "lively", { timeout: 5000 });
  let m = await mode();
  assert.deepEqual([m.why, m.until], ["override", scheduleEnds]);
  assert.equal((await app.settings()).modes.choice, "auto", "Auto underneath");
  await addTimer();
  await app.b.waitUntil(async () => /then Auto/.test((await modeMark())?.info ?? ""), { timeout: 5000 });
  // Quiet for 30 minutes.
  await app.run("tray", "Switch mode", "Quiet for…", "30 minutes");
  await app.b.waitUntil(async () => (await mode()).mode === "quiet", { timeout: 5000 });
  m = await mode();
  assert.ok(Math.abs(m.until - (Date.now() + 30 * MIN)) < 30_000, JSON.stringify(m));
  const sub = (await app.menu("pet")).find((i) => typeof i === "object" && i.text.startsWith("Switch mode")).items.find((i) => i.text === "Quiet for…");
  assert.deepEqual(sub.items.slice(0, 3), ["30 minutes", "1 hour", "2 hours"]);
  assert.match(sub.items[3], /^Until tomorrow /);
  await app.run("pet", "Switch mode", "Auto");
  await app.b.waitUntil(async () => (await mode()).mode === "work", { timeout: 5000 });
});

check("modes.postpone", "in Work an anniversary waits (its own badge, “🎂 Mum”, nothing plays); back to Normal the pet asks “Celebrate now?” and Celebrate plays it", async () => {
  const app = ctx.app;
  await reset({ choice: "work" });
  await app.invoke("add_anniversary", { anniversary: { kind: "birthday", icon: "🎂", since: null, preps: [], effect: true, music: null, name: "Mum", ...md() } });
  await app.present();
  await app.b.waitUntil(async () => (await app.badges()).some((b) => b.text.endsWith("🎂 Mum")), { timeout: 10_000 });
  assert.ok(!(await app.bubble())?.includes("Happy"), "not played in Work");
  await app.setSettings((s) => ((s.modes.choice = "normal"), s));
  assert.match(await app.waitBubble("Celebrate now?", 10_000), /🎂 Mum/);
  await app.answer("Celebrate");
  await app.waitBubble("Happy birthday, Mum", 10_000);
  assert.ok(!(await app.badges()).some((b) => b.text.includes("Mum")));
}, { timeout: 60_000 });

check("modes.missed", "an anniversary put off all day is missed after midnight; the next time you're at the computer (not in Quiet) the pet says so once, with Celebrate now", async () => {
  const app = ctx.app;
  await reset({ choice: "work" });
  await app.invoke("add_anniversary", { anniversary: { kind: "birthday", icon: "🎂", since: null, preps: [], effect: true, music: null, name: "Ann", ...md() } });
  await app.present();
  await app.b.waitUntil(async () => (await app.pet()).postponed.includes("Ann"), { timeout: 10_000 });
  // Tomorrow (the test clock): missed.
  await app.invoke("shift_clock", { ms: 24 * 60 * MIN });
  try {
    await app.b.waitUntil(async () => (await app.pet()).missed.includes("Ann"), { timeout: 10_000 });
    assert.ok(!(await app.badges()).some((b) => b.text.includes("Ann")));
    // At the computer, in Normal: told once.
    await app.setSettings((s) => ((s.modes.choice = "normal"), s));
    await app.b.execute(() => window.__epet.activity());
    assert.match(await app.waitBubble("You missed", 5000), /🎂 You missed Ann yesterday\./);
    await app.answer("OK");
    assert.deepEqual((await app.pet()).missed, []);
  } finally {
    await app.invoke("shift_clock", { ms: -24 * 60 * MIN });
  }
}, { timeout: 60_000 });

check("modes.intro", "once, the pet says what modes are (not in Quiet); Show me opens the Modes tab", async () => {
  const app = ctx.app;
  await reset({ choice: "normal", introduced: false });
  assert.match(await app.waitBubble("New: modes!", 40_000), /I'm in 🙂 Normal\./);
  assert.equal((await app.settings()).modes.introduced, true);
  await app.answer("Show me");
  assert.equal(await app.panelTab(), "modes");
}, { timeout: 60_000 });

check("modes.panel", "the Modes tab: the mode now, the week, a mode picked there; a Work slot added sets the Focus tab's work hours; a new slot follows the last; a slot can't end when it starts; days off until a date", async () => {
  const app = ctx.app;
  await reset({ choice: "auto" });
  await app.panel("modes");
  await app.until(() => document.querySelectorAll(".modes .week-row").length === 7);
  await app.waitText(".modes .mode-now", "Now: 🙂 Normal");
  await app.b.execute(() => {
    const s = document.querySelector(".modes .mode-choice");
    s.value = "work";
    s.dispatchEvent(new Event("change"));
  });
  await app.b.waitUntil(async () => (await app.settings()).modes.choice === "work", { timeout: 5000 });
  await app.b.waitUntil(async () => (await mode()).why === "manual", { timeout: 5000 });
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
  // The next one starts where it ends.
  await app.tab("modes");
  await app.click(".modes .slots.workday .add-slot", "Add a time slot");
  await app.b.waitUntil(async () => (await app.settings()).modes.workday.length === 2, { timeout: 5000 });
  assert.deepEqual((await app.settings()).modes.workday[1], { start: "13:00", end: "14:00", mode: "work" });
  // Its end set to its start (13:00, a step down from 14:00): it ends an hour later instead.
  await app.b.execute(() => {
    const el = document.querySelectorAll(".modes .slots.workday .slot-row")[1].querySelectorAll(".time-field")[1].querySelector(".part.hour");
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await app.waitText(".modes .slot-notice", "needs an end after its start", 5000);
  assert.deepEqual((await app.settings()).modes.workday[1], { start: "13:00", end: "14:00", mode: "work" });
  // Days off until a date.
  await app.click(".modes .holiday-add", "Days off until");
  await app.b.waitUntil(async () => !!(await app.settings()).modes.holidayUntil, { timeout: 5000 });
  await app.click(".modes .holiday .remove");
  await app.b.waitUntil(async () => (await app.settings()).modes.holidayUntil === null, { timeout: 5000 });
  await app.tab("focus");
  await app.waitText(".work-hours .work-span", await app.clock(noon.getTime()));
});
