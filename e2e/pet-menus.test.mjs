import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const MIN = 60_000;

/** Items of a menu (or of one of its submenus) as plain texts. */
const texts = (items) => items.map((i) => (typeof i === "string" ? i : i.text));
const sub = (items, start) => items.find((i) => typeof i !== "string" && i.text.startsWith(start))?.items ?? [];

/** Nothing running and no panel: a clean start for each test. */
async function reset() {
  const app = ctx.app;
  await app.toPet();
  for (const a of await app.invoke("list_alarms")) await app.invoke("delete_alarm", { id: a.id });
  await app.invoke("pomodoro_stop");
  await app.closeWindow("panel");
  await app.closeWindow("game");
  if (!(await app.visible("pet"))) await app.invoke("e2e_tray", { id: "show" });
  await app.sleep(500);
}

/** The pet keeps going: its simulation runs (the state machine and position move on). */
async function petIsAlive() {
  const app = ctx.app;
  const before = (await app.pet()).frames;
  await app.sleep(1000);
  return (await app.pet()).frames > before + 10;
}

check("menu.add-todo", "Add to-do… opens the panel on To-dos, ready to type; the pet keeps going", async () => {
  const app = ctx.app;
  await reset();
  await app.run("pet", "Add to-do…");
  assert.equal(await app.panelTab(), "todos");
  await app.until(() => document.activeElement?.matches("input"));
  assert.ok(await petIsAlive(), "the pet moves on");
});

check("menu.set-alarm", "Set alarm… opens Alarms with the time field focused", async () => {
  const app = ctx.app;
  await reset();
  await app.run("pet", "Set alarm…");
  assert.equal(await app.panelTab(), "alarms");
  const focused = await app
    .until(() => document.activeElement?.closest(".time-field") && document.activeElement.outerHTML.slice(0, 80))
    .catch(async () => {
      throw new Error(`focus is on ${await app.b.execute(() => document.activeElement?.outerHTML.slice(0, 120))}`);
    });
  assert.ok(focused);
});

check("menu.open-panel-tab", "Open panel… opens what runs out first: a timer (Alarms) or focus (Focus); else the default", async () => {
  const app = ctx.app;
  await reset();
  await app.addTimer(5, 5 * MIN);
  await app.invoke("pomodoro_start");
  await app.sleep(500);
  for (const menu of ["pet", "tray"]) {
    await app.closeWindow("panel");
    await app.run(menu, "Open panel…");
    assert.equal(await app.panelTab(), "alarms", `${menu}: the timer ends first`);
  }
  for (const a of await app.invoke("list_alarms")) await app.invoke("delete_alarm", { id: a.id });
  await app.sleep(500);
  for (const menu of ["pet", "tray"]) {
    await app.closeWindow("panel");
    await app.run(menu, "Open panel…");
    assert.equal(await app.panelTab(), "focus", `${menu}: only focus`);
  }
  await app.invoke("pomodoro_stop");
  await app.sleep(500);
  await app.closeWindow("panel");
  await app.run("pet", "Open panel…");
  assert.equal(await app.panelTab(), "todos", "nothing running: the default tab");
});

check("menu.hide", "Hide pet hides it; the tray's first item follows (Show pet / Hide pet); Show pet brings it back", async () => {
  const app = ctx.app;
  await reset();
  assert.equal((await app.menu("tray"))[0], "Hide pet");
  await app.run("pet", "Hide pet");
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
  await app.b.waitUntil(async () => (await app.menu("tray"))[0] === "Show pet", { timeout: 5000 });
  await app.run("tray", "Show pet");
  await app.b.waitUntil(async () => app.visible("pet"), { timeout: 5000 });
  await app.b.waitUntil(async () => (await app.menu("tray"))[0] === "Hide pet", { timeout: 5000 });
  // And from the tray.
  await app.run("tray", "Hide pet");
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
  await app.run("tray", "Show pet");
  await app.b.waitUntil(async () => app.visible("pet"), { timeout: 5000 });
});

check("tray.actions", "the tray's items do what the pet menu's do", async () => {
  const app = ctx.app;
  await reset();
  await app.run("tray", "Add to-do…");
  assert.equal(await app.panelTab(), "todos");
  await app.closeWindow("panel");
  await app.run("tray", "Set alarm…");
  assert.equal(await app.panelTab(), "alarms");
  await app.closeWindow("panel");
  await app.run("tray", "Set timer", "5 min");
  await app.b.waitUntil(async () => (await app.invoke("list_alarms")).some((a) => a.label === "Timer: 5 min"), { timeout: 5000 });
  await app.run("tray", "Switch character", "Rooster");
  await app.b.waitUntil(async () => (await app.pet()).character === "rooster", { timeout: 5000 });
  await app.run("tray", "Switch character", "Cat");
  await app.b.waitUntil(async () => (await app.pet()).character === "cat", { timeout: 5000 });
  await app.run("tray", "Play Safe Landing");
  await app.toWindow("game.html");
  await app.closeWindow("game");
  await app.run("tray", "Open panel…");
  assert.equal(await app.panelTab(), "alarms", "a timer is running");
});

check("tray.live-state", "with a timer and a focus session both menus say Cancel timer (rings …) and Stop focus session (ends …)", async () => {
  const app = ctx.app;
  await reset();
  const timer = await app.addTimer(5, 5 * MIN);
  const focus = await app.invoke("pomodoro_start");
  await app.sleep(800);
  const rings = await app.clock(timer.nextFire);
  const ends = await app.clock(focus.endsAt);
  for (const menu of ["pet", "tray"]) {
    const items = texts(await app.menu(menu));
    assert.ok(items.includes(`Cancel timer: 5 min (rings ${rings})`), `${menu}: ${items.join(" | ")}`);
    assert.ok(items.includes(`Stop focus session (ends ${ends})`), `${menu}: ${items.join(" | ")}`);
  }
  await app.run("tray", "Cancel timer");
  await app.run("tray", "Stop focus session");
  await app.sleep(800);
  for (const menu of ["pet", "tray"]) {
    const items = texts(await app.menu(menu));
    assert.ok(!items.some((t) => t.startsWith("Cancel timer")), `${menu}: ${items.join(" | ")}`);
    assert.ok(items.includes("Start focus session 🍅"), `${menu}: ${items.join(" | ")}`);
  }
});

check("tray.custom-hidden", "with the pet hidden, Set timer → Custom / Edit… opens the Alarms tab", async () => {
  const app = ctx.app;
  await reset();
  await app.run("tray", "Hide pet");
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
  await app.run("tray", "Set timer", "Custom / Edit…");
  assert.equal(await app.panelTab(), "alarms");
  const pet = await app.pet();
  assert.equal(pet.prompting, false, "no prompt in a hidden pet's bubble");
  await app.run("tray", "Show pet");
  // The submenu's presets, the same in both menus.
  assert.deepEqual(texts(sub(await app.menu("tray"), "Set timer")), texts(sub(await app.menu("pet"), "Set timer")));
});
