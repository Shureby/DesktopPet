/**
 * Upgrading a real installation (Windows CI only, README.md "Windows installer"): the older
 * release's installer, its data written by that version, then the new installer run through
 * its pages as a person would. Needs EPET_OLD_SETUP and EPET_NEW_SETUP (NSIS installers).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { App, appProcesses, check, recordResults } from "./harness.mjs";

const OLD = process.env.EPET_OLD_SETUP;
const NEW = process.env.EPET_NEW_SETUP;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ePet";

/** A value of ePet's uninstall entry in the registry (null if missing). */
function installed(name) {
  const out = spawnSync("reg", ["query", KEY, "/v", name], { encoding: "utf8" }).stdout ?? "";
  const m = new RegExp(`${name}\\s+REG_SZ\\s+(.*)`).exec(out);
  return m ? m[1].trim().replace(/^"|"$/g, "") : null;
}
/** "0.32.4" from "ePet_0.32.4_x64-setup.exe". */
const versionOf = (setup) => /_(\d+\.\d+\.\d+)_/.exec(setup)?.[1];

if (process.platform === "win32" && OLD && NEW) {
  recordResults(import.meta.filename);
  check(
    "install.upgrade",
    "over an older version, the installer asks nothing (no “already installed” page, ePet closed for it); the to-dos, alarms, anniversaries, settings and mood are all still there",
    async () => {
      // The older release, installed quietly.
      const r = spawnSync(OLD, ["/S"], { timeout: 180_000 });
      assert.equal(r.status, 0, "older version installed");
      assert.equal(installed("DisplayVersion"), versionOf(OLD));
      const exe = join(installed("InstallLocation"), installed("MainBinaryName") ?? "desktoppet.exe");
      assert.ok(existsSync(exe), exe);

      // That version writes some data (a release: no test hooks, only its commands).
      let app = await App.launch({ exe, hooks: false });
      const due = Date.now() + 3 * 86_400_000;
      await app.invoke("add_todo", { todo: { title: "Kept to-do", allDay: false, repeat: "none", dueAt: due } });
      await app.invoke("add_alarm", { label: "Kept alarm", at: due, repeat: "daily", days: null });
      await app.invoke("add_anniversary", {
        anniversary: { kind: "birthday", icon: "🎂", name: "Kept", month: 3, day: 14, since: 1990, preps: [], effect: true, music: null },
      });
      const settings = { ...(await app.invoke("get_settings")), character: "rooster", size: 1.5 };
      await app.invoke("set_settings", { settings });
      await app.invoke("save_mood", { character: "cat", mood: { affection: 77, fullness: 33, petWindow: { start: 0, gained: 0 } } });
      await app.quit();

      // ePet running, as it usually is when you upgrade.
      spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
      await sleep(5000);
      assert.equal(appProcesses(), 1);

      // The new installer, page by page.
      const out = join(process.env.E2E_RESULTS ?? "e2e-results", "install-pages.json");
      const ps = spawnSync("pwsh", ["-NoProfile", "-File", fileURLToPath(new URL("./install-gui.ps1", import.meta.url)), "-Setup", NEW, "-Out", out], {
        timeout: 360_000,
        encoding: "utf8",
      });
      assert.equal(ps.status, 0, ps.stderr);
      const run = JSON.parse(readFileSync(out, "utf8").replace(/^﻿/, ""));
      assert.equal(run.timedOut, false, `installer stuck on: ${run.pages.at(-1)} (clicked: ${run.clicks?.join(" / ")}; errors: ${run.errors?.join(" / ")})`);
      assert.equal(run.exitCode, 0);
      const asked = run.pages.filter((p) => /Already Installed|Uninstall before installing|is running/i.test(p));
      assert.deepEqual(asked, [], "no question about the installed version or the running ePet");
      assert.equal(installed("DisplayVersion"), versionOf(NEW));

      // The new version has everything.
      spawnSync("taskkill", ["/F", "/IM", "desktoppet.exe"], { stdio: "ignore" });
      await sleep(1500);
      app = await App.launch({ keepData: true, exe, hooks: false });
      try {
        assert.ok((await app.invoke("list_todos")).some((t) => t.title === "Kept to-do" && t.dueAt === due));
        assert.ok((await app.invoke("list_alarms")).some((a) => a.label === "Kept alarm" && a.repeat === "daily"));
        assert.ok((await app.invoke("list_anniversaries")).some((a) => a.name === "Kept" && a.month === 3 && a.day === 14));
        const s = await app.invoke("get_settings");
        assert.deepEqual([s.character, s.size], ["rooster", 1.5]);
        const mood = await app.invoke("load_mood", { character: "cat" });
        assert.ok(Math.abs(mood.affection - 77) < 1 && Math.abs(mood.fullness - 33) < 1, JSON.stringify(mood));
        assert.equal(await app.b.execute(() => document.getElementById("pet")?.width > 0), true, "the new version's pet is up");
      } finally {
        await app.quit();
      }
    },
    { timeout: 600_000 },
  );
}
