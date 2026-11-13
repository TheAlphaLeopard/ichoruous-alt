// Which room eats the heap, and what is allocating inside it?
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = () => {};
// count the argument shapes of method creation
const methN = new Map();
const mk = runner.makeImports.bind(runner);
runner.makeImports = () => {
  const p = mk();
  return new Proxy(p, { get(t, k) {
    const f = t[k];
    if (typeof f !== "function") return f;
    return (...a) => {
      if (k === "f140e645a0") {
        const key = "r8=" + (Number(a[2]) ? "struct" : "0") + " rdx=0x" + Number(a[1]).toString(16).slice(0, 6);
        methN.set(key, (methN.get(key) ?? 0) + 1);
      }
      return f(...a);
    };
  } });
};
await runner.boot(rb("gex/game.wasm"), rb("gex/image.bin"), rj("gex/meta.json"), rj("gex/builtins.json"));
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
// sample who is allocating: every Nth alloc, record the guest call chain
const allocs = new Map();
let n = 0;
const origAlloc = runner.guest.alloc.bind(runner.guest);
runner.guest.alloc = (b, a = 8) => {
  if (process.env.SAMPLE && ++n % Number(process.env.SAMPLE) === 0) {
    const k = chain().slice(0, 3).join(" <- ") || "(no chain)";
    allocs.set(k, (allocs.get(k) ?? 0) + 1);
    if (process.env.JSSTACK) {
      const st = String(new Error().stack).split("\n").slice(2, 6).map((l) => l.trim().replace(/^at /, "")).join(" | ");
      allocs.set("JS " + st.slice(0, 110), (allocs.get("JS " + st.slice(0, 110)) ?? 0) + 1);
    }
  }
  return origAlloc(b, a);
};
const target = rooms.findIndex((r) => r.name === (process.argv[2] ?? "rmSqualorLevelBoss"));
for (const ri of roomOrder.slice(0, roomOrder.indexOf(target) + 1)) {
  try { runner.budgetMs = 9000; runner.gotoRoom(ri); } catch (e) { console.log("enter threw", String(e.message).slice(0, 60)); } finally { runner.budgetMs = 0; }
}
console.log("room", rooms[target].name, "instances", runner.instanceList.length);
if (process.env.SAMPLE) { n = 0; allocs.clear(); }
runner.countABI = true;
const counts = () => [...runner.abiCounts].sort((a, b) => b[1] - a[1]).slice(0, 10);
const before = new Map(runner.abiCounts);
for (let f = 0; f < 8; f++) {
  const h0 = runner.guest.heapPtr, t = Date.now();
  try { runner.stepFrame(); } catch (e) { console.log("frame threw", String(e.message).slice(0, 70)); }
  console.log(`frame ${f}: +${((runner.guest.heapPtr - h0) / 1024).toFixed(0)}KB  ${Date.now() - t}ms  total ${((runner.guest.heapPtr - 32505856) / 1048576).toFixed(2)}MB`);
  if (f === 0) { console.log("   abi calls, this frame:"); for (const [k, v] of counts()) console.log("      " + String(v - (before.get(k) ?? 0)).padStart(8) + "  " + k); }
}
{
  console.log("\nmethod creation shapes:");
  const tot = [...methN.values()].reduce((s, x) => s + x, 0);
  for (const [k, v] of [...methN].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log("   " + String(v).padStart(8) + "  " + k);
  console.log("   " + String(tot).padStart(8) + "  TOTAL");
}
if (process.env.SAMPLE) {
  console.log("\nallocation sites (guest chain, sampled):");
  for (const [k, v] of [...allocs].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log("   " + String(v).padStart(6) + "  " + k.slice(0, 130));
}
