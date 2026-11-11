#!/usr/bin/env node
// Rebase the committed static build (the files at the repo root) so it can be
// served from a sub-path instead of a domain root.
//
//   node tools/set-base-path.mjs /ichoruous-alt   # GitHub Pages project site
//   node tools/set-base-path.mjs ""               # back to serving at /
//
// The Next.js export writes absolute URLs ("/_next/...", "/gex/game.wasm", ...)
// which 404 the moment the site lives under /<repo>/. This rewrites those
// string literals in place — HTML, the JS chunks, CSS and the RSC .txt payloads.
// Idempotent: the previously applied prefix is recorded in tools/.base-path and
// stripped before the new one is applied, so re-running never double-prefixes.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOOLS = path.join(ROOT, "tools");
const STATE = path.join(TOOLS, ".base-path");

// Absolute paths the exported app requests. Keep in sync with src/lib/gex/boot.ts
// (the port) if new top-level asset folders are added.
const TARGETS = ["/_next/", "/gex/", "/cartridge/", "/logo.svg", "/_downloads/"];
const TEXT_EXT = new Set([".html", ".htm", ".js", ".mjs", ".css", ".txt", ".json", ".svg", ".map", ".webmanifest", ".xml"]);
const SKIP_DIRS = new Set([".git", "node_modules", "port", "tools", "upload"]);

const next = (process.argv[2] ?? "").replace(/\/+$/, "");
if (next && !/^\/[A-Za-z0-9._-]+$/.test(next)) {
  console.error(`base path must look like "/repo-name" (got "${process.argv[2]}")`);
  process.exit(1);
}

const prev = fs.existsSync(STATE) ? fs.readFileSync(STATE, "utf8").trim() : "";
if (prev === next) {
  console.log(`base path already "${next || "/"}" — nothing to do`);
  process.exit(0);
}

function strip(text) {
  if (!prev) return text;
  let out = text;
  for (const t of TARGETS) out = out.split(prev + t).join(t);
  return out.split(`href="${prev}/"`).join('href="/"');
}

function apply(text) {
  if (!next) return text;
  let out = text;
  for (const t of TARGETS) out = out.split(t).join(next + t);
  return out.split('href="/"').join(`href="${next}/"`);
}

let files = 0;
let hits = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const before = fs.readFileSync(file, "utf8");
    const after = apply(strip(before));
    if (after !== before) {
      fs.writeFileSync(file, after);
      files++;
      hits += (before.match(/\/_next\/|\/gex\/|\/cartridge\/|\/logo\.svg|\/_downloads\//g) ?? []).length;
    }
  }
}

walk(ROOT);

// Without this, GitHub Pages' Jekyll step drops every path starting with "_"
// — which is exactly where Next puts its chunks (_next/).
const nojekyll = path.join(ROOT, ".nojekyll");
if (!fs.existsSync(nojekyll)) fs.writeFileSync(nojekyll, "");

fs.writeFileSync(STATE, next + "\n");
console.log(`base path: "${prev || "/"}" -> "${next || "/"}" (${files} files, ${hits} urls rewritten)`);
