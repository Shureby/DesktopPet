import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

/**
 * The lunar date of a Gregorian day, worked out here from the app's table (the other way
 * round from the app, so the two check each other).
 */
const YEARS = [...readFileSync(new URL("../src/features/anniversary/lunar.ts", import.meta.url), "utf8").matchAll(/0x[0-9a-f]{5}/g)].map((m) => Number(m[0]));
const monthDays = (y, m, leap) => (leap ? YEARS[y - 1900] & 0x10000 : YEARS[y - 1900] & (0x10000 >> m)) ? 30 : 29;
const leapOf = (y) => YEARS[y - 1900] & 0xf;
function toLunar(date) {
  let n = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(1900, 0, 31)) / 86_400_000);
  for (let y = 1900; ; y++) {
    for (let m = 1; m <= 12; m++) {
      for (const leap of leapOf(y) === m ? [false, true] : [false]) {
        const len = monthDays(y, m, leap);
        if (n < len) return { year: y, month: m, day: n + 1, leap };
        n -= len;
      }
    }
  }
}

/** The panel on To-dos → 🎂 Anniversaries, with none saved. */
async function page() {
  const app = ctx.app;
  await app.panel("todos");
  for (const a of await app.invoke("list_anniversaries")) await app.invoke("delete_anniversary", { id: a.id });
  if (!(await app.b.execute(() => document.querySelector(".ann-form")))) {
    await app.click(".subtabs button", "Anniversaries");
    await app.until(() => document.querySelector(".ann-form"));
  }
  return app;
}
async function select(css, value) {
  await ctx.app.b.execute(
    (c, v) => {
      const s = document.querySelector(c);
      s.value = v;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    },
    css,
    String(value),
  );
  await ctx.app.sleep(300);
}
async function typeName(name) {
  await ctx.app.b.execute((n) => {
    const i = document.querySelector(".ann-name");
    i.value = n;
    i.dispatchEvent(new Event("input", { bubbles: true }));
  }, name);
}
const rowText = (name) =>
  ctx.app.b.execute((n) => {
    const li = [...document.querySelectorAll(".anniversaries li.ann")].find((x) => x.querySelector(".title")?.textContent === n);
    return li?.querySelector(".sub")?.textContent ?? null;
  }, name);
const saved = async (name) => (await ctx.app.invoke("list_anniversaries")).find((a) => a.name === name);

check("anniv.lunar", "Date → Lunar date: month, day and Leap; “Next: …” says when; listed as “Lunar 8/15 · …”; ✎ fills the form back in", async () => {
  const app = await page();
  await typeName("Grandma");
  await select(".ann-calendar", "lunar");
  await select(".lunar-month", 8);
  await select(".lunar-day", 15);
  const next = await app.b.execute(() => document.querySelector(".ann-next").textContent);
  assert.match(next, /^Next: /);
  await app.click(".ann-form button.primary", "Add");
  await app.waitText(".anniversaries li.ann .sub", "Lunar 8/15");
  const a = await saved("Grandma");
  assert.deepEqual([a.calendar, a.month, a.day, a.leap], ["lunar", 8, 15, false]);
  // Leap: saved as such, listed as "Lunar leap 4/8".
  await typeName("Uncle");
  await select(".ann-calendar", "lunar");
  await select(".lunar-month", 4);
  await select(".lunar-day", 8);
  await app.click(".lunar-leap input");
  await app.click(".ann-form button.primary", "Add");
  await app.waitText(".anniversaries li.ann .sub", "Lunar leap 4/8");
  assert.equal((await saved("Uncle")).leap, true);
  // ✎: back in the form as it was.
  await app.b.execute(() => {
    const li = [...document.querySelectorAll(".anniversaries li.ann")].find((x) => x.querySelector(".title")?.textContent === "Grandma");
    li.querySelector("button.edit[title=Edit]").click();
  });
  await app.sleep(400);
  const f = await app.b.execute(() => ({
    calendar: document.querySelector(".ann-calendar").value,
    month: document.querySelector(".lunar-month").value,
    day: document.querySelector(".lunar-day").value,
    leap: document.querySelector(".lunar-leap input").checked,
  }));
  assert.deepEqual(f, { calendar: "lunar", month: "8", day: "15", leap: false });
  await app.click(".edit-head .link", "Cancel");
});

check("anniv.holidays", "Holiday: picking one fills in its name, icon, day and reminders (Mid-Autumn: Lunar 8/15, Buy mooncakes; Mother's Day: 2nd Sunday of May); no Since", async () => {
  const app = await page();
  await select(".ann-type", "holiday");
  assert.equal(await app.b.execute(() => !!document.querySelector(".ann-form .since")), false, "no Since for a holiday");
  const options = await app.b.execute(() => [...document.querySelectorAll(".ann-holiday option")].map((o) => o.textContent));
  for (const n of ["Lunar New Year", "Mid-Autumn Festival", "Lunar New Year's Eve", "Mother's Day", "Father's Day (Australia, NZ)", "Thanksgiving (US)"])
    assert.ok(options.some((o) => o.endsWith(n)), n);
  await select(".ann-holiday", options.findIndex((o) => o.endsWith("Mid-Autumn Festival")) - 1);
  const f = await app.b.execute(() => ({
    name: document.querySelector(".ann-name").value,
    icon: document.querySelector(".icon-pick").textContent,
    calendar: document.querySelector(".ann-calendar").value,
    month: document.querySelector(".lunar-month")?.value,
    day: document.querySelector(".lunar-day")?.value,
    preps: [...document.querySelectorAll(".ann-form .row.prep input")].map((i) => i.value),
  }));
  assert.deepEqual(f, { name: "Mid-Autumn Festival", icon: "🥮", calendar: "lunar", month: "8", day: "15", preps: ["Buy mooncakes"] });
  await app.click(".ann-form button.primary", "Add");
  await app.waitText(".anniversaries li.ann .sub", "Lunar 8/15");
  const mid = await saved("Mid-Autumn Festival");
  assert.deepEqual([mid.kind, mid.calendar, mid.since, mid.music], ["holiday", "lunar", null, "festive"]);
  // A day of the week.
  await select(".ann-type", "holiday");
  const opts = await app.b.execute(() => [...document.querySelectorAll(".ann-holiday option")].map((o) => o.textContent));
  await select(".ann-holiday", opts.findIndex((o) => o.endsWith("Mother's Day")) - 1);
  await app.click(".ann-form button.primary", "Add");
  await app.waitText(".anniversaries li.ann .sub", "2nd Sunday of May");
  const m = await saved("Mother's Day");
  assert.deepEqual([m.calendar, m.month, m.nth, m.weekday], ["weekday", 5, 2, 0]);
});

check("anniv.weekday", "Date → Day of the week: “Last Monday of May” saved and listed; Next is that day", async () => {
  const app = await page();
  await typeName("Memorial");
  await select(".ann-calendar", "weekday");
  await select(".wd-nth", -1);
  await select(".wd-day", 1);
  await select(".wd-month", 5);
  await app.click(".ann-form button.primary", "Add");
  await app.waitText(".anniversaries li.ann .sub", "Last Monday of May");
  const a = await saved("Memorial");
  assert.deepEqual([a.calendar, a.month, a.nth, a.weekday], ["weekday", 5, -1, 1]);
  // Its day in the list is a Monday in late May.
  const sub = await rowText("Memorial");
  assert.match(sub, /Mon, May (2[5-9]|3[01])/);
});

check("anniv.lunar-celebrate", "a lunar birthday whose day is tomorrow: its reminder to-do comes today, and the next day (test clock) the pet celebrates it", async () => {
  const app = ctx.app;
  await app.closeWindow("panel");
  for (const a of await app.invoke("list_anniversaries")) await app.invoke("delete_anniversary", { id: a.id });
  for (const t of await app.invoke("list_todos")) await app.invoke("delete_todo", { id: t.id });
  await app.setSettings((s) => ({ ...s, celebrate: { ...s.celebrate, enabled: false, seconds: 10, music: false } }));
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const l = toLunar(tomorrow);
  await app.invoke("add_anniversary", {
    anniversary: {
      kind: "birthday",
      icon: "🎂",
      name: "Mum",
      calendar: "lunar",
      month: l.month,
      day: l.day,
      leap: l.leap,
      since: null,
      preps: [{ lead: "1d", label: "Order a cake" }],
      effect: false,
      music: null,
    },
  });
  // The day before: the cake.
  await app.b.waitUntil(async () => (await app.invoke("list_todos")).some((t) => t.title === "🎂 Mum - Order a cake"), { timeout: 10_000 });
  await app.present();
  await app.sleep(3000);
  assert.ok(!(await app.bubble())?.includes("Happy birthday, Mum"), "not today");
  // Tomorrow.
  await app.toPet();
  const shift = await app.invoke("shift_clock", { ms: 24 * 3_600_000 });
  try {
    await app.sleep(2500);
    await app.present();
    await app.waitBubble("Happy birthday, Mum!", 15_000);
  } finally {
    await app.invoke("shift_clock", { ms: -shift });
  }
}, { timeout: 90_000 });
