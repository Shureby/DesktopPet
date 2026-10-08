import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const MIN = 60_000;

const texts = (items) => items.map((i) => (typeof i === "string" ? i : i.text));
const status = () => ctx.app.invoke("pomodoro_status");

/** Idle, default lengths, nothing else running. */
async function reset(pomodoro = {}) {
  const app = ctx.app;
  await app.toPet();
  await app.invoke("pomodoro_stop");
  for (const a of await app.invoke("list_alarms")) await app.invoke("delete_alarm", { id: a.id });
  await app.closeWindow("panel");
  await app.closeWindow("game");
  if (!(await app.visible("pet"))) await app.invoke("e2e_tray", { id: "show" });
  await app.setSettings((s) => {
    s.pomodoro = {
      ...s.pomodoro,
      focusMin: 25,
      shortBreakMin: 5,
      longBreakMin: 15,
      roundsBeforeLong: 4,
      autoContinue: true,
      holdGames: true,
      workHours: { ...s.pomodoro.workHours, enabled: false },
      ...pomodoro,
    };
    s.alerts.alarm = { ...s.alerts.alarm, ring: false, petRuns: true, ringSeconds: 30 };
    return s;
  });
  await app.b.execute(() => [...document.querySelectorAll("#bubble .actions button")].find((b) => /Done|Cancel/.test(b.textContent))?.click());
}

/** "HH:MM" `ms` from now (local time). */
function hm(ms) {
  const d = new Date(Date.now() + ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

check("focus.start", "Start focus session 🍅: a 🍅 countdown badge, above the timer's", async () => {
  const app = ctx.app;
  await reset();
  await app.addTimer(5, 5 * MIN);
  await app.run("pet", "Start focus session 🍅");
  await app.b.waitUntil(async () => (await app.badges()).length === 2, { timeout: 5000 });
  const [first, second] = await app.badges();
  assert.match(first.text, /^🍅 2[45]:\d\d$/);
  assert.match(second.text, /^⏱ /);
  assert.equal((await status()).phase, "focus");
});

check("focus.timer-during", "during a focus session a ringing timer doesn't send the pet running", async () => {
  const app = ctx.app;
  await reset();
  await app.invoke("pomodoro_start");
  await app.sleep(500);
  await app.addTimer(1, 1500);
  await app.waitBubble("Time's up", 10_000);
  const p = await app.pet();
  assert.equal(p.mode, "focus");
  assert.ok(p.state !== "goto" && !p.target, `stays at its desk: ${p.state} ${JSON.stringify(p.target)}`);
  await app.click("#bubble .actions button", "Done");
});

check("focus.cycle", "a focus ends in a break; every N rounds a long break (lengths from the Focus tab)", async () => {
  const app = ctx.app;
  // Three-second phases, a long break every second round.
  await reset({ focusMin: 0.05, shortBreakMin: 0.05, longBreakMin: 0.05, roundsBeforeLong: 2 });
  await app.invoke("pomodoro_start");
  const phases = ["focus"];
  let breakLine = null;
  await app.b.waitUntil(
    async () => {
      const p = (await status()).phase;
      if (p !== phases.at(-1)) {
        phases.push(p);
        if (p === "short_break") breakLine ??= await app.bubble();
      }
      return phases.includes("long_break");
    },
    { timeout: 30_000, interval: 250 },
  );
  assert.deepEqual(phases.slice(0, 4), ["focus", "short_break", "focus", "long_break"]);
  assert.ok(breakLine, "the pet says something when the break starts");
  await app.invoke("pomodoro_stop");
});

check("focus.stats", "the Focus tab's Last 7 days counts finished sessions", async () => {
  const app = ctx.app;
  // (focus.cycle finished two.)
  const stats = await app.invoke("pomodoro_stats", { days: 7 });
  const sessions = stats.reduce((n, d) => n + d.completed, 0);
  assert.ok(sessions >= 2, JSON.stringify(stats));
  await app.panel("focus");
  await app.waitText("h3.split small", `${sessions} sessions`);
});

check("focus.stop", "the menu says “Stop focus session (ends …)”; it stops", async () => {
  const app = ctx.app;
  await reset();
  const s = await app.invoke("pomodoro_start");
  await app.sleep(500);
  const item = `Stop focus session (ends ${await app.clock(s.endsAt)})`;
  assert.ok(texts(await app.menu("pet")).includes(item));
  await app.run("pet", "Stop focus session");
  await app.b.waitUntil(async () => (await status()).phase === "idle", { timeout: 5000 });
  assert.ok(texts(await app.menu("pet")).includes("Start focus session 🍅"));
  await app.b.waitUntil(async () => !(await app.badges()).some((b) => b.text.startsWith("🍅")), { timeout: 5000 });
});

check("focus.work-hours", "Work hours: days and times show when on; it starts by itself at work time; stopped by hand it stays stopped", async () => {
  const app = ctx.app;
  await reset();
  await app.panel("focus");
  const toggle = () =>
    app.b.execute(() => [...document.querySelectorAll(".work-hours label.check")][0].querySelector("input").click());
  assert.equal(await app.b.execute(() => document.querySelector(".work-hours .day-picker")), null);
  await toggle();
  await app.until(() => document.querySelector(".work-hours .day-picker") && document.querySelectorAll(".work-hours .time-field").length === 2);
  await toggle();
  await app.until(() => !document.querySelector(".work-hours .day-picker"));
  // Work started a minute ago and ends in half an hour, every day: it starts by itself.
  await app.setSettings((s) => ((s.pomodoro.workHours = { enabled: true, days: 0b111_1111, start: hm(-MIN), end: hm(30 * MIN) }), s));
  await app.b.waitUntil(async () => (await status()).phase === "focus", { timeout: 10_000 });
  await app.b.waitUntil(async () => (await app.badges()).some((b) => b.text.startsWith("🍅")), { timeout: 5000 });
  // Stopped by hand: it stays stopped.
  await app.invoke("pomodoro_stop");
  await app.sleep(4000);
  assert.equal((await status()).phase, "idle");
  await app.setSettings((s) => ((s.pomodoro.workHours.enabled = false), s));
});

check("focus.games-held", "during focus the game asks first (Cancel / Play anyway); hidden, the tray leaves it out; not in breaks or with the option off", async () => {
  const app = ctx.app;
  await reset();
  await app.invoke("pomodoro_start");
  await app.sleep(500);
  for (const menu of ["pet", "tray"]) assert.ok(texts(await app.menu(menu)).includes("Play Safe Landing (focusing)"), menu);
  // Asked first; Cancel opens nothing.
  await app.run("pet", "Play Safe Landing");
  const asked = await app.waitBubble("Play anyway?");
  assert.match(asked, new RegExp(`We're focusing until ${(await app.clock((await status()).endsAt)).replace(/\s/g, "\\s")}\\. Play anyway\\?`));
  assert.equal(await app.hasWindow("game.html"), false);
  await app.click("#bubble .actions button", "Cancel");
  await app.sleep(800);
  assert.equal(await app.hasWindow("game.html"), false);
  // Play anyway opens it.
  await app.run("tray", "Play Safe Landing");
  await app.waitBubble("Play anyway?");
  await app.click("#bubble .actions button", "Play anyway");
  await app.toWindow("game.html");
  await app.closeWindow("game");
  // Hidden: no game in the tray until the pet is back.
  await app.run("tray", "Hide pet");
  await app.b.waitUntil(async () => !texts(await app.menu("tray")).some((t) => t.startsWith("Play")), { timeout: 5000 });
  await app.run("tray", "Show pet");
  await app.b.waitUntil(async () => texts(await app.menu("tray")).includes("Play Safe Landing (focusing)"), { timeout: 5000 });
  // The panel's Games tab asks too.
  await app.panel("games");
  await app.click("button.primary", "Play");
  await app.until(() => document.querySelector(".ask"));
  await app.click(".ask button", "Cancel");
  // In a break: no asking.
  await app.toPet();
  await app.invoke("pomodoro_skip");
  await app.b.waitUntil(async () => texts(await app.menu("pet")).includes("Play Safe Landing"), { timeout: 5000 });
  // With the option off: no asking either.
  await app.invoke("pomodoro_start");
  await app.setSettings((s) => ((s.pomodoro.holdGames = false), s));
  await app.b.waitUntil(async () => texts(await app.menu("pet")).includes("Play Safe Landing"), { timeout: 5000 });
  await app.invoke("pomodoro_stop");
});

check("focus.sounds", "a focus starting and a break starting have sounds of their own (Field phone, Chime by default), each can be off, and they play with the pet hidden too", async () => {
  const app = ctx.app;
  await reset({ focusMin: 0.05, shortBreakMin: 0.05, sounds: { focus: "fieldPhone", break: "chime", volume: 0.5 } });
  const tones = async (since) => (await app.sounds(since)).filter((s) => s.kind === "focus-tone").map((s) => `${s.what}:${s.id}`);
  let since = Date.now();
  await app.invoke("pomodoro_start");
  // 3 s of focus, then the break.
  await app.b.waitUntil(async () => (await status()).phase === "short_break", { timeout: 15_000 });
  await app.sleep(500);
  assert.deepEqual(await tones(since), ["focus:fieldPhone", "break:chime"]);
  await app.invoke("pomodoro_stop");
  // Hidden, with other tones; the break's off.
  await reset({ focusMin: 0.05, shortBreakMin: 0.05, sounds: { focus: "digital", break: "off", volume: 0.3 } });
  await app.run("tray", "Hide pet");
  since = Date.now();
  await app.invoke("pomodoro_start");
  await app.b.waitUntil(async () => (await status()).phase === "short_break", { timeout: 15_000 });
  await app.sleep(500);
  assert.deepEqual(await tones(since), ["focus:digital"]);
  await app.invoke("pomodoro_stop");
  await app.invoke("e2e_tray", { id: "show" });
  // The Focus tab offers them, with Off.
  await app.panel("focus");
  const options = await app.b.execute(() => [...document.querySelectorAll(".focus-tone-focus option")].map((o) => o.textContent));
  assert.equal(options[0], "Field phone");
  assert.equal(options.at(-1), "Off");
  await reset({ sounds: { focus: "fieldPhone", break: "chime", volume: 0.5 } });
}, { timeout: 90_000 });
