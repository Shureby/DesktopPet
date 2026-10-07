import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

const year = new Date().getFullYear();
/** Month and day `days` from today. */
function md(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return { month: d.getMonth() + 1, day: d.getDate() };
}
const anniversary = (a) => ({ kind: "birthday", icon: "🎂", since: null, preps: [], effect: true, music: null, name: "Mum", ...md(0), ...a });

/** No anniversaries, to-dos or panel; celebrations of 10 s; music as given. */
async function reset(celebrate = {}) {
  const app = ctx.app;
  await app.toPet();
  if ((await app.menu("tray"))[0] === "Show pet") await app.invoke("e2e_tray", { id: "show" });
  for (const a of await app.invoke("list_anniversaries")) await app.invoke("delete_anniversary", { id: a.id });
  for (const t of await app.invoke("list_todos")) await app.invoke("delete_todo", { id: t.id });
  for (const a of await app.invoke("list_alarms")) await app.invoke("delete_alarm", { id: a.id });
  await app.closeWindow("panel");
  await app.closeWindow("celebrate");
  await app.setSettings((s) => {
    s.celebrate = { enabled: true, seconds: 10, music: false, musicVolume: 0.5, ...celebrate };
    s.hiddenAlerts = { ...s.hiddenAlerts, anniversaries: true };
    s.alerts.alarm = { ...s.alerts.alarm, ring: false, ringSeconds: 30 };
    return s;
  });
  // Whatever was still being celebrated is over.
  await app.until(() => document.getElementById("bubble").hidden, [], 20_000).catch(() => {});
  await app.sleep(2500);
}

/** The effect window's celebration while it is open, else null (the window isn't entered: it may close any moment). */
async function effect() {
  const app = ctx.app;
  await app.toPet();
  const open = await app.invoke("plugin:window|is_visible", { label: "celebrate" }).catch(() => false);
  return open ? (await app.pet()).celebration : null;
}

const preview = (a) => ctx.app.invoke("preview_celebration", { anniversary: anniversary(a) });

check("anniv.preview", "▶ Preview plays the day's celebration at once without saving anything; hidden, the pet comes out; with the effect off it only speaks; a previewed day still celebrates", async () => {
  const app = ctx.app;
  await reset();
  // From the form, unsaved and unnamed: the template's name.
  await app.panel("todos");
  await app.click(".subtabs button", "Anniversaries");
  await app.until(() => document.querySelector(".ann-form"));
  await app.click(".ann-form button.preview", "Preview");
  const said = await app.waitBubble("Happy birthday", 5000);
  assert.match(said, /^🎉 Happy birthday, Birthday!$/);
  await app.b.waitUntil(async () => (await effect())?.anniversary.kind === "birthday", { timeout: 10_000 });
  // The panel still answers.
  await app.toWindow("panel.html");
  await app.click(".subtabs button", "To-dos");
  assert.deepEqual(await app.invoke("list_anniversaries"), []);
  assert.deepEqual(await app.invoke("list_todos"), []);
  // Hidden: it comes out and goes back.
  await reset();
  await app.run("tray", "Hide pet");
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
  await preview({ name: "Ann" });
  await app.b.waitUntil(async () => app.visible("pet"), { timeout: 5000 });
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 40_000 });
  await app.run("tray", "Show pet");
  // On-screen celebrations off: only the line.
  await reset({ enabled: false });
  await preview({ name: "Ann" });
  await app.waitBubble("Happy birthday, Ann!", 5000);
  await app.sleep(2000);
  assert.equal(await effect(), null);
  // A previewed day still gets its real celebration.
  await reset();
  const added = await app.invoke("add_anniversary", { anniversary: anniversary({ name: "Today's" }) });
  await app.invoke("preview_celebration", { anniversary: added });
  await app.waitBubble("Today's", 5000);
  await app.until(() => document.getElementById("bubble").hidden, [], 20_000);
  await app.sleep(2500);
  await app.present();
  await app.waitBubble("Happy birthday, Today's!", 10_000);
}, { timeout: 180_000 });

check("anniv.fireworks", "a birthday's fireworks: “🎉 Happy 36th birthday, …!”, the effect (fireworks, 🎂🎁, balloons) for the set time; on the day it plays once", async () => {
  const app = ctx.app;
  await reset();
  await preview({ name: "Ann", since: year - 36 });
  assert.equal(await app.waitBubble("Happy", 5000), "🎉 Happy 36th birthday, Ann!");
  await app.b.waitUntil(async () => !!(await effect()), { timeout: 10_000 });
  const e = await effect();
  assert.equal(e.seconds, 10);
  assert.equal(e.effect, true);
  // Over after its time: the window and the line.
  const start = Date.now();
  await app.b.waitUntil(async () => !(await effect()), { timeout: 20_000 });
  assert.ok(Date.now() - start < 15_000);
  await app.b.waitUntil(async () => (await app.bubble()) === null || !(await app.bubble()).includes("Happy 36th"), { timeout: 5000 });
  // On the day: once.
  await reset();
  await app.invoke("add_anniversary", { anniversary: anniversary({ name: "Bea", since: year - 30 }) });
  await app.present();
  await app.waitBubble("Happy 30th birthday, Bea!", 10_000);
  await reset();
  await app.present();
  await app.sleep(3000);
  assert.ok(!(await app.bubble())?.includes("Bea"), "not twice");
}, { timeout: 120_000 });

check("anniv.candle", "a remembrance: without the effect a quiet line; with it, the candle, and the pet sits aside facing it", async () => {
  const app = ctx.app;
  await reset();
  const r = { kind: "remembrance", icon: "🕯️", name: "Grandpa", since: year - 7 };
  await preview({ ...r, effect: false });
  assert.equal(await app.waitBubble("Remembering", 5000), "🕯️ Remembering Grandpa today. 7 years");
  await app.sleep(1500);
  assert.equal(await effect(), null);
  assert.notEqual((await app.pet()).state, "happy");
  await reset();
  await preview({ ...r, effect: true });
  await app.waitBubble("Remembering", 5000);
  await app.b.waitUntil(async () => (await effect())?.anniversary.kind === "remembrance", { timeout: 10_000 });
  // It walks aside (it may already be there) and sits, facing the candle in the middle.
  let p;
  await app.b.waitUntil(async () => (p = await app.pet()).state === "vigil", { timeout: 20_000 }).catch(() => {
    throw new Error(`no vigil: ${JSON.stringify({ state: p.state, x: p.x, y: p.y, grounded: p.grounded, target: p.target, vigil: p.vigil, celebrating: p.celebrating })}`);
  });
  const centre = p.area.x + p.area.w / 2;
  assert.ok(Math.abs(p.x - centre) > 160 * p.dpr, `aside, clear of the flowers: ${p.x} vs ${centre}`);
  assert.equal(p.facing, p.x < centre ? 1 : -1, `facing the candle: ${JSON.stringify({ x: p.x, centre, vigil: p.vigil, area: p.area })}`);
}, { timeout: 90_000 });

check("anniv.same-day", "two on one day: the remembrance first, then (after a pause) the birthday, both in full; not again that day", async () => {
  const app = ctx.app;
  await reset({ music: true });
  await app.invoke("add_anniversary", { anniversary: anniversary({ name: "Mum" }) });
  await app.invoke("add_anniversary", { anniversary: anniversary({ kind: "remembrance", icon: "🕯️", name: "Grandpa", effect: true }) });
  const since = Date.now();
  await app.present();
  await app.waitBubble("Remembering Grandpa", 10_000);
  await app.waitBubble("Happy birthday, Mum!", 25_000);
  const music = (await app.sounds(since)).filter((s) => s.kind === "music");
  assert.deepEqual(music.map((m) => m.piece), ["aisi", "birthday"]);
  assert.ok(music[1].at - music[0].at >= 11_000, `in turn, with a pause: ${music[1].at - music[0].at} ms`);
  await reset({ music: true });
  await app.present();
  await app.sleep(3000);
  assert.equal(await app.bubble(), null, "not again");
}, { timeout: 120_000 });

check("anniv.music-play", "with music on, each preview plays its piece; an alarm stops it; it plays with on-screen celebrations off; off, none", async () => {
  const app = ctx.app;
  await reset({ music: true, musicVolume: 0.5 });
  const played = async (a) => {
    const since = Date.now();
    await preview(a);
    await app.sleep(1500);
    const m = (await app.sounds(since)).filter((s) => s.kind === "music");
    await reset({ music: true, musicVolume: 0.5 });
    return m.map((s) => s.piece);
  };
  assert.deepEqual(await played({}), ["birthday"]);
  assert.deepEqual(await played({ kind: "wedding", icon: "💍" }), ["canon"]);
  assert.deepEqual(await played({ kind: "wedding", icon: "💍", music: "mendelssohn" }), ["mendelssohn"]);
  assert.deepEqual(await played({ kind: "wedding", icon: "💍", music: "wagner" }), ["wagner"]);
  assert.deepEqual(await played({ kind: "custom", icon: "⭐", music: "ode" }), ["ode"]);
  assert.deepEqual(await played({ kind: "remembrance", icon: "🕯️" }), ["aisi"]);
  // Its length is the celebration's; the volume the setting's.
  let since = Date.now();
  await preview({});
  await app.sleep(800);
  const m = (await app.sounds(since)).find((s) => s.kind === "music");
  assert.deepEqual([m.seconds, m.volume], [10, 0.5]);
  // A timer ringing stops it.
  await app.addTimer(1, 1500);
  await app.waitBubble("Time's up", 10_000);
  assert.ok((await app.sounds(since)).some((s) => s.kind === "music-stop"));
  await app.answer("Done");
  // Celebrations on screen off: the music still plays. Music off: none.
  await reset({ enabled: false, music: true });
  since = Date.now();
  await preview({});
  await app.sleep(1000);
  assert.ok((await app.sounds(since)).some((s) => s.kind === "music"));
  await reset({ music: false });
  since = Date.now();
  await preview({});
  await app.sleep(1000);
  assert.ok(!(await app.sounds(since)).some((s) => s.kind === "music"));
}, { timeout: 180_000 });

check("anniv.prep-todo", "reminders before an anniversary become a day's to-do (“💍 Name - Buy flowers”) once; one already past isn't made; deleting the anniversary keeps it", async () => {
  const app = ctx.app;
  await reset();
  const a = await app.invoke("add_anniversary", {
    anniversary: anniversary({
      kind: "wedding",
      icon: "💍",
      name: "Us",
      ...md(1),
      preps: [
        { lead: "1d", label: "Buy flowers" },
        { lead: "1w", label: "Book a restaurant" },
      ],
    }),
  });
  await app.b.waitUntil(async () => (await app.invoke("list_todos")).some((t) => t.title === "💍 Us - Buy flowers"), { timeout: 10_000 });
  await app.sleep(3000);
  const list = await app.invoke("list_todos");
  assert.equal(list.filter((t) => t.title === "💍 Us - Buy flowers").length, 1, "once");
  const t = list.find((x) => x.title === "💍 Us - Buy flowers");
  assert.equal(t.allDay, true);
  assert.ok(!list.some((x) => x.title.includes("Book a restaurant")), "already past: not made");
  await app.panel("todos");
  await app.waitText(".todos .list li", "💍 Us - Buy flowers");
  await app.invoke("delete_anniversary", { id: a.id });
  await app.sleep(1000);
  assert.ok((await app.invoke("list_todos")).some((x) => x.id === t.id), "kept");
});

check("anniv.settings", "on-screen off: just the line; the length is 10–60 s; hidden and not coming out it waits for Show pet; coming out it celebrates and goes back", async () => {
  const app = ctx.app;
  await reset();
  // The length: 10–60 s.
  await app.panel("settings");
  const setSeconds = async (v) => {
    await app.panel("settings");
    await app.b.execute((value) => {
      const input = document.querySelector("label.celebrate input[type=number]");
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, v);
    await app.sleep(600);
    return (await app.fullSettings()).celebrate.seconds;
  };
  assert.equal(await setSeconds("5"), 10);
  assert.equal(await setSeconds("90"), 60);
  assert.equal(await setSeconds("10"), 10);
  // Off: no effect, the line only (on the day).
  await reset({ enabled: false });
  await app.invoke("add_anniversary", { anniversary: anniversary({ name: "Cy" }) });
  await app.present();
  await app.waitBubble("Happy birthday, Cy!", 10_000);
  await app.sleep(1500);
  assert.equal(await effect(), null);
  // Hidden, not coming out for anniversaries: it waits until the pet is shown.
  await reset();
  await app.setSettings((s) => ((s.hiddenAlerts.anniversaries = false), s));
  await app.invoke("add_anniversary", { anniversary: anniversary({ name: "Di" }) });
  await app.run("tray", "Hide pet");
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
  await app.present();
  await app.sleep(3000);
  assert.equal(await app.visible("pet"), false, "doesn't come out");
  await app.run("tray", "Show pet");
  await app.present();
  await app.waitBubble("Happy birthday, Di!", 10_000);
  // Coming out for it: out, then back into hiding.
  await reset();
  await app.invoke("add_anniversary", { anniversary: anniversary({ name: "Ed" }) });
  await app.run("tray", "Hide pet");
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
  await app.present();
  await app.b.waitUntil(async () => app.visible("pet"), { timeout: 10_000 });
  await app.waitBubble("Happy birthday, Ed!", 5000);
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 40_000 });
  await app.run("tray", "Show pet");
}, { timeout: 180_000 });
