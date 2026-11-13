import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = (m) => console.log("  LOG", m.slice(0, 110));
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

let n = 0;
const orig = runner.vtableCall.bind(runner);
runner.vtableCall = (selfPtr, disp, rcx, rdx) => {
  const cellId = rdx > 0 && rdx + 4 <= runner.guest.u8.length ? runner.guest.dv.getInt32(rdx, true) : -1;
  const name = runner.meta.cellNames[cellId] ?? "";
  const r = orig(selfPtr, disp, rcx, rdx);
  if (n++ < 14) console.log(`  icall disp=0x${(disp >>> 0).toString(16)} self=0x${(selfPtr >>> 0).toString(16)} rdx=0x${(rdx >>> 0).toString(16)} cell=${cellId} name="${name}" -> slot=${r[0]}`);
  return r;
};
const oc = runner.callGuest.bind(runner);
runner.callGuest = (...a) => {
  if (n < 6) console.log(`  callGuest ${a[0]} rsp=${runner.exports.rsp.value} self=${a[1]} other=${a[2]} r8=${a[3]}`);
  return oc(...a);
};
console.log("rsp before gotoRoom:", runner.exports.rsp.value, " mem:", runner.guest.u8.length, " heap:", runner.guest.heapPtr);
console.log("--- gotoRoom (Create events) ---");
runner.gotoRoom(order.map((o) => idx.get(o.room)).filter((i) => i !== undefined)[0]);
console.log("instances:", runner.instanceList.length, " rsp after:", runner.exports.rsp.value);
