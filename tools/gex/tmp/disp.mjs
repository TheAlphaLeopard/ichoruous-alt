import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = () => {};
runner.traceABI = true;
const who = new Map();
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
// what do the unresolvable callee slots actually contain?
const seen = new Map();
const orig = runner.callTargetId.bind(runner);
runner.callTargetId = (v) => {
  const id = orig(v);
  if (id < 0) {
    const p = v >>> 0;
    let shape = "?", extra = "";
    if (v >= 0 && v < 100000) shape = "small-int";
    if (p && p + 16 <= runner.guest.u8.length) {
      const t = runner.guest.dv.getUint32(p + 12, true) & 0xffffff;
      shape = "rv-ptr kind=" + t;
      extra = " payload=" + runner.guest.dv.getBigUint64(p, true);
    } else if (p >= runner.meta.cellNames.length) shape = "big-addr";
    seen.set(shape + extra.slice(0, 30), (seen.get(shape + extra.slice(0, 30)) ?? 0) + 1);
    const inst = runner.instanceByGuestPtr(runner.curSelfPtr);
    const nm = inst ? (runner.objects[inst.objIndex]?.name ?? "?") : "ptr=0x" + (Number(runner.curSelfPtr) >>> 0).toString(16);
    const key = nm + "  <=  " + runner.abiTrace.slice(-4).join(" -> ");
    who.set(key, (who.get(key) ?? 0) + 1);
  }
  return id;
};
runner.gotoRoom(order.map((o) => idx.get(o.room)).filter((i) => i !== undefined)[0]);
for (let i = 0; i < 60; i++) { try { runner.stepFrame(); } catch {} }
console.log("unresolvable callee shapes over room entry + 60 frames:");
for (const [k, n] of [...seen].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log("   " + String(n).padStart(6) + "  " + k);
console.log("\nwho is calling it:");
for (const [k, n] of [...who].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log("   " + String(n).padStart(5) + "  " + k.slice(0, 150));
console.log("cells:", runner.meta.cellNames.length, " instances:", runner.instanceList.length);
