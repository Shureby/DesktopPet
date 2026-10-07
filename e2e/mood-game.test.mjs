import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

/** A bundled character's lines for `key`. */
const lines = (character, key) =>
  JSON.parse(readFileSync(new URL(`../assets/characters/${character}/character.json`, import.meta.url), "utf8")).personality.lines[key];

/** The game window's state (window.__epetGame), with the game window current. */
async function game() {
  await ctx.app.toWindow("game.html");
  await ctx.app.b.waitUntil(() => ctx.app.b.execute(() => !!window.__epetGame), { timeout: 10_000 });
  return ctx.app.b.execute(() => window.__epetGame.state);
}

/** A key pressed (and released after `holdMs`) in the game window. */
async function key(code, holdMs = 50) {
  await ctx.app.toWindow("game.html");
  await ctx.app.b.execute((c) => window.dispatchEvent(new KeyboardEvent("keydown", { code: c, key: c, bubbles: true })), code);
  await ctx.app.sleep(holdMs);
  await ctx.app.b.execute((c) => window.dispatchEvent(new KeyboardEvent("keyup", { code: c, key: c, bubbles: true })), code);
}

async function closeGame() {
  // Closing it tells the pet the game ended (the app does, as for any close).
  await ctx.app.closeWindow("game");
}

check("mood.start", "a new character starts content (about 60%) and doesn't turn grumpy on its own", async () => {
  const app = ctx.app;
  const first = (await app.pet()).mood;
  assert.ok(Math.abs(first.affection - 60) < 2, JSON.stringify(first));
  await app.sleep(5000);
  const later = (await app.pet()).mood;
  assert.ok(later.affection > 55, JSON.stringify(later));
});

check("mood.care", "petting floats “+3 ♥”; too much petting gets “That's plenty for now”", async () => {
  const app = ctx.app;
  await app.toPet();
  const before = (await app.pet()).mood.affection;
  await app.b.execute(() => window.__epet.care("pet"));
  await app.until(() => [...document.querySelectorAll(".gain")].some((g) => g.textContent.includes("+3 ♥")), [], 3000);
  assert.ok((await app.pet()).mood.affection >= before + 2.9);
  const enough = lines("cat", "enough");
  let said = null;
  for (let i = 0; i < 8 && !said; i++) {
    await app.b.execute(() => window.__epet.care("pet"));
    await app.sleep(300);
    const b = await app.bubble();
    if (b && enough.some((l) => b.includes(l))) said = b;
  }
  assert.ok(said, "the pet says it has had enough");
});

check("mood.full", "fed until full: fullness tops out, and feeding again gets a reaction", async () => {
  const app = ctx.app;
  await app.toPet();
  for (let i = 0; i < 4; i++) {
    await app.b.execute(() => window.__epet.care("feed"));
    await app.sleep(300);
  }
  const m = (await app.pet()).mood;
  assert.ok(m.fullness > 90, JSON.stringify(m));
  const full = lines("cat", "full");
  await app.b.execute(() => window.__epet.care("feed"));
  await app.sleep(400);
  const said = await app.bubble();
  assert.ok(said && full.some((l) => said.includes(l)), `reacts: ${said}`);
});

check("game.open", "Play Safe Landing opens the game; the pet window keeps going", async () => {
  const app = ctx.app;
  await app.run("pet", "Play Safe Landing");
  const g = await game();
  assert.equal(g.phase, "intro");
  const before = (await app.pet()).frames;
  await app.sleep(1000);
  assert.ok((await app.pet()).frames > before, "the pet window still runs");
});

check("game.controls", "← → / A D steer; Space or Enter starts", async () => {
  const app = ctx.app;
  await key("Space");
  assert.equal((await game()).phase, "playing");
  const x0 = (await game()).x;
  await key("ArrowLeft", 400);
  const x1 = (await game()).x;
  assert.ok(x1 < x0, `left: ${x0} → ${x1}`);
  await key("KeyD", 400);
  const x2 = (await game()).x;
  assert.ok(x2 > x1, `right: ${x1} → ${x2}`);
  // Enter starts too (after a restart from the result screen, see game.finish).
  await closeGame();
  await app.run("pet", "Play Safe Landing");
  await game();
  await key("Enter");
  assert.equal((await game()).phase, "playing");
});

check("game.finish", "after a round: R plays again; the round made the pet happier", async () => {
  const app = ctx.app;
  const before = (await app.pet()).mood.affection;
  await app.toWindow("game.html");
  await app.until(() => window.__epetGame.state.phase === "result", [], 90_000);
  await key("KeyR");
  assert.equal((await game()).phase, "playing");
  await closeGame();
  await app.toPet();
  const after = (await app.pet()).mood.affection;
  assert.ok(after > before, `affection ${before} → ${after}`);
}, { timeout: 150_000 });

check("game.abilities", "Cat grabs ☂ to slow down; Rooster holds Space to glide (the hints say so)", async () => {
  const app = ctx.app;
  await app.run("pet", "Play Safe Landing");
  assert.ok((await game()).controls.includes("Grab ☂ umbrellas to slow down"));
  await closeGame();
  await app.run("pet", "Switch character", "Rooster");
  await app.b.waitUntil(async () => (await app.pet()).character === "rooster", { timeout: 5000 });
  await app.run("pet", "Play Safe Landing");
  assert.ok((await game()).controls.some((c) => c.startsWith("Hold Space to glide")));
  await closeGame();
  await app.run("pet", "Switch character", "Cat");
});

check("pet.idle", "left alone it walks, sits, runs or sleeps on its own, without script errors", async () => {
  const app = ctx.app;
  const seen = new Set();
  const until = Date.now() + 45_000;
  while (Date.now() < until && seen.size < 3) {
    seen.add((await app.pet()).state);
    await app.sleep(500);
  }
  assert.ok(seen.size >= 2, `states: ${[...seen].join(", ")}`);
  assert.deepEqual(await app.b.execute(() => window.__epet.errors), []);
});
