#!/usr/bin/env node
// docs/test-checklist.json is the source of the manual test checklist; this renders
// docs/TESTING.md from it (the online checklist page reads the JSON directly).
//
//   npm run test-checklist            regenerate docs/TESTING.md
//   npm run test-checklist -- --check fail if TESTING.md is stale, an id repeats, or an
//                                     item's `rev` is not a version up to the current one
//
// `rev` is the app version in which an item's expected behaviour last changed. When a
// change makes earlier results meaningless, set the affected items' `rev` to the new
// version: results recorded on older builds then show as "needs retest".
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = join(root, "docs", "test-checklist.json");
const mdPath = join(root, "docs", "TESTING.md");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { sections } = JSON.parse(readFileSync(jsonPath, "utf8"));

const semver = (v) => v.split(".").map(Number);
const cmp = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const fill = (s) => s.replaceAll("{version}", version);

function render() {
  const lines = [
    "# 手动测试清单",
    "",
    "<!-- Generated from test-checklist.json by `npm run test-checklist`. Edit the JSON, not this file. -->",
    "",
    `当前版本 \`${version}\`。标 **【新】** 的项目在这一版新增或改动过，旧结果不再算数，需要重测。`,
    "在线勾选页面（保存结果，自动标出需要重测的项目）：https://claude.ai/artifact/XQVzPKq4w2MThVnTLYCGy1",
    "",
  ];
  sections.forEach((s, si) => {
    lines.push(`## ${si + 1}. ${s.title}`, "");
    s.items.forEach((it, ii) => {
      const tag = it.rev === version ? "**【新】** " : "";
      lines.push(`- [ ] ${si + 1}.${ii + 1} ${tag}${fill(it.do)} → **${fill(it.expect)}**`);
    });
    lines.push("");
  });
  return lines.join("\n");
}

function check() {
  const problems = [];
  const seen = new Set();
  for (const s of sections)
    for (const it of s.items) {
      if (seen.has(it.id)) problems.push(`duplicate id ${it.id}`);
      seen.add(it.id);
      if (!/^\d+\.\d+\.\d+$/.test(it.rev ?? "")) problems.push(`${it.id}: bad rev ${it.rev}`);
      else if (cmp(it.rev, version) > 0) problems.push(`${it.id}: rev ${it.rev} is newer than ${version}`);
    }
  if (readFileSync(mdPath, "utf8") !== render()) problems.push("docs/TESTING.md is stale: run npm run test-checklist");
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`Test checklist OK: ${seen.size} items.`);
}

if (process.argv[2] === "--check") check();
else {
  writeFileSync(mdPath, render());
  console.log("docs/TESTING.md regenerated.");
}
