// Run a room entry on a worker thread and watch memory from the main thread.
// Timers cannot fire inside a synchronous guest loop, but they do fire on a
// thread that is not the one spinning - so this is how you watch a runaway
// that makes no host calls at all.
//
//   node --max-old-space-size=2200 tools/gex/tmp/tutwatch.mjs rmTutorial2
import { Worker, isMainThread } from "node:worker_threads";
import fs from "node:fs";
const ROOM = process.argv[2] ?? "rmTutorial2";
const self = new URL(import.meta.url).pathname;

if (isMainThread) {
  const w = new Worker(self, { argv: [ROOM], resourceLimits: { maxOldGenerationSizeMb: Number(process.env.WCAP ?? 2048) } });
  w.on("message", (m) => console.log("[worker]", m));
  w.on("exit", (c) => console.log("[worker] exit " + c));
  const t0 = Date.now();
  const tick = setInterval(() => {
    const rss = Number(fs.readFileSync("/proc/self/statm", "utf8").split(" ")[1]) * 4096 / 1048576;
    console.log(`  t+${((Date.now() - t0) / 1000).toFixed(0)}s  process RSS ${rss.toFixed(0)}MB`);
  }, 2000);
  setTimeout(() => { clearInterval(tick); w.terminate(); console.log("watch window over"); process.exit(0); }, 40000);
} else {
  const { gunzipSync } = await import("node:zlib");
  const { GMRunner } = await import("/home/user/ichoruous-alt/js/gex/runtime.js");
  const { parentPort, workerData } = await import("node:worker_threads");
  const R = "/home/user/ichoruous-alt/";
  const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
  const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
  const say = (s) => parentPort.postMessage(s);
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
  say("boot done, wasm memory " + (runner.guest.mem.buffer.byteLength / 1048576).toFixed(1) + "MB");
  const ocg = runner.callGuest.bind(runner);
  runner.callGuest = (nm, ...a) => { say("callGuest " + nm + "  wasmMem " + (runner.guest.mem.buffer.byteLength / 1048576).toFixed(1) + "MB"); return ocg(nm, ...a); };
  const t0 = Date.now();
  try { runner.gotoRoom(idx.get(ROOM)); say("entered in " + (Date.now() - t0) + "ms"); }
  catch (e) { say("threw after " + (Date.now() - t0) + "ms: " + String(e.message).slice(0, 120)); }
}
