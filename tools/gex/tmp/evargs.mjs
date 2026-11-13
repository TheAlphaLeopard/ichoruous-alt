import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
const logs = [];
runner.debugFn = (m) => logs.push(m);
await runner.boot(rb("gex/game.wasm"), rb("gex/image.bin"), rj("gex/meta.json"), rj("gex/builtins.json"));
const objects = rj("gex/objects.json"), rooms = rj("gex/rooms.json"), game = rj("cartridge/game.json");
const order = rj("cartridge/room_order.json");
const idx = new Map(rooms.map((r, i) => [r.name, i]));
const sprites = game.sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames }));
runner.loadWorld(sprites, objects, rooms, order.map((o) => idx.get(o.room)).filter((i) => i !== undefined), game.sounds.map((s) => s.name));
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };
const g = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = g.guestPtr;
runner.gotoRoom(order.map((o) => idx.get(o.room)).filter((i) => i !== undefined)[0]);
const inst = runner.instanceList.find((i) => runner.objects[i.objIndex]?.name === "oCam");
console.log("oCam instance ptr:", inst?.guestPtr, " objIndex:", inst?.objIndex);
const fn = "gml_Object_oCam_Draw_0";
const variants = {
  "current: (self,self,0,0)": [inst.guestPtr, inst.guestPtr, 0, 0],
  "(self,self,rv,0)": [inst.guestPtr, inst.guestPtr, runner.guest.alloc(16, 16), 0],
  "(self,0,rv,0)": [inst.guestPtr, 0, runner.guest.alloc(16, 16), 0],
  "(self,self,rv,0)+args": [inst.guestPtr, inst.guestPtr, runner.guest.alloc(16, 16), 0],
  "boot style (global,0,rv,0)": [runner.globalInstPtr, 0, runner.guest.alloc(16, 16), 0],
};
for (const [name, args] of Object.entries(variants)) {
  try {
    runner.budgetMs = 3000;
    const r = runner.callGuest(fn, args[0], args[1], args[2], args[3]);
    console.log("  ok  ", name, "-> rax", r.rax, "xmm0", r.xmm0.toFixed(3));
  } catch (e) {
    console.log("  THROW", name, "->", String(e.message).slice(0, 90));
  }
}
console.log("\nlast logs:", logs.slice(-4).map((l) => l.slice(0, 100)));
