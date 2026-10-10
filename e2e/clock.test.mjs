/**
 * Across days, with the test clock (src-tauri/src/state.rs, `shift_clock`): the app's clock is
 * set ahead instead of waiting for tomorrow. It starts at 08:00 (the next one), so every run
 * sees the same time of day; reminders and the panel follow the app's clock.
 */
import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How far the app's clock is ahead of the computer's. */
let shift = 0;
const appNow = () => Date.now() + shift;

/** Sets the app's clock `ms` ahead. */
async function ahead(ms) {
  await ctx.app.toPet();
  shift = await ctx.app.invoke("shift_clock", { ms });
  // A scheduler tick (once a second) and the windows following it.
  await ctx.app.sleep(2500);
}

/** Local midnight of the app's day `days` from today, plus `h:m`. */
function at(days, h = 0, m = 0) {
  const d = new Date(appNow());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
/** "HH:MM" of the app's clock `ms` from now. */
function hm(ms) {
  const d = new Date(appNow() + ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The to-do row titled `title` in the panel: its "when" text and whether it's overdue. */
function whenOf(title) {
  return ctx.app.b.execute((t) => {
    const li = [...document.querySelectorAll(".todos li")].find((x) => x.querySelector(".title")?.textContent === t);
    const w = li?.querySelector(".when");
    return w ? { text: w.textContent.replace(/\s+/g, " ").trim(), overdue: w.classList.contains("overdue") } : null;
  }, title);
}

check("todo.day-overdue", "a day's to-do is “Today” all day and only “Overdue · Yesterday” the next; a timed one is Overdue once its time is past; nothing of yesterday is reminded the next day", async () => {
  const app = ctx.app;
  // 08:00 today (or tomorrow, if it's later than that now).
  const next8 = at(new Date(appNow()).getHours() < 8 ? 0 : 1, 8);
  await ahead(next8 - appNow());
  // The day's reminder late in the evening: none comes today.
  await app.setSettings((s) => ((s.todoDayTime = "23:30"), s));
  await app.invoke("add_todo", { todo: { title: "Day only", allDay: true, repeat: "none", dueAt: at(0) } });
  await app.invoke("add_todo", { todo: { title: "Timed", allDay: false, repeat: "none", dueAt: at(0, 7) } });
  await app.panel("todos");
  await app.waitText(".todos .list .title", "Timed");
  let day = await whenOf("Day only");
  assert.ok(day && /Today/.test(day.text) && !day.overdue, `the day's to-do today: ${JSON.stringify(day)}`);
  const timed = await whenOf("Timed");
  assert.ok(timed && /^Overdue · Today/.test(timed.text) && timed.overdue, `the timed one, its time past: ${JSON.stringify(timed)}`);
  // The next day.
  await ahead(DAY);
  await app.toWindow("panel.html");
  await app.until((t) => /Overdue · Yesterday/.test([...document.querySelectorAll(".todos li")].find((x) => x.querySelector(".title")?.textContent === t)?.querySelector(".when")?.textContent ?? ""), ["Day only"], 10_000);
  day = await whenOf("Day only");
  assert.equal(day.overdue, true, JSON.stringify(day));
  // Today's reminder time comes: nothing of yesterday.
  await app.setSettings((s) => ((s.todoDayTime = hm(-MIN)), s));
  await app.sleep(5000);
  const said = await app.bubble();
  assert.ok(!said?.includes("Day only") && !said?.includes("Timed"), `no reminder for yesterday: ${said}`);
  assert.deepEqual(await app.invoke("list_unseen"), []);
  for (const t of await app.invoke("list_todos")) await app.invoke("delete_todo", { id: t.id });
}, { timeout: 120_000 });

check("alarm.repeat-missed", "an Every day alarm that was missed rings again the next day", async () => {
  const app = ctx.app;
  // Rings 3 s, then missed at once (no snoozing).
  await app.setSettings((s) => {
    s.alerts.alarm = { ...s.alerts.alarm, ring: false, petRuns: false, ringSeconds: 3, autoSnoozeMax: 0 };
    return s;
  });
  // An Every day alarm keeps hours and minutes: on the next whole minute, 3 s from now.
  const minute = Math.ceil((appNow() + 5000) / MIN) * MIN;
  await ahead(minute - appNow() - 5500);
  const a = await app.invoke("add_alarm", { label: "Every day test", at: minute, repeat: "daily", days: null });
  await app.waitBubble("Every day test", 10_000);
  const find = async () => (await app.invoke("list_alarms")).find((x) => x.id === a.id);
  let missed;
  await app.b.waitUntil(async () => (missed = await find())?.missedAt, { timeout: 15_000 });
  assert.equal(missed.enabled, true, "still on");
  assert.ok(missed.nextFire > appNow() + 20 * HOUR, `next: tomorrow (${new Date(missed.nextFire).toString()})`);
  // The next day, a moment before its time.
  await ahead(missed.nextFire - appNow() - 4000);
  await app.waitBubble("Every day test", 15_000);
  await app.answer("Done");
  const after = await find();
  assert.equal(after.enabled, true);
  assert.ok(after.nextFire > appNow() + 20 * HOUR, "and the day after");
  await app.invoke("delete_alarm", { id: a.id });
}, { timeout: 120_000 });

check("alarm.daily-cleanup", "the next day, yesterday's finished timers and ticked to-dos are cleared", async () => {
  const app = ctx.app;
  await app.setSettings((s) => {
    s.alerts.alarm = { ...s.alerts.alarm, ring: false, petRuns: false, ringSeconds: 30 };
    return s;
  });
  const timer = await app.invoke("add_alarm", { label: "Timer: 1 min", at: appNow() + 1500, repeat: "none", days: null });
  await app.waitBubble("Time's up", 10_000);
  await app.answer("Done");
  const todo = await app.invoke("add_todo", { todo: { title: "Ticked", allDay: false, repeat: "none", dueAt: null } });
  await app.invoke("update_todo", { id: todo.id, patch: { done: true } });
  await app.panel("alarms");
  await app.waitText("details.finished .finished-row .sub", "Done · Today");
  // The next day.
  await ahead(DAY);
  await app.b.waitUntil(async () => !(await app.invoke("list_alarms")).some((x) => x.id === timer.id), { timeout: 10_000 }).catch(() => {
    throw new Error("yesterday's finished timer is still there");
  });
  assert.ok(!(await app.invoke("list_todos")).some((x) => x.id === todo.id), "yesterday's ticked to-do is cleared");
  await app.panel("alarms");
  await app.waitNoText("details.finished .finished-row .sub", "Done ·", 5000);
}, { timeout: 120_000 });
