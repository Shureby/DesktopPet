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
async function options({ hands, unsolvable, level, sounds }, mode) {
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
  if (sounds !== undefined)
    await app.b.execute((on) => {
      const c = document.querySelector("input[name=sounds]");
      if (c.checked !== on) c.click();
    }, sounds);
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

/** Waits until the desktop pet stands on the board's window. */
async function onTheBoard(timeout = 20_000) {
  await ctx.app.b
    .waitUntil(async () => (await ctx.app.pet()).board?.on === true, {
      timeout,
    })
    .catch(async () => {
      const p = await ctx.app.pet();
      throw new Error(
        `not on the board: ${p.state} ${JSON.stringify(p.support)} ${JSON.stringify(p.board)}`,
      );
    });
}

async function close24() {
  await ctx.app.closeWindow("game");
}

check(
  "t24.open",
  "Play 24 Points opens a small board; the desktop pet itself gets up onto it and sits at its top right, quiet (another character picked meanwhile goes up too); it stays out when the game closes",
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
    assert.ok(w <= 520 && h <= 720, `a board, not the whole screen: ${w}×${h}`);
    // The desktop pet, not a copy: out, on the board's window, near its right end.
    await onTheBoard();
    const p = await app.pet();
    assert.equal(p.hidden, false);
    const board = p.windows.find((x) => x.id === "epet-board");
    assert.ok(
      p.x > board.x + board.w / 2,
      `at its right end: ${p.x} on ${board.x}…${board.x + board.w}`,
    );
    assert.equal(Math.round(p.y), Math.round(board.y));
    // Another character picked meanwhile: it goes up onto the board too, and the tab says so.
    await app.run("pet", "Switch character", "Rooster");
    await app.b.waitUntil(
      async () => (await app.pet()).character === "rooster",
      { timeout: 5000 },
    );
    await onTheBoard();
    await board();
    await app.b.waitUntil(
      () =>
        app.b.execute(() =>
          document
            .querySelector(".t24-tabs button[data-mode=race]")
            .textContent.includes("Rooster"),
        ),
      { timeout: 5000 },
    );
    await app.run("pet", "Switch character", "Cat");
    await app.b.waitUntil(async () => (await app.pet()).character === "cat", {
      timeout: 5000,
    });
    await onTheBoard();
    await close24();
    await app.b.waitUntil(async () => (await app.pet()).board === null, {
      timeout: 5000,
    });
    assert.equal((await app.pet()).hidden, false);
  },
);

check(
  "t24.pause",
  "an alarm or timer ringing (anything the pet asks): the game pauses (veil, cards blurred) and the pet rings on the board; answered, “3, 2, 1” and on; “Keep playing” goes on at once",
  async () => {
    const app = ctx.app;
    await open24();
    await options({ level: "easy" }, "race");
    await onTheBoard();
    await app.addTimer(1, 1500);
    await app.waitBubble("Time's up", 10_000);
    await app.b.waitUntil(
      async () => (await board()).paused?.reason === "ring",
      { timeout: 5000 },
    );
    assert.ok((await app.text(".t24-pause")).includes("ringing"));
    assert.equal(
      await app.b.execute(() =>
        document.querySelector(".t24-body").classList.contains("paused"),
      ),
      true,
    );
    // It rang where it sits.
    assert.equal((await app.pet()).support?.id, "epet-board");
    await app.answer("Done");
    await app.b.waitUntil(
      async () => (await board()).paused?.counting === true,
      { timeout: 5000 },
    );
    await app.b.waitUntil(async () => (await board()).paused === null, {
      timeout: 6000,
    });
    // Keep playing: on at once, even while it still rings.
    await app.addTimer(1, 1500);
    await app.waitBubble("Time's up", 10_000);
    await app.b.waitUntil(
      async () => (await board()).paused?.reason === "ring",
      { timeout: 5000 },
    );
    await app.click(".t24-pause button", "Keep playing");
    await app.b.waitUntil(async () => (await board()).paused === null, {
      timeout: 6000,
    });
    await app.answer("Done");
    await close24();
  },
  { timeout: 120_000 },
);

check(
  "t24.minimize",
  "– minimizes the board and pauses the game: the pet falls off as off any window; back from the taskbar, it goes up again and “3, 2, 1”, on",
  async () => {
    const app = ctx.app;
    await open24();
    await onTheBoard();
    await board();
    await app.click(".t24-icon", "–");
    assert.equal((await board()).paused?.reason, "minimized");
    const minimized = await app.invoke("plugin:window|is_minimized", {
      label: "game",
    });
    if (!minimized && process.platform === "linux") {
      // (Xvfb without a window manager can't minimize: the pause is all there is to see.)
      await close24();
      return;
    }
    await app.b.waitUntil(
      async () =>
        (await app.pet()).board?.on === false && (await app.pet()).grounded,
      { timeout: 8000 },
    );
    await hook("restore");
    await app.b.waitUntil(async () => (await board()).paused === null, {
      timeout: 8000,
    });
    await onTheBoard();
    await close24();
  },
  { timeout: 120_000 },
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
    assert.match(s.message, /Got it! \+1/);
    // Fractions stay exact.
    await hook("deal", [3, 3, 8, 8]);
    await tap(2, "÷", 0);
    assert.equal((await board()).cards[0].text, "8/3");
    await close24();
  },
);

check(
  "t24.feedback",
  "one line per move; the last one green ✓ (a ding-dong) or red ✗ (a boop) with Undo and Start over picked out; a right answer waits for Next; the sounds can be turned off",
  async () => {
    const app = ctx.app;
    await open24();
    await options({ sounds: true }, "race");
    const sounds = () =>
      app.b.execute(() =>
        window.__epetSounds.filter((x) => x.kind === "answer").map((x) => x.id),
      );
    // 6 7 Q 4 the long way round: 7 × 4 = 28, 28 − Q = 16, 16 + 6 = 22.
    await hook("deal", [6, 7, 12, 4]);
    await tap(1, "×", 3);
    assert.deepEqual(await app.texts(".t24-line"), [
      "7 × 4 = 28",
      "28 ▍ Pick a sign",
    ]);
    await tap("−", 2, "+", 0);
    assert.deepEqual(await app.texts(".t24-line"), [
      "7 × 4 = 28",
      "28 − Q = 16",
      "16 + 6 = 22 ✗",
    ]);
    assert.equal((await app.texts(".t24-line.wrong")).length, 1);
    assert.match(await app.text(".t24-msg"), /Makes 22, not 24/);
    assert.equal((await app.texts(".t24-actions button.warn")).length, 2);
    assert.deepEqual(await sounds(), ["wrong"]);
    // Start over: the four cards again.
    await app.click(".t24-actions button", "Start over");
    assert.deepEqual(
      (await board()).cards.map((c) => c.used),
      [false, false, false, false],
    );
    assert.equal(
      (await app.texts(".t24-line")).length,
      1,
      "only the “Pick a card…” line",
    );
    // 7 − 4 = 3, 6 ÷ 3 = 2, 2 × Q = 24.
    await tap(1, "−", 3, 0, "÷", 3, "×", 2);
    assert.deepEqual(await app.texts(".t24-line"), [
      "7 − 4 = 3",
      "6 ÷ 3 = 2",
      "2 × Q = 24 ✓",
    ]);
    assert.match(await app.text(".t24-msg.good"), /Got it! \+1/);
    assert.deepEqual(await sounds(), ["wrong", "right"]);
    // It stays until Next.
    const s = await board();
    await app.sleep(2500);
    assert.equal((await board()).handNo, s.handNo);
    assert.equal((await board()).phase, "over");
    await app.click(".t24-actions button.primary", "Next hand");
    assert.equal((await board()).handNo, s.handNo + 1);
    // Turned off: no sounds.
    await options({ sounds: false }, "practice");
    await hook("deal", [1, 2, 3, 4]);
    await tap(0, "+", 1, "+", 2, "+", 3);
    assert.deepEqual(await sounds(), ["wrong", "right"]);
    await options({ sounds: true });
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
    assert.equal(await app.text(".t24-reveal"), "The answer:");
    assert.deepEqual(await app.texts(".t24-line"), [
      "8 ÷ 3 = 8/3",
      "3 − 8/3 = 1/3",
      "8 ÷ 1/3 = 24 ✓",
    ]);
    assert.equal(s.you, 0);
    await close24();
  },
);

check(
  "t24.race",
  "vs the pet: it paces while thinking, never answers sooner than 15 s plus its thinking, 3 s more for each move you make (not again after Undo); settles down 5 s before it answers (“answers in 5 s”), then answers and scores, its way one step a line (“Cat's way:”), “Cat got it first”; the board's rows never move; you first: your point",
  async () => {
    const app = ctx.app;
    await open24();
    await options({ level: "strong" }, "race");
    await hook("deal", [1, 2, 3, 4]);
    let s = await board();
    assert.equal(s.petState, "thinking");
    assert.equal(s.pose, "think");
    const ms = s.petMs;
    assert.ok(ms >= 19_000, `answers after ${ms} ms`);
    await tap(0, "×", 1);
    assert.equal((await board()).petMs, ms + 3000);
    await app.click(".t24-actions button", "Undo");
    await tap(0, "×", 1);
    assert.equal((await board()).petMs, ms + 3000, "not again after Undo");
    await app.click(".t24-actions button", "Start over");
    await hook("petReady");
    s = await board();
    assert.equal(s.petState, "ready");
    assert.equal(s.pose, "ready");
    assert.ok((await app.text(".t24-clock-text")).includes("answers in 5 s"));
    await hook("petNow");
    s = await board();
    assert.equal(s.pet, 1);
    assert.equal(s.phase, "over");
    assert.match(s.bubble, /= 24!/);
    // Its way, one step a line; the status line says it got there first. Nothing moved.
    assert.equal(await app.text(".t24-reveal"), "Cat's way:");
    assert.match(await app.text(".t24-clock-text"), /Cat got it first/);
    const rows = () =>
      app.b.execute(() =>
        [
          ".t24-clock",
          ".t24-cards",
          ".t24-ops",
          ".t24-work",
          ".t24-actions",
        ].map((c) =>
          Math.round(document.querySelector(c).getBoundingClientRect().top),
        ),
      );
    const after = await rows();
    await app.click(".t24-actions button.primary", "Next hand");
    assert.deepEqual(await rows(), after, "the rows stay where they are");
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
  "Timed: a 2-minute clock, +15 s for a hard hand; time up on an unsolved hand: its answer, then the score; Daily: one hand a day, the same for everyone, then “a new hand comes tomorrow”",
  async () => {
    const app = ctx.app;
    await open24();
    await app.click(".t24-tabs button[data-mode=timed]");
    assert.ok((await app.text(".t24-clock-text")).includes("s left"));
    // A hard hand: 15 s more on the clock.
    const before = (await board()).endsIn;
    await hook("deal", [3, 3, 8, 8]);
    const after = (await board()).endsIn;
    assert.ok(after - before > 14_000, `${before} → ${after}`);
    assert.ok((await app.text(".t24-note")).includes("+15 s"));
    // Time's up on an unsolved hand: its answer first, the score when you say.
    await hook("timeUp");
    let s = await board();
    assert.equal(s.phase, "over");
    assert.equal(s.timeUp, true);
    assert.match(await app.text(".t24-reveal"), /Time's up/);
    assert.deepEqual(await app.texts(".t24-line"), [
      "8 ÷ 3 = 8/3",
      "3 − 8/3 = 1/3",
      "8 ÷ 1/3 = 24 ✓",
    ]);
    await app.click(".t24-actions button.primary", "See the score");
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
