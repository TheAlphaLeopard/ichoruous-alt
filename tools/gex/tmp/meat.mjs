// oMeatBlob's Create event runs away. What grows while it does?
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = () => {};
let N = 0;
const mk = runner.makeImports.bind(runner);
runner.makeImports = () => {
  const p = mk();
  return new Proxy(p, { get(t, k) {
    const f = t[k];
    if (typeof f !== "function") return f;
    return (...a) => {
      if (++N % 2000 === 0) {
        const s = runner;
        fs.writeSync(2, `  [${N}] rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB  methods ${s.methods.size} dsMaps ${s.dsMaps.size} members ${s.members.size} instances ${s.instances.size} list ${s.instanceList.length} structIds ${s.structIds.size} scope ${s.scopeStack.length} ptrMap ${s.guestPtrMap.size} depth ${s.callDepth}\n`);
      }
      return f(...a);
    };
  } });
};
await runner.boot(rb("gex/game.wasm"), rb("gex/image.bin"), rj("gex/meta.json"), rj("gex/builtins.json"));
const objects = rj("gex/objects.json"), rooms = rj("gex/rooms.json"), game = rj("cartridge/game.json");
const order = rj("cartridge/room_order.json");
const idx = new Map(rooms.map((r, i) => [r.name, i]));
const roomOrder = order.map((o) => idx.get(o.room)).filter((i) => i !== undefined);
runner.loadWorld(game.sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames })), objects, rooms, roomOrder, game.sounds.map((s) => s.name));
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };
const g = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = g.guestPtr;
for (const f of runner.meta.fns.filter((f) => f.n.startsWith("gml_GlobalScript_"))) {
  try { runner.budgetMs = 3000; runner.callGuest(f.n, g.guestPtr, 0, runner.guest.alloc(16, 16), 0); } catch {} finally { runner.budgetMs = 0; }
}
let EG = 0;
const oeg = runner.enterGuest.bind(runner);
runner.enterGuest = (fn, ...a) => {
  if (++EG % 2000 === 0) {
    const s = runner;
    fs.writeSync(2, `  [enter ${EG}] rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB  methods ${s.methods.size} dsMaps ${s.dsMaps.size} members ${s.members.size} instances ${s.instances.size} list ${s.instanceList.length} structIds ${s.structIds.size} scope ${s.scopeStack.length} depth ${s.callDepth}
`);
  }
  return oeg(fn, ...a);
};
const oi = objects.findIndex((o) => o.name === (process.argv[2] ?? "oMeatBlob"));
console.error("creating", objects[oi].name);
runner.budgetMs = 4000;
try { runner.createInstance(oi, 0, 0); console.error("created ok"); }
catch (e) { console.error("threw: " + String(e.message).slice(0, 120)); }
