// Enter one room and count ABI imports from inside checkBudget, which runs on
// every import. Timers cannot fire inside a synchronous guest loop, so counting
// at the host boundary is the only way to see whether a runaway is even talking
// to the host. rmTutorial2 makes zero import calls and is still OOM-killed,
// which is how we know its loop is entirely inside lifted wasm.
//
//   node --max-old-space-size=2200 tools/gex/tmp/tut.mjs rmTutorial2
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const W = (s) => fs.writeSync(2, s + "\n");
const runner = new GMRunner();
runner.debugFn = () => {};
await runner.boot(rb("gex/game.wasm"), rb("gex/image.bin"), rj("gex/meta.json"), rj("gex/builtins.json"));
const objects = rj("gex/objects.json"), rooms = rj("gex/rooms.json"), game = rj("cartridge/game.json");
const order = rj("cartridge/room_order.json");
const idx = new Map(rooms.map((r, i) => [r.name, i]));
runner.loadWorld(game.sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames })), objects, rooms, order.map((o) => idx.get(o.room)).filter((i) => i !== undefined), game.sounds.map((s) => s.name));
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };
const g = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = g.guestPtr;
for (const f of runner.meta.fns.filter((f) => f.n.startsWith("gml_GlobalScript_"))) {
  try { runner.budgetMs = 3000; runner.callGuest(f.n, g.guestPtr, 0, runner.guest.alloc(16, 16), 0); } catch {} finally { runner.budgetMs = 0; }
}
// Phase tracing: append to a file so the last marker survives an OOM kill.
const TRACEF = process.env.TRACEF;
const T = (s) => { if (TRACEF) fs.appendFileSync(TRACEF, s + "\n"); };
if (TRACEF) {
  const ore = runner.runEvent.bind(runner);
  runner.runEvent = (inst, ev) => { T("  runEvent " + (inst && inst.objName) + " " + ev); return ore(inst, ev); };
  const oci = runner.createInstance.bind(runner);
  runner.createInstance = (o, x, y) => { T("  createInstance " + (objects[o] && objects[o].name)); return oci(o, x, y); };
  const ocg = runner.callGuest.bind(runner);
  runner.callGuest = (nm, ...a) => { T("  callGuest " + nm); return ocg(nm, ...a); };
}
let n = 0; let live = false;
const MOD = Number(process.env.MOD ?? 500000);
const cb = runner.checkBudget.bind(runner);
runner.checkBudget = (k) => {
  if (live && ++n % MOD === 0) {
    if (TRACEF) fs.appendFileSync(TRACEF, "  [imports " + n + "]\n");
    W(`  [${n / 1000 | 0}k] rss ${(process.memoryUsage().rss / 1048576) | 0}MB heap ${(process.memoryUsage().heapUsed / 1048576) | 0}MB  dsMaps ${runner.dsMaps.size} methods ${runner.methods.size} members ${runner.members.size} instances ${runner.instances.size} list ${runner.instanceList.length} structs ${runner.structIds.size} guestHeap ${((runner.guest.heapPtr - 32505856) / 1048576).toFixed(1)}MB depth ${runner.callDepth}`);
  }
  return cb(k);
};
const name = process.argv[2] ?? "rmTutorial2";
W("entering " + name);
const t0 = Date.now(); live = true;
runner.budgetMs = 0;
try { runner.gotoRoom(idx.get(name)); W("entered in " + (Date.now() - t0) + "ms"); }
catch (e) { W("threw after " + (Date.now() - t0) + "ms: " + String(e.message).slice(0, 100)); }
W("import calls: " + n);
