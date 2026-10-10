import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

const texts = (items) => items.map((i) => (typeof i === "string" ? i : i.text));
const alarms = () => ctx.app.invoke("list_alarms");

/** Shown, nothing set, nothing unseen; alarms ring 3 s, snoozes 6 s. */
async function reset(alarm = {}) {
  const app = ctx.app;
  await app.toPet();
  if ((await app.menu("tray"))[0] === "Show pet") await app.invoke("e2e_tray", { id: "show" });
  await app.b.execute(() => [...document.querySelectorAll("#bubble .actions button")].find((b) => b.textContent === "Done")?.click());
  for (const a of await alarms()) await app.invoke("delete_alarm", { id: a.id });
  for (const t of await app.invoke("list_todos")) await app.invoke("delete_todo", { id: t.id });
  await app.invoke("clear_unseen");
  await app.invoke("pomodoro_stop");
  await app.setSettings((s) => {
    s.alerts.alarm = { ...s.alerts.alarm, ring: false, petRuns: true, ringSeconds: 3, snoozeMinutes: 0.1, autoSnoozeMax: 3, ...alarm };
    s.alerts.todo = { ...s.alerts.todo, ring: false, petRuns: true };
    s.hiddenAlerts = { alarms: true, timers: true, todos: true, focus: false, anniversaries: true };
    return s;
  });
  await app.sleep(500);
}

async function hide() {
  const app = ctx.app;
  await app.run("tray", "Hide pet");
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
}

/** The pet is out (its window shown) while the tray still offers Show pet. */
async function waitOut(timeout = 10_000) {
  const app = ctx.app;
  await app.b.waitUntil(async () => app.visible("pet"), { timeout });
  assert.equal((await app.menu("tray"))[0], "Show pet", "still hidden as far as the tray goes");
  assert.equal((await app.pet()).peek, true);
}

/** Back into hiding once nothing is left to answer. */
async function waitBack(timeout = 25_000) {
  const app = ctx.app;
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout }).catch(async (e) => {
    const p = await app.pet();
    throw new Error(`still out: ${JSON.stringify({ state: p.state, peek: p.peek, x: p.x, area: p.area, target: p.target, bubble: await app.bubble() })} (${e.message})`);
  });
  assert.equal((await app.pet()).peek, false);
}

const addAlarm = (ms, label = "") => ctx.app.invoke("add_alarm", { label, at: Date.now() + ms, repeat: "none", days: null });

check("hidden.peek-alarm", "hidden, the pet comes out for an alarm (tray still says Show pet) and goes back after Done or Snooze; Show pet while it rings keeps it out", async () => {
  const app = ctx.app;
  // Snoozes of 30 s: time to walk off and hide before it rings again.
  await reset({ ringSeconds: 30, snoozeMinutes: 0.5 });
  await hide();
  // Done: back into hiding.
  await addAlarm(2000);
  await waitOut();
  await app.waitBubble("Alarm", 5000);
  const p = await app.pet();
  assert.ok(p.target && Math.abs(p.target.x - (p.area.x + p.area.w / 2)) < 2, "out for something, it goes to the middle");
  await app.answer("Done");
  await waitBack();
  // Snooze: back, and out again for the next ring.
  await addAlarm(2000);
  await waitOut();
  await app.waitBubble("Alarm", 5000);
  await app.answer("Snooze 0.5 min");
  await waitBack();
  await waitOut(40_000);
  await app.waitBubble("Snoozed 1×", 5000);
  await app.answer("Done");
  await waitBack();
  // Show pet while it rings: it stays out.
  await addAlarm(2000);
  await waitOut();
  await app.run("tray", "Show pet");
  await app.answer("Done");
  await app.sleep(8000);
  assert.equal(await app.visible("pet"), true);
  assert.equal((await app.menu("tray"))[0], "Hide pet");
}, { timeout: 150_000 });

check("hidden.peek-timer-todo", "hidden: timers and to-dos bring it out, unanswered it goes back; a focus session's end only with Focus sessions ticked", async () => {
  const app = ctx.app;
  await reset();
  await hide();
  // A timer nobody answers.
  await app.addTimer(1, 2000);
  await waitOut();
  await app.waitBubble("Time's up", 5000);
  await waitBack();
  // A to-do nobody answers (its bubble stays a minute).
  await app.invoke("add_todo", { todo: { title: "Call mom", allDay: false, repeat: "none", dueAt: Date.now() + 2000 } });
  await waitOut();
  await app.waitBubble("Call mom", 5000);
  await waitBack(90_000);
  // A focus session's end: not with Focus sessions unticked…
  await app.setSettings((s) => ((s.pomodoro = { ...s.pomodoro, focusMin: 0.05, shortBreakMin: 5, autoContinue: true }), s));
  await app.invoke("pomodoro_start");
  await app.b.waitUntil(async () => (await app.invoke("pomodoro_status")).phase === "short_break", { timeout: 10_000 });
  await app.sleep(1500);
  assert.equal(await app.visible("pet"), false, "stays hidden");
  await app.invoke("pomodoro_stop");
  // …and with it ticked it comes out, says so and goes back.
  await app.setSettings((s) => ((s.hiddenAlerts.focus = true), s));
  await app.invoke("pomodoro_start");
  await waitOut();
  await waitBack();
  await app.invoke("pomodoro_stop");
}, { timeout: 180_000 });

check("hidden.unseen-list", "Show pet: “While I was hidden you missed:” with dates, oldest first, “…and N more”; it stays (petting, a restart) until Done, which clears it and the ⏰ badge", async () => {
  let app = ctx.app;
  // (hidden.peek-timer-todo left a timer and a to-do unanswered.)
  let list = await app.invoke("list_unseen");
  assert.ok(list.some((u) => u.kind === "timer") && list.some((u) => u.kind === "todo"), JSON.stringify(list));
  // A missed alarm (nobody answered while hidden, not coming out for alarms), and enough to overflow.
  await app.setSettings((s) => ((s.hiddenAlerts.alarms = false), s));
  const missed = await addAlarm(1500, "Pills");
  await app.b.waitUntil(async () => (await app.invoke("list_unseen")).some((u) => u.kind === "alarm"), { timeout: 15_000 });
  assert.equal(await app.visible("pet"), false, "didn't come out");
  for (let i = 0; i < 3; i++) {
    await app.invoke("record_unseen", { item: { kind: "todo", refId: 0, title: `Old ${i}`, at: Date.now() - (i + 2) * 86_400_000, snoozes: 0 } });
  }
  list = await app.invoke("list_unseen");
  assert.equal(list.length, 6);
  await app.run("tray", "Show pet");
  let said = await app.waitBubble("While I was hidden you missed:");
  const lines = said.replace("While I was hidden you missed: ", "").split(/ (?=• |…and)/);
  assert.equal(lines.length, 6, said);
  assert.match(lines[0], /^• 📝 Old 2 · /, "oldest first");
  assert.ok(lines.some((l) => /^• ⏱ 1 min timer · Today /.test(l)), said);
  assert.ok(lines.some((l) => /^• 📝 Call mom · Today /.test(l)), said);
  assert.equal(lines[5], "…and 1 more");
  // Petting doesn't replace it.
  await app.b.execute(() => window.__epet.care("pet"));
  await app.sleep(800);
  assert.match(await app.bubble(), /^While I was hidden you missed:/);
  // After a restart it's there again.
  ctx.app = app = await app.restart();
  said = await app.waitBubble("While I was hidden you missed:", 15_000);
  // Done clears it, and the ⏰ badge; Finished still says Missed; the to-do shows Overdue.
  await app.answer("Done");
  await app.b.waitUntil(async () => (await app.invoke("list_unseen")).length === 0, { timeout: 5000 });
  await app.b.waitUntil(async () => !(await app.badges()).some((b) => b.text.startsWith("⏰")), { timeout: 5000 });
  assert.ok((await alarms()).find((a) => a.id === missed.id).missedAt);
  await app.panel("alarms");
  await app.waitText("details.finished .finished-row .sub.missed", "Missed");
  await app.panel("todos");
  await app.waitText(".when.overdue", "Overdue");
}, { timeout: 120_000 });
