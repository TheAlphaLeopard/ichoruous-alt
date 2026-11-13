// How many created methods carry a bound struct?
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = () => {};
const HEAD = 31226448;
const cstr = (p) => { const u = runner.guest.u8; if (!p || p >= u.length) return "?"; let s = ""; for (let i = 0; i < 200 && u[p + i]; i++) s += String.fromCharCode(u[p + i]); return s; };
const chain = () => {
  const dv = runner.guest.dv; let p = Number(dv.getBigUint64(HEAD, true)); const out = [];
  for (let i = 0; i < 4 && p && p + 16 <= runner.guest.u8.length; i++) {
    const np = Number(dv.getBigUint64(p + 8, true)); const nm = cstr(np); if (!nm || nm === "?") break;
    out.push(nm); p = Number(dv.getBigUint64(p, true));
  }
  return out;
};
const shapes = new Map();
let CALLS = 0;
const mk = runner.makeImports.bind(runner);
runner.makeImports = () => {
  const p = mk();
  return new Proxy(p, { get(t, k) {
    const f = t[k];
    if (typeof f !== "function") return f;
    return (...a) => {
      if (++CALLS % 2000000 === 0) {
        console.error(`  [${CALLS} abi]  ${chain().slice(0, 3).join(" <- ").slice(0, 150)}`);
        console.error(`              members ${runner.members.size}  dsMaps ${runner.dsMaps.size}  methods ${runner.methods.size}  structIds ${runner.structIds.size}  instances ${runner.instances.size}  heap ${((runner.guest.heapPtr - 32505856) / 1048576).toFixed(1)}MB  rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`);
      }
      if (k === "f140e645a0") {
        const key = "r8=" + (Number(a[2]) ? "struct" : "0") + "  rdx=0x" + Number(a[1]).toString(16);
        shapes.set(key, (shapes.get(key) ?? 0) + 1);
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
const room = process.argv[2] ?? "rmSqualor03";
const fr = Number(process.argv[3] ?? 5);
shapes.clear();
runner.budgetMs = Number(process.env.BUDGET ?? 20000);
runner.gotoRoom(idx.get(room));
for (let i = 0; i < fr; i++) { try { runner.stepFrame(); } catch (e) { console.log("frame threw", String(e.message).slice(0, 80)); } }
let bound = 0, unbound = 0;
for (const [k, v] of shapes) { if (k.startsWith("r8=struct")) bound += v; else unbound += v; }
console.log(`room ${room}, ${fr} frames: methods created ${bound + unbound}  (bound ${bound}, unbound ${unbound})`);
console.log("runner.methods map size:", runner.methods.size);
for (const [k, v] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log("   " + String(v).padStart(8) + "  " + k);
