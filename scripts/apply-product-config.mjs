#!/usr/bin/env node
// Copies branding from product.config.json into tauri.conf.json so the product
// can be renamed in one place. Runs automatically before `dev` and `build`.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const product = JSON.parse(readFileSync(`${root}product.config.json`, "utf8"));
const confPath = `${root}src-tauri/tauri.conf.json`;
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));

conf.productName = product.productName;
conf.identifier = product.identifier;
conf.version = pkg.version;
conf.bundle.publisher = product.publisher;
conf.bundle.homepage = product.website;
for (const w of conf.app.windows) w.title = product.productName;

const next = JSON.stringify(conf, null, 2) + "\n";
if (next !== readFileSync(confPath, "utf8")) {
  writeFileSync(confPath, next);
  console.log(`tauri.conf.json updated for "${product.productName}" (${product.identifier})`);
}
