import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDataDir, check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const chars = () => join(appDataDir(), "characters");

async function settingsPage() {
  await ctx.app.panel("settings");
  return ctx.app;
}
async function charactersPage() {
  await ctx.app.panel("characters");
  return ctx.app;
}
const cardNames = () => ctx.app.texts(".cards .card strong");
/** Opens the characters folder (writing its guide); the file manager may not open on CI. */
async function openFolder() {
  await ctx.app.invoke("open_user_characters_folder").catch(() => {});
  await ctx.app.sleep(300);
}

check("hidden.settings-warning", "“When hidden, it comes out for”: defaults, and a red warning naming what's off", async () => {
  const app = await settingsPage();
  const boxes = () =>
    app.b.execute(() => Object.fromEntries([...document.querySelectorAll(".hidden-alerts label.check")].map((l) => [l.textContent.trim(), l.querySelector("input").checked])));
  assert.deepEqual(await boxes(), { Alarms: true, Timers: true, "To-do reminders": true, "Focus sessions": false, Anniversaries: true });
  assert.equal(await app.b.execute(() => document.querySelector(".warning")), null);
  // One at a time, as a person clicks (each waits for the panel to save and redraw).
  const toggle = async (name) => {
    await app.b.execute((n) => [...document.querySelectorAll(".hidden-alerts label.check")].find((l) => l.textContent.trim() === n).querySelector("input").click(), name);
    await app.sleep(600);
  };
  await toggle("Alarms");
  await app.waitText(".warning", "While your pet is hidden, alarms will not alert you.");
  await toggle("Timers");
  await app.waitText(".warning", "alarms and timers will not alert you");
  await toggle("To-do reminders");
  await app.waitText(".warning", "alarms, timers and to-do reminders will not alert you");
  for (const n of ["Alarms", "Timers", "To-do reminders"]) await toggle(n);
  await app.until(() => !document.querySelector(".warning"));
  await toggle("Timers");
  await app.until(() => document.querySelector(".warning"));
  assert.equal((await app.settings()).hiddenAlerts.timers, false);
  await toggle("Timers");
});

check("settings.layout", "Settings has its four cards; Focus fits without scrolling; changes stay after switching tabs", async () => {
  const app = await settingsPage();
  const heads = await app.texts("main h3");
  for (const h of ["Pet", "Alarms & timers", "To-do reminders", "General"]) assert.ok(heads.some((x) => x.toLowerCase() === h.toLowerCase()), `${h} in ${heads.join("|")}`);
  // Size, quiet hours, a ringtone: changed, then still there.
  await app.b.execute(() => {
    const r = document.querySelector("main input[type=range]");
    r.value = "1.5";
    r.dispatchEvent(new Event("input", { bubbles: true }));
    r.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await app.sleep(800);
  await app.b.execute(() => {
    const tone = document.querySelector(".box.alert select");
    tone.value = [...tone.options].at(-1).value;
    tone.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await app.sleep(800);
  await app.tab("todos");
  await app.tab("settings");
  const s = await app.settings();
  assert.equal(s.size, 1.5);
  assert.equal(await app.b.execute(() => document.querySelector("main input[type=range]").value), "1.5");
  assert.equal(await app.b.execute(() => document.querySelector(".box.alert select").value), s.alerts.alarm.ringtone);
  // Focus with Work hours on fits the default panel size.
  await app.invoke("set_settings", { settings: { ...s, size: 1, pomodoro: { ...s.pomodoro, workHours: { ...s.pomodoro.workHours, enabled: true } } } });
  await app.tab("focus");
  await app.sleep(500);
  const over = await app.b.execute(() => document.scrollingElement.scrollHeight - window.innerHeight);
  assert.ok(over <= 2, `Focus page scrolls by ${over}px`);
});

check("mood.cards", "each character has a mood card", async () => {
  const app = await charactersPage();
  const n = await app.b.execute(() => document.querySelectorAll(".cards .card").length);
  assert.ok(n >= 2);
  assert.equal(await app.b.execute(() => document.querySelectorAll(".cards .card .mood-card").length), n);
});

check("characters.switch", "switching character and back keeps the first one's mood", async () => {
  const app = await charactersPage();
  // The pet saves the cat's mood as it switches away; switching back and away again finds the same.
  await app.click(".cards .card", "Rooster");
  await app.until(() => document.querySelector(".cards .card.selected")?.textContent.includes("Rooster"));
  assert.equal((await app.settings()).character, "rooster");
  await app.sleep(1000);
  const first = await app.invoke("load_mood", { character: "cat" });
  assert.ok(first, "cat's mood saved on switching");
  await app.click(".cards .card", "Cat");
  await app.until(() => document.querySelector(".cards .card.selected")?.textContent.includes("Cat"));
  assert.equal((await app.settings()).character, "cat");
  await app.sleep(1000);
  await app.click(".cards .card", "Rooster");
  await app.sleep(1000);
  const again = await app.invoke("load_mood", { character: "cat" });
  assert.ok(Math.abs(again.affection - first.affection) < 2 && Math.abs(again.fullness - first.fullness) < 2, JSON.stringify([first, again]));
  await app.click(".cards .card", "Cat");
  await app.sleep(500);
});

check("characters.folder", "the characters folder has a README, the schema and an example; a deleted README comes back, an edited one stays", async () => {
  const app = await charactersPage();
  await openFolder();
  const readme = join(chars(), "README.txt");
  assert.ok(readFileSync(readme, "utf8").includes("Make a copy"));
  assert.ok(existsSync(join(chars(), "character.schema.json")));
  const example = JSON.parse(readFileSync(join(chars(), "example-cat", "character.json.example"), "utf8"));
  assert.equal(example.id, "example-cat");
  assert.ok(!(await cardNames()).some((n) => n.includes("Example")));
  rmSync(readme);
  await openFolder();
  assert.ok(existsSync(readme));
  writeFileSync(readme, "mine");
  await openFolder();
  assert.equal(readFileSync(readme, "utf8"), "mine");
});

check("characters.copy", "“Make a copy” makes cat-copy (then cat-copy-2, “Cat (copy 2)”…) and shows it at once", async () => {
  const app = await charactersPage();
  const copyOf = (name) => app.b.execute((n) => [...document.querySelectorAll(".card-wrap")].find((w) => w.querySelector("strong").textContent === n).querySelector("button.copy").click(), name);
  await copyOf("Cat");
  await app.waitText(".cards .card strong", "Cat (copy) (custom)");
  const json = JSON.parse(readFileSync(join(chars(), "cat-copy", "character.json"), "utf8"));
  assert.deepEqual([json.id, json.displayName, json.$schema], ["cat-copy", "Cat (copy)", "../character.schema.json"]);
  await copyOf("Cat");
  await app.waitText(".cards .card strong", "Cat (copy 2) (custom)");
  assert.ok(existsSync(join(chars(), "cat-copy-2", "character.json")));
  await copyOf("Cat (copy) (custom)");
  await app.until(() => document.querySelectorAll(".cards .card").length >= 5);
  const ids = (await app.invoke("list_user_characters")).map((c) => JSON.parse(c.json).id).sort();
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("cat-copy-3"), ids.join(","));
});

check("characters.reload", "edited character.json applies on Reload (no restart); a broken one is listed with why", async () => {
  const app = await charactersPage();
  await app.click(".cards .card", "Cat (copy)");
  await app.until(() => document.querySelector(".cards .card.selected")?.textContent.includes("Cat (copy)"));
  await app.sleep(1000);
  const picked = (await app.settings()).character;
  const file = join(chars(), picked, "character.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.sprite.palette.o = "#9e9e9e";
  json.sprite.palette.d = "#6d6d6d";
  json.personality.lines.greet = ["Grey and proud."];
  writeFileSync(file, JSON.stringify(json, null, 2));
  await app.click("button.reload", "Reload characters");
  await app.sleep(1500);
  // The pet on the desktop is grey now and greets with the new line.
  await app.toPet();
  const grey = await app
    .until(() => {
      const c = document.getElementById("pet");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] === 0x9e && d[i + 1] === 0x9e && d[i + 2] === 0x9e && d[i + 3] > 200) return true;
      return false;
    }, [], 15_000)
    .catch(() => false);
  assert.ok(grey, "the pet is drawn grey");
  await app.invoke("plugin:event|emit", { event: "pet-command", payload: "greet" });
  await app.waitText(".bubble", "Grey and proud.");
  // Broken JSON: listed on the Characters page, the others still load.
  writeFileSync(file, readFileSync(file, "utf8").replace(`"id": "${picked}",`, `"id": "${picked}"`));
  await charactersPage();
  await app.click("button.reload", "Reload characters");
  await app.waitText("details.issues summary", "1 character(s) could not be loaded");
  assert.match(await app.b.execute(() => document.querySelector("details.issues pre").textContent), new RegExp(`${picked}[\\s\\S]*invalid JSON`));
  assert.equal(await app.b.execute(() => document.querySelector("details.issues").open), true);
  assert.ok((await cardNames()).includes("Cat"));
});
