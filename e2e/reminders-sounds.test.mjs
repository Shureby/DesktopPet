import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check, clearOfMidnight, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const MIN = 60_000;

const lines = (key) =>
  JSON.parse(readFileSync(new URL("../assets/characters/cat/character.json", import.meta.url), "utf8")).personality.lines[key];
const todos = () => ctx.app.invoke("list_todos");
/** Local midnight `days` from today. */
function day(days = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}
/** "HH:MM" `ms` from now. */
function hm(ms) {
  const d = new Date(Date.now() + ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function reset(todo = {}) {
  const app = ctx.app;
  await app.toPet();
  await app.b.execute(() => [...document.querySelectorAll("#bubble .actions button")].find((b) => /Done|Later/.test(b.textContent))?.click());
  for (const t of await todos()) await app.invoke("delete_todo", { id: t.id });
  for (const a of await app.invoke("list_alarms")) await app.invoke("delete_alarm", { id: a.id });
  await app.invoke("pomodoro_stop");
  await app.closeWindow("panel");
  await app.setSettings((s) => {
    s.alerts.todo = { ...s.alerts.todo, ring: true, ringtone: "chime", volume: 0.5, petRuns: false, ...todo };
    s.sound = true;
    // Well away from now, so no day reminder comes unasked.
    s.todoDayTime = hm(-3 * 60 * MIN);
    return s;
  });
  await app.until(() => document.getElementById("bubble").hidden || !document.querySelector("#bubble .actions"), [], 15_000).catch(() => {});
}

check("todo.remind", "a to-do comes due: reminded once, with the to-do reminder's sound", async () => {
  const app = ctx.app;
  await reset();
  const since = Date.now();
  await app.invoke("add_todo", { todo: { title: "Water the plants", allDay: false, repeat: "none", dueAt: Date.now() + 2000 } });
  await app.waitBubble("Water the plants", 10_000);
  assert.deepEqual(await app.texts("#bubble .actions button"), ["✓ Done", "Later"]);
  await app.sleep(4000);
  const rang = (await app.sounds(since)).filter((s) => s.kind === "ringtone");
  assert.deepEqual(rang.map((s) => s.id), ["chime"], "once, with the set tone");
  await app.answer("✓ Done");
  await app.b.waitUntil(async () => (await todos()).find((t) => t.title === "Water the plants")?.done, { timeout: 5000 });
});

check("todo.day-remind", "to-dos without a time: one bubble “📅 Today: • … • …” at the day's time (late too); Later reminds again in 10 min, same day; one alone is a normal reminder", async () => {
  const app = ctx.app;
  // A minute ago must be today.
  await clearOfMidnight();
  await reset();
  const a = await app.invoke("add_todo", { todo: { title: "Bins", allDay: true, repeat: "none", dueAt: day(0) } });
  const b = await app.invoke("add_todo", { todo: { title: "Pay bills", allDay: true, repeat: "none", dueAt: day(0) } });
  // The day's reminder time a minute ago (ePet opened late: still reminded that day).
  await app.setSettings((s) => ((s.todoDayTime = hm(-MIN)), s));
  const said = await app.waitBubble("📅 Today:", 10_000);
  assert.match(said, /^📅 Today: • (Bins • Pay bills|Pay bills • Bins)$/);
  assert.deepEqual(await app.texts("#bubble .actions button"), ["Open To-dos", "Later"]);
  await app.answer("Later");
  // Not again right away (in 10 minutes: the store's tests check that), and still on its day.
  await app.sleep(5000);
  assert.ok(!(await app.bubble())?.startsWith("📅 Today:"));
  for (const id of [a.id, b.id]) {
    const t = (await todos()).find((x) => x.id === id);
    assert.equal(t.allDay, true, "still a day's to-do");
    assert.equal(t.dueAt, day(0), "same day");
  }
  // One alone: a normal reminder with ✓ Done.
  await reset();
  await app.invoke("add_todo", { todo: { title: "Gym", allDay: true, repeat: "none", dueAt: day(0) } });
  await app.setSettings((s) => ((s.todoDayTime = hm(-MIN)), s));
  await app.waitBubble("Gym", 10_000);
  assert.deepEqual(await app.texts("#bubble .actions button"), ["✓ Done", "Later"]);
  await app.answer("✓ Done");
}, { timeout: 360_000 });

check("todo.feedback", "adding a to-do in the panel: the pet confirms; ticking it: praise and more love", async () => {
  const app = ctx.app;
  await reset();
  await app.panel("todos");
  await app.type(".todos input[type=text]", "Buy milk");
  await app.press(".todos input[type=text]", ["Enter"]);
  const noted = await app.waitBubble("Buy milk");
  assert.ok(lines("noted").some((l) => noted.startsWith(l.split("{")[0])), noted);
  const before = (await app.pet()).mood.affection;
  await app.panel("todos");
  await app.b.execute(() => [...document.querySelectorAll(".todos .list li")].find((li) => li.textContent.includes("Buy milk")).querySelector("input[type=checkbox]").click());
  await app.toPet();
  await app.b.waitUntil(
    async () => {
      const b = (await app.bubble()) ?? "";
      return lines("praise").some((l) => b.includes(l));
    },
    { timeout: 5000 },
  );
  assert.ok((await app.pet()).mood.affection > before);
});

check("settings.size-speed", "the Size and Speed sliders apply at once", async () => {
  const app = ctx.app;
  await reset();
  const before = await app.pet();
  await app.panel("settings");
  const slide = (i, v) =>
    app.b.execute(
      (index, value) => {
        const r = document.querySelectorAll("main input[type=range]")[index];
        r.value = value;
        r.dispatchEvent(new Event("input", { bubbles: true }));
        r.dispatchEvent(new Event("change", { bubbles: true }));
      },
      i,
      v,
    );
  await slide(0, "2");
  await app.sleep(800);
  await slide(1, "1.5");
  await app.sleep(800);
  const after = await app.pet();
  assert.ok(after.size.w > before.size.w * 1.5, `bigger: ${before.size.w} → ${after.size.w}`);
  assert.equal(after.speed, 1.5);
  await app.setSettings((s) => ({ ...s, size: 1, speed: 1 }));
});

check("settings.ringtones", "each of the six ringtones plays from ▶", async () => {
  const app = ctx.app;
  await reset();
  await app.panel("settings");
  const ids = await app.b.execute(() => [...document.querySelector(".box.alert select").options].map((o) => o.value));
  assert.equal(ids.length, 6);
  const since = Date.now();
  for (const id of ids) {
    await app.b.execute((v) => {
      const box = document.querySelector(".box.alert");
      box.querySelector("select").value = v;
      box.querySelector("button[title=Preview]").click();
    }, id);
    await app.sleep(300);
  }
  const played = (await app.sounds(since)).filter((s) => s.kind === "ringtone");
  assert.deepEqual(played.map((s) => s.id), ids);
  assert.ok(played.every((s) => s.known));
});

check("settings.other-sounds", "Other sounds off: no petting or focus sounds; on: both", async () => {
  const app = ctx.app;
  await reset();
  const tryAll = async () => {
    const since = Date.now();
    await app.toPet();
    await app.b.execute(() => window.__epet.care("pet"));
    await app.invoke("pomodoro_start");
    await app.sleep(1500);
    await app.invoke("pomodoro_stop");
    await app.sleep(500);
    return (await app.sounds(since)).map((s) => s.kind);
  };
  await app.setSettings((s) => ({ ...s, sound: false }));
  const off = await tryAll();
  assert.ok(!off.includes("pop") && !off.includes("chime"), off.join(","));
  await app.setSettings((s) => ({ ...s, sound: true }));
  const on = await tryAll();
  assert.ok(on.includes("pop") && on.includes("chime"), on.join(","));
});
