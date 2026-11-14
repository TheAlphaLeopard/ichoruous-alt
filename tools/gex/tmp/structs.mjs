// Are struct members actually stored? Structs come back from @@NewGMLObject@@
// as ds_map ids (small ints); instances are guest pointers (~46M). If struct
// keys never appear in the member table, every struct field reads as unset,
// and a struct holding a method reads as 0 - which is the "uncallable callee"
// flood.
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = () => {};
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
// What does the LHS of a dot-access actually hold? If resolveTargetKey sees a
// kind it does not handle it returns 0, and setMember then drops the write on
// the floor - which is how 2813 of 2815 structs ended up with no members.
const KINDS = ["double","string","array","ptr","bool","undef","object","int32","vec3","vec4","int64","accessor","null","intbool"];
const seenKinds = new Map(); let dropped = 0, stored = 0;
const ortk = runner.resolveTargetKey.bind(runner);
runner.resolveTargetKey = (rvPtr) => {
  if (rvPtr && rvPtr + 16 <= runner.guest.u8.length) {
    const t = runner.guest.dv.getUint32(rvPtr + 12, true) & 0xffffff;
    seenKinds.set(t, (seenKinds.get(t) ?? 0) + 1);
  }
  const k = ortk(rvPtr);
  if (k) stored++; else dropped++;
  return k;
};
const osm = runner.setMember.bind(runner);
runner.setMember = (key, cell, v) => { if (!key) dropped++; return osm(key, cell, v); };
const ROOMS = Number(process.env.ROOMS ?? 12), FRAMES = Number(process.env.FRAMES ?? 20);
for (const ri of roomOrder.slice(0, ROOMS)) {
  try { runner.budgetMs = 5000; runner.gotoRoom(ri); } catch {} finally { runner.budgetMs = 0; }
  for (let i = 0; i < FRAMES; i++) { try { runner.stepFrame(); } catch {} }
}
// classify member keys
let structKeys = 0, ptrKeys = 0, other = 0;
const structCells = [];
for (const [k, m] of runner.members) {
  if (k >= 32505856 && k <= 40894464) { structKeys++; structCells.push([k, m.size]); }
  else if (k > 0x1000000) ptrKeys++;
  else other++;
}
console.log("LHS kinds seen (resolveTargetKey):");
for (const [t, n] of [...seenKinds].sort((a,b)=>b[1]-a[1])) console.log("   kind " + String(t).padStart(2) + " " + (KINDS[t] ?? "?").padEnd(10) + " " + n);
console.log("member keys: heap/struct ptrs " + structKeys + ", instance ptrs " + ptrKeys + ", other(handles) " + other);
console.log("dsMaps alive: " + runner.dsMaps.size + "   methods: " + runner.methods.size);
structCells.sort((a, b) => b[1] - a[1]);
console.log("struct keys with most members:");
for (const [k, n] of structCells.slice(0, 10)) {
  const names = [...runner.members.get(k).keys()].slice(0, 8).map((c) => runner.cellName(c)).join(",");
  console.log("   key " + k + ": " + n + " members  [" + names + "]");
}
const total = structCells.reduce((s, [, n]) => s + n, 0);
console.log("total struct members stored: " + total);
