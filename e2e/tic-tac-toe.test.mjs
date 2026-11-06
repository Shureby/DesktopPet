import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

/** The tic-tac-toe window current; what its board shows (window.__epetTtt.state). */
async function board() {
  await ctx.app.toWindow("tic-tac-toe.html");
  await ctx.app.b.waitUntil(() => ctx.app.b.execute(() => !!window.__epetTtt), {
    timeout: 10_000,
  });
  return ctx.app.b.execute(() => window.__epetTtt.state);
}

/** Runs a test hook in the tic-tac-toe window. */
async function hook(name, ...args) {
  await board();
  await ctx.app.b.execute((n, a) => window.__epetTtt[n](...a), name, args);
  await ctx.app.sleep(200);
}

/** Clicks cells as a player would (by index: 0–8, ultimate 0–80). */
async function tap(...cells) {
  await board();
  for (const c of cells) {
    const ok = await ctx.app.b.execute((i) => {
      const b = document.querySelector(`[data-cell="${i}"]`);
      if (!b || b.disabled) return false;
      b.click();
      return true;
    }, c);
    assert.ok(ok, `cell ${c} can be played`);
    await ctx.app.sleep(120);
  }
}

/** Two players, playing `rules` (from ⚙). */
async function duo(rules) {
  const app = ctx.app;
  await board();
  await app.click(".t24-icon", "⚙");
  await app.b.execute(
    (v) => document.querySelector(`input[name=duo][value=${v}]`).click(),
    rules,
  );
  await app.click(".t24-actions button.primary");
  await app.click(".t24-tabs button[data-mode=duo]");
  // (A new game from an empty board: player 1 starts.)
  await app.click(".t24-tabs button[data-mode=classic]");
  await app.click(".t24-tabs button[data-mode=duo]");
}

async function openTtt() {
  await ctx.app.run("pet", "Play tic-tac-toe");
  return board();
}

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

const closeTtt = () => ctx.app.closeWindow("game");

check(
  "ttt.open",
  "Play tic-tac-toe opens the small board (classic, against the pet, its own mark); the desktop pet gets up onto it; it stays out when the game closes",
  async () => {
    const app = ctx.app;
    const s = await openTtt();
    assert.equal(s.mode, "classic");
    assert.equal(s.cells.length, 9);
    const [w, h] = await app.b.execute(() => [
      window.innerWidth,
      window.innerHeight,
    ]);
    assert.ok(w <= 520 && h <= 720, `a board, not the whole screen: ${w}×${h}`);
    await onTheBoard();
    // The cat's pieces are paw prints.
    await tap(4);
    await hook("petNow");
    await board();
    assert.equal(
      await app.b.execute(
        () => !!document.querySelector(".ttt-cell.o .ttt-mark.pet"),
      ),
      true,
    );
    await closeTtt();
    await app.b.waitUntil(async () => (await app.pet()).board === null, {
      timeout: 5000,
    });
    assert.equal((await app.pet()).hidden, false);
  },
);

check(
  "ttt.vs-pet",
  "against the pet: it paces while it thinks, then plays; at its best it never loses at classic; Undo takes back your move and its answer; the score counts",
  async () => {
    const app = ctx.app;
    await openTtt();
    await hook("level", "strong");
    await hook("start", "classic");
    for (let i = 0; i < 9; i++) {
      let s = await board();
      if (s.winner) break;
      if (s.turn === "o") {
        assert.equal(s.petThinking, true);
        assert.equal(s.pose, "think");
        await hook("petNow");
        continue;
      }
      // Undo once along the way: back to the same board.
      if (i === 2) {
        const before = s.cells.join();
        await tap(s.cells.findIndex((c) => c === null));
        await hook("petNow");
        await app.click(".ttt-undo");
        s = await board();
        assert.equal(s.cells.join(), before);
      }
      await tap(s.cells.findIndex((c) => c === null));
    }
    const end = await board();
    assert.notEqual(end.winner, null);
    assert.notEqual(end.winner, "x");
    assert.equal(end.you, 0);
    assert.equal(end.pet + end.draws, 1);
    await app.waitText(".ttt-status", end.winner === "draw" ? "draw" : "wins");
    // Again: the pet starts this one.
    await app.click(".ttt-again");
    const next = await board();
    assert.equal(next.winner, null);
    assert.equal(next.turn, "o");
    await closeTtt();
  },
  { timeout: 120_000 },
);

check(
  "ttt.duo",
  "two players at one computer: ✕ and ○ take turns; three in a row wins and says who; the next game the other one starts",
  async () => {
    const app = ctx.app;
    await openTtt();
    await duo("classic");
    await tap(0, 3, 1, 4, 2);
    const s = await board();
    assert.equal(s.winner, "x");
    assert.deepEqual(s.line, [0, 1, 2]);
    assert.equal(s.you, 1);
    await app.waitText(".ttt-status", "Player 1 wins!");
    await app.click(".ttt-again");
    assert.equal((await board()).turn, "o");
    await closeTtt();
  },
);

check(
  "ttt.vanishing",
  "vanishing: three pieces each; the oldest is marked “goes next move” and goes when a fourth is placed",
  async () => {
    const app = ctx.app;
    await openTtt();
    await duo("vanishing");
    await tap(0, 4, 2, 8, 6, 7);
    let s = await board();
    assert.equal(s.rules, "vanishing");
    assert.equal(s.goesNext.x, 0);
    await app.waitText('.ttt-cell[data-cell="0"]', "goes next move");
    await tap(3);
    s = await board();
    assert.equal(s.cells[0], null);
    assert.equal(s.cells.filter((c) => c === "x").length, 3);
    await closeTtt();
  },
);

check(
  "ttt.ultimate",
  "ultimate: nine small boards; where you play sends the other player to that board (lit, the others shut)",
  async () => {
    const app = ctx.app;
    await openTtt();
    await duo("ultimate");
    // Centre board, its top-right cell: ○ goes to the top-right board.
    await tap(4 * 9 + 2);
    const s = await board();
    assert.equal(s.forced, 2);
    assert.equal(
      await app.b.execute(
        () =>
          document
            .querySelector('.ttt-board[data-board="2"]')
            .classList.contains("active") &&
          !document
            .querySelector('.ttt-board[data-board="0"]')
            .classList.contains("active"),
      ),
      true,
    );
    await app.waitText(".ttt-status", "play in the top right board");
    assert.equal(
      await app.b.execute(
        () => document.querySelector('[data-cell="0"]').disabled,
      ),
      true,
    );
    await tap(2 * 9 + 0);
    assert.equal((await board()).forced, 0);
    await closeTtt();
  },
);

check(
  "ttt.pause",
  "an alarm or timer ringing pauses the game (veil): the pet doesn't play meanwhile; answered, “3, 2, 1” and it plays",
  async () => {
    const app = ctx.app;
    await openTtt();
    await hook("start", "classic");
    await onTheBoard();
    // (It thinks longer than the timer takes to ring: the ring comes while it thinks.)
    await hook("think", 60_000);
    await tap(4);
    await app.addTimer(1, 1500);
    await app.waitBubble("Time's up", 10_000);
    await app.b.waitUntil(
      async () => (await board()).paused?.reason === "ring",
      {
        timeout: 5000,
      },
    );
    await hook("petNow");
    assert.equal((await board()).cells.filter((c) => c === "o").length, 0);
    await app.answer("Done");
    await app.b.waitUntil(async () => (await board()).paused === null, {
      timeout: 8000,
    });
    await hook("petNow");
    assert.equal((await board()).cells.filter((c) => c === "o").length, 1);
    await closeTtt();
  },
  { timeout: 120_000 },
);
