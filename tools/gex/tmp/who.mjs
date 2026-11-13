import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = () => {};
await runner.boot(rb("gex/game.wasm"), rb("gex/image.bin"), rj("gex/meta.json"), rj("gex/builtins.json"));
// the runner keeps a linked list of {prev, name} for error reporting; the head
// lives in a .data global lifted code updates on entry
const HEAD = 31226448;
const cstr = (p) => { const u = runner.guest.u8; let s = ""; for (let i = 0; i < 200 && u[p + i]; i++) s += String.fromCharCode(u[p + i]); return s; };
const chain = () => {
  const dv = runner.guest.dv; let p = Number(dv.getBigUint64(HEAD, true)); const out = [];
  for (let i = 0; i < 10 && p && p + 16 <= runner.guest.u8.length; i++) {
    const np = Number(dv.getBigUint64(p + 8, true));
    const nm = np && np < runner.guest.u8.length ? cstr(np) : "?";
    out.push(nm); p = Number(dv.getBigUint64(p, true));
  }
  return out;
};
const objects = rj("gex/objects.json"), rooms = rj("gex/rooms.json"), game = rj("cartridge/game.json");
const order = rj("cartridge/room_order.json");
const idx = new Map(rooms.map((r, i) => [r.name, i]));
const sprites = game.sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames }));
runner.loadWorld(sprites, objects, rooms, order.map((o) => idx.get(o.room)).filter((i) => i !== undefined), game.sounds.map((s) => s.name));
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };
const g = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = g.guestPtr;
const who = new Map();
const orig = runner.callTargetId.bind(runner);
runner.callTargetId = (v) => { const id = orig(v); if (id < 0) { const k = chain().slice(0, 4).join(" <- "); who.set(k, (who.get(k) ?? 0) + 1); } return id; };
runner.gotoRoom(order.map((o) => idx.get(o.room)).filter((i) => i !== undefined)[0]);
console.log("chain after gotoRoom:", chain().slice(0, 3));
for (let i = 0; i < 60; i++) { try { runner.stepFrame(); } catch {} }
console.log("\nunresolvable callee, by guest call chain:");
for (const [k, n] of [...who].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log("   " + String(n).padStart(5) + "  " + k.slice(0, 160));
