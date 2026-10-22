import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

const hook = (name, ...args) =>
  ctx.app.b.execute((n, a) => window.__epet[n](...a), name, args);

/**
 * The real screen's work area cut into pretend screens: `parts` are [from, to] fractions of
 * its width, each with how much higher its floor is (physical px). Returns the areas.
 */
async function pretend(parts, unticked = []) {
  const app = ctx.app;
  await app.toPet();
  await hook("fakeScreens", null);
  await app.setSettings((s) => ({ ...s, screens: { off: [] } }));
  const a = (await app.pet()).area;
  const areas = parts.map(([from, to, up = 0]) => ({
    x: Math.round(a.x + a.w * from),
    y: a.y,
    w: Math.round(a.w * (to - from)),
    h: a.h - up,
  }));
  await hook("fakeScreens", areas);
  await app.setSettings((s) => ({ ...s, screens: { off: unticked } }));
  return areas;
}

/** Put down in the middle of `area`, a little above its floor; waits until it stands. */
async function dropIn(area) {
  const app = ctx.app;
  await hook("dropAt", area.x + area.w / 2, area.y + area.h - 200);
  await app.until(() => window.__epet.state().grounded, [], 10_000);
}

const standsOn = async (i) => (await ctx.app.pet()).support?.area === i;

check(
  "screens.settings",
  "Settings → Screens the pet lives on shows the screens, ticked; the last one can't be unticked; Identify shows each screen's number on it",
  async () => {
    const app = ctx.app;
    await app.toPet();
    await hook("fakeScreens", null);
    await app.setSettings((s) => ({ ...s, screens: { off: [] } }));
    const real = (await app.invoke("desktop_snapshot")).screens;
    assert.ok(
      real.length >= 1 && real.every((s) => s.id && s.frame.w > 0),
      JSON.stringify(real),
    );
    await app.panel("settings");
    await app.waitText(".box.screens", "Identify");
    const ticks = await app.b.execute(() =>
      [...document.querySelectorAll(".box.screens .screen input")].map((i) => ({
        on: i.checked,
        off: i.disabled,
      })),
    );
    assert.equal(ticks.length, real.length);
    assert.ok(
      ticks.every((t) => t.on),
      "all ticked",
    );
    if (ticks.length === 1)
      assert.equal(ticks[0].off, true, "the only screen can't be unticked");
    await app.click(".box.screens button.identify");
    await app.toPet();
    await app.b.waitUntil(() => app.hasWindow("identify.html"), {
      timeout: 5000,
    });
    await app.b.waitUntil(async () => !(await app.hasWindow("identify.html")), {
      timeout: 8000,
    });
    await app.closeWindow("panel");
  },
);

check(
  "screens.wall",
  "an unticked screen is a wall: walking toward it the pet stops at the edge",
  async () => {
    const app = ctx.app;
    const [left, right] = await pretend(
      [
        [0, 0.5],
        [0.5, 1],
      ],
      ["fake1"],
    );
    assert.deepEqual((await app.pet()).screens.allowed, [true, false]);
    await dropIn(left);
    await hook("walkTo", right.x + right.w / 2);
    await app.sleep(6000);
    const s = await app.pet();
    assert.ok(
      s.x < right.x,
      `stayed on the left screen (x ${s.x}, edge ${right.x})`,
    );
    assert.ok(await standsOn(0));
  },
);

check(
  "screens.visit",
  "carried onto an unticked screen it stays there (a visit); after 10 minutes it walks home and the edge is a wall again",
  async () => {
    const app = ctx.app;
    const [, right] = await pretend(
      [
        [0, 0.5],
        [0.5, 1, 120],
      ],
      ["fake1"],
    );
    await dropIn(right);
    let s = await app.pet();
    assert.equal(s.screens.visit?.id, "fake1", "a visit");
    assert.deepEqual(s.screens.allowed, [true, true], "home stays open");
    await app.sleep(3000);
    assert.ok(await standsOn(1), "plays there");
    await hook("ageVisit", 11 * 60_000);
    await app.b.waitUntil(() => standsOn(0), {
      timeout: 30_000,
      timeoutMsg: "back home",
    });
    await app.b.waitUntil(
      async () => (await app.pet()).screens.visit === null,
      { timeout: 5000 },
    );
    s = await app.pet();
    assert.deepEqual(s.screens.allowed, [true, false], "the wall is back");
  },
);

check(
  "screens.poof",
  "a visit to a screen not next to a ticked one ends with the pet vanishing there and appearing on the nearest ticked screen",
  async () => {
    const app = ctx.app;
    // A gap between them: no way across on foot.
    const [, far] = await pretend(
      [
        [0, 0.4],
        [0.55, 1],
      ],
      ["fake1"],
    );
    await dropIn(far);
    assert.equal((await app.pet()).screens.visit?.id, "fake1");
    await hook("ageVisit", 11 * 60_000);
    await app.b.waitUntil(() => standsOn(0), {
      timeout: 8000,
      timeoutMsg: "appeared on the ticked screen",
    });
  },
);

check(
  "screens.step-up",
  "screens not aligned at the bottom: walking to a higher one, the pet gets up onto it (the cat climbs, the rooster flies)",
  async () => {
    const app = ctx.app;
    for (const who of ["Cat", "Rooster"]) {
      await app.run("pet", "Switch character", who);
      await app.sleep(1000);
      const [left, right] = await pretend([
        [0, 0.5],
        [0.5, 1, 150],
      ]);
      await dropIn(left);
      await hook("walkTo", right.x + right.w / 2);
      await app.b.waitUntil(() => standsOn(1), {
        timeout: 45_000,
        timeoutMsg: `${who} up on the higher screen`,
      });
    }
    await app.run("pet", "Switch character", "Cat");
    await hook("fakeScreens", null);
    await app.setSettings((s) => ({ ...s, screens: { off: [] } }));
  },
);
