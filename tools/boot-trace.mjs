#!/usr/bin/env node
// Run the boot scripts one at a time, printing each name before it starts.
// Smoke prints no progress, so when a script hangs inside a single wasm frame
// (nothing can interrupt it) you cannot tell which one it was. This does.
//
//   node --max-old-space-size=2048 tools/boot-trace.mjs
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

const wasmBuf = readBin("gex/game.wasm");
const imageBuf = readBin("gex/image.bin");
const meta = readJson("gex/meta.json");
const builtins = readJson("gex/builtins.json");
const objects = readJson("gex/objects.json");
const rooms = readJson("gex/rooms.json");
const game = readJson("cartridge/game.json");
const roomOrder = readJson("cartridge/room_order.json");
const runner = new GMRunner();
runner.debugFn = () => {};
await runner.boot(wasmBuf, imageBuf, meta, builtins);
const sprites = game.sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames }));
const idx = new Map(rooms.map((r, i) => [r.name, i]));
const order = roomOrder.map((ro) => idx.get(ro.room)).filter((i) => i !== undefined);
runner.loadWorld(sprites, objects, rooms, order, game.sounds.map((s) => s.name));
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };
const globalInst = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = globalInst.guestPtr;

const scripts = runner.meta.fns.filter((f) => f.n.startsWith("gml_GlobalScript_"));
const trace = process.argv[2];
let printedStack = 0;
W(`${scripts.length} boot scripts`);
for (const f of scripts) {
  const t = now();
  const heap = process.memoryUsage().heapUsed / 1048576;
  W(`> ${f.n}  (rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB, heap ${heap.toFixed(0)}MB)`);
  let st = "ok";
  try {
    runner.budgetMs = 3000;
    runner.callGuest(f.n, globalInst.guestPtr, 0, runner.guest.alloc(16, 16), 0);
  } catch (e) {
    st = String(e.message).slice(0, 80);
    if (process.env.STACK && !printedStack) {
      printedStack = 1;
      W("  STACK:\n" + String(e.stack).split("\n").slice(0, 40).map((l) => "    " + l.slice(0, 160)).join("\n"));
    }
  } finally { runner.budgetMs = 0; }
  if (st !== "ok" || trace) W(`  ${st}  ${(now() - t).toFixed(0)}ms`);
}
W("done");
