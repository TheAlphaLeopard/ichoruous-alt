// Who is calling an uncallable value? The runner keeps a linked list of
// {prev, name} frames for error reporting; the head is a .data global that
// lifted code updates on entry, so it names the guest caller even when the
// JavaScript stack holds nothing but wasm frames.
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = () => {};
await runner.boot(rb("gex/game.wasm"), rb("gex/image.bin"), rj("gex/meta.json"), rj("gex/builtins.json"));
const HEAD = 31226448;
const cstr = (p) => { const u = runner.guest.u8; if (!p || p >= u.length) return "?"; let s = ""; for (let i = 0; i < 200 && u[p + i]; i++) s += String.fromCharCode(u[p + i]); return s; };
const chain = () => {
  const dv = runner.guest.dv; let p = Number(dv.getBigUint64(HEAD, true)); const out = [];
  for (let i = 0; i < 6 && p && p + 16 <= runner.guest.u8.length; i++) {
    const np = Number(dv.getBigUint64(p + 8, true));
    const nm = cstr(np); if (!nm || nm === "?") break;
    out.push(nm); p = Number(dv.getBigUint64(p, true));
  }
  return out;
};
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
const who = new Map(), shapes = new Map();
const orig = runner.callTargetId.bind(runner);
runner.callTargetId = (v) => {
  const id = orig(v);
  if (id < 0) {
    const p = v >>> 0;
    let shape = "?";
    if (v >= 0 && v < 100000) shape = "small-int " + v;
    else if (p && p + 16 <= runner.guest.u8.length) {
      const t = runner.guest.dv.getUint32(p + 12, true) & 0xffffff;
      shape = "rv kind=" + t + " payload=" + runner.guest.dv.getBigUint64(p, true);
    }
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    const c = chain();
    who.set(c.slice(0, 3).join(" <- "), (who.get(c.slice(0, 3).join(" <- ")) ?? 0) + 1);
  }
  return id;
};
for (const ri of roomOrder.slice(0, 12)) {
  try { runner.budgetMs = 5000; runner.gotoRoom(ri); } catch {} finally { runner.budgetMs = 0; }
  for (let i = 0; i < 20; i++) { try { runner.stepFrame(); } catch {} }
}
console.log("callee slot shapes:");
for (const [k, n] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log("   " + String(n).padStart(6) + "  " + k);
console.log("\nguest callers (innermost first):");
for (const [k, n] of [...who].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log("   " + String(n).padStart(6) + "  " + k.slice(0, 130));
