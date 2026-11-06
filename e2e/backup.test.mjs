/**
 * Backup and restore (src-tauri/src/backup.rs): an encrypted export, the password asked for,
 * a deleted to-do brought back by merging (nothing twice, timers not restored), a backup of
 * this computer made first, and the daily automatic backup. The file dialogs are skipped:
 * end-to-end tests pass the path.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, useApp } from "./harness.mjs";

const ctx = useApp(import.meta.filename);
const file = join(mkdtempSync(join(tmpdir(), "epet-backup-")), "test.epetbackup");
const titles = async () => (await ctx.app.invoke("list_todos")).map((t) => t.title).sort();

check("backup.export", "Export backup… with a password: a file that can't be read without it", async () => {
  const app = ctx.app;
  await app.invoke("add_todo", { todo: { title: "Keep me", allDay: false, repeat: "none", dueAt: null } });
  await app.invoke("add_todo", { todo: { title: "Also here", allDay: false, repeat: "none", dueAt: null } });
  await app.invoke("add_alarm", { label: "Timer: 30 min", at: Date.now() + 30 * 60_000, repeat: "none", days: null });
  const saved = await app.invoke("backup_export", { password: "hunter2", path: file });
  assert.equal(saved, file);
  // The panel's Backup section has both buttons.
  await app.panel("settings");
  await app.waitText(".box.backup button", "Export backup…");
});

check("backup.wrong-password", "opening an encrypted backup asks for its password, and says when it's wrong", async () => {
  const app = ctx.app;
  assert.equal((await app.invoke("backup_open", { path: file, password: null })).status, "needsPassword");
  assert.equal((await app.invoke("backup_open", { path: file, password: "hunter3" })).status, "wrongPassword");
  const ok = await app.invoke("backup_open", { path: file, password: "hunter2" });
  assert.equal(ok.status, "ok");
  assert.equal(ok.summary.todos, 2);
  assert.equal(ok.summary.timers, 1);
  assert.equal(ok.summary.alarms, 0);
});

check("backup.restore-merge", "restoring (merge) brings back a deleted to-do, adds nothing twice, keeps what's new, restores no timer; a backup of this computer is made first", async () => {
  const app = ctx.app;
  const keep = (await app.invoke("list_todos")).find((t) => t.title === "Keep me");
  await app.invoke("delete_todo", { id: keep.id });
  await app.invoke("add_todo", { todo: { title: "New since", allDay: false, repeat: "none", dueAt: null } });
  for (const a of await app.invoke("list_alarms")) await app.invoke("delete_alarm", { id: a.id });
  await app.invoke("backup_open", { path: file, password: "hunter2" });
  await app.invoke("backup_restore", { parts: { schedule: true, settings: true, pet: true, characters: true }, mode: "merge", restart: false });
  assert.deepEqual(await titles(), ["Also here", "Keep me", "New since"]);
  assert.deepEqual(await app.invoke("list_alarms"), [], "timers aren't restored");
  const saved = await app.invoke("backup_list_auto");
  assert.ok(saved.some((b) => b.kind === "beforeRestore"), JSON.stringify(saved));
  // After the restart the panel shows it.
  ctx.app = await app.restart();
  await ctx.app.panel("todos");
  await ctx.app.waitText(".todos .list .title", "Keep me");
});

check("backup.auto", "a backup of its own a few seconds after starting, listed under Automatic backups", async () => {
  const app = ctx.app;
  await app.b.waitUntil(async () => (await app.invoke("backup_list_auto")).some((b) => b.kind === "auto"), {
    timeout: 30_000,
    interval: 1000,
  });
  await app.panel("settings");
  await app.waitText(".saved-backup", "daily");
});
