import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

/** The panel on To-dos → 🎂 Anniversaries. */
async function page() {
  const app = ctx.app;
  await app.panel("todos");
  if (!(await app.b.execute(() => document.querySelector(".ann-form")))) {
    await app.click(".subtabs button", "Anniversaries");
    await app.until(() => document.querySelector(".ann-form"));
  }
  return app;
}
const list = () => ctx.app.invoke("list_anniversaries");
async function clearAll() {
  for (const a of await list()) await ctx.app.invoke("delete_anniversary", { id: a.id });
}
function add(a) {
  return ctx.app.invoke("add_anniversary", { anniversary: { kind: "birthday", icon: "🎂", since: null, preps: [], effect: true, music: null, ...a } });
}
/** Month and day `days` from today. */
function md(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return { month: d.getMonth() + 1, day: d.getDate() };
}
async function chooseType(kind) {
  await ctx.app.b.execute((k) => {
    const s = document.querySelector(".ann-form select.ann-type");
    s.value = k;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }, kind);
  await ctx.app.sleep(300);
}
const form = () =>
  ctx.app.b.execute(() => ({
    icon: document.querySelector(".ann-form .icon-pick").textContent,
    preps: [...document.querySelectorAll(".ann-form .row.prep")].map((r) => `${r.querySelector("select.lead").selectedOptions[0].textContent}: ${r.querySelector("input").value}`),
    effectText: document.querySelector(".ann-form label.check").textContent.trim(),
    effect: document.querySelector(".ann-form label.check input").checked,
    music: document.querySelector(".ann-form .fixed-music")?.textContent ?? null,
    musicOptions: [...document.querySelectorAll(".ann-form select.ann-music option")].map((o) => o.value),
    musicChoice: document.querySelector(".ann-form select.ann-music")?.value ?? null,
    musicOff: document.querySelector(".ann-form .fixed-music, .ann-form select.ann-music")?.parentElement.textContent.includes("off in Settings") ?? false,
    addMore: !!document.querySelector(".ann-form .add-more"),
  }));

check("anniv.subpages", "To-dos opens on its list; 🎂 Anniversaries shows a count within 7 days", async () => {
  const app = ctx.app;
  await app.panel("todos");
  await clearAll();
  const tabs = await app.texts(".subtabs button");
  assert.deepEqual(tabs, ["To-dos", "🎂 Anniversaries"]);
  assert.equal(await app.b.execute(() => document.querySelector(".subtabs button.on").textContent), "To-dos");
  await add({ name: "Soon", ...md(3) });
  await add({ name: "Far", ...md(40) });
  await app.waitText(".subtabs button .n", "1");
  await page();
  assert.ok(await app.b.execute(() => document.querySelector(".subtabs button.on").textContent.includes("Anniversaries")));
});

check("anniv.form", "types fill in the icon, reminders and effect; what was changed by hand stays", async () => {
  const app = await page();
  await chooseType("birthday");
  let f = await form();
  assert.equal(f.icon, "🎂");
  assert.deepEqual(f.preps, ["1 week: Buy a gift", "1 day: Order a cake"]);
  assert.match(f.effectText, /^Fireworks on the day/);
  assert.equal(f.effect, true);
  await chooseType("remembrance");
  f = await form();
  assert.equal(f.icon, "🕯️");
  assert.deepEqual(f.preps, ["1 day: Buy flowers"]);
  assert.match(f.effectText, /^Candle and flowers on the day/);
  assert.equal(f.effect, false);
  await chooseType("wedding");
  assert.equal((await form()).icon, "💍");
  // The icon grid: 20 icons, the chosen one marked.
  await app.click(".ann-form .icon-pick");
  assert.equal(await app.b.execute(() => document.querySelectorAll(".icon-grid button").length), 20);
  await app.click(".icon-grid button", "🍾");
  assert.equal((await form()).icon, "🍾");
  // A reminder changed by hand, then another type: both stay.
  await app.type(".ann-form .row.prep input", "Book the bistro");
  await chooseType("dating");
  f = await form();
  assert.equal(f.icon, "🍾");
  assert.ok(f.preps.some((p) => p.endsWith("Book the bistro")), f.preps.join("|"));
});

check("anniv.add-list", "added ones are listed soonest first with their years and reminders; Feb 29; up to 3 reminders", async () => {
  const app = await page();
  await clearAll();
  const year = new Date().getFullYear();
  await add({ name: "Mum", ...md(0), since: year - 36, preps: [{ lead: "1d", label: "Order a cake" }] });
  await add({ name: "Us", kind: "wedding", icon: "💍", ...md(1), since: year - 10 });
  await add({ name: "Grandpa", kind: "remembrance", icon: "🕯️", ...md(40), since: year - 7, effect: false });
  await app.waitText("li.ann .title", "Grandpa");
  assert.deepEqual(await app.texts("li.ann .title"), ["Mum", "Us", "Grandpa"]);
  const subs = await app.texts("li.ann .sub");
  assert.match(subs[0], /· Today 🎉 · 36th$/);
  assert.match(subs[1], /· Tomorrow · 10th$/);
  assert.match(subs[2], /· in 40 days · 7 years$/);
  assert.ok(await app.b.execute(() => document.querySelectorAll("li.ann .sub .soon").length === 2));
  assert.match(await app.text("li.ann .preps"), /1 day before: Order a cake/);
  // Feb 29 can be picked in the date field (no year).
  await chooseType("custom");
  await app.press(".ann-form .date-field .part.month", ["2"]);
  await app.press(".ann-form .date-field .part.day", ["2", "9"]);
  assert.equal(await app.b.execute(() => document.querySelector(".ann-form .date-field .part.day").textContent), "29");
  assert.equal(await app.b.execute(() => document.querySelector(".ann-form .date-field .part.year")), null);
  // Reminders: "+ Add another" goes once there are 3.
  while ((await form()).preps.length < 3) await app.click(".ann-form .add-more");
  assert.equal((await form()).addMore, false);
  // Saved from the form.
  await app.type(".ann-form input.ann-name", "Leap");
  await app.click(".ann-form .row.end button.primary", "Add");
  await app.waitText("li.ann .title", "Leap");
  const leap = (await list()).find((a) => a.name === "Leap");
  assert.deepEqual([leap.month, leap.day], [2, 29]);
});

check("anniv.music-form", "Music: Birthday fixed; Wedding three to pick; others by mood; “off in Settings”", async () => {
  const app = await page();
  await chooseType("birthday");
  let f = await form();
  assert.equal(f.music, "🎵 Happy Birthday");
  assert.equal(f.musicOff, true);
  await chooseType("pet");
  assert.equal((await form()).music, "🎵 Happy Birthday");
  await chooseType("wedding");
  f = await form();
  assert.deepEqual([f.musicOptions, f.musicChoice], [["canon", "mendelssohn", "wagner"], "canon"]);
  await chooseType("work");
  f = await form();
  assert.equal(f.musicOptions.length, 8);
  assert.equal(f.musicChoice, "waltz");
  await chooseType("remembrance");
  f = await form();
  assert.deepEqual([f.musicOptions, f.musicChoice], [["aisi", "chopin", "taps", "reflection"], "aisi"]);
  // Dating → Wedding March, then Wedding: kept; Waltz then Wedding: back to the Canon.
  const pick = (v) =>
    app.b.execute((x) => {
      const s = document.querySelector(".ann-form select.ann-music");
      s.value = x;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }, v);
  await chooseType("dating");
  await pick("mendelssohn");
  await chooseType("wedding");
  assert.equal((await form()).musicChoice, "mendelssohn");
  await chooseType("dating");
  await pick("waltz");
  await chooseType("wedding");
  assert.equal((await form()).musicChoice, "canon");
  // Saved and edited: the choice stays.
  await chooseType("work");
  await pick("jasmine");
  await app.type(".ann-form input.ann-name", "Joined");
  await app.click(".ann-form .row.end button.primary", "Add");
  await app.waitText("li.ann .title", "Joined");
  const joined = (await list()).find((a) => a.name === "Joined");
  assert.equal(joined.music, "jasmine");
  await app.b.execute(() => [...document.querySelectorAll("li.ann")].find((li) => li.textContent.includes("Joined")).querySelector("button[title=Edit]").click());
  await app.until(() => document.querySelector(".ann-form select.ann-music")?.value === "jasmine");
  // With music on in Settings, "off in Settings" goes.
  await app.invoke("set_settings", { settings: { ...(await app.settings()), celebrate: { enabled: true, seconds: 15, music: true, musicVolume: 0.5 } } });
  await app.tab("alarms");
  await page();
  assert.equal((await form()).musicOff, false);
});
