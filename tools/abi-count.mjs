#!/usr/bin/env node
// Run one guest function with per-ABI-import call counts, and dump the counts
// on a timer while it runs. When a script spins, this shows which runner
// function it is spinning inside.
//
//   node --max-old-space-size=2048 tools/abi-count.mjs gml_GlobalScript_Foo
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { GMRunner } from "../js/gex/runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = (s) => fs.writeSync(1, s + "\n");
const readBin = (p) => { try { return gunzipSync(fs.readFileSync(path.join(ROOT, p + ".gz"))); } catch { return fs.readFileSync(path.join(ROOT, p)); } };
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const now = () => Number(process.hrtime.bigint() / 1000000n);

const runner = new GMRunner();
runner.debugFn = () => {};
await runner.boot(readBin("gex/game.wasm"), readBin("gex/image.bin"), readJson("gex/meta.json"), readJson("gex/builtins.json"));
const objects = readJson("gex/objects.json");
const rooms = readJson("gex/rooms.json");
const game = readJson("cartridge/game.json");
const roomOrder = readJson("cartridge/room_order.json");
const sprites = game.sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames }));
const idx = new Map(rooms.map((r, i) => [r.name, i]));
runner.loadWorld(sprites, objects, rooms, roomOrder.map((ro) => idx.get(ro.room)).filter((i) => i !== undefined), game.sounds.map((s) => s.name));
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };
const globalInst = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = globalInst.guestPtr;
runner.countABI = true;
runner.traceABI = true;

const target = process.argv[2];
const timer = setInterval(() => {
  const c = [...runner.abiCounts.entries()].sort((a, b) => b[1] - a[1]);
  const total = c.reduce((s, x) => s + x[1], 0);
  W(`--- t=${((now() - t0) / 1000).toFixed(1)}s  ${total} abi calls  rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`);
  for (const [k, n] of c.slice(0, 8)) W(`      ${String(n).padStart(9)}  ${k}`);
  W(`      trace: ${runner.abiTrace.slice(-6).join(" | ").slice(0, 400)}`);
}, 2000);
const t0 = now();
try {
  runner.budgetMs = Number(process.env.BUDGET ?? 20000);
  runner.callGuest(target, globalInst.guestPtr, 0, runner.guest.alloc(16, 16), 0);
  W("ok " + (now() - t0).toFixed(0) + "ms");
} catch (e) { W("threw: " + String(e.message).slice(0, 300)); }
clearInterval(timer);
process.exit(0);
