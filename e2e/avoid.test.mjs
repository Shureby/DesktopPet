import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

const CALL = { fullscreen: false, presenting: false, call: true };
const GAME = { fullscreen: true, presenting: false, call: false };
const status = () => ctx.app.invoke("avoid_status");
const pretend = (busy) => ctx.app.invoke("pretend_busy", { busy });
const addAlarm = (ms, label = "", important = false) =>
  ctx.app.invoke("add_alarm", { label, at: Date.now() + ms, repeat: "none", days: null, important });

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

check("avoid.call", "in a call the pet steps aside, nothing rings (alarms are listed for later), ePet is hidden from screen sharing; back ~10 s after, it tells what you missed", async () => {
  const app = ctx.app;
  await reset();
  await stepAside(CALL, "call");
  assert.equal((await status()).protected, true, "left out of screen sharing");
  const tray = await app.menu("tray");
  assert.equal(tray[0], "Show pet");
  assert.ok(tray.includes("Stepped aside: in a call"), JSON.stringify(tray));
  const since = Date.now();
  await addAlarm(1500, "Stand-up notes");
  await app.b.waitUntil(async () => (await app.invoke("list_unseen")).length === 1, { timeout: 10_000 });
  assert.equal(await app.visible("pet"), false, "it doesn't come out");
  assert.ok(!(await app.sounds(since)).some((s) => s.kind === "ring"), "no ring in a call");
  await comeBack();
  await app.waitBubble("While you were busy you missed:", 5000);
  assert.ok((await app.bubble()).includes("Stand-up notes"));
  assert.equal((await status()).protected, false, "back in screenshots");
  await app.answer("Done");
});

check("avoid.important", "an important alarm brings the pet out even in a call, rings in full (also in Quiet), and the pet goes again after Done", async () => {
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
});

check("avoid.fullscreen", "full screen (a game, a video): the pet steps aside, alarms ring unseen and softly at first, ePet stays in screenshots; unanswered, they're told when it's back", async () => {
  const app = ctx.app;
  await reset();
  await stepAside(GAME, "fullscreen");
  assert.equal((await status()).protected, false);
  const since = Date.now();
  await addAlarm(1500, "Pizza");
  await app.b.waitUntil(async () => (await app.sounds(since)).some((s) => s.kind === "ring"), { timeout: 10_000 });
  const ring = (await app.sounds(since)).find((s) => s.kind === "ring");
  assert.equal(ring.rampUp, true, "starts soft");
  assert.equal(await app.visible("pet"), false, "rung without coming out");
  // Rings 3 s; unanswered (no snoozes), it's listed.
  await app.b.waitUntil(async () => (await app.invoke("list_unseen")).length === 1, { timeout: 15_000 });
  await comeBack();
  await app.waitBubble("While you were busy you missed:", 5000);
  await app.answer("Done");
});

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
