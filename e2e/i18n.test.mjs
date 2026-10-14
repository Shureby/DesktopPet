import assert from "node:assert/strict";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);

/** Sets the language and region (and waits for the pet to have them). */
function locale(language, region = "auto") {
  return ctx.app.setSettings((s) => ({ ...s, locale: { language, region } }));
}
const trayTexts = async () => (await ctx.app.menu("tray")).map((i) => (typeof i === "string" ? i : i.text));
const tabs = () => ctx.app.texts("nav button[data-tab]");

check("i18n.switch", "Settings → Language: the tray, the pet's menu and the panel say it at once, in Simplified or Traditional Chinese; Auto (English here)", async () => {
  const app = ctx.app;
  await app.closeWindow("panel");
  try {
    await locale("zh-CN");
    assert.ok((await trayTexts()).includes("打开面板…"), "tray in Simplified Chinese");
    assert.ok((await trayTexts()).some((x) => x === "隐藏宠物" || x === "显示宠物"));
    await app.panel("settings");
    assert.deepEqual((await tabs()).slice(0, 3), ["待办", "闹钟", "专注"]);
    await app.waitText(".settings h3", "语言和地区");
    // Picked in the panel: everything switches without a restart.
    await app.b.execute(() => {
      const s = document.querySelector(".box.locale select.language");
      s.value = "zh-TW";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await app.b.waitUntil(async () => (await tabs())[1] === "鬧鐘", { timeout: 5000 });
    assert.equal((await app.fullSettings()).locale.language, "zh-TW");
    await app.b.waitUntil(async () => (await trayTexts()).includes("開啟面板…"), { timeout: 5000 });
  } finally {
    await locale("auto");
  }
  await app.panel("settings");
  await app.b.waitUntil(async () => (await tabs())[1] === "Alarms", { timeout: 5000 });
  assert.ok((await trayTexts()).includes("Open panel…"));
});

check("i18n.formats", "times as each language writes them: 16:30 on the mainland, 下午4:30 in Taiwan; the week starts on Monday or Sunday", async () => {
  const app = ctx.app;
  for (const a of await app.invoke("list_alarms")) await app.invoke("delete_alarm", { id: a.id });
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(16, 30, 0, 0);
  await app.invoke("add_alarm", { label: "Tea", at: at.getTime(), repeat: "none", days: null });
  try {
    await locale("zh-CN");
    await app.panel("alarms");
    await app.waitText(".clock-row .big", "16:30");
    await locale("zh-TW");
    await app.panel("alarms");
    await app.waitText(".clock-row .big", "下午4:30");
    // Taiwan's week starts on Sunday (日), the mainland's on Monday (一).
    await app.panel("modes");
    const first = () => app.b.execute(() => document.querySelector(".day-picker button")?.textContent);
    assert.equal(await first(), "日");
    await locale("zh-CN");
    await app.panel("modes");
    await app.b.waitUntil(async () => (await first()) === "一", { timeout: 5000 });
  } finally {
    await locale("auto");
    for (const a of await app.invoke("list_alarms")) await app.invoke("delete_alarm", { id: a.id });
  }
});

check("region.holidays", "Settings → Region: the Holiday template offers that region's holidays (Taiwan: Double Tenth Day; Singapore: Deepavali; Other: Thanksgiving)", async () => {
  const app = ctx.app;
  const holidays = async () => {
    await app.panel("todos");
    if (!(await app.b.execute(() => document.querySelector(".ann-form")))) {
      await app.click(".subtabs button", "Anniversaries");
      await app.until(() => document.querySelector(".ann-form"));
    }
    await app.b.execute(() => {
      const s = document.querySelector(".ann-form select.ann-type");
      s.value = "holiday";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await app.sleep(300);
    return app.b.execute(() => [...document.querySelectorAll(".ann-holiday option")].map((o) => o.textContent));
  };
  try {
    await locale("en", "TW");
    let list = await holidays();
    assert.ok(list.some((o) => o.endsWith("Double Tenth Day")), list.join(", "));
    assert.ok(!list.some((o) => o.endsWith("Thanksgiving (US)")));
    await locale("en", "SG");
    await app.closeWindow("panel");
    list = await holidays();
    assert.ok(list.some((o) => o.endsWith("Deepavali")) && list.some((o) => o.endsWith("Hari Raya Puasa")), list.join(", "));
    await locale("en", "other");
    await app.closeWindow("panel");
    list = await holidays();
    assert.ok(list.some((o) => o.endsWith("Thanksgiving (US)")), list.join(", "));
  } finally {
    await locale("auto");
    await app.closeWindow("panel");
  }
});

/** Short texts broken over lines (a button, a date, a time, a tab) and a page wider than the window. */
function layoutProblems() {
  const found = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) found.push(`page ${document.documentElement.scrollWidth}px wide`);
  // The modes table's row names may take two lines, never a word or a character per line.
  for (const td of document.querySelectorAll("table.presets td:first-child")) {
    if (td.getBoundingClientRect().width < 4 * parseFloat(getComputedStyle(td).fontSize)) found.push(`“${td.textContent.trim()}” squeezed`);
  }
  // Character cards are buttons holding sentences: those wrap.
  for (const el of document.querySelectorAll("button:not(.card), .nobr, .time-field, nav, .chip, .soon, table.presets th")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const ys = [];
    while (walk.nextNode()) {
      if (!walk.currentNode.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walk.currentNode);
      for (const q of range.getClientRects()) if (q.width > 1) ys.push(q.top + q.height / 2);
    }
    const size = parseFloat(getComputedStyle(el).fontSize) || 14;
    if (ys.length > 1 && Math.max(...ys) - Math.min(...ys) > size * 0.7) found.push(`“${el.textContent.trim().slice(0, 30)}” on two lines`);
  }
  return found;
}

check("panel.layout", "In each language, at the panel's default width and its narrowest: no button, date or time broken over two lines, the modes table readable, and nothing wider than the window", async () => {
  const app = ctx.app;
  const at = new Date();
  at.setDate(at.getDate() + 3);
  at.setHours(16, 30, 0, 0);
  await app.invoke("add_alarm", { label: "Layout", at: at.getTime(), repeat: "none", days: null });
  await app.invoke("add_todo", { todo: { title: "Layout check", dueAt: at.getTime(), allDay: false, repeat: "none" } });
  await app.invoke("add_anniversary", { anniversary: { kind: "remembrance", icon: "🕯️", name: "Layout", month: at.getMonth() + 1, day: at.getDate(), since: 1926, preps: [], effect: true, music: null } });
  const problems = [];
  try {
    for (const language of ["en", "zh-CN", "zh-TW"]) {
      await locale(language);
      await app.closeWindow("panel");
      for (const width of [460, 380]) {
        for (const [tab, open] of [["todos", ".add-when"], ["todos", ".subtabs button:nth-child(2)"], ["alarms"], ["focus"], ["modes"], ["characters"], ["games"], ["settings"]]) {
          await app.panel(tab);
          await app.invoke("e2e_resize", { label: "panel", width, height: 640 });
          await app.sleep(300);
          if (open) await app.b.execute((s) => document.querySelector(s)?.click(), open);
          await app.sleep(300);
          for (const p of await app.b.execute(layoutProblems)) problems.push(`${language} ${width}px ${tab}: ${p}`);
        }
      }
    }
  } finally {
    await locale("auto");
    await app.closeWindow("panel");
    for (const a of await app.invoke("list_alarms")) if (a.label === "Layout") await app.invoke("delete_alarm", { id: a.id });
    for (const it of await app.invoke("list_todos")) if (it.title === "Layout check") await app.invoke("delete_todo", { id: it.id });
    for (const a of await app.invoke("list_anniversaries")) if (a.name === "Layout") await app.invoke("delete_anniversary", { id: a.id });
  }
  assert.deepEqual([...new Set(problems)], []);
}, { timeout: 300_000 });
