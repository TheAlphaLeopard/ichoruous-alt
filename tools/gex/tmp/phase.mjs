import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = () => {};
// live abi log: a guest loop can spin inside one wasm frame, so the buffered
// trace never gets a chance to print
let ABI_CAP = Number(process.env.ABI_CAP ?? 0);
let ABI_N = 0;
const mk = runner.makeImports.bind(runner);
runner.makeImports = () => {
  const p = mk();
  return new Proxy(p, { get(t, k) {
    const f = t[k];
    if (typeof f !== "function") return f;
    return (...a) => {
      if (ABI_CAP && ABI_N++ < ABI_CAP) console.error("   abi " + String(k) + "(" + a.slice(0, 3).map((x) => Number(x)).join(",") + ")");
      if (ABI_N === ABI_CAP + 1) console.error("   ... (rest suppressed)");
      return f(...a);
    };
  } });
};
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
runner.extraEvents = { pre: !!process.env.EV_PRE, step1: !!process.env.EV_STEP1, step2: !!process.env.EV_STEP2, cleanup: !!process.env.EV_CLEANUP, other: !!process.env.EV_OTHER };
const t = new Map(), n = new Map();
let budget = 300000, stop = false;
let SEQ = 0; const T0 = performance.now();
let TOTAL = 0;
const origEvent = runner.runEvent.bind(runner);
const slowest = [];
runner.runEvent = (inst, ev) => {
  const kind = ev.replace(/_\d+$/, "");
  const nm = runner.objects[inst.objIndex]?.name ?? "?";
  const seq = ++SEQ;
  if (process.env.EV_TRACE && nm + "." + ev === process.env.EV_TRACE) {
    console.error("TRACE enter " + nm + "." + ev + "  seq=" + seq);
    // log the abi calls live: the guest spins inside one wasm frame, so the
    // buffered trace never gets a chance to print
    ABI_CAP = Number(process.env.ABI_CAP ?? 400);
  }
  if (process.env.EV_LOG && seq % Number(process.env.EV_LOG) === 0) console.error("  seq " + seq + " " + nm + "." + ev);
  if (seq % 4000 === 0) console.log("  ..event " + seq + " " + nm + "." + ev + " t=" + (performance.now() - T0).toFixed(0));
  const a = performance.now();
  try { return origEvent(inst, ev); }
  finally {
    const d = performance.now() - a;
    t.set(kind, (t.get(kind) ?? 0) + d); n.set(kind, (n.get(kind) ?? 0) + 1);
    if (d > 50) slowest.push([d, ev, runner.objects[inst.objIndex]?.name ?? "?"]);
    if (process.env.EV_TRACE && nm + "." + ev === process.env.EV_TRACE) console.error("TRACE done " + nm + "." + ev + " " + d.toFixed(0) + "ms");
    if (--budget <= 0 && !stop) { stop = true; throw new Error("event budget exhausted"); }
  }
};
const A = performance.now();
try { runner.gotoRoom(idx.get("rmInit")); } catch (e) { console.log("gotoRoom threw:", String(e).slice(0, 100)); }
console.log("gotoRoom", (performance.now() - A).toFixed(0) + "ms", "instances", runner.instanceList.length);
for (let f = 0; f < 20; f++) {
  const a = performance.now();
  try { runner.stepFrame(); } catch (e) { console.log("frame " + f + " threw:", String(e).slice(0, 100)); break; }
  const d = performance.now() - a;
  console.log("frame " + f + ": " + d.toFixed(0) + "ms  instances " + runner.instanceList.length + "  events " + [...n.entries()].reduce((s, x) => s + x[1], 0));
  if (d > 20000) break;
}
console.log("\n  kind      count    total ms");
for (const k of [...t.keys()].sort((a, b) => t.get(b) - t.get(a))) console.log("   " + k.padEnd(11) + String(n.get(k)).padStart(7) + "  " + t.get(k).toFixed(0).padStart(9));
slowest.sort((a, b) => b[0] - a[0]);
console.log("\nslowest single events:");
for (const [d, ev, nm] of slowest.slice(0, 8)) console.log("   " + d.toFixed(0).padStart(7) + "ms  " + nm + "." + ev);
