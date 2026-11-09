import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

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
  // Each way from a new round, briefly (held longer, the pet may crash into something).
  for (const [code, sign] of [["ArrowLeft", -1], ["KeyD", 1]]) {
    if (code !== "ArrowLeft") {
      await closeGame();
      await app.run("pet", "Play Safe Landing");
      await game();
      await key("Space");
    }
    const x0 = (await game()).x;
    await key(code, 300);
    const g = await game();
    assert.ok(Math.sign(g.x - x0) === sign, `${code}: ${x0} → ${g.x} (${g.phase}, ${g.status})`);
  }
  // Enter starts too (after a restart from the result screen, see game.finish).
  await closeGame();
  await app.run("pet", "Play Safe Landing");
  await game();
  await key("Enter");
  assert.equal((await game()).phase, "playing");
});

check("game.finish", "after a round: R plays again", async () => {
  const app = ctx.app;
  // A round from the start (the last one may already be over).
  if ((await game()).phase === "result") await key("KeyR");
  assert.equal((await game()).phase, "playing");
  await app.toWindow("game.html");
  await app.until(() => window.__epetGame.state.phase === "result", [], 90_000);
  await key("KeyR");
  assert.equal((await game()).phase, "playing");
  await closeGame();
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
  // Woken first (at night it may sleep for minutes): then it carries on by itself.
  await app.b.execute(() => window.__epet.care("pet"));
  const seen = new Set();
  const until = Date.now() + 90_000;
  while (Date.now() < until && seen.size < 2) {
    const s = (await app.pet()).state;
    if (s !== "happy") seen.add(s);
    await app.sleep(500);
  }
  assert.ok(seen.size >= 2 || (seen.size === 1 && !seen.has("happy")), `states: ${[...seen].join(", ")}`);
  const frames = (await app.pet()).frames;
  await app.sleep(1000);
  assert.ok((await app.pet()).frames > frames + 10, "keeps animating");
  assert.deepEqual(await app.b.execute(() => window.__epet.errors), []);
}, { timeout: 120_000 });
