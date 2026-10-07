/**
 * The pet and the real mouse (Windows CI): the system cursor is moved and its button pressed
 * (e2e/mouse.ps1), so hovering, stroking, dragging and throwing go through the app as on a
 * desktop (click-through window, the OS cursor). docs/INTERACTIONS.md has the rules.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before } from "node:test";
import { check, Mouse, useApp } from "./harness.mjs";

if (process.platform === "win32") {
  const ctx = useApp(import.meta.filename);
  /** @type {Mouse} */
  let mouse;
  before(() => {
    mouse = Mouse.open();
  });
  after(() => mouse?.close());

  /** A bundled character's lines for `key`. */
  const lines = (character, key) =>
    JSON.parse(readFileSync(new URL(`../assets/characters/${character}/character.json`, import.meta.url), "utf8")).personality.lines[key];
  const said = (text, character, key) => !!text && lines(character, key).some((l) => text.includes(l));

  /** A point on the pet's body (physical px), from its state. */
  const onPet = (p) => ({ x: p.x, y: p.y - p.size.h * 0.4 });
  /** A screen point for page px of the pet window. */
  const toScreen = (p, x, y) => ({ x: p.origin.x + x * p.dpr, y: p.origin.y + y * p.dpr });

  /** Parks the cursor out of the way (top left of the work area). */
  async function away() {
    const p = await ctx.app.pet();
    await mouse.move(p.area.x + 2, p.area.y + 2);
    await ctx.app.sleep(300);
  }

  /** What the hover rules decided since `since`. */
  const hoverEvents = (since) => ctx.app.b.execute((s) => window.__epet.hoverEvents(s), since);

  /**
   * Puts the cursor on the pet (it may be walking: tried until the pet notices) and leaves
   * it there; returns when that was (Date.now()).
   */
  async function hoverPet() {
    const app = ctx.app;
    for (let i = 0; i < 10; i++) {
      const since = Date.now();
      const p = await app.pet();
      if (p.grounded && p.state !== "drag") {
        const at = onPet(p);
        await mouse.move(at.x, at.y);
        await app.sleep(400);
        const ev = await hoverEvents(since);
        if (ev.includes("attend") || ev.includes("dodge")) return since;
      }
      await away();
    }
    throw new Error(`the pet didn't notice the mouse (state ${(await app.pet()).state})`);
  }

  /** Waits until the pet stands on something; returns its state. */
  async function landed(timeout = 8000) {
    const app = ctx.app;
    await app.b.waitUntil(async () => (await app.pet()).grounded, { timeout, interval: 100 });
    return app.pet();
  }

  /**
   * Grabs the pet with the mouse (button down on it, then a move so it's a drag) and lifts
   * it until its feet are just off the floor (it hangs from the hand by the scruff); returns
   * where the hand is.
   */
  async function grab() {
    const app = ctx.app;
    await away();
    const p = await landed();
    const at = onPet(p);
    await mouse.move(at.x, at.y);
    // The window stops letting clicks through once the cursor is over the pet.
    await app.sleep(300);
    await mouse.down();
    const lifted = { x: at.x, y: p.y - p.size.h * 0.85 - 10 };
    await mouse.glide(at, lifted, 200);
    await app.b.waitUntil(async () => (await app.pet()).state === "drag", { timeout: 3000, interval: 50 });
    return lifted;
  }

  /** Lets go without throwing: a few slow small moves first, so it leaves the hand still. */
  async function drop(at) {
    for (let i = 1; i <= 4; i++) {
      await mouse.move(at.x + i, at.y);
      await ctx.app.sleep(120);
    }
    await mouse.up();
  }

  /** Walks the pet to the middle of the work area (away from the walls it might climb). */
  async function toMiddle() {
    const app = ctx.app;
    await away();
    const p = await landed();
    const middle = p.area.x + p.area.w / 2;
    await app.b.execute((x) => window.__epet.walkTo(x), middle);
    await app.b.waitUntil(async () => {
      const q = await app.pet();
      return q.grounded && q.state !== "walkTo" && Math.abs(q.x - middle) < q.size.w;
    }, { timeout: 15_000, interval: 200 });
  }

  /** Floor of the work area (physical px). */
  const floor = (p) => p.area.y + p.area.h;

  check("pet.hover-meter", "on the pet: hearts and fullness with their %; a bubble doesn't cover them", async () => {
    const app = ctx.app;
    await app.b.execute(() => window.__epet.setMood({ affection: 64, fullness: 55 }));
    await hoverPet();
    await app.until(() => !document.getElementById("mood").hidden, [], 3000);
    const meter = await app.b.execute(() => document.getElementById("mood").textContent);
    assert.match(meter, /♥.* 64%/);
    assert.match(meter, /● ?.* 55%/);
    // With something said: the meter and the bubble don't overlap.
    await app.b.execute(() => window.__epet.care("pet"));
    await app.until(() => !document.getElementById("bubble").hidden, [], 5000);
    const overlap = await app.b.execute(() => {
      const a = document.getElementById("mood").getBoundingClientRect();
      const b = document.getElementById("bubble").getBoundingClientRect();
      return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    });
    assert.equal(overlap, false, "the bubble covers the meter");
    await away();
    await app.until(() => document.getElementById("mood").hidden, [], 3000);
  });

  check("pet.hover-react", "resting on it for 2 s: one reaction (a line or a hop), once per visit", async () => {
    const app = ctx.app;
    await away();
    await app.sleep(2500);
    const since = await hoverPet();
    await app.sleep(800);
    assert.ok(!(await hoverEvents(since)).includes("react"), "not before 2 s");
    await app.b.waitUntil(async () => (await hoverEvents(since)).includes("react"), { timeout: 3000, interval: 100 });
    const b = await app.bubble();
    assert.ok(said(b, "cat", "noticed") || said(b, "cat", "noticedHappy") || (await app.pet()).state === "happy", `reacts: ${b}`);
    await app.sleep(2500);
    assert.equal((await hoverEvents(since)).filter((e) => e === "react").length, 1, "only once");
  });

  check("pet.hover-stroke", "moving the mouse over it after 2 s strokes it (+3 ♥ about every 1.5 s, then “That's plenty”); moving sooner doesn't", async () => {
    const app = ctx.app;
    await app.b.execute(() => window.__epet.setMood({ affection: 50, petWindow: { start: Date.now(), gained: 0 } }));
    // Moving straight away: no stroke before 2 s.
    await away();
    await app.sleep(2500);
    let since = await hoverPet();
    const p = await app.pet();
    const at = onPet(p);
    const rub = async (ms) => {
      const end = Date.now() + ms;
      for (let dir = 1; Date.now() < end; dir = -dir) await mouse.glide({ x: at.x - 25 * dir, y: at.y }, { x: at.x + 25 * dir, y: at.y }, 200, 8);
    };
    await rub(1000);
    assert.ok(!(await hoverEvents(since)).includes("stroke"), "no stroke within 2 s");
    // After the reaction, rubbing strokes.
    await app.b.waitUntil(async () => (await hoverEvents(since)).includes("react"), { timeout: 4000, interval: 100 });
    const before = (await app.pet()).mood.affection;
    await rub(4500);
    const strokes = (await hoverEvents(since)).filter((e) => e === "stroke").length;
    assert.ok(strokes >= 2 && strokes <= 4, `${strokes} strokes in 4.5 s`);
    const gained = (await app.pet()).mood.affection - before;
    assert.ok(Math.abs(gained - 3 * strokes) < 0.5, `+${gained} ♥ for ${strokes} strokes`);
    // At the hour's cap: “That's plenty for now”.
    await app.b.execute(() => window.__epet.setMood({ petWindow: { start: Date.now(), gained: 15 } }));
    since = Date.now();
    let enough = null;
    for (let i = 0; i < 6 && !enough; i++) {
      await rub(1600);
      const b = await app.bubble();
      if (said(b, "cat", "enough")) enough = b;
    }
    assert.ok(enough, `says it's enough (${await app.bubble()})`);
    await away();
  }, { timeout: 120_000 });

  check("pet.hover-release", "a cursor left still on it for 8 s: it says a line and goes on; it doesn't stop again for that cursor", async () => {
    const app = ctx.app;
    await away();
    await app.sleep(2500);
    const since = await hoverPet();
    await app.b.waitUntil(async () => (await hoverEvents(since)).includes("release"), { timeout: 12_000, interval: 200 });
    const after = await hoverEvents(since);
    assert.ok(Date.now() - since >= 8000, "not before 8 s");
    assert.equal(after.filter((e) => e === "attend").length, 1);
    assert.ok(said(await app.bubble(), "cat", "release"), `says so: ${await app.bubble()}`);
    // It goes on with its day.
    const p0 = await app.pet();
    await app.b.waitUntil(async () => {
      const p = await app.pet();
      return p.state !== "attend" || Math.abs(p.x - p0.x) > 5;
    }, { timeout: 20_000, interval: 300 });
    await away();
  }, { timeout: 60_000 });

  check("pet.hover-stop", "walking, it stops under a resting mouse and turns to it", async () => {
    const app = ctx.app;
    await away();
    await app.sleep(2500);
    let p = await landed();
    // Walking across the work area.
    const target = p.x < p.area.x + p.area.w / 2 ? p.area.x + p.area.w * 0.85 : p.area.x + p.area.w * 0.15;
    await app.b.execute((x) => window.__epet.walkTo(x), target);
    await app.b.waitUntil(async () => (await app.pet()).state === "walkTo", { timeout: 3000, interval: 100 });
    // The mouse waits a little ahead of it.
    p = await app.pet();
    const dir = Math.sign(target - p.x);
    const since = Date.now();
    await mouse.move(p.x + dir * p.size.w * 0.8, p.y - p.size.h * 0.4);
    await app.b.waitUntil(async () => (await hoverEvents(since)).includes("attend"), { timeout: 8000, interval: 100 });
    await app.sleep(600);
    const a = await app.pet();
    await app.sleep(1000);
    const b = await app.pet();
    assert.equal(b.state, "attend");
    assert.ok(Math.abs(b.x - a.x) < 2, `stays: ${a.x} → ${b.x}`);
    const cursor = await mouse.pos();
    assert.equal(b.facing, cursor.x > b.x ? 1 : -1, "faces the mouse");
    await away();
  });

  check("pet.hover-dodge", "hungry, it steps away and says why; hovering again within 10 s it stays and reacts at once", async () => {
    const app = ctx.app;
    await app.b.execute(() => window.__epet.setMood({ fullness: 20, affection: 60 }));
    // In the middle: stepping away, it doesn't reach a wall (and climb it).
    await toMiddle();
    await app.sleep(2500);
    const since = await hoverPet();
    await app.b.waitUntil(async () => (await hoverEvents(since)).includes("dodge"), { timeout: 3000, interval: 100 });
    await app.waitBubble("", 3000);
    assert.ok(said(await app.bubble(), "cat", "dodgeHungry"), `says why: ${await app.bubble()}`);
    // Again, soon: no dodge, a reaction straight away.
    await away();
    await app.sleep(1800);
    const again = await hoverPet();
    await app.b.waitUntil(async () => (await hoverEvents(again)).includes("react"), { timeout: 1500, interval: 100 });
    assert.ok(!(await hoverEvents(again)).includes("dodge"));
    await app.b.execute(() => window.__epet.setMood({ fullness: 70 }));
    await away();
  });

  check("pet.hover-off", "ringing or in a focus session the mouse on it changes nothing, and the ring's buttons work with a real click", async () => {
    const app = ctx.app;
    await app.setSettings((s) => {
      s.alerts.alarm = { ...s.alerts.alarm, ring: false, petRuns: false, ringSeconds: 30 };
      return s;
    });
    await away();
    const t = await app.addTimer(1, 1500);
    await app.waitBubble("Time's up", 10_000);
    const since = Date.now();
    let p = await app.pet();
    await mouse.move(onPet(p).x, onPet(p).y);
    await app.sleep(3000);
    assert.deepEqual(await hoverEvents(since), [], "no hover reactions while ringing");
    // Done, clicked with the mouse.
    p = await app.pet();
    const r = await app.b.execute(() => {
      const b = [...document.querySelectorAll("#bubble .actions button")].find((x) => x.textContent === "Done").getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    const at = toScreen(p, r.x, r.y);
    await mouse.move(at.x, at.y);
    await app.sleep(300);
    await mouse.down();
    await mouse.up();
    await app.b.waitUntil(async () => !(await app.pet()).ringing, { timeout: 5000, interval: 100 });
    assert.equal((await app.invoke("list_alarms")).find((a) => a.id === t.id).enabled, false);
    // A focus session: no hover reactions either.
    await away();
    await app.invoke("pomodoro_start");
    await app.b.waitUntil(async () => (await app.pet()).pomodoro.phase === "focus", { timeout: 5000 });
    await app.sleep(1500);
    const focusSince = Date.now();
    p = await app.pet();
    await mouse.move(onPet(p).x, onPet(p).y);
    await app.sleep(3000);
    assert.ok(!(await hoverEvents(focusSince)).some((e) => e === "attend" || e === "react"), "no hover reactions while focusing");
    await app.invoke("pomodoro_stop");
    await away();
  });

  check("pet.drag-throw", "dragged, it follows the hand (held by the scruff); flung, it flies on and lands", async () => {
    const app = ctx.app;
    const hand = await grab();
    const dragSince = Date.now();
    const p0 = await app.pet();
    // Carried: the pet hangs under the cursor.
    const to = { x: hand.x + (hand.x < p0.area.x + p0.area.w / 2 ? 200 : -200), y: hand.y - 150 };
    await mouse.glide(hand, to, 500);
    await app.sleep(2500);
    // Held up, it doesn't react to the hand as to a hovering mouse (pet.hover-off).
    assert.deepEqual((await hoverEvents(dragSince)).filter((e) => e !== "leave"), [], "no hover reactions while dragged");
    let p = await app.pet();
    assert.equal(p.state, "drag");
    assert.ok(Math.abs(p.x - to.x) <= 3, `x follows: ${p.x} vs ${to.x}`);
    assert.ok(Math.abs(p.y - (to.y + p.size.h * 0.85)) <= 3, `hangs below the hand: ${p.y} vs ${to.y}`);
    // Flung sideways and up.
    const dir = to.x < p.area.x + p.area.w / 2 ? 1 : -1;
    const flick = { x: to.x + dir * 120, y: to.y - 40 };
    await mouse.glide(to, flick, 60, 4);
    await mouse.up();
    const released = (await app.pet()).x;
    await app.sleep(150);
    p = await app.pet();
    assert.ok(Math.sign(p.vx) === dir || Math.sign(p.x - released) === dir, `flies on: vx ${p.vx}, ${released} → ${p.x}`);
    p = await landed();
    assert.ok(Math.sign(p.x - released) === dir, `lands further on: ${released} → ${p.x}`);
    await away();
  });

  check("mood.carry", "carried around it's play (+2 ♥); dropped from high it slams down (−1 ♥, a line)", async () => {
    const app = ctx.app;
    await app.b.execute(() => window.__epet.setMood({ affection: 50, petWindow: { start: Date.now(), gained: 0 } }));
    // Carried along the floor.
    let hand = await grab();
    const area = (await app.pet()).area;
    const along = { x: hand.x + 150 * (hand.x < area.x + area.w / 2 ? 1 : -1), y: hand.y };
    await mouse.glide(hand, along, 600);
    await drop(along);
    let p = await landed();
    assert.ok(Math.abs(p.mood.affection - 52) < 0.2, `carried: ${p.mood.affection}`);
    // Dropped from high up (playing is capped, so only the slam counts).
    await app.b.execute(() => window.__epet.setMood({ affection: 50, petWindow: { start: Date.now(), gained: 15 } }));
    hand = await grab();
    p = await app.pet();
    const high = { x: hand.x, y: p.area.y + 60 };
    await mouse.glide(hand, high, 500);
    await drop(high);
    p = await landed();
    assert.ok(Math.abs(p.mood.affection - 49) < 0.2, `slammed: ${p.mood.affection}`);
    assert.ok(said(await app.bubble(), "cat", "landed"), `says so: ${await app.bubble()}`);
    await away();
  });

  check("pet.windows", "dropped above a window it stands on its top edge; the window minimized, it falls", async () => {
    const app = ctx.app;
    const area = (await app.pet()).area;
    const title = "ePet test window";
    const win = { x: Math.round(area.x + area.w * 0.25), y: Math.round(area.y + area.h * 0.45), w: Math.round(area.w * 0.5), h: Math.round(area.h * 0.35) };
    const form = spawn(
      "pwsh",
      ["-NoProfile", "-File", fileURLToPath(new URL("./window.ps1", import.meta.url)), "-X", win.x, "-Y", win.y, "-W", win.w, "-H", win.h, "-Title", title].map(String),
      { stdio: "ignore" },
    );
    try {
      // Until the app sees it.
      let seen = null;
      await app.b.waitUntil(
        async () => (seen = (await app.pet()).windows.find((w) => Math.abs(w.x - win.x) < 20 && Math.abs(w.y - win.y) < 20)),
        { timeout: 20_000, interval: 300 },
      );
      // Carried above its middle and let go.
      const hand = await grab();
      // The feet hang 0.85 of its height below the hand: let go well above the top edge.
      const above = { x: seen.x + seen.w / 2, y: seen.y - (await app.pet()).size.h * 0.85 - 120 };
      await mouse.glide(hand, above, 500);
      await drop(above);
      let p = await landed();
      assert.ok(Math.abs(p.y - seen.y) <= 3, `stands on the window's top: feet ${p.y}, window top ${seen.y}`);
      // The window goes: it falls to the floor.
      await mouse.window("minimize", title);
      await app.b.waitUntil(async () => (p = await app.pet()).grounded && p.y > seen.y + 50, { timeout: 8000, interval: 100 });
      assert.ok(Math.abs(p.y - floor(p)) <= 3, `on the floor: ${p.y} vs ${floor(p)}`);
    } finally {
      form.kill();
      await away();
    }
  });

  check("pet.rooster-glide", "Rooster dropped from high glides: it falls much slower than the cat", async () => {
    const app = ctx.app;
    /** Drops the pet from near the top; how long it takes to land, and the states seen. */
    const fall = async () => {
      const hand = await grab();
      const p = await app.pet();
      const high = { x: p.area.x + p.area.w / 2, y: p.area.y + 60 };
      await mouse.glide(hand, high, 500);
      await drop(high);
      const start = Date.now();
      const states = new Set();
      await app.b.waitUntil(
        async () => {
          const s = await app.pet();
          states.add(s.state);
          return s.grounded;
        },
        { timeout: 15_000, interval: 50 },
      );
      return { ms: Date.now() - start, states };
    };
    const cat = await fall();
    await app.run("pet", "Switch character", "Rooster");
    await app.b.waitUntil(async () => (await app.pet()).character === "rooster", { timeout: 5000 });
    await landed();
    try {
      const rooster = await fall();
      assert.ok(rooster.states.has("glide"), `glides: ${[...rooster.states].join(", ")}`);
      assert.ok(rooster.ms > cat.ms * 1.5, `slower: cat ${cat.ms} ms, rooster ${rooster.ms} ms`);
    } finally {
      await app.run("pet", "Switch character", "Cat");
      await away();
    }
  }, { timeout: 120_000 });

  check("pet.hover-stop-run", "running to ring, it stops under a mouse waiting in its way and rings there (the bubble stays); a mouse sweeping across doesn't stop it", async () => {
    const app = ctx.app;
    // The Rooster runs to the middle (sociable); ringing without sound.
    await app.run("pet", "Switch character", "Rooster");
    await app.b.waitUntil(async () => (await app.pet()).character === "rooster", { timeout: 5000 });
    await app.setSettings((s) => {
      s.alerts.alarm = { ...s.alerts.alarm, ring: false, petRuns: true, ringSeconds: 30 };
      return s;
    });
    try {
      /** Puts the pet near the left edge and rings a timer until it runs; returns its state. */
      const ringAndRun = async () => {
        for (let i = 0; i < 6; i++) {
          const hand = await grab();
          const p = await app.pet();
          const left = { x: p.area.x + p.size.w, y: hand.y };
          await mouse.glide(hand, left, 400);
          await drop(left);
          await landed();
          await away();
          await app.addTimer(1, 1000);
          await app.waitBubble("Time's up", 10_000);
          const ran = await app.b
            .waitUntil(async () => (await app.pet()).state === "goto", { timeout: 2000, interval: 50 })
            .then(() => true, () => false);
          if (ran) return app.pet();
          await app.answer("Done");
          await app.sleep(500);
        }
        throw new Error("the pet never ran to the middle");
      };
      // A mouse waiting in its way: it stops under it and rings there.
      let p = await ringAndRun();
      const since = Date.now();
      const wait = { x: p.x + p.size.w * 2.5, y: p.y - p.size.h * 0.4 };
      await mouse.move(wait.x, wait.y);
      await app.b.waitUntil(async () => (await hoverEvents(since)).includes("stopRun"), { timeout: 8000, interval: 50 });
      await app.sleep(500);
      p = await app.pet();
      assert.notEqual(p.state, "goto");
      assert.ok(Math.abs(p.x - wait.x) <= p.size.w, `stopped under the mouse: ${p.x} vs ${wait.x}`);
      await app.sleep(2500);
      const b = await app.bubble();
      assert.ok(b?.includes("Time's up"), `the ring's bubble stays: ${b}`);
      assert.ok(await app.b.execute(() => !!document.querySelector("#bubble .actions button")), "with its buttons");
      await app.answer("Done");
      // A mouse sweeping across: it runs on.
      p = await ringAndRun();
      const sweepSince = Date.now();
      const y = p.y - p.size.h * 0.4;
      // Across it and on, without stopping (a mouse resting just past it counts as waiting).
      await mouse.glide({ x: p.x + p.size.w * 3, y }, { x: p.x - p.size.w, y }, 150, 10);
      await mouse.glide({ x: p.x - p.size.w, y }, { x: p.area.x + 10, y: p.area.y + 10 }, 400, 20);
      await away();
      await app.b.waitUntil(async () => (await app.pet()).state !== "goto", { timeout: 15_000, interval: 100 });
      p = await app.pet();
      assert.ok(!(await hoverEvents(sweepSince)).includes("stopRun"), "not stopped by a sweep");
      assert.ok(Math.abs(p.x - (p.area.x + p.area.w / 2)) < p.area.w * 0.2, `reached the middle: ${p.x}`);
      await app.answer("Done");
    } finally {
      await app.run("pet", "Switch character", "Cat");
      await away();
    }
  }, { timeout: 180_000 });
}
