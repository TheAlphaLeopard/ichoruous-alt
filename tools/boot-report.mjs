#!/usr/bin/env node
// Headless diagnostic: run every gml_GlobalScript_ boot script and group the
// ones that throw by root cause.
//
//   node --max-old-space-size=2048 tools/boot-report.mjs
//
// tools/smoke.mjs only reports *how many* boot scripts threw; this tells you
// *why*, which is the part that has to be fixed. Scripts are grouped by a
// normalised error message so one root cause shows up as one group.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "../js/gex/runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = (s) => fs.writeSync(1, s + "\n");
const readBin = (p) => {
  try { return gunzipSync(fs.readFileSync(path.join(ROOT, p + ".gz"))); }
  catch { return fs.readFileSync(path.join(ROOT, p)); }
};
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

// Boot scripts that spin inside a single wasm frame with no host calls; the
// worker watchdog skips them, so do we.
const KNOWN_HANGING = ["gml_GlobalScript_world_pos_to_gui"];

const runner = new GMRunner();
const logs = new Map();
runner.debugFn = (m) => { const k = m.slice(0, 120); logs.set(k, (logs.get(k) ?? 0) + 1); };

await runner.boot(readBin("gex/game.wasm"), readBin("gex/image.bin"), readJson("gex/meta.json"), readJson("gex/builtins.json"));
const objects = readJson("gex/objects.json");
const rooms = readJson("gex/rooms.json");
const game = readJson("cartridge/game.json");
const roomOrder = readJson("cartridge/room_order.json");
const idx = new Map(rooms.map((r, i) => [r.name, i]));
const order = roomOrder.map((ro) => idx.get(ro.room)).filter((i) => i !== undefined);
runner.loadWorld(
  game.sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames })),
  objects, rooms, order, game.sounds.map((s) => s.name)
);
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };

const globalInst = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = globalInst.guestPtr;

const scripts = runner.meta.fns.filter((f) => f.n.startsWith("gml_GlobalScript_"));
let ok = 0;
const thrown = [];
const t00 = Date.now();
for (const f of scripts) {
  if (KNOWN_HANGING.includes(f.n)) continue;
  fs.writeSync(1, `[${((Date.now() - t00) / 1000).toFixed(0)}s] ${ok}/${ok + thrown.length} ${f.n}\n`);
  try {
    runner.budgetMs = 3000;
    runner.callGuest(f.n, globalInst.guestPtr, 0, runner.guest.alloc(16, 16), 0);
    ok++;
  } catch (e) {
    thrown.push([f.n, String(e.message).slice(0, 220)]);
  }
}
W(`boot scripts: ${ok} ok, ${thrown.length} threw`);

const groups = new Map();
for (const [n, m] of thrown) {
  // the ABI trace prefix varies per call site; collapse it
  const k = m.replace(/\[[^\]]*\]/g, "[]");
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(n);
}
for (const [k, v] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  W(`\n${String(v.length).padStart(3)}x  ${k}`);
  W("      e.g. " + v.slice(0, 4).join("\n           "));
}
if (!thrown.length) W("\nno boot script threw");
W("");
