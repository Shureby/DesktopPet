/**
 * The nightly long run (.github/workflows/long-run.yml; Windows): ePet runs for an hour
 * (EPET_LONG_MINUTES) while used now and then as a person would (a timer rings and is
 * answered, the panel opens and closes, the pet is petted and fed). Every minute the memory,
 * handles and CPU time of ePet and its WebView2 processes are measured; they must level off,
 * not keep rising. The samples go to e2e-results/long-run-samples.json.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, useApp } from "../harness.mjs";

const MINUTES = Number(process.env.EPET_LONG_MINUTES ?? 60);
const MB = 1024 * 1024;

/**
 * ePet's processes (desktoppet.exe and everything it started: WebView2's browser, renderers,
 * GPU…), added up: private and working-set bytes, handles, CPU seconds.
 */
function measure() {
  const script = `
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, PrivatePageCount, WorkingSetSize, HandleCount, KernelModeTime, UserModeTime
    $root = $all | Where-Object { $_.Name -eq 'desktoppet.exe' } | Select-Object -First 1
    if (-not $root) { '{}'; exit }
    $ids = @($root.ProcessId)
    do {
      $more = @($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId })
      $ids += $more
    } while ($more.Count -gt 0)
    $tree = $all | Where-Object { $ids -contains $_.ProcessId }
    @{
      processes = $tree.Count
      privateBytes = ($tree | Measure-Object PrivatePageCount -Sum).Sum
      workingSet = ($tree | Measure-Object WorkingSetSize -Sum).Sum
      handles = ($tree | Measure-Object HandleCount -Sum).Sum
      cpuSeconds = (($tree | Measure-Object KernelModeTime -Sum).Sum + ($tree | Measure-Object UserModeTime -Sum).Sum) / 1e7
    } | ConvertTo-Json -Compress`;
  const out = spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 60_000 }).stdout.trim();
  return { at: Date.now(), ...JSON.parse(out || "{}") };
}

/** The median of `key` over samples. */
function median(samples, key) {
  const v = samples.map((s) => s[key]).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

if (process.platform === "win32") {
  const ctx = useApp(import.meta.filename);

  check(
    "stability.long-run",
    `running ${MINUTES} min and used now and then: memory, handles and CPU level off; the pet keeps going without script errors`,
    async () => {
      const app = ctx.app;
      await app.setSettings((s) => {
        s.alerts.alarm = { ...s.alerts.alarm, ring: false, ringSeconds: 20 };
        return s;
      });
      const samples = [];
      const started = Date.now();
      for (let minute = 0; minute < MINUTES; minute++) {
        // Something to do every few minutes, as on a normal day.
        if (minute % 5 === 1) {
          await app.addTimer(1, 3000);
          await app.waitBubble("Time's up", 15_000);
          await app.answer("Done");
        } else if (minute % 5 === 3) {
          await app.run("pet", "Open panel…");
          await app.panelTab();
          await app.closeWindow("panel");
        } else if (minute % 5 === 4) {
          await app.toPet();
          await app.b.execute(() => window.__epet.care(Math.random() < 0.5 ? "pet" : "feed"));
        }
        samples.push({ minute, ...measure() });
        await app.sleep(Math.max(0, started + (minute + 1) * 60_000 - Date.now()));
      }
      samples.push({ minute: MINUTES, ...measure() });

      const dir = process.env.E2E_RESULTS ?? "e2e-results";
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "long-run-samples.json"), JSON.stringify({ minutes: MINUTES, samples }, null, 2));

      // The pet still runs, with no script errors.
      const frames = (await app.pet()).frames;
      await app.sleep(1000);
      assert.ok((await app.pet()).frames > frames + 10, "the pet keeps going");
      assert.deepEqual(await app.b.execute(() => window.__epet.errors), []);

      // Levelled off: the last sixth against the second sixth (the first is warming up).
      const sixth = Math.max(2, Math.floor(samples.length / 6));
      const early = samples.slice(sixth, 2 * sixth);
      const late = samples.slice(-sixth);
      const summary = {};
      for (const key of ["privateBytes", "workingSet", "handles"]) {
        const a = median(early, key);
        const b = median(late, key);
        summary[key] = { early: a, late: b, growth: (b - a) / a };
      }
      const cpu = (samples.at(-1).cpuSeconds - samples[sixth].cpuSeconds) / ((samples.at(-1).at - samples[sixth].at) / 1000);
      const report = `private ${Math.round(summary.privateBytes.early / MB)} → ${Math.round(summary.privateBytes.late / MB)} MB, working set ${Math.round(summary.workingSet.early / MB)} → ${Math.round(summary.workingSet.late / MB)} MB, handles ${summary.handles.early} → ${summary.handles.late}, CPU ${(cpu * 100).toFixed(1)}% of a core`;
      console.log(`LONG_RUN ${report}`);
      const grew = summary.privateBytes.late - summary.privateBytes.early;
      assert.ok(summary.privateBytes.growth < 0.2 || grew < 40 * MB, `memory keeps rising: ${report}`);
      assert.ok(summary.handles.growth < 0.2, `handles keep rising: ${report}`);
      // A software-rendered CI machine: generous, but an animation stuck spinning would show.
      assert.ok(cpu < 0.6, `CPU: ${report}`);
    },
    { timeout: (MINUTES + 15) * 60_000 },
  );
}
