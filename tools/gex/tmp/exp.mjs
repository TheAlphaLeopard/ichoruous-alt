// Run one object's Create event on its own and count wasm export calls.
// Useful for checking whether a single object is responsible for a runaway:
// oMeatBlob's Create finishes in ~1ms here, which is how the earlier
// attribution of the tutorial-room hang to it was disproved.
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
runner.loadWorld(game.sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames })), objects, rooms, order.map((o) => idx.get(o.room)).filter((i) => i !== undefined), game.sounds.map((s) => s.name));
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };
const g = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = g.guestPtr;
for (const f of runner.meta.fns.filter((f) => f.n.startsWith("gml_GlobalScript_"))) {
  try { runner.budgetMs = 3000; runner.callGuest(f.n, g.guestPtr, 0, runner.guest.alloc(16, 16), 0); } catch {} finally { runner.budgetMs = 0; }
}
let total = 0; const byName = new Map(); let live = false;
const CAP = Number(process.env.CAP ?? 3000000);
const raw = runner.exports;
runner.exports = new Proxy(raw, { get(t, k) {
  const f = t[k];
  if (typeof f !== "function") return f;
  return (...a) => {
    if (live) { total++; if (total > CAP) throw new Error("export cap " + CAP); byName.set(k, (byName.get(k) ?? 0) + 1); }
    return f(...a);
  };
} });
const oi = objects.findIndex((o) => o.name === (process.argv[2] ?? "oMeatBlob"));
console.error("creating", objects[oi].name);
const t0 = Date.now(); live = true;
runner.budgetMs = 4000;
try { runner.createInstance(oi, 0, 0); console.error("created ok in " + (Date.now() - t0) + "ms"); }
catch (e) { console.error("threw after " + (Date.now() - t0) + "ms, " + total + " export calls: " + String(e.message).slice(0, 100)); }
console.error("top exports:");
for (const [k, v] of [...byName].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.error("   " + String(v).padStart(9) + "  " + k);
