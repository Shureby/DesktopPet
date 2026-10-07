/**
 * End-to-end tests against the real built app (README.md, "Automated tests of the real app").
 *
 * Each test file starts ePet with an empty data folder through tauri-driver (WebDriver),
 * drives its windows (the pet and the panel) and records results by checklist id, so CI
 * can tick the matching items in docs/test-checklist.json.
 *
 * Env: EPET_APP (the built executable), TAURI_DRIVER (default "tauri-driver"),
 * NATIVE_DRIVER (msedgedriver on Windows, then used directly, without tauri-driver),
 * E2E_RESULTS (default "e2e-results").
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { remote } from "webdriverio";

const IDENTIFIER = "com.ezyappco.epet";

/** How many ePet processes are running. */
export function appProcesses() {
  if (process.platform === "win32") {
    const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq desktoppet.exe", "/NH", "/FO", "CSV"], { encoding: "utf8" }).stdout ?? "";
    return out.split("\n").filter((l) => l.toLowerCase().includes("desktoppet.exe")).length;
  }
  const out = spawnSync("pgrep", ["-x", "desktoppet"], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").filter(Boolean).length;
}

/** Where the app keeps its database and characters (Tauri's app data dir). */
export function appDataDir() {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), IDENTIFIER);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", IDENTIFIER);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), IDENTIFIER);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class App {
  /** @type {import("webdriverio").Browser} */
  b;
  driver;
  petHandle = "";

  /**
   * Starts ePet with no data (unless `keepData`) and waits for the pet window. `exe` is
   * another build to start (e.g. an installed release, which has no test hooks: `hooks: false`).
   */
  static async launch({ keepData = false, exe = process.env.EPET_APP, hooks = true } = {}) {
    if (!exe) throw new Error("Set EPET_APP to the built ePet executable");
    if (!keepData) rmSync(appDataDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    const app = new App();
    app.exe = exe;
    app.hooks = hooks;
    try {
      await app.start();
    } catch (e) {
      // Nothing left behind for the next file (a leftover would hold single-instance).
      await app.quit();
      throw e;
    }
    return app;
  }

  async start() {
    const application = this.exe;
    let capabilities = { "tauri:options": { application } };
    if (process.platform === "win32" && process.env.NATIVE_DRIVER) {
      // Edge WebDriver directly, as tauri-driver would start it, with a log to read when a
      // session can't start (e2e-results/msedgedriver.log).
      const dir = process.env.E2E_RESULTS ?? "e2e-results";
      mkdirSync(dir, { recursive: true });
      this.driver = spawn(process.env.NATIVE_DRIVER, ["--port=4444", "--verbose", `--log-path=${join(dir, "msedgedriver.log")}`, "--append-log"], {
        stdio: "ignore",
        env: { ...process.env, TAURI_WEBVIEW_AUTOMATION: "true", EPET_E2E: "1" },
      });
      capabilities = { browserName: "webview2", "ms:edgeChromium": true, "ms:edgeOptions": { binary: application, args: [] } };
    } else {
      const args = process.env.NATIVE_DRIVER ? ["--native-driver", process.env.NATIVE_DRIVER] : [];
      this.driver = spawn(process.env.TAURI_DRIVER ?? "tauri-driver", args, {
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env, EPET_E2E: "1" },
      });
    }
    await sleep(1500);
    // Classic WebDriver: with BiDi (WebdriverIO's default) Edge WebDriver opens a tab of its
    // own and doesn't list the app's windows.
    capabilities["wdio:enforceWebDriverClassic"] = true;
    this.b = await remote({ hostname: "127.0.0.1", port: 4444, logLevel: "warn", connectionRetryCount: 1, capabilities });
    // The pet window, whichever window the session started on.
    const seen = new Map();
    const findPet = async () => {
      for (const h of await this.b.getWindowHandles()) {
        await this.b.switchToWindow(h);
        const url = await this.b.getUrl();
        seen.set(h, url);
        if (url.includes("pet.html")) return h;
      }
      return null;
    };
    await this.b
      .waitUntil(async () => (this.petHandle = await findPet()), { timeout: 30_000, interval: 500 })
      .catch((e) => {
        throw new Error(`No pet window; windows: ${JSON.stringify([...seen.values()])} (${e.message})`);
      });
    await this.b.switchToWindow(this.petHandle);
    // The pet page is ready once its canvas has a size.
    await this.b.waitUntil(() => this.b.execute(() => (document.getElementById("pet")?.width ?? 0) > 0), { timeout: 30_000 });
    // And its test hooks (EPET_E2E, debug builds): the pet has started.
    if (!this.hooks) return;
    await this.b
      .waitUntil(() => this.b.execute(() => !!window.__epet), { timeout: 15_000 })
      .catch(() => {
        throw new Error("No test hooks in the pet window: test a debug build (tauri build --debug), started with EPET_E2E");
      });
  }

  /** Quits and starts the app again with the same data; returns the new App. */
  async restart() {
    await this.quit();
    return App.launch({ keepData: true, exe: this.exe, hooks: this.hooks });
  }

  async quit() {
    await this.b?.deleteSession().catch(() => {});
    this.driver?.kill();
    // Nothing may outlive a test file: the next one starts the app afresh (a leftover
    // instance would take its place through single-instance, and lock the data folder).
    if (process.platform === "win32") {
      for (const exe of ["desktoppet.exe", "msedgedriver.exe", "tauri-driver.exe"]) spawnSync("taskkill", ["/F", "/T", "/IM", exe], { stdio: "ignore" });
    } else {
      spawnSync("pkill", ["-f", this.exe ?? process.env.EPET_APP], { stdio: "ignore" });
    }
    await sleep(1000);
  }

  /** A Tauri command from the current window. */
  invoke(cmd, args = {}) {
    return this.b.execute((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), cmd, args);
  }

  /** Settings as stored, merged by the app (`get_settings`). */
  settings() {
    return this.invoke("get_settings");
  }

  async toPet() {
    await this.b.switchToWindow(this.petHandle);
  }

  // --- The pet window's test hooks (window.__epet, PetHost.testHooks) ----------------

  /** A menu ("pet" or "tray") as data: texts, "—" for separators, submenus as { text, items }. */
  async menu(which) {
    await this.toPet();
    return this.b.execute((w) => window.__epet.menu(w), which);
  }

  /** "Clicks" a menu item by path (each step the start of an item's text); returns its text. */
  async run(which, ...path) {
    await this.toPet();
    const text = await this.b.execute((w, p) => window.__epet.run(w, p), which, path);
    await sleep(400);
    return text;
  }

  /** What the pet is doing (state, mode, position, mood, …). */
  async pet() {
    await this.toPet();
    return this.b.execute(() => window.__epet.state());
  }

  /** The pet window's bubble text (spaces collapsed), or null when it's hidden. */
  async bubble() {
    await this.toPet();
    return this.b.execute(() => {
      const b = document.getElementById("bubble");
      if (b.hidden) return null;
      // Its lines (not the buttons), one space between.
      const lines = [...b.children].filter((e) => !e.classList.contains("actions")).map((e) => e.textContent.trim());
      return lines.join(" ").replace(/\s+/g, " ").trim();
    });
  }

  /** Waits until the pet's bubble shows text including `text`; returns the bubble text. */
  async waitBubble(text, timeout = 10_000) {
    await this.toPet();
    await this.waitText("#bubble:not([hidden])", text, timeout);
    return this.bubble();
  }

  /** The badges beside the pet: [{ text, info }]. */
  async badges() {
    await this.toPet();
    return this.b.execute(() =>
      [...document.getElementById("badges").children].map((e) => ({ text: e.textContent, info: e.dataset.info ?? "" })),
    );
  }

  /** Whether a window (by label) is shown. */
  async visible(label) {
    return this.invoke("plugin:window|is_visible", { label });
  }

  /** Switches to the window whose URL includes `part` (waiting for it); returns its handle. */
  async toWindow(part, timeout = 15_000) {
    let found = null;
    await this.b.waitUntil(
      async () => {
        for (const h of await this.b.getWindowHandles()) {
          await this.b.switchToWindow(h);
          if ((await this.b.getUrl()).includes(part)) return (found = h);
        }
        return false;
      },
      { timeout, interval: 300 },
    );
    return found;
  }

  /** Whether a window whose URL includes `part` is open (leaves the pet window current). */
  async hasWindow(part) {
    let found = false;
    for (const h of await this.b.getWindowHandles()) {
      await this.b.switchToWindow(h);
      if ((await this.b.getUrl()).includes(part)) found = true;
    }
    await this.toPet();
    return found;
  }

  /** Waits for the panel and its tab; returns the tab (leaves the panel current). */
  async panelTab(timeout = 15_000) {
    await this.toWindow("panel.html", timeout);
    return this.until(() => document.querySelector("nav button.active")?.dataset.tab, [], timeout);
  }

  /** Changes settings: `change` gets the stored settings and returns the new ones. */
  async setSettings(change) {
    const s = await this.fullSettings();
    const next = change(structuredClone(s));
    await this.invoke("set_settings", { settings: next });
    // Until the pet has them (the next change starts from what it has).
    const want = JSON.stringify(next);
    await this.b
      .waitUntil(() => this.b.execute((w) => JSON.stringify(window.__epet.settings()) === w, want), { timeout: 5000, interval: 100 })
      .catch(() => {});
    await sleep(200);
  }

  /** The settings in force (merged with the defaults, as the pet sees them). */
  async fullSettings() {
    await this.toPet();
    return this.b.execute(() => window.__epet.settings());
  }

  /** A timer of `minutes` (under an hour; named as the menu names it) that rings in `ms`. */
  async addTimer(minutes, ms) {
    await this.toPet();
    return this.invoke("add_alarm", { label: `Timer: ${minutes} min`, at: Date.now() + ms, repeat: "none", days: null });
  }

  /** What the current window played since `since` (window.__epetSounds, src/pet/sound.ts). */
  sounds(since = 0) {
    return this.b.execute((t) => (window.__epetSounds ?? []).filter((s) => s.at >= t), since);
  }

  /** As if the mouse moved: today's anniversaries are celebrated (they wait for you). */
  async present() {
    await this.toPet();
    await this.invoke("e2e_present");
  }

  /** Answers the pet's bubble with the button labelled `label` (if there is one). */
  async answer(label) {
    await this.toPet();
    const ok = await this.b.execute((l) => {
      const b = [...document.querySelectorAll("#bubble .actions button")].find((x) => x.textContent === l);
      b?.click();
      return !!b;
    }, label);
    if (!ok) throw new Error(`No "${label}" in the bubble: ${await this.bubble()}`);
    await sleep(300);
  }

  /** A time range as the badges' info shows it ("8:10 → 8:22 PM"). */
  async badgeRange(start, end) {
    const a = await this.clock(start);
    const b = await this.clock(end);
    const suffix = /\s*[^\d\s:.]+$/.exec(a)?.[0];
    return `${suffix && b.endsWith(suffix) ? a.slice(0, -suffix.length) : a} → ${b}`;
  }

  /** Clock time as the app shows it ("3:52 PM"). */
  clock(ms) {
    return this.b.execute((t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), ms);
  }

  /** Closes a window by label (e.g. the panel), back on the pet window. */
  async closeWindow(label) {
    await this.toPet();
    await this.invoke("e2e_close", { label });
    await sleep(500);
  }

  /** Opens the panel on `tab` and switches to it; waits for the tab to render. */
  async panel(tab) {
    await this.toPet();
    await this.invoke("open_panel", { tab });
    await this.b.waitUntil(async () => (await this.b.getWindowHandles()).length > 1, { timeout: 15_000 });
    for (const h of await this.b.getWindowHandles()) {
      if (h === this.petHandle) continue;
      await this.b.switchToWindow(h);
      if ((await this.b.getUrl()).includes("panel.html")) break;
    }
    await this.tab(tab);
  }

  /** Clicks a panel tab and waits for its content. */
  async tab(tab) {
    await this.b.execute((t) => document.querySelector(`nav button[data-tab="${t}"]`)?.click(), tab);
    await this.b.waitUntil(
      () => this.b.execute((t) => document.querySelector(`nav button[data-tab="${t}"]`)?.classList.contains("active") && document.querySelector("main")?.children.length > 0, tab),
      { timeout: 10_000 },
    );
    await sleep(300);
  }

  /** Text of the first element matching `css` (trimmed, spaces collapsed), or null. */
  text(css) {
    return this.b.execute((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim() ?? null, css);
  }

  /** Texts of all elements matching `css` (including collapsed ones). */
  texts(css) {
    return this.b.execute((s) => [...document.querySelectorAll(s)].map((e) => e.textContent.replace(/\s+/g, " ").trim()), css);
  }

  /** Clicks the first element matching `css` whose text includes `withText` (if given). */
  async click(css, withText) {
    const ok = await this.b.execute(
      (s, t) => {
        const el = [...document.querySelectorAll(s)].find((e) => !t || e.innerText.includes(t) || e.title?.includes(t));
        if (!el) return false;
        el.click();
        return true;
      },
      css,
      withText ?? null,
    );
    if (!ok) throw new Error(`Nothing to click: ${css}${withText ? ` "${withText}"` : ""}`);
    await sleep(250);
  }

  /** Types into an input (replacing its value) the way a user would, firing input events. */
  async type(css, value, { enter = false } = {}) {
    const el = await this.b.$(css);
    await el.waitForExist({ timeout: 5000 });
    await el.clearValue();
    if (value) await el.setValue(value);
    // Clearing alone fires no "input" event.
    else await this.b.execute((s) => document.querySelector(s).dispatchEvent(new Event("input", { bubbles: true })), css);
    if (enter) await this.b.keys("Enter");
    await sleep(250);
  }

  /** Waits until some element matching `css` has text including `text` (shown or not). */
  async waitText(css, text, timeout = 10_000) {
    await this.until(
      (s, t) => [...document.querySelectorAll(s)].some((e) => e.textContent.replace(/\s+/g, " ").includes(t)),
      [css, text],
      timeout,
    );
  }

  /** Waits until no element matching `css` has text including `text`. */
  async waitNoText(css, text, timeout = 10_000) {
    await this.until(
      (s, t) => ![...document.querySelectorAll(s)].some((e) => e.textContent.replace(/\s+/g, " ").includes(t)),
      [css, text],
      timeout,
    );
  }

  /**
   * Presses keys on the element matching `css` (focused first): keydown events sent to it
   * directly, so they don't depend on which window has the system focus.
   */
  async press(css, keys) {
    await this.b.execute(
      (s, ks) => {
        const el = document.querySelector(s);
        // Focused afresh, as a click into it would start a new entry.
        if (document.activeElement === el) el.blur();
        el.focus();
        for (const key of ks) {
          const target = document.activeElement ?? el;
          target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        }
      },
      css,
      keys,
    );
    await sleep(200);
  }

  /** Waits until `fn` (run in the page) returns something truthy; returns it. */
  async until(fn, args = [], timeout = 10_000) {
    let value;
    await this.b.waitUntil(async () => (value = await this.b.execute(fn, ...args)), { timeout, interval: 200 });
    return value;
  }

  sleep(ms) {
    return sleep(ms);
  }
}

// --- Results by checklist id -------------------------------------------------------

const results = [];

/**
 * A test for checklist item `id` (docs/test-checklist.json). Several tests may share an
 * id; the item passes only if all of them do.
 */
export function check(id, name, fn, { timeout = 90_000 } = {}) {
  test(`[${id}] ${name}`, { timeout }, async (t) => {
    const started = Date.now();
    try {
      await fn(t);
      results.push({ id, name, ok: true, ms: Date.now() - started });
    } catch (e) {
      results.push({ id, name, ok: false, ms: Date.now() - started, error: String(e?.stack ?? e).slice(0, 2000) });
      throw e;
    }
  });
}

/** Launches the app before this file's tests and quits it after; writes the results. */
export function useApp(file) {
  const holder = { app: /** @type {App} */ (null) };
  before(async () => {
    holder.app = await App.launch();
  });
  after(async () => {
    await holder.app?.quit();
  });
  recordResults(file);
  return holder;
}

/** Writes this file's results (by checklist id) once its tests are done. */
export function recordResults(file) {
  after(() => {
    if (!results.length) return;
    const dir = process.env.E2E_RESULTS ?? "e2e-results";
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${basename(file).replace(/(\.test)?\.m?js$/, "")}.json`), JSON.stringify(results, null, 2));
  });
}
