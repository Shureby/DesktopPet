import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

/** The 24 Points window current; what its board shows (window.__epet24.state). */
async function board() {
  await ctx.app.toWindow("twenty-four.html");
  await ctx.app.b.waitUntil(() => ctx.app.b.execute(() => !!window.__epet24), {
    timeout: 10_000,
  });
  return ctx.app.b.execute(() => window.__epet24.state);
}

/** Runs a test hook in the 24 Points window. */
async function hook(name, ...args) {
  await board();
  await ctx.app.b.execute((n, a) => window.__epet24[n](...a), name, args);
  await ctx.app.sleep(200);
}

/** Clicks card i (0–3) or an operator ("+", "−", "×", "÷") as a player would. */
async function tap(...what) {
  await board();
  for (const w of what) {
    if (typeof w === "number")
      await ctx.app.b.execute(
        (i) => document.querySelectorAll(".t24-card")[i].click(),
        w,
      );
    else
      await ctx.app.b.execute(
        (s) =>
          [...document.querySelectorAll(".t24-ops button")]
            .find((b) => b.textContent === s)
            .click(),
        w,
      );
    await ctx.app.sleep(120);
  }
}

/** Sets the options from the ⚙ page and starts a new round in `mode`. */
async function options({ hands, unsolvable, level }, mode) {
  const app = ctx.app;
  await board();
  await app.click(".t24-icon", "⚙");
  if (hands)
    await app.b.execute(
      (v) => document.querySelector(`input[name=hands][value=${v}]`).click(),
      hands,
    );
  if (unsolvable !== undefined)
    await app.b.execute((on) => {
      const c = document.querySelector("input[name=unsolvable]");
      if (c.checked !== on) c.click();
    }, unsolvable);
  if (level)
    await app.b.execute(
      (v) => document.querySelector(`input[name=level][value=${v}]`).click(),
      level,
    );
  await app.click(".t24-actions button.primary");
  if (mode) await app.click(`.t24-tabs button[data-mode=${mode}]`);
}

async function open24() {
  await ctx.app.run("pet", "Play 24 Points");
  return board();
}

async function close24() {
  await ctx.app.closeWindow("game");
}

check(
  "t24.open",
  "Play 24 Points opens a small board with the pet standing on its top right; the desktop pet steps away until it closes",
  async () => {
    const app = ctx.app;
    const s = await open24();
    assert.equal(s.mode, "race");
    assert.equal(s.phase, "playing");
    assert.equal(s.cards.length, 4);
    const [w, h] = await app.b.execute(() => [
      window.innerWidth,
      window.innerHeight,
    ]);
    assert.ok(w <= 520 && h <= 700, `a board, not the whole screen: ${w}×${h}`);
    // Its pet is drawn on the strip above the board.
    assert.ok(
      await app.b.execute(() => document.getElementById("t24-pet").width > 0),
    );
    assert.equal((await app.pet()).hidden, true, "the desktop pet steps away");
    await close24();
    await app.b.waitUntil(async () => (await app.pet()).hidden === false, {
      timeout: 5000,
    });
  },
);

check(
  "t24.solve",
  "cards and signs make a new card (8 ÷ 3 = 8/3); four cards to 24 scores; a wrong total says so and Undo takes a move back",
  async () => {
    const app = ctx.app;
    await open24();
    await options({ level: "easy" }, "practice");
    await hook("deal", [1, 2, 3, 4]);
    // The new card stays picked: a sign and the next card carry on from it.
    await tap(0, "×", 1);
    let s = await board();
    assert.equal(s.cards[1].text, "2");
    assert.equal(s.cards[0].used, true);
    await tap("+", 2, "+", 3);
    s = await board();
    assert.match(s.message, /not 24/);
    await app.click(".t24-actions button", "Undo");
    await app.click(".t24-actions button", "Undo");
    s = await board();
    assert.deepEqual(
      s.cards.map((c) => c.used),
      [true, false, false, false],
    );
    await tap(1, "×", 2, "×", 3);
    s = await board();
    assert.equal(s.you, 1);
    assert.match(s.message, /24! \+1/);
    // Fractions stay exact.
    await hook("deal", [3, 3, 8, 8]);
    await tap(2, "÷", 0);
    assert.equal((await board()).cards[0].text, "8/3");
    await close24();
  },
);

check(
  "t24.help",
  "“I can't get it” in practice: the pet comes over, gives the first step (its cards marked), then the next, then the answer; the hand scores 0; a hard hand says it needs fractions",
  async () => {
    const app = ctx.app;
    await open24();
    await options({}, "practice");
    await hook("deal", [3, 3, 8, 8]);
    let s = await board();
    assert.equal(s.kind, "hard");
    assert.ok((await app.text(".t24-note")).includes("fractions"));
    await app.click(".t24-actions button.primary", "I can't get it");
    s = await board();
    assert.equal(s.hint, 1);
    assert.equal(s.pose, "help");
    assert.match(s.bubble, /Watch me: first 8 ÷ 3 = 8\/3/);
    assert.equal((await app.texts(".t24-card.hinted")).length, 2);
    await app.click(".t24-actions button.primary", "Show the next step");
    assert.equal((await board()).hint, 2);
    await app.click(".t24-actions button.primary", "Show the next step");
    s = await board();
    assert.equal(s.phase, "over");
    assert.match(s.message, /8 ÷ \(3 − 8 ÷ 3\) = 24/);
    assert.equal(s.you, 0);
    await close24();
  },
);

check(
  "t24.race",
  "vs the pet: it paces while thinking, settles down 3 s before it answers (“answers in 3 s”), then answers and scores; you first: your point",
  async () => {
    const app = ctx.app;
    await open24();
    await options({ level: "strong" }, "race");
    await hook("deal", [1, 2, 3, 4]);
    let s = await board();
    assert.equal(s.petState, "thinking");
    assert.equal(s.pose, "think");
    await hook("petReady");
    s = await board();
    assert.equal(s.petState, "ready");
    assert.equal(s.pose, "ready");
    assert.ok((await app.text(".t24-clock-text")).includes("answers in"));
    await hook("petNow");
    s = await board();
    assert.equal(s.pet, 1);
    assert.equal(s.phase, "over");
    assert.match(s.bubble, /= 24!/);
    await hook("deal", [1, 2, 3, 4]);
    await tap(0, "×", 1, "×", 2, "×", 3);
    s = await board();
    assert.equal(s.you, 1);
    assert.match(s.bubble, /You got it first/);
    await close24();
  },
);

check(
  "t24.round",
  "a round is 13 hands, never the same four numbers twice (suits don't count); at the end the result shows and the pet is happier",
  async () => {
    const app = ctx.app;
    await app.toPet();
    const before = (await app.pet()).mood.affection;
    await open24();
    await options({ level: "strong" }, "race");
    const keys = [];
    for (let i = 0; i < 13; i++) {
      const s = await board();
      keys.push(s.key);
      await hook("petNow");
      await app.click(".t24-actions button.primary");
    }
    assert.equal(new Set(keys).size, 13, keys.join(" "));
    const s = await board();
    assert.equal(s.phase, "done");
    assert.ok((await app.text(".t24-result h2")).includes("wins"));
    await close24();
    await app.b.waitUntil(
      async () => (await app.pet()).mood.affection > before,
      { timeout: 5000 },
    );
  },
  { timeout: 150_000 },
);

check(
  "t24.no-answer",
  "“Mix in hands with no answer” adds “No answer!”: right +1, wrong −1 (then it's off for that hand); off, it isn't there",
  async () => {
    const app = ctx.app;
    await open24();
    await options({ unsolvable: false }, "practice");
    assert.equal((await app.texts(".t24-none")).length, 0);
    await options({ unsolvable: true }, "practice");
    await hook("deal", [1, 1, 1, 1]);
    await app.click(".t24-none");
    let s = await board();
    assert.equal(s.you, 1);
    await hook("deal", [1, 2, 3, 4]);
    await app.click(".t24-none");
    s = await board();
    assert.equal(s.you, 0);
    assert.match(s.message, /There is an answer/);
    assert.equal(
      await app.b.execute(() => document.querySelector(".t24-none").disabled),
      true,
    );
    await options({ unsolvable: false });
    await close24();
  },
);

check(
  "t24.modes",
  "Timed: a 2-minute clock, then the result; Daily: one hand a day, the same for everyone, then “a new hand comes tomorrow”",
  async () => {
    const app = ctx.app;
    await open24();
    await app.click(".t24-tabs button[data-mode=timed]");
    assert.ok((await app.text(".t24-clock-text")).includes("s left"));
    await hook("timeUp");
    assert.equal((await board()).phase, "done");
    assert.ok(
      (await app.text(".t24-result h2")).includes("solved in 2 minutes"),
    );
    await app.click(".t24-tabs button[data-mode=daily]");
    const first = await board();
    assert.equal(first.mode, "daily");
    await app.click(".t24-actions button.primary", "I can't get it");
    for (let i = 0; i < 3 && (await board()).phase === "playing"; i++)
      await app.click(".t24-actions button.primary");
    await app.click(".t24-actions button.primary");
    assert.equal((await board()).phase, "done");
    assert.ok((await app.text(".t24-result")).includes("tomorrow"));
    // Back today: the result, not the hand again.
    await close24();
    await open24();
    await app.click(".t24-tabs button[data-mode=daily]");
    assert.equal((await board()).phase, "done");
    await close24();
  },
);
