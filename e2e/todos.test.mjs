import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const DAY = 86_400_000;

/** Local midnight `days` from today, plus `h:m`. */
function at(days, h = 0, m = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** The panel on To-dos (each test can run on its own). */
async function todosPage() {
  await ctx.app.panel("todos");
  return ctx.app;
}
async function add(todo) {
  return ctx.app.invoke("add_todo", { todo: { allDay: false, repeat: "none", dueAt: null, ...todo } });
}
async function todos() {
  return ctx.app.invoke("list_todos");
}
async function clearAll() {
  for (const t of await todos()) await ctx.app.invoke("delete_todo", { id: t.id });
}
/** Types into the to-do box from an empty one (so it parses afresh) and returns the hint. */
async function typeTodo(text) {
  const app = ctx.app;
  await app.type(".todos input[type=text]", "");
  await app.type(".todos input[type=text]", text);
  return app.text(".todos > .hint");
}

check("install.version", "the panel shows the app's version", async () => {
  const app = ctx.app;
  await app.panel("settings");
  const footer = await app.until(() => document.querySelector("footer")?.innerText);
  const version = await app.invoke("plugin:app|version");
  assert.ok(footer.includes(`ePet ${version} `), footer);
});

check("todo.parse-time", "“call mom at 3pm” gives the title and a 3 PM reminder", async () => {
  const app = await todosPage();
  const hint = await typeTodo("call mom at 3pm");
  assert.match(hint, /⏰ .*3:00\s?PM — “call mom”/i);
  await app.click(".todos .row button.primary", "Add");
  await app.waitText(".todos .list .title", "call mom");
  const t = (await todos()).find((x) => x.title === "call mom");
  const d = new Date(t.dueAt);
  assert.deepEqual([d.getHours(), d.getMinutes(), t.allDay], [15, 0, false]);
});

check("todo.parse-more", "times in several forms, and a note with no reminder", async () => {
  await todosPage();
  assert.match(await typeTodo("standup tomorrow 9:30"), /⏰ Tomorrow 9:30\s?AM — “standup”/);
  const stretch = await typeTodo("stretch in 20m");
  assert.match(stretch, /⏰ .* — “stretch”/);
  assert.match(await typeTodo("pay rent fri 10am"), /⏰ .*10:00\s?AM — “pay rent”/);
  assert.equal(await typeTodo("just a note"), "No reminder — “just a note”");
  assert.equal(await ctx.app.b.execute(() => document.querySelector(".todos .when-row .date-field")), null);
});

check("todo.day-only", "a day without a time: date field, “+ Time”, hint, list shows the day", async () => {
  const app = await todosPage();
  await clearAll();
  const hint = await typeTodo("buy milk today");
  assert.match(hint, /^📅 Today — “buy milk” · reminds at 9:00\s?AM that day$/);
  assert.ok(await app.b.execute(() => !!document.querySelector(".todos .when-row .date-field")));
  assert.equal(await app.text(".todos .when-row .add-when"), "+ Time");
  await app.click(".todos .row button.primary", "Add");
  await app.waitText(".todos .list .title", "buy milk");
  const when = await app.text(".todos .list li .when");
  assert.equal(when, "Today");
  const t = (await todos())[0];
  assert.equal(t.allDay, true);
  assert.ok(sameDay(t.dueAt, Date.now()));
  // A weekday a few days on shows as that day, without a time.
  assert.match(await typeTodo("dentist fri"), /^📅 .+ — “dentist” · reminds at/);
});

check("todo.date-field", "the date field drags, scrolls, takes keys and typing; ✕ removes it", async () => {
  const app = await todosPage();
  await typeTodo("");
  await app.click(".todos .when-row .add-when", "+ Date");
  const value = () => app.b.execute(() => {
    const f = document.querySelector(".todos .when-row .date-field");
    return f && { day: f.querySelector(".part.day").textContent, month: f.querySelector(".part.month").textContent, year: f.querySelector(".part.year").textContent, weekday: f.querySelector(".weekday").textContent };
  });
  const start = await value();
  assert.ok(start, "date field shown");
  // ↑ on the day: the next day (and its weekday).
  await app.press(".todos .date-field .part.day", ["ArrowUp"]);
  const up = await value();
  assert.notEqual(up.weekday, start.weekday);
  // The 31st (typed), then November (typed): the day becomes the 30th.
  await app.press(".todos .date-field .part.month", ["1"]);
  await app.press(".todos .date-field .part.day", ["3", "1"]);
  assert.equal((await value()).day, "31");
  await app.press(".todos .date-field .part.month", ["1", "1"]);
  const nov = await value();
  assert.match(nov.month, /Nov/);
  assert.equal(nov.day, "30");
  // The wheel and dragging change it too.
  const before = (await value()).day;
  await app.b.execute(() => document.querySelector(".todos .date-field .part.day").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true })));
  assert.notEqual((await value()).day, before);
  await app.b.execute(() => {
    const el = document.querySelector(".todos .date-field .part.day");
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, pointerId: 1, clientX: r.x + 5, clientY: r.y + 5 };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointermove", { ...o, clientY: r.y + 5 + 40 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, clientY: r.y + 5 + 40 }));
  });
  assert.notEqual((await value()).day, before);
  // Up from 30 wraps to 1 without changing the month.
  await app.press(".todos .date-field .part.day", ["3", "0"]);
  await app.press(".todos .date-field .part.day", ["ArrowUp"]);
  const wrapped = await value();
  assert.deepEqual([wrapped.day, wrapped.month], ["1", nov.month]);
  // ✕: back to "+ Date", and Repeat can't be picked.
  await app.click(".todos .date-field .mini");
  assert.equal(await app.text(".todos .when-row .add-when"), "+ Date");
  assert.equal(await app.b.execute(() => document.querySelector(".todos .when-row select.repeat").disabled), true);
});

check("todo.time-toggle", "“+ Time” becomes a time field and back; a typed time shows one", async () => {
  const app = await todosPage();
  await app.click(".todos .when-row .add-when", "+ Date");
  await app.click(".todos .when-row .add-when", "+ Time");
  assert.ok(await app.b.execute(() => !!document.querySelector(".todos .when-row .time-field:not(.date-field)")));
  await app.click(".todos .when-row .time-field:not(.date-field) .mini");
  assert.equal(await app.text(".todos .when-row .add-when"), "+ Time");
  const hint = await typeTodo("call mom tomorrow 3pm");
  assert.match(hint, /^⏰ Tomorrow 3:00\s?PM/);
  assert.ok(await app.b.execute(() => !!document.querySelector(".todos .when-row .time-field:not(.date-field)")));
});

check("todo.repeat-parse", "“every tue”, “daily”, “monthly 1st”… pick the repeat and the next day", async () => {
  const app = await todosPage();
  const repeat = () => app.b.execute(() => document.querySelector(".todos .when-row select.repeat").value);
  const cases = [
    ["bins every tue", "weekly", "bins"],
    ["recycling every other thu", "fortnightly", "recycling"],
    ["water plants daily", "daily", "water plants"],
    ["pay bills monthly 1st", "monthly", "pay bills"],
    ["review budget quarterly", "quarterly", "review budget"],
    ["car rego yearly on the 20th", "yearly", "car rego"],
  ];
  for (const [text, r, title] of cases) {
    const hint = await typeTodo(text);
    assert.equal(await repeat(), r, text);
    assert.ok(hint.includes(`“${title}”`), `${text}: ${hint}`);
  }
  assert.match(await typeTodo("bins every tue 7pm"), /7:00\s?PM — “bins” · 🔁/);
  // "every tue" is the next Tuesday, today if it's Tuesday.
  await typeTodo("bins every tue");
  await app.click(".todos .row button.primary", "Add");
  await app.waitText(".todos .list .title", "bins");
  const bins = (await todos()).find((t) => t.title === "bins");
  const d = new Date(bins.dueAt);
  assert.equal(d.getDay(), 2);
  assert.ok(bins.dueAt >= at(0) && bins.dueAt < at(7));
  // Changed by hand, the row stays as it is while typing goes on.
  await typeTodo("water plants daily");
  await app.b.execute(() => {
    const s = document.querySelector(".todos .when-row select.repeat");
    s.value = "weekly";
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await app.b.execute(() => {
    const i = document.querySelector(".todos input[type=text]");
    i.value += " x";
    i.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await repeat(), "weekly");
});

check("todo.sections", "Today (overdue, timed, day, no date) and a folded Upcoming that stays open", async () => {
  const app = await todosPage();
  await clearAll();
  await add({ title: "late", dueAt: at(-1, 10) });
  await add({ title: "timed", dueAt: at(0, 23, 59) });
  await add({ title: "day", dueAt: at(0), allDay: true });
  await add({ title: "whenever" });
  await add({ title: "soon", dueAt: at(3, 9) });
  await add({ title: "later", dueAt: at(5, 9) });
  await app.waitText(".todos .upcoming summary", "Upcoming (2)");
  const h3 = await app.texts(".todos h3");
  assert.ok(h3.some((t) => /Today \(4\)/i.test(t)), h3.join("|"));
  const today = await app.texts(".todos > ul.list > li .title");
  assert.deepEqual(today, ["late", "timed", "day", "whenever"]);
  assert.match(await app.text(".todos > ul.list > li .when"), /Overdue/);
  assert.equal(await app.b.execute(() => document.querySelector(".todos > ul.list > li .when").classList.contains("overdue")), true);
  assert.match(await app.text(".todos .upcoming summary"), /Upcoming \(2\) · next /);
  assert.equal(await app.b.execute(() => document.querySelector(".todos .upcoming").open), false);
  await app.b.execute(() => document.querySelector(".todos .upcoming summary").click());
  // Re-rendered (as when the panel is opened again), it stays open.
  await app.tab("alarms");
  await app.tab("todos");
  assert.equal(await app.b.execute(() => document.querySelector(".todos .upcoming").open), true);
  await clearAll();
  await app.waitText(".todos .empty", "Nothing for today. Your pet approves.");
});

check("todo.repeat-tick", "ticking a repeating to-do logs it and moves it on", async () => {
  const app = await todosPage();
  await clearAll();
  const bins = await add({ title: "bins", dueAt: at(0), allDay: true, repeat: "weekly" });
  await app.waitText(".todos .list .title", "bins");
  await app.b.execute(() => [...document.querySelectorAll(".todos .list li")].find((li) => li.textContent.includes("bins")).querySelector("input[type=checkbox]").click());
  await app.waitText(".todos details.finished:not(.upcoming) summary", "Done (1)");
  const after = (await todos()).find((t) => t.id === bins.id);
  assert.equal(after.done, false);
  assert.ok(sameDay(after.dueAt, at(7)));
  assert.match(await app.text(".todos .list li .when .rep"), /Weekly/);
  // Three weeks behind: only the next one from today, not three.
  const old = await add({ title: "old", dueAt: at(-21, 9), repeat: "weekly" });
  await app.invoke("update_todo", { id: old.id, patch: { done: true } });
  const moved = (await todos()).find((t) => t.id === old.id);
  assert.ok(moved.dueAt > Date.now() && moved.dueAt <= at(8), new Date(moved.dueAt).toString());
  assert.equal((await todos()).filter((t) => t.title === "old" && t.done).length, 1);
  // Monthly on the 31st: Jan 31 → Feb 28 → Mar 31.
  const y = new Date().getFullYear() + 1;
  const m31 = await add({ title: "rent", dueAt: new Date(y, 0, 31, 9).getTime(), repeat: "monthly" });
  await app.invoke("update_todo", { id: m31.id, patch: { done: true } });
  const feb = new Date((await todos()).find((t) => t.id === m31.id).dueAt);
  await app.invoke("update_todo", { id: m31.id, patch: { done: true } });
  const mar = new Date((await todos()).find((t) => t.id === m31.id).dueAt);
  assert.deepEqual([feb.getMonth(), feb.getDate(), mar.getMonth(), mar.getDate()], [1, new Date(y, 2, 0).getDate(), 2, 31]);
});

check("todo.untick-undo", "unticking a repeating to-do in Done undoes the tick", async () => {
  const app = await todosPage();
  await clearAll();
  const fort = await add({ title: "fortnight", dueAt: at(2, 9), repeat: "fortnightly" });
  await app.invoke("update_todo", { id: fort.id, patch: { done: true } });
  assert.ok(sameDay((await todos()).find((t) => t.id === fort.id).dueAt, at(16)));
  await app.waitText(".todos details.finished:not(.upcoming) summary", "Done (1)");
  await app.b.execute(() => document.querySelector(".todos details.finished:not(.upcoming) li input[type=checkbox]").click());
  await app.waitNoText(".todos details.finished:not(.upcoming) summary", "Done (1)");
  let list = await todos();
  assert.equal(list.length, 1, JSON.stringify(list));
  assert.ok(sameDay(list[0].dueAt, at(2)));
  // Today's daily: back to today.
  const daily = await add({ title: "daily", dueAt: at(0), allDay: true, repeat: "daily" });
  await app.invoke("update_todo", { id: daily.id, patch: { done: true } });
  const log = (await todos()).find((t) => t.done && t.title === "daily");
  await app.invoke("update_todo", { id: log.id, patch: { done: false } });
  list = await todos();
  assert.ok(sameDay(list.find((t) => t.id === daily.id).dueAt, at(0)));
  assert.equal(list.filter((t) => t.title === "daily").length, 1);
  // Ticked, then the to-do deleted: unticking its record makes a plain one-off to-do.
  await app.invoke("update_todo", { id: daily.id, patch: { done: true } });
  const record = (await todos()).find((t) => t.done && t.title === "daily");
  await app.invoke("delete_todo", { id: daily.id });
  await app.invoke("update_todo", { id: record.id, patch: { done: false } });
  const left = (await todos()).find((t) => t.id === record.id);
  assert.deepEqual([left.done, left.repeat], [false, "none"]);
});

check("todo.edit", "✎ fills the form; Save changes only that to-do; Cancel changes nothing", async () => {
  const app = await todosPage();
  await clearAll();
  await add({ title: "first", dueAt: at(0), allDay: true });
  const second = await add({ title: "second" });
  await app.waitText(".todos .list .title", "second");
  const editRow = (title) => app.b.execute((t) => [...document.querySelectorAll(".todos .list li")].find((li) => li.querySelector(".title").textContent === t).querySelector("button.edit").click(), title);
  await editRow("second");
  await app.waitText(".todos .edit-head h3", "Edit to-do · second");
  assert.equal(await app.text(".todos .row button.primary"), "Save");
  assert.equal(await app.b.execute(() => document.querySelector(".todos input[type=text]").value), "second");
  assert.ok(await app.b.execute(() => [...document.querySelectorAll(".todos .list li.editing")].length === 1));
  await app.type(".todos input[type=text]", "second, renamed");
  await app.click(".todos .when-row .add-when", "+ Date");
  await app.click(".todos .when-row .add-when", "+ Time");
  await app.b.execute(() => {
    const s = document.querySelector(".todos .when-row select.repeat");
    s.value = "weekly";
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await app.click(".todos .row button.primary", "Save");
  await app.waitText(".todos .list .title", "second, renamed");
  let list = await todos();
  assert.equal(list.length, 2);
  const changed = list.find((t) => t.id === second.id);
  assert.deepEqual([changed.title, changed.allDay, changed.repeat], ["second, renamed", false, "weekly"]);
  assert.ok(changed.dueAt !== null);
  // Cancel: nothing changes.
  await editRow("first");
  await app.type(".todos input[type=text]", "nope");
  await app.click(".todos .edit-head button.link", "Cancel");
  assert.equal(await app.text(".todos .row button.primary"), "Add");
  assert.ok((await todos()).some((t) => t.title === "first"));
  // Ticked off while being edited: back to a new to-do.
  await editRow("first");
  await app.b.execute(() => [...document.querySelectorAll(".todos .list li")].find((li) => li.querySelector(".title").textContent === "first").querySelector("input[type=checkbox]").click());
  await app.until(() => document.querySelector(".todos .row button.primary")?.textContent === "Add");
  assert.equal(await app.b.execute(() => document.querySelector(".todos .edit-head")), null);
  // Done to-dos have no ✎.
  assert.equal(await app.b.execute(() => document.querySelector(".todos details.finished:not(.upcoming) li button.edit")), null);
});

check("todo.done-time", "Done shows when each was ticked, latest first; times without a leading 0", async () => {
  const app = await todosPage();
  await clearAll();
  const a = await add({ title: "aaa", dueAt: at(0, 9, 5) });
  const b = await add({ title: "bbb" });
  await app.waitText(".todos .list .title", "aaa");
  assert.match(await app.text(".todos .list li .when"), /(Overdue · )?Today 9:05\s?AM/);
  await app.invoke("update_todo", { id: a.id, patch: { done: true } });
  await app.sleep(1100);
  await app.invoke("update_todo", { id: b.id, patch: { done: true } });
  await app.waitText(".todos details.finished:not(.upcoming) summary", "Done (2)");
  assert.deepEqual(await app.texts(".todos details.finished:not(.upcoming) li .title"), ["bbb", "aaa"]);
  const whens = await app.texts(".todos details.finished:not(.upcoming) li .when");
  assert.ok(whens.every((w) => /^Done · Today \d{1,2}:\d{2}/.test(w) && !/Today 0\d/.test(w)), whens.join("|"));
});

check("todo.clear", "Clear empties Done", async () => {
  const app = await todosPage();
  await app.click(".todos details.finished:not(.upcoming) summary button.clear", "Clear");
  await app.until(() => !document.querySelector(".todos details.finished:not(.upcoming)"));
  assert.equal((await todos()).filter((t) => t.done).length, 0);
});
