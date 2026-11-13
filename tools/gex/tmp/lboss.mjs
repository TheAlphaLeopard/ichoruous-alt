// Does the runaway frame in rmSqualorLevelBoss ever finish?
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = (m) => console.error("  LOG " + m.slice(0, 120));
const HEAD = 31226448;
const cstr = (p) => { const u = runner.guest.u8; if (!p || p >= u.length) return "?"; let s = ""; for (let i = 0; i < 200 && u[p + i]; i++) s += String.fromCharCode(u[p + i]); return s; };
const chain = () => {
  const dv = runner.guest.dv; let p = Number(dv.getBigUint64(HEAD, true)); const out = [];
  for (let i = 0; i < 5 && p && p + 16 <= runner.guest.u8.length; i++) {
    const np = Number(dv.getBigUint64(p + 8, true)); const nm = cstr(np); if (!nm || nm === "?") break;
    out.push(nm); p = Number(dv.getBigUint64(p, true));
  }
  return out;
};
let CALLS = 0;
const mk = runner.makeImports.bind(runner);
runner.makeImports = () => {
  const p = mk();
  return new Proxy(p, { get(t, k) { const f = t[k]; if (typeof f !== "function") return f; return (...a) => { CALLS++; return f(...a); }; } });
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
runner.budgetMs = 0;
runner.traceABI = true;
// trap the runaway: after N method dispatches in one frame, throw so the
// abiTrace and the guest chain tell us where the loop is
const LIM = Number(process.env.METHLIM ?? 300000);
const BN = new Map();
const BLIM = Number(process.env.BLIM ?? 100000);
const cb = runner.callBuiltin.bind(runner);
runner.callBuiltin = (name, ...a) => {
  const n = (BN.set(name, (BN.get(name) ?? 0) + 1), BN.get(name));
  if (n === BLIM) {
    console.log("builtin limit hit on", name);
    console.log("   guest chain: " + chain().slice(0, 4).join(" <- "));
    console.log("   last abi calls: " + runner.abiTrace.slice(-14).join(" \u2192 "));
    console.log("top builtins:", [...BN].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => k + "=" + v).join("  "));
    throw new Error("BUILTIN LIMIT " + name);
  }
  return cb(name, ...a);
};
let mc = 0;
const rm = runner.resolveMethod.bind(runner);
runner.resolveMethod = (p) => {
  if (++mc > LIM) { throw new Error("METHOD DISPATCH LIMIT at " + p); }
  return rm(p);
};
runner.gotoRoom(idx.get("rmSqualorLevelBoss"));
console.log("entered, instances", runner.instanceList.length);
for (let i = 0; i < 3; i++) {
  CALLS = 0; mc = 0;
  const t = Date.now();
  try { runner.stepFrame(); } catch (e) { console.log("frame threw", String(e.message).slice(0, 90)); }
  console.log(`FRAME ${i} DONE in ${((Date.now() - t) / 1000).toFixed(1)}s, ${CALLS} abi calls, dsMaps ${runner.dsMaps.size}, heap ${((runner.guest.heapPtr - 32505856) / 1048576).toFixed(2)}MB`);
}
