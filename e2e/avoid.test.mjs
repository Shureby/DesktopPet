import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

const CALL = { fullscreen: false, presenting: false, call: true };
const GAME = { fullscreen: true, presenting: false, call: false };
const status = () => ctx.app.invoke("avoid_status");
const pretend = (busy) => ctx.app.invoke("pretend_busy", { busy });
const addAlarm = (ms, label = "", important = false) =>
  ctx.app.invoke("add_alarm", { label, at: Date.now() + ms, repeat: "none", days: null, important, autoSnooze: false });
const addTodo = (ms, title) => ctx.app.invoke("add_todo", { todo: { title, dueAt: Date.now() + ms, allDay: false, repeat: "none" } });

/** Shown and back from any stepping aside, nothing set or unseen; alarms ring 3 s, no snoozes. */
async function reset(alarm = {}) {
  const app = ctx.app;
  await app.toPet();
  await pretend(null);
  // Back about 10 s after what it stepped aside for is over.
  await app.b.waitUntil(async () => (await status()).reason === null, { timeout: 20_000 });
  if ((await app.menu("tray"))[0] === "Show pet") await app.invoke("e2e_tray", { id: "show" });
  for (const label of ["Done", "Done"]) await app.answer(label).catch(() => {});
  for (const a of await app.invoke("list_alarms")) await app.invoke("delete_alarm", { id: a.id });
  for (const t of await app.invoke("list_todos")) await app.invoke("delete_todo", { id: t.id });
  const clock = await app.invoke("test_clock");
  if (clock?.shift) await app.invoke("shift_clock", { ms: -clock.shift });
  await app.invoke("clear_unseen");
  await app.setSettings((s) => {
    s.alerts.alarm = { ...s.alerts.alarm, ring: true, ringtone: "classic", volume: 0.6, petRuns: false, ringSeconds: 3, autoSnoozeMax: 0, ...alarm };
    s.avoid = { fullscreen: true, presenting: true, calls: true, alwaysHide: false };
    s.modes = { ...s.modes, choice: "normal", override: null };
    return s;
  });
  await app.sleep(500);
}

/** Stepped aside for `busy`: the pet's window goes and the tray says why. */
async function stepAside(busy, why) {
  const app = ctx.app;
  await pretend(busy);
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
  assert.equal((await status()).reason, why);
  assert.equal((await app.pet()).away, why);
}

/** Over: back after a while, telling what was missed. */
async function comeBack() {
  const app = ctx.app;
  await pretend(null);
  await app.sleep(4000);
  assert.equal(await app.visible("pet"), false, "not back at once");
  await app.b.waitUntil(async () => app.visible("pet"), { timeout: 15_000 });
  assert.equal((await app.pet()).away, null);
}

check("avoid.call", "in a call the pet steps aside and nothing rings (an alarm waits), ePet is hidden from screen sharing; back ~10 s after, the alarm rings with the pet", async () => {
  const app = ctx.app;
  await reset({ ringSeconds: 30 });
  await stepAside(CALL, "call");
  assert.equal((await status()).protected, true, "left out of screen sharing");
  const tray = await app.menu("tray");
  assert.equal(tray[0], "Show pet");
  assert.ok(tray.includes("Stepped aside: in a call"), JSON.stringify(tray));
  const since = Date.now();
  const a = await addAlarm(1500, "Stand-up notes");
  await app.b.waitUntil(async () => (await app.invoke("list_alarms")).find((x) => x.id === a.id)?.rangAt, { timeout: 10_000 });
  await app.sleep(2000);
  assert.equal(await app.visible("pet"), false, "it doesn't come out");
  assert.ok(!(await app.sounds(since)).some((s) => s.kind === "ring"), "no ring in a call");
  assert.equal((await app.invoke("list_unseen")).length, 0, "not missed: it waits");
  await comeBack();
  await app.waitBubble("Stand-up notes", 5000);
  assert.ok((await app.sounds(since)).some((s) => s.kind === "ring"), "rings now, with the pet");
  assert.equal((await status()).protected, false, "back in screenshots");
  await app.answer("Done");
});

check("avoid.important", "an important alarm brings the pet out even in a call, rings in full (also in Quiet), and the pet goes again after Done and stays away", async () => {
  const app = ctx.app;
  await reset({ ringSeconds: 30 });
  await stepAside(CALL, "call");
  let since = Date.now();
  await addAlarm(1500, "Pick up kids", true);
  await app.b.waitUntil(async () => app.visible("pet"), { timeout: 10_000 });
  await app.waitBubble("Pick up kids", 5000);
  const ring = (await app.sounds(since)).find((s) => s.kind === "ring");
  assert.deepEqual([ring?.volume, ring?.rampUp], [0.6, false]);
  await app.answer("Done");
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 25_000 });
  // Answering it doesn't end the call: the pet stays away (it used to come back for good).
  await app.sleep(15_000);
  assert.equal(await app.visible("pet"), false, "still aside after Done");
  assert.equal((await status()).reason, "call");
  await reset({ ringSeconds: 30 });
  // Quiet rings softly and starts low; an important alarm doesn't.
  await app.setSettings((s) => ({ ...s, modes: { ...s.modes, choice: "quiet" } }));
  since = Date.now();
  await addAlarm(1500, "Medicine", true);
  await app.waitBubble("Medicine", 10_000);
  const loud = (await app.sounds(since)).find((s) => s.kind === "ring");
  assert.deepEqual([loud?.volume, loud?.rampUp], [0.6, false]);
  await app.answer("Done");
  since = Date.now();
  await addAlarm(1500, "Tea");
  await app.waitBubble("Tea", 10_000);
  const soft = (await app.sounds(since)).find((s) => s.kind === "ring");
  assert.equal(soft?.rampUp, true, "an ordinary one starts soft in Quiet");
  await app.answer("Done");
}, { timeout: 120_000 });

check("avoid.fullscreen", "full screen (a game, a video): the pet steps aside and nothing rings, ePet stays in screenshots; back more than 15 min later, the alarm is missed and told", async () => {
  const app = ctx.app;
  await reset();
  await stepAside(GAME, "fullscreen");
  assert.equal((await status()).protected, false);
  const since = Date.now();
  const a = await addAlarm(1500, "Pizza");
  await app.b.waitUntil(async () => (await app.invoke("list_alarms")).find((x) => x.id === a.id)?.rangAt, { timeout: 10_000 });
  await app.sleep(2000);
  assert.ok(!(await app.sounds(since)).some((s) => s.kind === "ring"), "no ring without the pet");
  assert.equal(await app.visible("pet"), false);
  // The game goes on for 16 minutes.
  await app.invoke("shift_clock", { ms: 16 * 60_000 });
  await app.sleep(2500);
  await comeBack();
  await app.waitBubble("While you were busy you missed:", 5000);
  assert.ok((await app.bubble()).includes("Pizza"));
  assert.ok(!(await app.sounds(since)).some((s) => s.kind === "ring"), "too late to ring");
  assert.ok((await app.invoke("list_alarms")).find((x) => x.id === a.id)?.missedAt, "missed");
  await app.answer("Done");
});

check("avoid.held", "aside, an alarm and a to-do wait; back within 15 min the alarm rings with the pet first, then the to-do is told, each saying how late and why", async () => {
  const app = ctx.app;
  await reset({ ringSeconds: 30 });
  await stepAside(GAME, "fullscreen");
  await addTodo(1000, "Call the plumber");
  await addAlarm(2000, "Laundry");
  await app.sleep(4000);
  assert.equal(await app.visible("pet"), false);
  // Ten minutes later: still in time.
  await app.invoke("shift_clock", { ms: 10 * 60_000 });
  await app.sleep(2500);
  await comeBack();
  await app.waitBubble("Laundry", 5000);
  assert.ok(!(await app.bubble()).includes("plumber"), "the alarm first");
  // Rung late: when it was meant for, how late, and why.
  assert.match(await app.bubble(), /Due .+ · 1\d min late — an app was full screen/);
  await app.answer("Done");
  await app.waitBubble("Call the plumber", 5000);
  assert.match(await app.bubble(), /Due .+ · 1\d min late — an app was full screen/);
  assert.equal((await app.invoke("list_unseen")).length, 0, "nothing missed");
}, { timeout: 90_000 });

check("avoid.tray-stop", "while an alarm rings, the tray's top lines “⏰ Done (stop ringing)” and “💤 Snooze 5 min” answer it", async () => {
  const app = ctx.app;
  await reset({ ringSeconds: 30, snoozeMinutes: 5 });
  let since = Date.now();
  const a = await addAlarm(1500, "Kettle");
  await app.waitBubble("Kettle", 10_000);
  const tray = await app.menu("tray");
  assert.deepEqual(tray.slice(0, 3), ["⏰ Done (stop ringing)", "💤 Snooze 5 min", "—"]);
  await app.run("tray", "⏰ Done");
  assert.ok((await app.sounds(since)).some((s) => s.kind === "ring-stop"), "the ring stops");
  assert.equal((await app.pet()).ringing, false);
  await app.b.waitUntil(async () => !(await app.invoke("list_alarms")).find((x) => x.id === a.id)?.enabled, { timeout: 5000 });
  assert.notEqual((await app.menu("tray"))[0], "⏰ Done (stop ringing)");
  since = Date.now();
  const b = await addAlarm(1500, "Oven");
  await app.waitBubble("Oven", 10_000);
  await app.run("tray", "💤 Snooze");
  assert.equal((await app.pet()).ringing, false);
  await app.b.waitUntil(async () => (await app.invoke("list_alarms")).find((x) => x.id === b.id)?.snoozes === 1, { timeout: 5000 });
});

check("avoid.goodbye", "stepping aside it says why and runs off the edge; back it runs in from that edge and, with nothing to tell after 2 minutes away, chats; Show pet: “I'm back”", async () => {
  const app = ctx.app;
  await reset();
  const LEAVING = ["Full screen? I'll get out of your way.", "Go on, I'll wait off-screen.", "Big screen time! I'll be just around the corner."];
  const BACK = ["Are you playing games without me?", "What app needs the whole screen like that?", "Back from the big screen? I missed you."];
  const SHOWN = ["OK, I'm back!", "You called? Here I am!", "Back already? Hi again!"];
  await pretend(GAME);
  // It says why and runs before its window goes.
  await app.b.waitUntil(async () => LEAVING.includes(await app.bubble()), { timeout: 3000, interval: 100 });
  assert.equal((await app.pet()).state, "goto", "runs off");
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
  const gone = await app.pet();
  const edge = Math.min(Math.abs(gone.x - gone.area.x), Math.abs(gone.area.x + gone.area.w - gone.x));
  assert.ok(edge < gone.size.w * 2, `at the edge when it goes: ${JSON.stringify({ x: gone.x, area: gone.area })}`);
  // Three minutes of game, nothing due: back, it runs in from that edge and chats.
  await app.invoke("shift_clock", { ms: 3 * 60_000 });
  await pretend(null);
  await app.b.waitUntil(async () => app.visible("pet"), { timeout: 15_000 });
  const back = await app.pet();
  const fromEdge = Math.min(Math.abs(back.x - back.area.x), Math.abs(back.area.x + back.area.w - back.x));
  assert.ok(fromEdge < back.area.w * 0.25, `comes in from the edge: ${JSON.stringify({ x: back.x, area: back.area })}`);
  await app.b.waitUntil(async () => BACK.includes(await app.bubble()), { timeout: 5000, interval: 100 });
  // Show pet during a call: back at once, "I'm back".
  await stepAside(CALL, "call");
  await app.invoke("e2e_tray", { id: "show" });
  await app.b.waitUntil(async () => app.visible("pet"), { timeout: 5000 });
  await app.b.waitUntil(async () => SHOWN.includes(await app.bubble()), { timeout: 5000, interval: 100 });
  // Shown anyway, it stays until 10 s after the call is over (for the next test).
  await pretend(null);
  await app.sleep(11_000);
}, { timeout: 90_000 });

check("avoid.show-anyway", "Show pet while it stepped aside brings it back until that's over; still hidden from screen sharing while the call goes on", async () => {
  const app = ctx.app;
  await reset();
  await stepAside(CALL, "call");
  await app.invoke("e2e_tray", { id: "show" });
  await app.b.waitUntil(async () => app.visible("pet"), { timeout: 5000 });
  assert.equal((await status()).reason, null);
  assert.equal((await app.pet()).away, null);
  assert.equal((await status()).protected, true, "the call goes on");
  await app.sleep(3000);
  assert.equal(await app.visible("pet"), true, "it stays for this call");
  assert.equal((await app.menu("tray"))[0], "Hide pet");
});

check("avoid.settings", "Modes → Step aside: unticked, the pet stays for that; Always hide keeps ePet out of screenshots", async () => {
  const app = ctx.app;
  await reset();
  await app.panel("modes");
  await app.click(".avoid label.check", "Video calls");
  await app.b.waitUntil(async () => (await app.settings()).avoid.calls === false, { timeout: 5000 });
  await app.toPet();
  await pretend(CALL);
  await app.sleep(3000);
  assert.equal(await app.visible("pet"), true, "stays for calls when unticked");
  assert.equal((await status()).reason, null);
  assert.equal((await status()).protected, false);
  await pretend(null);
  await app.setSettings((s) => ({ ...s, avoid: { ...s.avoid, alwaysHide: true } }));
  await app.b.waitUntil(async () => (await status()).protected === true, { timeout: 5000 });
  await app.setSettings((s) => ({ ...s, avoid: { ...s.avoid, alwaysHide: false } }));
  await app.b.waitUntil(async () => (await status()).protected === false, { timeout: 5000 });
});

check("alarm.important", "the alarm form's Important tick: saved with the alarm, shown in the list, kept when edited", async () => {
  const app = ctx.app;
  await reset();
  await app.panel("alarms");
  await app.click(".important-row input");
  await app.b.execute(() => {
    const label = document.querySelector('input[placeholder="Label"]');
    label.value = "Flight";
    label.dispatchEvent(new Event("input"));
  });
  await app.click("button.primary", "Add");
  await app.waitText(".clock-row .chip.important", "Important");
  const [a] = await app.invoke("list_alarms");
  assert.equal(a.important, true);
  await app.click(".clock-row button.edit");
  assert.equal(await app.b.execute(() => document.querySelector(".important-row input").checked), true);
  await app.click("button.primary", "Save");
  await app.sleep(500);
  assert.equal((await app.invoke("list_alarms"))[0].important, true);
});

check("pet.bubble-edge", "at the very edge of the screen (half the pet window off it) the speech bubble wraps narrower and stays whole on screen", async () => {
  const app = ctx.app;
  await reset();
  // A long line: "While I was hidden you missed:" and an item.
  await app.invoke("record_unseen", { item: { kind: "alarm", refId: 0, title: "Alarm", at: Date.now() - 60_000, snoozes: 0 } });
  const p = await app.pet();
  // Walk to the left edge of its screen.
  await app.b.waitUntil(async () => {
    // Asked again until it's there (it may set off on a walk of its own first).
    await app.b.execute((x) => window.__epet.walkTo(x), p.area.x);
    await app.sleep(1500);
    const q = await app.pet();
    return q.grounded && q.state !== "walkTo" && q.x - q.area.x < q.size.w;
  }, { timeout: 40_000, interval: 200 }).catch(async (e) => {
    const q = await app.pet();
    throw new Error(`didn't reach the edge: ${JSON.stringify({ x: q.x, area: q.area, state: q.state, size: q.size, grounded: q.grounded, target: q.target })} (${e.message})`);
  });
  await app.invoke("e2e_tray", { id: "hide" });
  await app.sleep(500);
  await app.invoke("e2e_tray", { id: "show" });
  await app.waitBubble("you missed", 5000);
  await app.sleep(500);
  const r = await app.b.execute(() => {
    const s = window.__epet.state();
    const b = document.getElementById("bubble").getBoundingClientRect();
    // The screen's part of the window, in its CSS px.
    const left = (s.area.x - s.origin.x) / s.dpr;
    const right = (s.area.x + s.area.w - s.origin.x) / s.dpr;
    return { b: { left: b.left, right: b.right }, left, right };
  });
  assert.ok(r.left > 0, `the window hangs off the screen (${JSON.stringify(r)})`);
  assert.ok(r.b.left >= r.left - 1 && r.b.right <= Math.min(r.right, 340) + 1, `the bubble is whole on screen: ${JSON.stringify(r)}`);
  await app.answer("Done");
}, { timeout: 60_000 });
