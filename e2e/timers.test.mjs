import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const MIN = 60_000;

const texts = (items) => items.map((i) => (typeof i === "string" ? i : i.text));
const sub = (items, start) => items.find((i) => typeof i !== "string" && i.text.startsWith(start))?.items ?? [];
const alarms = () => ctx.app.invoke("list_alarms");

/** Nothing running or finished, no panel, quiet rings that last `ringSeconds`. */
async function reset(ringSeconds = 30) {
  const app = ctx.app;
  await app.toPet();
  for (const a of await alarms()) await app.invoke("delete_alarm", { id: a.id });
  await app.invoke("pomodoro_stop");
  await app.closeWindow("panel");
  await app.setSettings((s) => {
    s.alerts.alarm = { ...s.alerts.alarm, ring: false, petRuns: true, ringSeconds, snoozeMinutes: 5, autoSnoozeMax: 3 };
    return s;
  });
  // Answer anything still ringing (a test that failed), then let the bubble go.
  await app.b.execute(() => [...document.querySelectorAll("#bubble .actions button")].find((b) => b.textContent === "Done")?.click());
  await app.until(() => document.getElementById("bubble").hidden || !document.querySelector("#bubble .actions"), [], 15_000).catch(() => {});
  // …and dismiss a "⏱ Done" badge it left.
  if ((await app.badges()).some((b) => b.text.startsWith("⏱ Done"))) await clickBadge("⏱ Done");
}

/** Clicks a button in the pet's bubble. */
async function answer(label) {
  await ctx.app.toPet();
  await ctx.app.click("#bubble .actions button", label);
}

/** Clicks the badge whose text starts with `start`. */
async function clickBadge(start) {
  await ctx.app.toPet();
  await ctx.app.b.execute((s) => [...document.getElementById("badges").children].find((e) => e.textContent.startsWith(s)).click(), start);
  await ctx.app.sleep(400);
}

check("timer.confirm", "Set timer → 1 min: the pet confirms, and a ⏱ countdown badge shows", async () => {
  const app = ctx.app;
  await reset();
  await app.run("pet", "Set timer", "1 min");
  const said = await app.waitBubble("1 min");
  assert.match(said, /1 min/);
  const timer = (await alarms()).find((a) => a.label === "Timer: 1 min");
  assert.ok(timer && Math.abs(timer.nextFire - Date.now() - MIN) < 5000);
  await app.b.waitUntil(async () => (await app.badges()).some((b) => /^⏱ 0:5\d$/.test(b.text)), { timeout: 5000 });
});

check("timer.several", "three timers: the badge shows the nearest + 2; Cancel timer lists them all with their ring times", async () => {
  const app = ctx.app;
  await reset();
  for (const m of ["5 min", "1 min", "10 min"]) await app.run("pet", "Set timer", m);
  await app.b.waitUntil(async () => (await app.badges()).some((b) => /^⏱ 0:\d\d \+2$/.test(b.text)), { timeout: 5000 });
  const list = (await alarms()).sort((a, b) => a.nextFire - b.nextFire);
  const cancel = sub(await app.menu("pet"), "Cancel timer");
  const want = [];
  for (const a of list) want.push(`${a.label.slice("Timer: ".length)} (rings ${await app.clock(a.nextFire)})`);
  assert.deepEqual(cancel, want);
  assert.deepEqual(sub(await app.menu("tray"), "Cancel timer"), want);
});

check("timer.cancel", "cancelling one: it leaves the badge and the panel together", async () => {
  const app = ctx.app;
  await reset();
  for (const m of ["1 min", "5 min"]) await app.run("pet", "Set timer", m);
  // The menu lists them once the pet has them.
  await app.b.waitUntil(async () => sub(await app.menu("pet"), "Cancel timer")?.length === 2, { timeout: 5000 });
  await app.run("pet", "Cancel timer", "1 min");
  await app.b.waitUntil(async () => (await app.badges()).some((b) => /^⏱ 4:\d\d$/.test(b.text)), { timeout: 5000 });
  assert.deepEqual((await alarms()).map((a) => a.label), ["Timer: 5 min"]);
  await app.panel("alarms");
  assert.deepEqual(await app.texts("li.clock-row:has(.countdown) .title"), ["⏱ 5 min timer"]);
});

check("timer.ring", "when it runs out: the bubble with Snooze and Done; with “run to the middle” off the pet stays put", async () => {
  const app = ctx.app;
  await reset();
  await app.addTimer(1, 2000);
  const said = await app.waitBubble("Time's up", 10_000);
  assert.match(said, /⏱ Time's up! \(1 min timer\)/);
  assert.deepEqual(await app.texts("#bubble .actions button"), ["Snooze 5 min", "Done"]);
  const p = await app.pet();
  assert.ok(p.ringing);
  // Running there is up to the pet's personality (sociable ones come); when it does, to the middle.
  if (p.target) assert.ok(Math.abs(p.target.x - (p.area.x + p.area.w / 2)) < 2, `runs to the middle: ${JSON.stringify(p.target)}`);
  await answer("Done");
  await app.setSettings((s) => ((s.alerts.alarm.petRuns = false), s));
  await app.addTimer(1, 1500);
  await app.waitBubble("Time's up", 10_000);
  const q = await app.pet();
  assert.ok(q.state !== "goto" && !q.target, `stays put: ${q.state} ${JSON.stringify(q.target)}`);
  await answer("Done");
});

check("timer.snooze", "Snooze: “Snoozed until …”; it shows in the panel and the badge, and can be cancelled from the menu", async () => {
  const app = ctx.app;
  await reset();
  const t = await app.addTimer(1, 2000);
  await app.waitBubble("Time's up", 10_000);
  await answer("Snooze 5 min");
  const said = await app.waitBubble("Snoozed until");
  assert.match(said, new RegExp(`Snoozed until ${(await app.clock(Date.now() + 5 * MIN)).replace(/\s/g, "\\s")}`));
  const snoozed = (await alarms()).find((a) => a.id === t.id);
  assert.equal(snoozed.snoozes, 1);
  await app.b.waitUntil(async () => (await app.badges()).some((b) => /^⏱ [45]:\d\d$/.test(b.text)), { timeout: 5000 });
  await app.panel("alarms");
  await app.waitText("li.clock-row:has(.countdown) .chip", "snoozed 1×");
  await app.run("pet", "Cancel timer");
  await app.b.waitUntil(async () => (await alarms()).length === 0, { timeout: 5000 });
});

check("timer.done", "Done: it stops and stays in Finished as “Done · Today …”", async () => {
  const app = ctx.app;
  await reset();
  const t = await app.addTimer(1, 2000);
  await app.waitBubble("Time's up", 10_000);
  await answer("Done");
  await app.b.waitUntil(async () => (await alarms()).find((a) => a.id === t.id)?.enabled === false, { timeout: 5000 });
  const rang = (await alarms()).find((a) => a.id === t.id).rangAt;
  await app.panel("alarms");
  await app.waitText("details.finished .finished-row .sub", `Done · Today ${await app.clock(rang)}`);
});

check("timer.together", "two timers due together share one bubble; one Done finishes both", async () => {
  const app = ctx.app;
  await reset();
  const a = await app.addTimer(1, 2000);
  const b = await app.addTimer(2, 3500);
  const said = await app.waitBubble("2 timers are up", 10_000);
  assert.match(said, /⏱ 2 timers are up: • 1 min timer • 2 min timer/);
  await answer("Done");
  await app.b.waitUntil(async () => (await alarms()).filter((x) => [a.id, b.id].includes(x.id) && !x.enabled).length === 2, { timeout: 5000 });
  await app.panel("alarms");
  assert.equal((await app.texts("details.finished .finished-row .sub")).filter((s) => s.startsWith("Done ·")).length, 2);
});

check("timer.unanswered", "nobody answers: no snooze; a quiet “⏱ Done …” badge, gone when clicked", async () => {
  const app = ctx.app;
  await reset(3);
  const t = await app.addTimer(1, 1500);
  await app.waitBubble("Time's up", 10_000);
  await app.b.waitUntil(async () => (await app.badges()).some((x) => x.text.startsWith("⏱ Done")), { timeout: 10_000 });
  const after = (await alarms()).find((a) => a.id === t.id);
  assert.equal(after.snoozes, 0, "timers never snooze themselves");
  assert.equal(after.enabled, false);
  const badge = (await app.badges()).find((x) => x.text.startsWith("⏱ Done"));
  // When it rang (as Finished says), not when the ring ended.
  assert.equal(badge.text, `⏱ Done ${await app.clock(after.rangAt)}`);
  await clickBadge("⏱ Done");
  assert.ok(!(await app.badges()).some((x) => x.text.startsWith("⏱ Done")));
});

check("timer.badge-click", "clicking ⏱ opens Alarms, 🍅 opens Focus; the countdown keeps going", async () => {
  const app = ctx.app;
  await reset();
  await app.addTimer(5, 5 * MIN);
  await app.invoke("pomodoro_start");
  await app.b.waitUntil(async () => (await app.badges()).length === 2, { timeout: 5000 });
  const [focus, timer] = await app.badges();
  assert.match(focus.text, /^🍅 \d+:\d\d$/, "focus above the timer");
  assert.match(timer.text, /^⏱ \d:\d\d$/);
  await clickBadge("⏱");
  assert.equal(await app.panelTab(), "alarms");
  await clickBadge("🍅");
  assert.equal(await app.panelTab(), "focus");
  await clickBadge("⏱");
  assert.equal(await app.panelTab(), "alarms", "every click works");
  const before = (await app.badges())[1].text;
  await app.sleep(1500);
  assert.notEqual((await app.badges())[1].text, before, "still counting down");
});

check("timer.started", "the panel says “Started … · rings at …”; the ⏱ badge's info lists each timer", async () => {
  const app = ctx.app;
  await reset();
  await app.run("pet", "Set timer", "5 min");
  await app.run("pet", "Set timer", "5 min");
  await app.run("pet", "Set timer", "10 min");
  const list = (await alarms()).sort((a, b) => a.nextFire - b.nextFire);
  await app.panel("alarms");
  const subs = await app.texts("li.clock-row:has(.countdown) .sub");
  const want = [];
  for (const a of list) want.push(`Started ${await app.clock(a.createdAt)} · rings at ${await app.clock(a.nextFire)}`);
  assert.deepEqual(subs, want);
  const info = (await app.badges()).find((b) => b.text.startsWith("⏱")).info.split("\n");
  const lines = [];
  for (const a of list) lines.push(`${a.label.slice("Timer: ".length)} · ${await app.badgeRange(a.createdAt, a.nextFire)}`);
  assert.deepEqual(info, [...lines, "Open the Alarms tab"]);
});

check("timer.badge-info", "each badge's info: what and when, then what a click does", async () => {
  const app = ctx.app;
  await reset();
  const focus = await app.invoke("pomodoro_start");
  // An alarm snoozed once, a missed one, and a timer nobody answered.
  const at = Date.now() + 30 * MIN;
  const snoozed = await app.invoke("add_alarm", { label: "Tea", at, repeat: "none", days: null });
  await app.invoke("snooze_alarm", { id: snoozed.id, minutes: 8 });
  // (Far enough ahead not to count as upcoming too.)
  const missed = await app.invoke("add_alarm", { label: "Call", at: Date.now() + 6 * 60 * MIN, repeat: "none", days: null });
  await app.invoke("mark_alarm_missed", { id: missed.id });
  await app.setSettings((s) => ({ ...s, alerts: { ...s.alerts, alarm: { ...s.alerts.alarm, ringSeconds: 3 } } }));
  await app.addTimer(1, 1500);
  await app.b.waitUntil(async () => (await app.badges()).some((x) => x.text.startsWith("⏱ Done")), { timeout: 15_000 });
  await app.toPet();
  await app.invoke("plugin:event|emit", { event: "alarms-changed", payload: null });
  await app.sleep(800);
  const byIcon = Object.fromEntries((await app.badges()).map((b) => [b.text.split(" ")[0], b.info.split("\n")]));
  const pc = (await app.fullSettings()).pomodoro;
  assert.deepEqual(byIcon["🍅"], [`Focus · ${await app.badgeRange(focus.endsAt - pc.focusMin * MIN, focus.endsAt)}`, "Open the Focus tab"]);
  const tea = (await alarms()).find((a) => a.id === snoozed.id);
  assert.equal(byIcon["💤"].at(-1), "Open the Alarms tab");
  assert.equal(byIcon["💤"][0], `Tea · 💤×1 · next ${await app.clock(tea.nextFire)}`);
  assert.deepEqual(byIcon["⏰"], ["Call", "Mark as seen"]);
  assert.equal(byIcon["⏱"].at(-1), "Dismiss");
  assert.match(byIcon["⏱"][0], /^1 min timer · done /);
});
