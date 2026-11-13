/**
 * Pet Crossing (src/features/games/crossing, docs/INTERACTIONS.md "Pet Crossing"): the pet
 * hops up the board, level after level. The lanes are set as a test needs them
 * (window.__epetCrossing.rig), since which way they run is drawn by lot.
 */
import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

/** The game's window current; what it shows (window.__epetCrossing.state). */
async function game() {
  await ctx.app.toWindow("crossing.html");
  await ctx.app.b.waitUntil(() => ctx.app.b.execute(() => !!window.__epetCrossing), { timeout: 10_000 });
  return ctx.app.b.execute(() => window.__epetCrossing.state);
}

/** Runs a test hook in the game's window. */
async function hook(name, ...args) {
  await game();
  await ctx.app.b.execute((n, a) => window.__epetCrossing[n](...a), name, args);
}

/** A key pressed in the game's window (by its place on the keyboard: "KeyW", "ArrowUp", "Space"…). */
async function key(code, repeat = false) {
  await ctx.app.toWindow("crossing.html");
  await ctx.app.b.execute((c, r) => window.dispatchEvent(new KeyboardEvent("keydown", { code: c, key: c, repeat: r, bubbles: true, cancelable: true })), code, repeat);
  await ctx.app.sleep(60);
}

const until = (fn, timeout = 8000) => ctx.app.b.waitUntil(async () => fn(await game()), { timeout, interval: 150 });

/** Opens the game; the tests click around in other windows, which mustn't pause it. */
async function open() {
  await ctx.app.run("pet", "Play Pet Crossing");
  const s = await game();
  await hook("pauseOnBlur", false);
  return s;
}

/** A game begun, the lanes standing still: nothing on the road, the river covered. */
async function begin(rig = { road: "clear", river: "bridge" }) {
  await hook("start");
  await hook("rig", rig);
  return game();
}

/** Hops up to the goal (from the start). */
async function cross() {
  for (let i = 0; i < 10; i++) await key("ArrowUp");
}

const close = () => ctx.app.closeWindow("game");

check("cross.open", "Play Pet Crossing opens a small window on its start screen (Normal, Cute); the pet is in the game, so it's off the desktop, and back when the game closes", async () => {
  const app = ctx.app;
  const s = await open();
  assert.equal(s.screen, "start");
  assert.deepEqual(s.options, { level: "normal", theme: "cute", sounds: true, music: true });
  const [w, h] = await app.b.execute(() => [window.innerWidth, window.innerHeight]);
  assert.ok(w <= 480 && h <= 760 && h > w, `a small upright window: ${w}×${h}`);
  assert.match(await app.text(".xg-start"), /Pet Crossing.*Cat hops up one cell at a time.*Difficulty.*Easy.*Normal.*Won't go easy.*Theme.*Cute.*Traffic.*Office.*Random.*Music.*On.*Off.*Sound effects.*On.*Off.*Start/s);
  // What the keys do, under the board.
  assert.match(await app.text(".xg-keys"), /move \(back too\).*Space.*forward.*Esc.*pause/s);
  assert.match(await app.text(".xg-pad .up"), /W \/ Space/);
  assert.equal((await app.pet()).hidden, true);
  await close();
  await app.b.waitUntil(async () => (await app.pet()).hidden === false, { timeout: 5000 });
  // In the main window's Games tab too.
  await app.panel("games");
  await app.waitText(".games", "Pet Crossing");
  await app.closeWindow("panel");
});

check("cross.start", "the start screen: difficulty and theme are picked there and remembered; Start, Space or Enter begins: level 1, three lives, the clock running", async () => {
  const app = ctx.app;
  await open();
  await app.click(".xg-chips button[data-level=easy]");
  await app.click(".xg-chips button[data-theme=office]");
  let s = await game();
  assert.deepEqual([s.options.level, s.options.theme], ["easy", "office"]);
  assert.equal(s.theme, "office", "the board behind shows it");
  await close();
  s = await open();
  assert.deepEqual([s.options.level, s.options.theme], ["easy", "office"], "remembered");
  assert.equal(await app.b.execute(() => document.querySelector(".xg-chips button.selected[data-level]").dataset.level), "easy");
  await key("Space");
  s = await game();
  assert.equal(s.screen, "play");
  assert.deepEqual([s.level, s.lives, s.score, s.row, s.x], [1, 3, 0, 10, 4]);
  // Easy: 55 seconds a level, running down.
  assert.ok(s.time > 50 && s.time <= 55, `time ${s.time}`);
  await app.waitText(".xg-level", "Level 1");
  assert.equal(await app.text(".xg-lives"), "♥♥♥");
  assert.match(await app.text(".xg-sub"), /Theme: Office/);
  await app.sleep(1200);
  assert.ok((await game()).time < s.time, "the clock runs");
  // Back to Normal and Cute for the tests after this one.
  await key("Escape");
  await app.click(".xg-settings");
  await app.click(".xg-chips button[data-level=normal]");
  await app.click(".xg-chips button[data-theme=cute]");
  await key("Enter");
  assert.equal((await game()).screen, "play");
  await close();
});

check("cross.move", "arrow keys and W A S D hop one cell (back too), Space hops forward, a held key doesn't run; the pad's buttons do the same; each new row scores the level's number, once", async () => {
  const app = ctx.app;
  await open();
  await begin();
  for (const code of ["ArrowUp", "KeyW", "Space"]) await key(code);
  let s = await game();
  assert.deepEqual([s.row, s.x, s.score], [7, 4, 3]);
  await key("ArrowUp", true);
  assert.equal((await game()).row, 7, "held: no more hops");
  for (const code of ["ArrowLeft", "KeyA", "ArrowDown", "KeyS", "ArrowRight", "KeyD", "KeyD"]) await key(code);
  s = await game();
  assert.deepEqual([s.row, s.x, s.score], [9, 5, 3]);
  // Up the same rows again: nothing more.
  await key("KeyW");
  await key("KeyW");
  assert.equal((await game()).score, 3);
  // The pad.
  for (const dir of ["up", "left", "left", "down", "right"]) {
    await app.click(`.xg-pad button[data-go=${dir}]`);
    await app.sleep(60);
  }
  s = await game();
  assert.deepEqual([s.row, s.x, s.score], [7, 4, 4]);
  await app.waitText(".xg-score", "4");
  // The edges hold.
  for (let i = 0; i < 12; i++) await key("KeyA");
  assert.equal((await game()).x, 0);
  await close();
});

check("cross.lives", "bumped on the road, a missed step at the river, or the time running out: a banner says which, a life goes, the pet starts the level again with the clock full; the third ends the game with its score (kept as the best), and Play again starts over", async () => {
  const app = ctx.app;
  await open();
  await begin({ road: "wall", river: "bridge" });
  await key("ArrowUp");
  await key("ArrowUp");
  await until((s) => s.phase === "dead");
  let s = await game();
  assert.deepEqual([s.cause, s.lives], ["hit", 2]);
  await app.waitText(".xg-banner", "Bumped! −1 life");
  await until((s) => s.phase === "playing" && s.row === 10);
  assert.equal(await app.text(".xg-lives"), "♥♥♡");
  // The river with nothing to stand on.
  await hook("rig", { road: "clear", river: "gap" });
  for (let i = 0; i < 7; i++) await key("ArrowUp");
  await until((s) => s.phase === "dead");
  s = await game();
  assert.deepEqual([s.cause, s.lives, s.row], ["fell", 1, 3]);
  await app.waitText(".xg-banner", "Missed your footing! −1 life");
  await until((s) => s.phase === "playing" && s.row === 10);
  assert.ok((await game()).time > 38, "the clock is full again");
  const score = (await game()).score;
  assert.equal(score, 7, "seven rows reached, each once");
  // The time.
  await hook("rig", { time: 0.4 });
  await until((s) => s.screen === "over");
  s = await game();
  assert.deepEqual([s.cause, s.lives, s.best], ["time", 0, score]);
  assert.match(await app.text(".xg-over"), /Game over.*Reached level 1 · Score 7.*A new best!.*Play again.*Change settings/s);
  const top = await app.invoke("top_scores", { game: "crossing", limit: 1 });
  assert.equal(top[0]?.score, score);
  await app.click(".xg-again");
  s = await game();
  assert.deepEqual([s.screen, s.level, s.lives, s.score], ["play", 1, 3, 0]);
  await app.waitText(".xg-sub", `Best ${score}`);
  await close();
}, { timeout: 120_000 });

check("cross.levels", "the goal reached: the seconds left × the level are added and the next level begins (faster, the clock full); after level 20 the pet asks about endless levels: “Let's go!” plays on (level 21 · endless), “Stop here” ends the game", async () => {
  const app = ctx.app;
  await open();
  let s = await begin();
  await cross();
  s = await game();
  assert.equal(s.phase, "won");
  const bonus = s.score - 10;
  assert.ok(bonus >= 28 && bonus <= 40, `the seconds left: ${bonus}`);
  await app.waitText(".xg-banner", `Level 1 done! +${bonus}`);
  await until((s) => s.level === 2 && s.phase === "playing");
  s = await game();
  assert.deepEqual([s.row, s.lives, s.score], [10, 3, 10 + bonus]);
  assert.ok(s.time > 39, "the clock is full again");
  // Level 2: a row is worth 2.
  await hook("rig", { road: "clear", river: "bridge" });
  await key("ArrowUp");
  assert.equal((await game()).score, 12 + bonus);
  // The last level.
  await hook("rig", { level: 20 });
  await cross();
  await until((s) => s.screen === "cleared");
  assert.match(await app.text(".xg-cleared"), /All 20 levels done!.*Cat asks: one more round\? Endless levels, faster and faster\..*Let's go!.*Stop here/s);
  await app.click(".xg-endless");
  s = await game();
  assert.deepEqual([s.screen, s.level, s.endless, s.lives], ["play", 21, true, 3]);
  await app.waitText(".xg-level", "Level 21 · endless");
  // Endless: no more asking.
  await hook("rig", { road: "clear", river: "bridge" });
  await cross();
  await until((s) => s.level === 22 && s.phase === "playing");
  // Another game, stopped after level 20.
  await begin();
  await hook("rig", { level: 20 });
  await cross();
  await until((s) => s.screen === "cleared");
  await app.click(".xg-stop");
  s = await game();
  assert.equal(s.screen, "over");
  assert.match(await app.text(".xg-over"), /Well played!.*Reached level 20/s);
  await close();
}, { timeout: 120_000 });

check("cross.themes", "the theme you picked stays for the whole game (Cute: the fish nest; Traffic: the other side; Office: the slacking spot); Random is another one each level", async () => {
  const app = ctx.app;
  await open();
  for (const [theme, name] of [["traffic", "Traffic"], ["office", "Office"], ["cute", "Cute"]]) {
    await app.click(`.xg-chips button[data-theme=${theme}]`);
    await begin();
    await cross();
    await until((s) => s.level === 2 && s.phase === "playing");
    assert.equal((await game()).theme, theme);
    await app.waitText(".xg-sub", `Theme: ${name}`);
    await key("Escape");
    await app.click(".xg-settings");
  }
  await app.click(".xg-chips button[data-theme=random]");
  await begin();
  const seen = new Set();
  for (let level = 1; level <= 6; level++) {
    const s = await game();
    seen.add(s.theme);
    await app.waitText(".xg-sub", "Theme: Random → ");
    await hook("rig", { road: "clear", river: "bridge" });
    await cross();
    await until((n) => n.level === level + 1 && n.phase === "playing");
    assert.notEqual((await game()).theme, s.theme, "another one each level");
  }
  assert.ok(seen.size >= 2);
  await key("Escape");
  await app.click(".xg-settings");
  await app.click(".xg-chips button[data-theme=cute]");
  await close();
}, { timeout: 180_000 });

check("cross.pause", "Esc (or ⏸) pauses: the clock and the lanes stop, nothing moves; Continue (or Esc) counts “3, 2, 1” and plays on; clicking another window pauses too; a ringing timer pauses it and the pet comes out to ring, answered it plays on; – minimizes and pauses", async () => {
  const app = ctx.app;
  await open();
  await begin();
  await key("Escape");
  let s = await game();
  assert.deepEqual(s.paused, { reason: "you", counting: false });
  assert.match(await app.text(".xg-overlay"), /Paused.*Continue.*Change settings/s);
  await app.sleep(1000);
  assert.equal((await game()).time, s.time, "the clock stands");
  await key("ArrowUp");
  assert.equal((await game()).row, 10, "no hops while paused");
  await app.click(".xg-continue");
  assert.equal((await game()).paused?.counting, true);
  await app.waitText(".xg-overlay", "Back to it in");
  await until((n) => n.paused === null, 6000);
  await key("ArrowUp");
  assert.equal((await game()).row, 9);
  // ⏸, and Esc to go on.
  await app.click(".xg-pause");
  assert.equal((await game()).paused?.reason, "you");
  await key("Escape");
  await until((n) => n.paused === null, 6000);
  // Another window clicked.
  await hook("pauseOnBlur", true);
  await app.b.execute(() => window.dispatchEvent(new Event("blur")));
  assert.equal((await game()).paused?.reason, "you");
  await hook("pauseOnBlur", false);
  await key("Escape");
  await until((n) => n.paused === null, 6000);
  // A timer rings: the pet comes out to ring, the game waits.
  await app.addTimer(1, 1500);
  await app.waitBubble("Time's up", 10_000);
  await until((n) => n.paused?.reason === "ring", 5000);
  assert.ok((await app.text(".xg-overlay")).includes("ringing"));
  assert.equal((await app.pet()).hidden, false);
  await app.answer("Done");
  await until((n) => n.paused?.counting === true, 5000);
  await until((n) => n.paused === null, 6000);
  // Minimized.
  await app.click(".t24-icon", "–");
  assert.equal((await game()).paused?.reason, "minimized");
  const minimized = await app.invoke("plugin:window|is_minimized", { label: "game" });
  if (minimized || process.platform !== "linux") {
    await hook("restore");
    await until((n) => n.paused === null, 8000);
  }
  await close();
}, { timeout: 120_000 });

check("cross.sound", "sounds for a start, a hop, a bump, a level done and the game's end; each theme's music plays while the game is played and stops while it's paused or over; Music and Sound effects are switched on the start screen or with ♪ and 🔔 in the head, and remembered", async () => {
  const app = ctx.app;
  await open();
  const heard = async () => {
    await game();
    return app.b.execute(() => window.__epetSounds.splice(0).map((s) => `${s.kind}:${s.id ?? s.piece}`));
  };
  await heard();
  await begin();
  await key("ArrowUp");
  await until((s) => s.music === "cute");
  assert.deepEqual(await heard(), ["crossing:start", "music:waltz", "crossing:hop"]);
  // Paused: the music stops; on again after "3, 2, 1".
  await key("Escape");
  await until((s) => s.music === null);
  assert.deepEqual(await heard(), ["music-stop:waltz"]);
  await key("Escape");
  await until((s) => s.paused === null && s.music === "cute", 6000);
  assert.deepEqual(await heard(), ["music:waltz"]);
  // The goal, and the next level.
  await cross();
  assert.ok((await heard()).includes("crossing:level"));
  await until((s) => s.level === 2 && s.phase === "playing");
  // A bump, and the end.
  await hook("rig", { road: "wall", lives: 1 });
  await key("ArrowUp");
  await key("ArrowUp");
  await until((s) => s.screen === "over");
  const end = await heard();
  assert.ok(end.includes("crossing:bump") && end.includes("crossing:over") && end.includes("music-stop:waltz"), end.join());
  // Another theme, another piece.
  await app.click(".xg-settings");
  await app.click(".xg-chips button[data-theme=office]");
  await begin();
  await until((s) => s.music === "office");
  assert.ok((await heard()).includes("music:canon"));
  // ♪ off: it stops, and stays off; 🔔 off: no more sounds.
  await app.click(".xg-music");
  await until((s) => s.music === null);
  assert.equal(await app.b.execute(() => document.querySelector(".xg-music").getAttribute("aria-label")), "Music: off");
  await app.click(".xg-sound");
  await heard();
  await key("ArrowUp");
  await app.sleep(300);
  assert.deepEqual(await heard(), []);
  await close();
  const s = await open();
  assert.deepEqual([s.options.music, s.options.sounds], [false, false], "remembered");
  assert.equal(await app.b.execute(() => document.querySelector(".xg-chips button.selected[data-music]").dataset.music), "off");
  // Back on (and Cute) for the tests after this one.
  await app.click(".xg-chips button[data-music=on]");
  await app.click(".xg-chips button[data-sounds=on]");
  await app.click(".xg-chips button[data-theme=cute]");
  assert.deepEqual((await game()).options, { level: "normal", theme: "cute", sounds: true, music: true });
  await close();
}, { timeout: 120_000 });
