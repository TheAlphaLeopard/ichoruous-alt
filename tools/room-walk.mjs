#!/usr/bin/env node
// Walk the game's rooms: enter each one, run it, and report what happened.
//
//   node tools/room-walk.mjs [framesPerRoom] [maxRooms]
//
// The point of this is that the boot room (rmInit) holds nothing but manager
// objects, so measuring only there says almost nothing: it reports no draw
// calls and no instances with sprites. This enters the real rooms in the
// order the game lists them and measures the frame loop in each.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "../js/gex/runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRAMES = Number(process.argv[2] ?? 30);
const MAXROOMS = Number(process.argv[3] ?? 1e9);
const rb = (p) => { const f = path.join(ROOT, p); try { return gunzipSync(fs.readFileSync(f + ".gz")); } catch { return fs.readFileSync(f); } };
const rj = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const W = (s) => fs.writeSync(1, s + "\n");

const runner = new GMRunner();
const logs = new Map();
runner.debugFn = (m) => logs.set(m.replace(/\d+/g, "N"), (logs.get(m.replace(/\d+/g, "N")) ?? 0) + 1);
await runner.boot(rb("gex/game.wasm"), rb("gex/image.bin"), rj("gex/meta.json"), rj("gex/builtins.json"));
const objects = rj("gex/objects.json"), rooms = rj("gex/rooms.json"), game = rj("cartridge/game.json");
const order = rj("cartridge/room_order.json");
const idx = new Map(rooms.map((r, i) => [r.name, i]));
const roomOrder = order.map((o) => idx.get(o.room)).filter((i) => i !== undefined);
runner.loadWorld(game.sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames })), objects, rooms, roomOrder, game.sounds.map((s) => s.name));
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };

runner.countABI = process.env.NO_ABI ? false : true;
// working set: which lifted functions the frame loop actually enters
const entered = new Set();
if (process.env.WORKSET) {
  const cg = runner.callGuest.bind(runner);
  runner.callGuest = (n, ...a) => { entered.add(n); return cg(n, ...a); };
  const di = runner.dispatchInner.bind(runner);
  runner.dispatchInner = (...a) => {
    const name = runner.meta.cellNames[a[4]];
    const f = runner.fnByName.get("gml_Script_" + name) ?? runner.fnByName.get(name);
    if (f) entered.add(f.n);
    return di(...a);
  };
}
const globalInst = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = globalInst.guestPtr;
const t0 = Date.now();
for (const f of runner.meta.fns.filter((f) => f.n.startsWith("gml_GlobalScript_"))) {
  try { runner.budgetMs = 3000; runner.callGuest(f.n, globalInst.guestPtr, 0, runner.guest.alloc(16, 16), 0); } catch { /* counted below */ } finally { runner.budgetMs = 0; }
}
W(`boot scripts ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

let walkable = 0, drew = 0, totalDraws = 0, totalFrames = 0;
const errors = new Map();
const started = Date.now();
for (const ri of roomOrder.slice(0, MAXROOMS)) {
  const name = rooms[ri].name;
  const before = runner.instanceList.length;
  let enterMs = -1, threw = 0, draws = 0, maxFrame = 0;
  const a = Date.now();
  try {
    runner.budgetMs = 5000;
    runner.gotoRoom(ri);
    enterMs = Date.now() - a;
    const n0 = runner.instanceList.length;
    for (let i = 0; i < FRAMES; i++) {
      const fa = Date.now();
      try { runner.stepFrame(); } catch (e) { threw++; const k = String(e.message).slice(0, 90); errors.set(k, (errors.get(k) ?? 0) + 1); }
      maxFrame = Math.max(maxFrame, Date.now() - fa);
    }
    draws = runner.drawCalls;
    if (runner.currentRoom === ri && n0 > 0) walkable++;
    if (draws > 0) drew++;
    totalDraws += draws;
    totalFrames += FRAMES;
  } catch (e) {
    const k = "enter: " + String(e.message).slice(0, 90);
    errors.set(k, (errors.get(k) ?? 0) + 1);
  } finally { runner.budgetMs = 0; }
  W(`${name.padEnd(28)} inst ${String(runner.instanceList.length).padStart(4)} (was ${before})  enter ${String(enterMs).padStart(5)}ms  throws ${String(threw).padStart(3)}  draws/f ${(draws / FRAMES).toFixed(1).padStart(6)}  max ${String(maxFrame).padStart(5)}ms`);
}
W(`\nrooms entered ${walkable}/${roomOrder.slice(0, MAXROOMS).length}, rooms that drew anything ${drew}, mean draws/frame ${(totalDraws / Math.max(1, totalFrames)).toFixed(1)}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (errors.size) {
  W("\nerrors:");
  for (const [k, n] of [...errors].sort((a, b) => b[1] - a[1]).slice(0, 12)) W(`   ${String(n).padStart(5)}  ${k}`);
}
if (!process.env.NO_ABI) {
  const abi = [...runner.unimplementedBuiltins].filter(([k]) => k.startsWith("abi:")).sort((a, b) => b[1] - a[1]);
  W("\nunimplemented ABI imports, by call count:");
  for (const [k, n] of abi.slice(0, 15)) W("   " + String(n).padStart(8) + "  " + k.slice(4));
  W("   " + String(abi.reduce((s, x) => s + x[1], 0)).padStart(8) + "  TOTAL across " + abi.length + " distinct imports");
}
if (process.env.WORKSET) W(`\nworking set: ${entered.size} of ${runner.meta.fns.length} lifted functions entered (${(100 * entered.size / runner.meta.fns.length).toFixed(1)}%), rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`);
if (logs.size) {
  W("\nguest messages:");
  for (const [k, n] of [...logs].sort((a, b) => b[1] - a[1]).slice(0, 12)) W(`   ${String(n).padStart(5)}  ${k.slice(0, 110)}`);
}
