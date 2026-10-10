import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const MIN = 60_000;
const DAY = 86_400_000;
const ALARM_TIME = ".row .time-field";

async function page() {
  await ctx.app.panel("alarms");
  return ctx.app;
}
const alarms = () => ctx.app.invoke("list_alarms");
async function clearAll() {
  for (const a of await alarms()) await ctx.app.invoke("delete_alarm", { id: a.id });
}
function addAlarm(label, at, repeat = "none", days = null) {
  return ctx.app.invoke("add_alarm", { label, at, repeat, days });
}
/** Local time `days` from today at h:m. */
function at(days, h, m = 0) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}
/** The New alarm time field: its value ("HH:MM") and what its parts show. */
const field = (css = ALARM_TIME) =>
  ctx.app.b.execute((s) => {
    const f = document.querySelector(s);
    return { value: f.value, hour: f.querySelector(".part.hour").textContent, minute: f.querySelector(".part.minute").textContent, period: f.querySelector(".part.period")?.textContent ?? null };
  }, css);
const rowTitles = () => ctx.app.texts("ul.clocks:not(:has(.countdown)) li .title");
const row = (label) =>
  ctx.app.b.execute((l) => {
    const li = [...document.querySelectorAll("li.clock-row")].find((x) => x.querySelector(".title")?.textContent === l);
    return li && { big: li.querySelector(".big").textContent, sub: li.querySelector(".sub").textContent, off: li.classList.contains("off"), on: li.querySelector("input[role=switch]")?.checked ?? null, chips: [...li.querySelectorAll(".chip")].map((c) => c.textContent), editing: li.classList.contains("editing") };
  }, label);
const clickInRow = (label, css) =>
  ctx.app.b.execute(
    (l, s) => [...document.querySelectorAll("li.clock-row")].find((x) => x.querySelector(".title")?.textContent === l).querySelector(s).click(),
    label,
    css,
  );
async function chooseRepeat(value) {
  await ctx.app.b.execute((v) => {
    const s = document.querySelector("section > .row select.repeat");
    s.value = v;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}
const pickerState = () =>
  ctx.app.b.execute(() => ({
    shown: !document.querySelector(".days-row").hidden,
    on: [...document.querySelectorAll(".days-row .day-picker button")].filter((b) => b.classList.contains("on")).map((b) => b.title),
    choice: document.querySelector("section > .row select.repeat").value,
    addDisabled: document.querySelector("section > .row button.primary").disabled,
  }));
const clickDay = (name) => ctx.app.click(".days-row .day-picker button", name);
async function addFromForm(label) {
  const app = ctx.app;
  await app.type("section > .row input[placeholder=Label]", label);
  await app.click("section > .row button.primary");
  await app.waitText("li.clock-row .title", label);
}

check("alarm.create", "a new Once alarm 2 minutes from now; the time field starts at now", async () => {
  const app = await page();
  await clearAll();
  const now = new Date();
  const f = await field();
  const [h, m] = f.value.split(":").map(Number);
  assert.ok(Math.abs(h * 60 + m - (now.getHours() * 60 + now.getMinutes())) <= 1, `field ${f.value}`);
  await app.press(`${ALARM_TIME} .part.minute`, ["ArrowUp", "ArrowUp"]);
  await addFromForm("Tea");
  const r = await row("Tea");
  assert.match(r.sub, /^Once · (Today|Tomorrow)$/);
  assert.equal(r.on, true);
  const a = (await alarms()).find((x) => x.label === "Tea");
  assert.ok(Math.abs(a.nextFire - (Date.now() + 2 * MIN)) < 2 * MIN || a.nextFire > Date.now());
});

check("ui.time-field", "drag, wheel, keys and typing in the time field; Quiet hours keep their change", async () => {
  const app = await page();
  const twelve = (await field()).period !== null;
  // Typing 7 3 0 → 7:30.
  await app.press(`${ALARM_TIME} .part.hour`, ["7", "3", "0"]);
  let f = await field();
  assert.equal(`${f.hour}:${f.minute}`, twelve ? "7:30" : "07:30");
  const hourShown = f.hour;
  // ↑/↓ and the wheel: one step each.
  await app.press(`${ALARM_TIME} .part.minute`, ["ArrowUp"]);
  assert.equal((await field()).minute, "31");
  await app.press(`${ALARM_TIME} .part.minute`, ["ArrowDown", "ArrowDown"]);
  assert.equal((await field()).minute, "29");
  await app.b.execute((s) => document.querySelector(`${s} .part.minute`).dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true })), ALARM_TIME);
  assert.equal((await field()).minute, "30");
  // 59 → 00 keeps the hour.
  await app.press(`${ALARM_TIME} .part.minute`, ["5", "9"]);
  await app.press(`${ALARM_TIME} .part.minute`, ["ArrowUp"]);
  f = await field();
  assert.equal(f.minute, "00");
  assert.equal(f.hour, hourShown);
  // Dragging up raises the hour, further raises it more; down lowers it.
  const drag = (dy) =>
    app.b.execute(
      (s, d) => {
        const el = document.querySelector(`${s} .part.hour`);
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, pointerId: 1, clientX: r.x + 5, clientY: r.y + 5 };
        el.dispatchEvent(new PointerEvent("pointerdown", o));
        el.dispatchEvent(new PointerEvent("pointermove", { ...o, clientY: r.y + 5 + d }));
        el.dispatchEvent(new PointerEvent("pointerup", { ...o, clientY: r.y + 5 + d }));
      },
      ALARM_TIME,
      dy,
    );
  const hour = async () => Number((await field()).value.split(":")[0]) % 12;
  // From 1 o'clock, so it doesn't wrap round (on a 12-hour clock it wraps within AM/PM).
  await app.press(`${ALARM_TIME} .part.hour`, ["1"]);
  const h0 = await hour();
  await drag(-16);
  const h1 = await hour();
  await drag(-48);
  const h2 = await hour();
  await drag(32);
  const h3 = await hour();
  assert.ok(h1 > h0 && h2 - h1 > h1 - h0 && h3 < h2, `${h0} ${h1} ${h2} ${h3}`);
  if (twelve) {
    // 12 → 1 keeps AM/PM; clicking AM/PM flips it.
    await app.press(`${ALARM_TIME} .part.hour`, ["1", "2"]);
    const before = (await field()).period;
    await app.press(`${ALARM_TIME} .part.hour`, ["ArrowUp"]);
    f = await field();
    assert.deepEqual([f.hour, f.period], ["1", before]);
    await app.b.execute((s) => {
      const el = document.querySelector(`${s} .part.period`);
      const o = { bubbles: true, pointerId: 1, clientX: 1, clientY: 1 };
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new PointerEvent("pointerup", o));
    }, ALARM_TIME);
    assert.notEqual((await field()).period, before);
  } else {
    assert.equal((await field()).period, null);
  }
  // A time slot in the Modes tab: changed, then kept after leaving the tab.
  await app.tab("modes");
  const quiet = ".modes .time-field";
  const start = await app.b.execute(() => document.querySelector(".modes .time-field").value);
  await app.b.execute(() => {
    const el = document.querySelector(".modes .time-field .part.minute");
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  });
  await app.sleep(1200);
  await app.tab("alarms");
  await app.tab("modes");
  const after = await app.b.execute(() => document.querySelector(".modes .time-field").value);
  assert.notEqual(after, start, quiet);
  assert.equal((await app.settings()).modes.workday[0].start, after);
});

check("alarm.repeat", "Every day and Weekdays alarms say so, and the next ring is on a right day", async () => {
  const app = await page();
  await clearAll();
  await chooseRepeat("daily");
  await addFromForm("Daily one");
  await chooseRepeat("weekdays");
  await addFromForm("Work one");
  assert.match((await row("Daily one")).sub, /^Every day/);
  assert.match((await row("Work one")).sub, /^Weekdays/);
  const work = (await alarms()).find((a) => a.label === "Work one");
  const day = new Date(work.nextFire).getDay();
  assert.ok(day >= 1 && day <= 5, `next ring on day ${day}`);
});

check("alarm.custom-days", "the Repeat menu and the day picker follow each other", async () => {
  const app = await page();
  await clearAll();
  await chooseRepeat("none");
  assert.equal((await pickerState()).shown, false);
  await chooseRepeat("daily");
  assert.equal((await pickerState()).shown, false);
  await chooseRepeat("weekdays");
  let s = await pickerState();
  assert.equal(s.shown, true);
  assert.deepEqual(s.on, ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
  await chooseRepeat("weekends");
  assert.deepEqual((await pickerState()).on, ["Saturday", "Sunday"]);
  await chooseRepeat("weekdays");
  await clickDay("Monday");
  assert.equal((await pickerState()).choice, "days");
  await clickDay("Monday");
  assert.equal((await pickerState()).choice, "weekdays");
  await clickDay("Saturday");
  assert.equal((await pickerState()).choice, "days");
  // Only Saturday and Sunday by hand: Weekends.
  for (const d of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Sunday"]) await clickDay(d);
  assert.equal((await pickerState()).choice, "weekends");
  // Custom days from Once: today is ticked; none ticked: Add is greyed out.
  await chooseRepeat("none");
  await chooseRepeat("days");
  s = await pickerState();
  const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
  assert.deepEqual(s.on, [today]);
  await clickDay(today);
  assert.equal((await pickerState()).addDisabled, true);
  // Once, Weekends and Mon/Wed/Fri alarms.
  await chooseRepeat("none");
  await addFromForm("One-off");
  await chooseRepeat("weekends");
  await addFromForm("Lie-in");
  // From Once, Custom days starts with just today.
  await chooseRepeat("none");
  await chooseRepeat("days");
  for (const d of ["Monday", "Wednesday", "Friday"]) if (d !== today) await clickDay(d);
  if (!["Monday", "Wednesday", "Friday"].includes(today)) await clickDay(today);
  assert.deepEqual((await pickerState()).on, ["Monday", "Wednesday", "Friday"]);
  await addFromForm("Gym");
  assert.match((await row("One-off")).sub, /^Once · (Today|Tomorrow)$/);
  assert.match((await row("Lie-in")).sub, /^Weekends/);
  assert.match((await row("Gym")).sub, /^Mon, Wed, Fri/);
  const gym = (await alarms()).find((a) => a.label === "Gym");
  assert.ok([1, 3, 5].includes(new Date(gym.nextFire).getDay()));
});

check("alarm.switch", "a switched-off alarm greys out and comes back with the same time", async () => {
  const app = await page();
  await clearAll();
  const a = await addAlarm("Nap", at(1, 14, 0));
  await app.waitText("li.clock-row .title", "Nap");
  const before = (await row("Nap")).big;
  await clickInRow("Nap", "input[role=switch]");
  await app.until(() => document.querySelector("li.clock-row.off"));
  let r = await row("Nap");
  assert.deepEqual([r.off, r.on], [true, false]);
  assert.match(r.sub, /Off/);
  await clickInRow("Nap", "input[role=switch]");
  await app.until(() => !document.querySelector("li.clock-row.off"));
  r = await row("Nap");
  assert.deepEqual([r.on, r.big], [true, before]);
  assert.equal((await alarms()).find((x) => x.id === a.id).enabled, true);
});

check("alarm.skip-once", "switching off a repeating alarm asks: Skip once, Turn off or Cancel", async () => {
  const app = await page();
  await clearAll();
  // Its first ring is the next 7:00, as the form would set it (today's, if not yet past).
  const daily = await addAlarm("Morning", at(new Date().getHours() < 7 ? 0 : 1, 7, 0), "daily");
  await addAlarm("Once only", at(1, 8, 0));
  await app.waitText("li.clock-row .title", "Once only");
  await clickInRow("Morning", "input[role=switch]");
  await app.until(() => document.querySelector(".ask"));
  const dialog = await app.b.execute(() => [...document.querySelectorAll(".ask p, .ask button")].map((e) => e.textContent));
  assert.equal(dialog[0], "Morning");
  assert.equal(dialog[1], "Every day");
  assert.match(dialog[2], /^Skip once · .*7:00\s?AM \((Today|Tomorrow)\)$/);
  assert.deepEqual(dialog.slice(3), ["Turn off repeating alarm", "Cancel"]);
  // Esc: nothing changes.
  await app.b.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  await app.until(() => !document.querySelector(".ask"));
  assert.equal((await row("Morning")).on, true);
  // Skip once: still on, the chip shows, the next ring moves a day on.
  const next = (await alarms()).find((a) => a.id === daily.id).nextFire;
  await clickInRow("Morning", "input[role=switch]");
  await app.click(".ask button", "Skip once");
  await app.waitText("li.clock-row .chip.skip", "Skips");
  assert.equal((await row("Morning")).on, true);
  const skipped = (await alarms()).find((a) => a.id === daily.id);
  assert.equal(skipped.nextFire - next, DAY);
  // Already skipped: only Turn off and Cancel.
  await clickInRow("Morning", "input[role=switch]");
  await app.until(() => document.querySelector(".ask"));
  assert.deepEqual(await app.texts(".ask button"), ["Turn off repeating alarm", "Cancel"]);
  await app.click(".ask button", "Cancel");
  // Undo the skip.
  await app.click("li.clock-row .chip.skip button.link", "Undo");
  await app.waitNoText("li.clock-row .chip", "Skips");
  assert.equal((await alarms()).find((a) => a.id === daily.id).nextFire, next);
  // Turn off.
  await clickInRow("Morning", "input[role=switch]");
  await app.click(".ask button", "Turn off repeating alarm");
  await app.until(() => document.querySelector("li.clock-row.off"));
  // A one-off alarm switches off without asking.
  await clickInRow("Once only", "input[role=switch]");
  await app.sleep(400);
  assert.equal(await app.b.execute(() => document.querySelector(".ask")), null);
  assert.equal((await alarms()).find((a) => a.label === "Once only").enabled, false);
});

check("alarm.delete", "✕ deletes an alarm", async () => {
  const app = await page();
  await clearAll();
  await addAlarm("Bin night", at(1, 19, 0));
  await app.waitText("li.clock-row .title", "Bin night");
  await clickInRow("Bin night", "button.delete");
  await app.waitText("p.empty", "No alarms set.");
  assert.equal((await alarms()).length, 0);
});

check("alarm.edit", "✎ fills the form; Save changes only that alarm and switches it on; Cancel changes nothing", async () => {
  const app = await page();
  await clearAll();
  // Tue, Thu, Sat.
  const a = await addAlarm("Swim", at(1, 6, 30), "days", (1 << 2) | (1 << 4) | (1 << 6));
  await addAlarm("Other", at(1, 9, 0));
  await app.waitText("li.clock-row .title", "Swim");
  await clickInRow("Swim", "button.edit");
  await app.waitText(".edit-head h3", "Edit alarm · Swim");
  assert.equal(await app.text("section > .row button.primary"), "Save");
  assert.equal((await row("Swim")).editing, true);
  let s = await pickerState();
  assert.deepEqual([s.choice, s.on], ["days", ["Tuesday", "Thursday", "Saturday"]]);
  assert.equal(await app.b.execute(() => document.querySelector("section > .row input[placeholder=Label]").value), "Swim");
  assert.equal((await field()).value, "06:30");
  for (const d of ["Tuesday", "Thursday", "Saturday", "Monday", "Wednesday", "Friday"]) await clickDay(d);
  await app.type("section > .row input[placeholder=Label]", "Swim club");
  await app.click("section > .row button.primary", "Save");
  await app.waitText("li.clock-row .title", "Swim club");
  const list = await alarms();
  assert.equal(list.length, 2);
  const swim = list.find((x) => x.id === a.id);
  assert.equal(swim.label, "Swim club");
  assert.match((await row("Swim club")).sub, /^Mon, Wed, Fri/);
  assert.equal(await app.b.execute(() => document.querySelector(".edit-head")), null);
  // A switched-off alarm saved with ✎ is on again.
  await app.invoke("set_alarm_enabled", { id: a.id, enabled: false });
  await app.until(() => document.querySelector("li.clock-row.off"));
  await clickInRow("Swim club", "button.edit");
  await app.click("section > .row button.primary", "Save");
  await app.until(() => !document.querySelector("li.clock-row.off"));
  // Cancel changes nothing.
  await clickInRow("Other", "button.edit");
  await app.type("section > .row input[placeholder=Label]", "Changed");
  await app.click(".edit-head button.link", "Cancel");
  assert.ok((await alarms()).some((x) => x.label === "Other"));
  // Deleted while being edited: back to New alarm.
  await clickInRow("Other", "button.edit");
  await clickInRow("Other", "button.delete");
  await app.until(() => !document.querySelector(".edit-head"));
  assert.equal(await app.text("section > .row button.primary"), "Add");
});

check("alarm.list-order", "soonest ring first, a snoozed one by its snooze, switched-off ones last", async () => {
  const app = await page();
  await clearAll();
  await addAlarm("Tomorrow 7", at(1, 7, 0));
  const work = await addAlarm("Weekdays 8", at(1, 8, 0), "weekdays");
  await addAlarm("In 2 days", at(2, 6, 0));
  const off = await addAlarm("Off one", at(1, 5, 0));
  const snoozed = await addAlarm("Snoozed", at(2, 10, 0));
  await app.invoke("set_alarm_enabled", { id: off.id, enabled: false });
  await app.invoke("snooze_alarm", { id: snoozed.id, minutes: 5 });
  await app.waitText("li.clock-row .title", "Snoozed");
  await app.sleep(500);
  const list = (await alarms()).filter((a) => a.label !== "Off one").sort((a, b) => a.nextFire - b.nextFire).map((a) => a.label);
  assert.equal(list[0], "Snoozed");
  assert.deepEqual(await rowTitles(), [...list, "Off one"]);
  assert.ok((await row("Snoozed")).chips.some((c) => c.startsWith("💤")));
  void work;
});

check("alarm.new-time-now", "a half-set alarm survives a refresh; leaving the tab starts again from now", async () => {
  const app = await page();
  await app.tab("todos");
  await app.tab("alarms");
  await app.press(`${ALARM_TIME} .part.hour`, ["ArrowUp", "ArrowUp"]);
  await app.type("section > .row input[placeholder=Label]", "half done");
  const set = (await field()).value;
  // A timer starts: the page redraws.
  await app.invoke("add_alarm", { label: "Timer: 5 min", at: Date.now() + 5 * 60_000, repeat: "none", days: null });
  await app.waitText("h3", "Timers");
  assert.equal((await field()).value, set);
  assert.equal(await app.b.execute(() => document.querySelector("section > .row input[placeholder=Label]").value), "half done");
  await app.tab("todos");
  await app.tab("alarms");
  const now = new Date();
  const [h, m] = (await field()).value.split(":").map(Number);
  assert.ok(Math.abs(h * 60 + m - (now.getHours() * 60 + now.getMinutes())) <= 1);
  assert.equal(await app.b.execute(() => document.querySelector("section > .row input[placeholder=Label]").value), "");
});

check("alarm.finished", "Finished lists rang and missed alarms, the missed one marked; Clear empties it", async () => {
  const app = await page();
  await clearAll();
  const rang = await addAlarm("Rang one", at(1, 6, 0));
  const missed = await addAlarm("Missed one", at(1, 7, 0));
  await app.invoke("dismiss_alarm", { id: rang.id });
  await app.invoke("mark_alarm_missed", { id: missed.id });
  await app.invoke("dismiss_alarm", { id: missed.id });
  await app.waitText("details.finished summary", "Finished (2)");
  // (Rang and missed for real are checked when they ring; here they're marked directly.)
  const subs = await app.texts("li.finished-row .sub");
  const titles = await app.texts("li.finished-row .title");
  assert.deepEqual([...titles].sort(), ["Missed one", "Rang one"]);
  assert.match(subs[titles.indexOf("Missed one")], /^Missed · /);
  assert.match(subs[titles.indexOf("Rang one")], /^Rang\b/);
  assert.equal(await app.b.execute(() => document.querySelector("li.finished-row .sub.missed") !== null), true);
  await app.click("details.finished summary button.clear", "Clear");
  await app.until(() => !document.querySelector("details.finished"));
  assert.equal((await alarms()).length, 0);
});

// --- Quick timers ------------------------------------------------------------------

const quick = () => ctx.app.texts("section > .row.wrap > button, section > .row.wrap .custom-chip button.custom");

check("quick.row", "Quick timer: the presets, then your custom ones (dashed)", async () => {
  const app = await page();
  await app.invoke("set_settings", { settings: { ...(await app.settings()), recentTimers: [90, 25] } });
  await app.tab("todos");
  await app.tab("alarms");
  assert.deepEqual(await quick(), ["1m", "5m", "10m", "15m", "30m", "45m", "1h", "1h30m", "25m"]);
  assert.equal(await app.b.execute(() => document.querySelectorAll("section > .row.wrap .custom-chip button.custom").length), 2);
});

check("quick.edit", "✎ on a custom one puts it in the box; Enter replaces it in place", async () => {
  const app = await page();
  await app.b.execute(() => [...document.querySelectorAll(".custom-chip")].find((c) => c.textContent.includes("25m")).querySelector("button[title='Change this one']").click());
  assert.equal(await app.b.execute(() => document.querySelector("input.custom-timer").value), "25");
  assert.match(await app.text(".custom-row .hint"), /^25m → /);
  await app.type("input.custom-timer", "40", { enter: true });
  await app.waitText(".custom-chip button.custom", "40m");
  assert.deepEqual((await app.settings()).recentTimers, [90, 40]);
});

check("quick.forget", "✕ forgets a custom one (here and in the pet's menu)", async () => {
  const app = await page();
  await app.b.execute(() => [...document.querySelectorAll(".custom-chip")].find((c) => c.textContent.includes("40m")).querySelector("button[title='Forget this one']").click());
  await app.waitNoText(".custom-chip button.custom", "40m");
  assert.deepEqual((await app.settings()).recentTimers, [90]);
});

check("quick.custom-input", "a custom length in the box starts a timer with a countdown and Cancel", async () => {
  const app = await page();
  await clearAll();
  await app.type("input.custom-timer", "2h", { enter: true });
  await app.waitText("h3", "Timers");
  assert.match(await app.text("ul.clocks li .title"), /2 hours? timer/);
  assert.match(await app.text("ul.clocks li .countdown"), /^(119|120):\d{2}$/);
  assert.ok((await app.texts("ul.clocks li button")).includes("Cancel"));
  // A gap between the buttons and the box.
  const gap = await app.b.execute(() => document.querySelector(".custom-row").getBoundingClientRect().top - document.querySelector("section > .row.wrap").getBoundingClientRect().bottom);
  assert.ok(gap >= 6, `gap ${gap}`);
});
