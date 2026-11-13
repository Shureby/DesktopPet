#!/usr/bin/env node
// Keeps the app version in one place across package.json, Cargo.toml, tauri.conf.json,
// the lockfiles and CHANGELOG.md.
//
//   npm run set-version -- 0.9.0    set every version field and move CHANGELOG's
//                                   "Unreleased" entries under "## [0.9.0] - <today>"
//   npm run set-version -- --check  fail if the versions disagree or CHANGELOG has no
//                                   section for the current version (run by CI)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = (...p) => join(root, ...p);
const read = (p) => readFileSync(path(p), "utf8");
const write = (p, s) => writeFileSync(path(p), s);

const CARGO_VERSION = /(\[workspace\.package\][^[]*?\nversion = ")([^"]+)(")/;
const CRATES = ["desktoppet", "desktoppet-core"];
const lockEntry = (name) => new RegExp(`(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")([^"]+)(")`);

function versions() {
  const lock = read("Cargo.lock");
  return {
    "package.json": JSON.parse(read("package.json")).version,
    "package-lock.json": JSON.parse(read("package-lock.json")).version,
    "Cargo.toml": read("Cargo.toml").match(CARGO_VERSION)?.[2],
    "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
    ...Object.fromEntries(CRATES.map((c) => [`Cargo.lock (${c})`, lock.match(lockEntry(c))?.[2]])),
  };
}

function check() {
  const all = versions();
  const version = all["package.json"];
  const wrong = Object.entries(all).filter(([, v]) => v !== version);
  const problems = wrong.map(([file, v]) => `${file} has ${v ?? "no version"}, package.json has ${version}`);
  if (!read("CHANGELOG.md").includes(`## [${version}]`)) problems.push(`CHANGELOG.md has no "## [${version}]" section`);
  if (problems.length) {
    console.error(problems.join("\n") + "\nFix with: npm run set-version -- <version>");
    process.exit(1);
  }
  console.log(`Version ${version}: all files agree, CHANGELOG has it.`);
}

function set(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a version: ${version} (expected e.g. 0.9.0)`);
  const json = (p, edit) => {
    const data = JSON.parse(read(p));
    edit(data);
    write(p, JSON.stringify(data, null, 2) + "\n");
  };
  json("package.json", (d) => (d.version = version));
  json("package-lock.json", (d) => {
    d.version = version;
    if (d.packages?.[""]) d.packages[""].version = version;
  });
  json("src-tauri/tauri.conf.json", (d) => (d.version = version));
  write("Cargo.toml", read("Cargo.toml").replace(CARGO_VERSION, `$1${version}$3`));
  let lock = read("Cargo.lock");
  for (const c of CRATES) lock = lock.replace(lockEntry(c), `$1${version}$3`);
  write("Cargo.lock", lock);

  const log = read("CHANGELOG.md");
  if (!log.includes(`## [${version}]`)) {
    const today = new Date().toISOString().slice(0, 10);
    write("CHANGELOG.md", log.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${version}] - ${today}\n`));
  }
  console.log(`Version set to ${version}.`);
}

const arg = process.argv[2];
if (arg === "--check") check();
else if (arg) set(arg);
else console.log(Object.entries(versions()).map(([f, v]) => `${v}\t${f}`).join("\n"));
