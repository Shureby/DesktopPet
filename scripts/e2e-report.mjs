#!/usr/bin/env node
// Turns automated test results into a report per checklist item (docs/test-checklist.json):
//   - e2e-results/*.json, written by the end-to-end tests (e2e/harness.mjs);
//   - e2e-results/unit.json, Vitest's JSON report (tests named "[item.id] …" count).
// Writes e2e-results/report.json and a Markdown table to $GITHUB_STEP_SUMMARY (when set),
// and prints the report on one line after "E2E_REPORT " so it can be read from the log.
// Fails if a test failed, or an item marked "ci" in the checklist has no result.
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.E2E_RESULTS ?? "e2e-results";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const { sections } = JSON.parse(readFileSync("docs/test-checklist.json", "utf8"));
const items = sections.flatMap((s) => s.items);
const byId = new Map(items.map((i) => [i.id, i]));

/** id → tests */
const found = new Map();
const add = (id, test) => {
  if (!found.has(id)) found.set(id, []);
  found.get(id).push(test);
};

for (const f of existsSync(dir) ? readdirSync(dir) : []) {
  if (!f.endsWith(".json") || f === "report.json" || f === "unit.json") continue;
  const results = JSON.parse(readFileSync(join(dir, f), "utf8").replace(/^\uFEFF/, ""));
  // (Other JSON the tests leave there, e.g. install-pages.json, isn't a list of results.)
  if (!Array.isArray(results)) continue;
  for (const r of results) add(r.id, { name: r.name, ok: r.ok, error: r.error, kind: "e2e" });
}
const unitPath = join(dir, "unit.json");
if (existsSync(unitPath)) {
  for (const file of JSON.parse(readFileSync(unitPath, "utf8")).testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      const m = /\[([a-z0-9-]+\.[a-z0-9.-]+)\]/.exec(t.title ?? "");
      if (m) add(m[1], { name: t.fullName ?? t.title, ok: t.status === "passed", error: t.failureMessages?.join("\n").slice(0, 2000), kind: "unit" });
    }
  }
}

const problems = [];
const report = {
  version,
  commit: process.env.GITHUB_SHA ?? null,
  run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  at: new Date().toISOString(),
  items: {},
};
for (const [id, tests] of found) {
  if (!byId.has(id)) problems.push(`tests name an unknown checklist item: ${id}`);
  const ok = tests.every((t) => t.ok);
  report.items[id] = { ok, tests: tests.map(({ name, ok: o, kind, error }) => ({ name, ok: o, kind, ...(o ? {} : { error }) })) };
  if (!ok) problems.push(`${id}: ${tests.filter((t) => !t.ok).map((t) => t.name).join("; ")}`);
}
for (const it of items) if (it.ci && !found.has(it.id)) problems.push(`${it.id} is marked ci: "${it.ci}" but no test covers it`);

writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
const auto = items.filter((i) => i.ci === "auto").length;
const partial = items.filter((i) => i.ci === "partial").length;
const md = [
  `### Checklist items tested automatically (v${version})`,
  "",
  `${Object.values(report.items).filter((r) => r.ok).length} passed, ${Object.values(report.items).filter((r) => !r.ok).length} failed · ${auto} 🤖 automatic and ${partial} 🤖+👀 partly automatic of ${items.length} items.`,
  "",
  "| Item | | Tests |",
  "| --- | --- | --- |",
  ...items
    .filter((i) => report.items[i.id])
    .map((i) => `| \`${i.id}\` ${i.ci === "partial" ? "🤖+👀" : "🤖"} | ${report.items[i.id].ok ? "✅" : "❌"} | ${report.items[i.id].tests.map((t) => t.name.replace(/\|/g, "\\|")).join("<br>")} |`),
  "",
  ...(problems.length ? ["**Problems**", "", ...problems.map((p) => `- ${p}`)] : []),
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
console.log(md);
console.log(`E2E_REPORT ${JSON.stringify({ version, commit: report.commit, run: report.run, at: report.at, items: Object.fromEntries(Object.entries(report.items).map(([id, r]) => [id, r.ok])) })}`);
if (problems.length) process.exit(1);
