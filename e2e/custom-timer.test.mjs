import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

const sub = (items, start) => items.find((i) => typeof i !== "string" && i.text.startsWith(start))?.items ?? [];
const timers = async () => (await ctx.app.invoke("list_alarms")).map((a) => a.label);

/** No timers, no saved lengths. */
async function reset() {
  const app = ctx.app;
  await app.toPet();
  for (const a of await app.invoke("list_alarms")) await app.invoke("delete_alarm", { id: a.id });
  await app.setSettings((s) => ({ ...s, recentTimers: [] }));
  await closePrompt();
}

/** Set timer → Custom / Edit…: the bubble asks “How long?”. */
async function openPrompt() {
  const app = ctx.app;
  await app.run("pet", "Set timer", "Custom / Edit…");
  await app.waitText("#bubble:not([hidden])", "How long?");
}

async function closePrompt() {
  await ctx.app.toPet();
  await ctx.app.b.execute(() => document.querySelector('#bubble button[title="Cancel"]')?.click());
  await ctx.app.sleep(300);
}

/** Types into the prompt (as keystrokes would, firing "input"); Enter if asked. */
async function type(value, enter = false) {
  const app = ctx.app;
  await app.toPet();
  await app.b.execute(
    (v, e) => {
      const input = document.querySelector("#bubble input.duration");
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (e) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    },
    value,
    enter,
  );
  await app.sleep(300);
}

const hint = () => ctx.app.b.execute(() => document.querySelector("#bubble .hint")?.textContent ?? null);
const chips = () => ctx.app.b.execute(() => [...document.querySelectorAll("#bubble .saved .chip")].map((c) => c.firstChild.textContent));
const customItems = async () => sub(await ctx.app.menu("pet"), "Set timer").filter((t) => typeof t === "string" && t.endsWith("(custom)"));

check("custom.prompt", "Custom / Edit… asks “How long?” in the bubble, with the box focused", async () => {
  const app = ctx.app;
  await reset();
  await openPrompt();
  assert.equal((await app.pet()).prompting, true);
  assert.equal(await app.b.execute(() => document.activeElement?.matches("#bubble input.duration")), true);
  assert.equal(await hint(), "e.g. 20 · 1:30 · 90s");
  await closePrompt();
});

check("custom.formats", "20, 1:30, 90s, 2.5h, 1h30m are read as they're typed", async () => {
  await reset();
  await openPrompt();
  for (const [input, shown] of [
    ["20", "= 20 min"],
    ["1:30", "= 1 h 30 min"],
    ["90s", "= 1 min 30 s"],
    ["2.5h", "= 2 h 30 min"],
    ["1h30m", "= 1 h 30 min"],
  ]) {
    await type(input);
    assert.equal(await hint(), shown, input);
  }
  await closePrompt();
});

check("custom.invalid", "abc + Enter: “Try 20, 1:30 or 90s” in red; nothing starts", async () => {
  const app = ctx.app;
  await reset();
  await openPrompt();
  await type("abc", true);
  assert.equal(await hint(), "Try 20, 1:30 or 90s");
  assert.equal(await app.b.execute(() => document.querySelector("#bubble .hint").classList.contains("error")), true);
  assert.deepEqual(await timers(), []);
  assert.equal((await app.pet()).prompting, true, "still asking");
  await closePrompt();
});

check("custom.start", "1:30 + Enter starts a 1 h 30 min timer and the pet confirms", async () => {
  const app = ctx.app;
  await reset();
  await openPrompt();
  await type("1:30", true);
  await app.b.waitUntil(async () => (await timers()).includes("Timer: 1 h 30 min"), { timeout: 5000 });
  assert.match(await app.waitBubble("1 h 30 min"), /1 h 30 min/);
});

check("custom.listed", "the length is listed under Set timer as “(custom)”, and starts from there", async () => {
  const app = ctx.app;
  await reset();
  await openPrompt();
  await type("1:30", true);
  await app.b.waitUntil(async () => (await customItems()).length === 1, { timeout: 5000 });
  assert.deepEqual(await customItems(), ["1 h 30 min (custom)"]);
  // Below the separator, above Custom / Edit….
  const menu = sub(await app.menu("pet"), "Set timer");
  assert.deepEqual(menu.slice(-3), ["—", "1 h 30 min (custom)", "Custom / Edit…"]);
  await app.run("pet", "Set timer", "1 h 30 min (custom)");
  await app.b.waitUntil(async () => (await timers()).filter((t) => t === "Timer: 1 h 30 min").length === 2, { timeout: 5000 });
});

check("custom.max-three", "three at most, newest first", async () => {
  const app = ctx.app;
  await reset();
  for (const v of ["12", "17", "22", "27"]) {
    await openPrompt();
    await type(v, true);
    await app.sleep(500);
  }
  await app.b.waitUntil(async () => (await customItems())[0] === "27 min (custom)", { timeout: 5000 });
  assert.deepEqual(await customItems(), ["27 min (custom)", "22 min (custom)", "17 min (custom)"]);
});

check("custom.preset-skip", "a length that is a preset (30) isn't listed", async () => {
  const app = ctx.app;
  await reset();
  await openPrompt();
  await type("30", true);
  await app.b.waitUntil(async () => (await timers()).includes("Timer: 30 min"), { timeout: 5000 });
  assert.deepEqual(await customItems(), []);
});

check("custom.edit", "✎ puts a saved length in the box (“Change X → …”); Enter replaces it in place", async () => {
  const app = ctx.app;
  await reset();
  await app.setSettings((s) => ({ ...s, recentTimers: [27, 22, 17] }));
  await openPrompt();
  assert.deepEqual(await chips(), ["27 min", "22 min", "17 min"]);
  await app.b.execute(() => document.querySelectorAll("#bubble .saved .chip")[1].querySelector('button[title="Change this one"]').click());
  await app.sleep(300);
  assert.equal(await app.b.execute(() => document.querySelector("#bubble input.duration").value), "22");
  assert.equal(await hint(), "Change 22 min → 22 min");
  await type("25");
  assert.equal(await hint(), "Change 22 min → 25 min");
  await app.b.execute(() => document.querySelector("#bubble input.duration").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await app.b.waitUntil(async () => (await customItems())[1] === "25 min (custom)", { timeout: 5000 });
  assert.deepEqual(await customItems(), ["27 min (custom)", "25 min (custom)", "17 min (custom)"]);
  assert.ok((await timers()).includes("Timer: 25 min"));
});

check("custom.forget", "✕ on a saved length forgets it (the bubble and the menu)", async () => {
  const app = ctx.app;
  await reset();
  await app.setSettings((s) => ({ ...s, recentTimers: [27, 22, 17] }));
  await openPrompt();
  await app.b.execute(() => document.querySelectorAll("#bubble .saved .chip")[0].querySelector('button[title="Forget this one"]').click());
  await app.sleep(300);
  assert.deepEqual(await chips(), ["22 min", "17 min"]);
  await app.b.waitUntil(async () => (await customItems()).length === 2, { timeout: 5000 });
  assert.deepEqual(await customItems(), ["22 min (custom)", "17 min (custom)"]);
  await closePrompt();
});

check("custom.cancel", "Esc, ✕, or 45 s untouched close the prompt without starting anything", async () => {
  const app = ctx.app;
  await reset();
  await openPrompt();
  await type("20");
  await app.b.execute(() => document.querySelector("#bubble input.duration").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await app.until(() => document.getElementById("bubble").hidden);
  await openPrompt();
  await type("20");
  await closePrompt();
  await app.until(() => document.getElementById("bubble").hidden);
  assert.equal((await app.pet()).prompting, false);
  // Left alone, it gives up after 45 seconds.
  await openPrompt();
  await type("20");
  await app.sleep(44_000);
  assert.equal((await app.pet()).prompting, true, "still there at 44 s");
  await app.until(() => document.getElementById("bubble").hidden, [], 5000);
  assert.equal((await app.pet()).prompting, false);
  assert.deepEqual(await timers(), []);
});

check("custom.chatter", "while the prompt is open the pet's chatter doesn't replace it", async () => {
  const app = ctx.app;
  await reset();
  await openPrompt();
  await type("20");
  // A greeting (as when the pet is shown) and petting would normally talk.
  await app.invoke("plugin:event|emit", { event: "pet-command", payload: "greet" });
  await app.b.execute(() => window.__epet.care("pet"));
  await app.sleep(1500);
  assert.match(await app.bubble(), /^How long\?/);
  assert.equal(await app.b.execute(() => document.querySelector("#bubble input.duration").value), "20");
  await closePrompt();
});
