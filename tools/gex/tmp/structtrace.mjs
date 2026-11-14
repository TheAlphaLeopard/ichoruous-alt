// What happens right after a struct is created? Struct literals come back
// from @@NewGMLObject@@, and their fields are then written by something - but
// resolveTargetKey is called only ~290 times while 2815 structs exist, so
// whatever writes struct fields is not the `a.b = v` path.
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = () => {};
// Wrap every import so we can record the calls that follow a struct creation.
const mk = runner.makeImports.bind(runner);
let recording = null; const WINDOW = Number(process.env.WINDOW ?? 30);
runner.makeImports = () => {
  const p = mk();
  return new Proxy(p, { get(t, k) {
    const f = t[k];
    if (typeof f !== "function") return f;
    return (...a) => {
      if (recording) {
        recording.push(k + "(" + a.slice(0, 4).map((v) => (typeof v === "number" ? (v >>> 0 < 4096 ? v : "0x" + (v >>> 0).toString(16)) : String(v))).join(",") + ")");
        if (recording.length >= WINDOW) flush();
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
// Re-instantiate so the wrapped imports are the live ones.
const ocbb = runner.callBuiltin.bind(runner);
let snaps = 0, want = 0, lastId = 0;
runner.callBuiltin = function (nm, ...a) {
  const r = ocbb(nm, ...a);
  // Arm the recorder *after* the struct exists; the field writes happen in the
  // code that follows, not inside the builtin itself.
  if (nm === "@@NewGMLObject@@" && snaps < Number(process.env.SNAPS ?? 3) && !recording) {
    lastId = Number(runner.guest.dv.getBigUint64(a[2], true));
    snaps++; want = snaps;
    recording = [];
  }
  return r;
};
const flush = () => {
  console.log("--- after @@NewGMLObject@@ #" + want + " (returned id " + lastId + ") ---");
  for (const c of recording) console.log("   " + c);
  recording = null;
};
for (const ri of roomOrder.slice(0, Number(process.env.ROOMS ?? 3))) {
  try { runner.budgetMs = 5000; runner.gotoRoom(ri); } catch {} finally { runner.budgetMs = 0; }
  for (let i = 0; i < Number(process.env.FRAMES ?? 5); i++) { try { runner.stepFrame(); } catch {} }
}
