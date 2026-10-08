import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const MIN = 60_000;

const texts = (items) => items.map((i) => (typeof i === "string" ? i : i.text));
const alarms = () => ctx.app.invoke("list_alarms");
const find = async (id) => (await alarms()).find((a) => a.id === id);
/** "Alarm 9:40 PM": what an alarm without a label is called. */
const unnamed = async (at) => `Alarm ${await ctx.app.clock(at)}`;

/**
 * Nothing set, no panel, ringing as given (defaults: rings 30 s, snooze 5 min × 3, the ring
 * sound on, the pet stays put).
 */
async function reset(alarm = {}, extra = (s) => s) {
  const app = ctx.app;
  await app.toPet();
  await app.b.execute(() => [...document.querySelectorAll("#bubble .actions button")].find((b) => b.textContent === "Done")?.click());
  for (const a of await alarms()) await app.invoke("delete_alarm", { id: a.id });
  await app.invoke("pomodoro_stop");
  await app.closeWindow("panel");
  await app.setSettings((s) => {
    s.alerts.alarm = { ...s.alerts.alarm, ring: true, ringtone: "classic", volume: 0.7, petRuns: false, ringSeconds: 30, snoozeMinutes: 5, autoSnoozeMax: 3, ...alarm };
    s.quietHours = { ...s.quietHours, enabled: false };
    s.upcomingAlarms = { show: true, minutes: 60 };
    s.sound = true;
    return extra(s);
  });
  await app.until(() => document.getElementById("bubble").hidden || !document.querySelector("#bubble .actions"), [], 15_000).catch(() => {});
}

/** An alarm (no label: "Alarm 9:40 PM") ringing in `ms`. */
function addAlarm(ms, label = "") {
  return ctx.app.invoke("add_alarm", { label, at: Date.now() + ms, repeat: "none", days: null });
}

check("alarm.ring", "when it's time: the bubble with Snooze 5 min and Done, and the ring (Settings decide)", async () => {
  const app = ctx.app;
  await reset();
  const since = Date.now();
  const a = await addAlarm(2000);
  const said = await app.waitBubble(await unnamed(a.nextFire), 10_000);
  assert.ok(said);
  assert.deepEqual(await app.texts("#bubble .actions button"), ["Snooze 5 min", "Done"]);
  const p = await app.pet();
  assert.ok(p.ringing && p.state !== "goto", "rings where it is (Pet comes to the middle: off)");
  assert.ok((await app.sounds(since)).some((s) => s.kind === "ring" && s.id === "classic"));
  await app.answer("Done");
  assert.ok((await app.sounds(since)).some((s) => s.kind === "ring-stop"), "the ring stops");
});

check("alarm.auto-snooze", "unanswered, an alarm snoozes itself: 💤 badge, (1/3) in the panel, Cancel snooze in the menu; its rings say “Snoozed 1× · first rang …”, the last “last try…”", async () => {
  const app = ctx.app;
  // Rings 3 s; snoozes of 12 s.
  await reset({ ringSeconds: 3, snoozeMinutes: 0.2 });
  const a = await addAlarm(2000);
  const name = await unnamed(a.nextFire);
  await app.waitBubble(name, 10_000);
  await app.waitBubble("No answer", 10_000);
  const s1 = await find(a.id);
  assert.equal(s1.snoozes, 1);
  const next = await app.clock(s1.nextFire);
  assert.match(await app.bubble(), new RegExp(`I'll try ${name.replace(/\s/g, "\\s")} again at ${next.replace(/\s/g, "\\s")} \\(1/3\\)`));
  assert.ok(texts(await app.menu("pet")).includes(`Cancel snooze: ${name} (next ring ${next})`));
  assert.ok((await app.badges()).some((b) => b.text === `💤 ${next}`));
  await app.panel("alarms");
  await app.waitText("li.clock-row .chip", `💤 ${next} (1/3)`);
  await app.toPet();
  // Its next ring: still "Alarm 9:40 PM", with the snooze noted.
  await app.waitBubble(`Snoozed 1× · first rang ${await app.clock(a.nextFire)}`, 20_000);
  assert.match(await app.bubble(), new RegExp(name.replace(/\s/g, "\\s")));
  // The third snooze's ring is the last try.
  await app.waitBubble("last try before it's marked missed", 45_000);
  assert.match(await app.bubble(), /Snoozed 3×/);
  ctx.missedId = a.id;
  ctx.missedName = name;
  ctx.missedAt = a.nextFire;
}, { timeout: 120_000 });

check("alarm.missed", "after the last try: an orange “⏰ Missed …” badge with the alarm's own time, gone when clicked", async () => {
  const app = ctx.app;
  assert.ok(ctx.missedId, "follows alarm.auto-snooze");
  await app.b.waitUntil(async () => (await find(ctx.missedId))?.missedAt, { timeout: 15_000 });
  await app.b.waitUntil(async () => (await app.badges()).some((b) => b.text.startsWith("⏰ Missed")), { timeout: 5000 });
  const badge = (await app.badges()).find((b) => b.text.startsWith("⏰"));
  assert.equal(badge.text, `⏰ Missed ${await app.clock(ctx.missedAt)}`);
  assert.equal(await app.b.execute(() => [...document.getElementById("badges").children].find((e) => e.textContent.startsWith("⏰")).classList.contains("missed")), true);
});

check("alarm.welcome-back", "back at the pet, it says “You missed …” once; a click doesn't replace it", async () => {
  const app = ctx.app;
  await app.toPet();
  await app.b.execute(() => window.__epet.hoverIn());
  const said = await app.waitBubble("You missed");
  assert.match(said, new RegExp(`^You missed ${ctx.missedName.replace(/\s/g, "\\s")} \\(I tried 3 more times\\)`));
  // A click is petting: love goes up, the line stays.
  const before = (await app.pet()).mood.affection;
  await app.b.execute(() => window.__epet.care("pet"));
  await app.sleep(500);
  assert.match(await app.bubble(), /^You missed/);
  assert.ok((await app.pet()).mood.affection > before);
  // Only once.
  await app.b.waitUntil(async () => !(await app.bubble())?.startsWith("You missed"), { timeout: 15_000 });
  await app.b.execute(() => window.__epet.hoverIn());
  await app.sleep(500);
  assert.ok(!(await app.bubble())?.startsWith("You missed"));
  // Seen: clicking the badge.
  await app.b.execute(() => [...document.getElementById("badges").children].find((e) => e.textContent.startsWith("⏰")).click());
  await app.b.waitUntil(async () => !(await app.badges()).some((b) => b.text.startsWith("⏰")), { timeout: 5000 });
});

check("alarm.done-ends", "Done on a snoozed ring ends the whole cycle", async () => {
  const app = ctx.app;
  await reset({ ringSeconds: 3, snoozeMinutes: 0.1 });
  const a = await addAlarm(2000);
  await app.waitBubble("No answer", 15_000);
  await app.waitBubble("Snoozed 1×", 20_000);
  await app.answer("Done");
  await app.sleep(1000);
  const after = await find(a.id);
  assert.equal(after.enabled, false);
  await app.sleep(10_000);
  assert.ok(!(await app.bubble())?.includes("Snoozed"), "doesn't ring again");
  assert.equal((await find(a.id)).snoozes, 1);
});

check("alarm.upcoming-badge", "🔔 shows alarms due soon (with snoozed ones, in ring order); the setting turns it off and sets the minutes (1–120)", async () => {
  const app = ctx.app;
  await reset();
  const a = await addAlarm(20 * MIN, "Login CMC");
  const b = await addAlarm(40 * MIN);
  await addAlarm(90 * MIN);
  await app.b.waitUntil(async () => (await app.badges()).some((x) => x.text.startsWith("🔔")), { timeout: 5000 });
  const bell = (await app.badges()).find((x) => x.text.startsWith("🔔"));
  assert.equal(bell.text, `🔔 ${await app.clock(a.nextFire)} +1`);
  assert.deepEqual(bell.info.split("\n"), [`Login CMC · ${await app.clock(a.nextFire)}`, await unnamed(b.nextFire), "Open the Alarms tab"]);
  await app.b.execute(() => [...document.getElementById("badges").children].find((e) => e.textContent.startsWith("🔔")).click());
  assert.equal(await app.panelTab(), "alarms");
  // Settings: off hides it (and greys the minutes), on brings it back.
  await app.panel("settings");
  const row = "label.upcoming";
  await app.b.execute((r) => document.querySelector(`${r} input[type=checkbox]`).click(), row);
  await app.until((r) => document.querySelector(`${r} input[type=number]`)?.disabled, [row]);
  await app.b.waitUntil(async () => !(await app.badges()).some((x) => x.text.startsWith("🔔")), { timeout: 5000 });
  await app.panel("settings");
  await app.b.execute((r) => document.querySelector(`${r} input[type=checkbox]`).click(), row);
  await app.until((r) => document.querySelector(`${r} input[type=number]`)?.disabled === false, [row]);
  await app.b.waitUntil(async () => (await app.badges()).some((x) => x.text.startsWith("🔔")), { timeout: 5000 });
  // Minutes: 0 → 1, 500 → 120; 30 leaves out the alarm in 40 minutes.
  const setMinutes = async (v) => {
    await app.panel("settings");
    await app.b.execute(
      (r, value) => {
        const input = document.querySelector(`${r} input[type=number]`);
        input.value = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      row,
      v,
    );
    await app.sleep(600);
    return (await app.fullSettings()).upcomingAlarms.minutes;
  };
  assert.equal(await setMinutes("0"), 1);
  assert.equal(await setMinutes("500"), 120);
  assert.equal(await setMinutes("30"), 30);
  await app.b.waitUntil(async () => (await app.badges()).find((x) => x.text.startsWith("🔔"))?.text === `🔔 ${await app.clock(a.nextFire)}`, { timeout: 5000 });
  // A snoozed alarm shares the badge; nearest first, so 💤.
  const s = await addAlarm(3 * 60 * MIN, "Tea");
  await app.invoke("snooze_alarm", { id: s.id, minutes: 8 });
  const tea = await find(s.id);
  await app.b.waitUntil(async () => (await app.badges()).some((x) => x.text.startsWith("💤")), { timeout: 5000 });
  const both = (await app.badges()).find((x) => x.text.startsWith("💤"));
  assert.equal(both.text, `💤 ${await app.clock(tea.nextFire)} +1`);
  assert.equal(both.info.split("\n")[0], `Tea · 💤×1 · next ${await app.clock(tea.nextFire)}`);
  // Turned off, the snoozed one still shows.
  await app.setSettings((x) => ((x.upcomingAlarms.show = false), x));
  await app.b.waitUntil(async () => (await app.badges()).find((x) => x.text.startsWith("💤"))?.text === `💤 ${await app.clock(tea.nextFire)}`, { timeout: 5000 });
});

check("settings.unanswered", "Ring for and If nobody answers are kept; “Mark as missed” marks it at once", async () => {
  const app = ctx.app;
  await reset();
  await app.panel("settings");
  const choose = (label, index) =>
    app.b.execute(
      (l, i) => {
        const sel = [...document.querySelectorAll(".box.alert label")].find((x) => x.textContent.startsWith(l)).querySelector("select");
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      },
      label,
      index,
    );
  await choose("Ring for", 2);
  await app.sleep(600);
  assert.equal((await app.fullSettings()).alerts.alarm.ringSeconds, 120);
  await app.panel("settings");
  await choose("If nobody answers", 1);
  await app.sleep(600);
  let a = (await app.fullSettings()).alerts.alarm;
  assert.deepEqual([a.snoozeMinutes, a.autoSnoozeMax], [10, 3]);
  await app.panel("settings");
  await choose("If nobody answers", 3);
  await app.sleep(600);
  a = (await app.fullSettings()).alerts.alarm;
  assert.equal(a.autoSnoozeMax, 0);
  // Now an unanswered alarm (rings 3 s here) is missed at once, no snoozing.
  await app.setSettings((s) => ((s.alerts.alarm.ringSeconds = 3), s));
  await app.toPet();
  const x = await addAlarm(2000);
  await app.b.waitUntil(async () => (await find(x.id))?.missedAt, { timeout: 15_000 });
  assert.equal((await find(x.id)).snoozes, 0);
  // And how long it rings: the bubble went after about 3 s.
  await app.b.execute(() => [...document.getElementById("badges").children].find((e) => e.textContent.startsWith("⏰"))?.click());
});

check("settings.alerts", "Ring off: silent; ringtone and volume as set; the ▶ preview plays; Pet comes to the middle sends it there", async () => {
  const app = ctx.app;
  await reset({ ring: false });
  let since = Date.now();
  await addAlarm(1500);
  await app.waitBubble("Alarm", 10_000);
  assert.ok(!(await app.sounds(since)).some((s) => s.kind === "ring"), "no ring with Ring off");
  await app.answer("Done");
  await reset({ ring: true, ringtone: "marimba", volume: 0.3 });
  since = Date.now();
  await addAlarm(1500);
  await app.waitBubble("Alarm", 10_000);
  const ring = (await app.sounds(since)).find((s) => s.kind === "ring");
  assert.deepEqual([ring?.id, ring?.volume], ["marimba", 0.3]);
  await app.answer("Done");
  // The preview in Settings.
  await app.panel("settings");
  since = Date.now();
  await app.b.execute(() => document.querySelector(".box.alert button[title=Preview]").click());
  await app.sleep(300);
  assert.ok((await app.sounds(since)).some((s) => s.kind === "ringtone" && s.id === "marimba"));
  // Pet comes to the middle: it heads there (if it will: aloof pets may just perk up).
  await reset({ petRuns: true });
  let ran = false;
  const seen = [];
  // (At night a sleepy pet often just perks up, and a walk of its own may still be under
  // way when the bubble shows: several tries.)
  for (let i = 0; i < 12 && !ran; i++) {
    // Away from the middle first (a pet already there has nowhere to run).
    const at = await app.pet();
    const side = at.area.x + at.area.w * 0.15;
    await app.b.execute((x) => window.__epet.walkTo(x), side);
    await app.b
      .waitUntil(async () => Math.abs((await app.pet()).x - side) < at.area.w * 0.1, { timeout: 15_000, interval: 200 })
      .catch(() => {});
    await addAlarm(1500);
    await app.waitBubble("Alarm", 10_000);
    const p = await app.pet();
    const middle = p.area.x + p.area.w / 2;
    seen.push(p.target ? Math.round(p.target.x - middle) : null);
    ran = !!p.target && Math.abs(p.target.x - middle) < 2;
    await app.answer("Done");
    await app.sleep(500);
  }
  assert.ok(ran, `came to the middle in 12 tries (target − middle each try: ${JSON.stringify(seen)})`);
});

check("settings.quiet-hours", "in quiet hours the pet is quiet, but alarms still ring", async () => {
  const app = ctx.app;
  const hm = (ms) => {
    const d = new Date(Date.now() + ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  await reset({}, (s) => ((s.quietHours = { enabled: true, start: hm(-30 * MIN), end: hm(30 * MIN) }), s));
  await app.b.waitUntil(async () => (await app.pet()).mode === "quiet", { timeout: 35_000 });
  await addAlarm(1500);
  await app.waitBubble("Alarm", 10_000);
  await app.answer("Done");
  await app.setSettings((s) => ((s.quietHours.enabled = false), s));
}, { timeout: 90_000 });
