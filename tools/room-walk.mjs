#!/usr/bin/env node
// Walk the game's rooms: enter each one, run it, and report what happened.
//
//   node tools/room-walk.mjs [framesPerRoom] [maxRooms]
//
// The point of this is that the boot room (rmInit) holds nothing but manager
// objects, so measuring only there says almost nothing: it reports no draw
// calls and no instances with sprites. This enters the real rooms in the
// order the game lists them and measures the frame loop in each.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "../js/gex/runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRAMES = Number(process.argv[2] ?? 30);
const MAXROOMS = Number(process.argv[3] ?? 1e9);
const START = Number(process.env.START ?? 0);
const ONLY = process.env.ROOM ?? null;
const rb = (p) => { const f = path.join(ROOT, p); try { return gunzipSync(fs.readFileSync(f + ".gz")); } catch { return fs.readFileSync(f); } };
const rj = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const W = (s) => fs.writeSync(1, s + "\n");

// A room that runs away cannot be stopped from inside the process — a loop
// that never calls the host is invisible to every watchdog — so in isolate
// mode each room gets its own child process, and one bad room costs one room
// instead of the whole run.
if (process.env.ISOLATE) {
  const { spawnSync } = await import("node:child_process");
  const self = fileURLToPath(import.meta.url);
  const order = rj("cartridge/room_order.json");
  const allRooms = rj("gex/rooms.json");
  const byName = new Map(allRooms.map((r, i) => [r.name, i]));
  const list = order.map((o) => byName.get(o.room)).filter((i) => i !== undefined).slice(START, START + MAXROOMS);
  const chased = /* @__PURE__ */ new Map();
  let drew = 0, ok = 0, killed = 0;
  for (const ri of list) {
    const name = allRooms[ri].name;
    const r = spawnSync(process.execPath, ["--max-old-space-size=1200", self, String(FRAMES), "1"],
      { env: { ...process.env, ROOM: name, ISOLATE: "", NO_ABI: "1" }, encoding: "utf8", timeout: 180000 });
    const line = String(r.stdout ?? "").split("\n").find((l) => l.startsWith("ROOM ")) ?? "";
    const dead = r.status !== 0 || !line;
    if (dead) killed++; else { ok++; if ((Number((line.match(/draws=\s*([\d.]+)/) ?? [])[1]) || 0) > 0) drew++; }
    const tag = dead ? (r.signal === "SIGKILL" || r.status === 137 ? "OUT OF MEMORY" : "exit " + r.status) : line.replace("ROOM ", "");
    W(`${name.padEnd(28)} ${tag}`);
    for (const m of String(r.stderr ?? "").matchAll(/^(dispatch: \S+|unimplemented builtin: \S+|runner error: \S+)/gm)) chased.set(m[1], (chased.get(m[1]) ?? 0) + 1);
  }
  W(`\n${ok}/${list.length} rooms survived, ${drew} drew something, ${killed} killed`);
  if (chased.size) { W("\nacross the whole run:"); for (const [k, v] of [...chased].sort((a, b) => b[1] - a[1]).slice(0, 8)) W(`   ${String(v).padStart(6)}  ${k}`); }
  process.exit(0);
}

const runner = new GMRunner();
const logs = new Map();
runner.debugFn = (m) => logs.set(m.replace(/\d+/g, "N"), (logs.get(m.replace(/\d+/g, "N")) ?? 0) + 1);
await runner.boot(rb("gex/game.wasm"), rb("gex/image.bin"), rj("gex/meta.json"), rj("gex/builtins.json"));
const objects = rj("gex/objects.json"), rooms = rj("gex/rooms.json"), game = rj("cartridge/game.json");
const order = rj("cartridge/room_order.json");
const idx = new Map(rooms.map((r, i) => [r.name, i]));
const roomOrder = order.map((o) => idx.get(o.room)).filter((i) => i !== undefined);
runner.loadWorld(game.sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames })), objects, rooms, roomOrder, game.sounds.map((s) => s.name));
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };

runner.countABI = process.env.NO_ABI ? false : true;
// working set: which lifted functions the frame loop actually enters
const entered = new Set();
if (process.env.WORKSET) {
  const cg = runner.callGuest.bind(runner);
  runner.callGuest = (n, ...a) => { entered.add(n); return cg(n, ...a); };
  const di = runner.dispatchInner.bind(runner);
  runner.dispatchInner = (...a) => {
    const name = runner.meta.cellNames[a[4]];
    const f = runner.fnByName.get("gml_Script_" + name) ?? runner.fnByName.get(name);
    if (f) entered.add(f.n);
    return di(...a);
  };
}
const globalInst = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = globalInst.guestPtr;
const t0 = Date.now();
for (const f of runner.meta.fns.filter((f) => f.n.startsWith("gml_GlobalScript_"))) {
  try { runner.budgetMs = 3000; runner.callGuest(f.n, globalInst.guestPtr, 0, runner.guest.alloc(16, 16), 0); } catch { /* counted below */ } finally { runner.budgetMs = 0; }
}
W(`boot scripts ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

let walkable = 0, drew = 0, totalDraws = 0, totalFrames = 0;
const errors = new Map();
const started = Date.now();
const walkList = ONLY !== null ? [idx.get(ONLY)].filter((i) => i !== undefined) : roomOrder.slice(START, START + MAXROOMS);
for (const ri of walkList) {
  const name = rooms[ri].name;
  const before = runner.instanceList.length;
  let enterMs = -1, threw = 0, draws = 0, maxFrame = 0;
  const a = Date.now();
  try {
    runner.budgetMs = 5000;
    runner.gotoRoom(ri);
    enterMs = Date.now() - a;
    const n0 = runner.instanceList.length;
    for (let i = 0; i < FRAMES; i++) {
      const fa = Date.now();
      try { runner.stepFrame(); } catch (e) { threw++; const k = String(e.message).slice(0, 90); errors.set(k, (errors.get(k) ?? 0) + 1); }
      maxFrame = Math.max(maxFrame, Date.now() - fa);
    }
    draws = runner.drawCalls;
    if (runner.currentRoom === ri && n0 > 0) walkable++;
    if (draws > 0) drew++;
    totalDraws += draws;
    totalFrames += FRAMES;
  } catch (e) {
    const k = "enter: " + String(e.message).slice(0, 90);
    errors.set(k, (errors.get(k) ?? 0) + 1);
  } finally { runner.budgetMs = 0; }
  const heap = ((runner.guest.heapPtr - 32505856) / 1048576).toFixed(1);
  if (process.env.MAPS) W(`      members ${runner.members.size}  dsMaps ${runner.dsMaps.size}  methods ${runner.methods.size}  structIds ${runner.structIds.size}  instances ${runner.instances.size}  slots ${runner.instances.size ? "" : ""}  rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`);
  W((ONLY !== null ? "ROOM " : "") + `${name.padEnd(28)} inst ${String(runner.instanceList.length).padStart(4)}  enter ${String(enterMs).padStart(5)}ms  throws ${String(threw).padStart(3)}  draws=${(draws / FRAMES).toFixed(1).padStart(6)}/f  max ${String(maxFrame).padStart(5)}ms  heap ${heap.padStart(5)}MB`);
}
W(`\nrooms entered ${walkable}/${walkList.length}, rooms that drew anything ${drew}, mean draws/frame ${(totalDraws / Math.max(1, totalFrames)).toFixed(1)}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (errors.size) {
  W("\nerrors:");
  for (const [k, n] of [...errors].sort((a, b) => b[1] - a[1]).slice(0, 12)) W(`   ${String(n).padStart(5)}  ${k}`);
}
if (!process.env.NO_ABI) {
  const abi = [...runner.unimplementedBuiltins].filter(([k]) => k.startsWith("abi:")).sort((a, b) => b[1] - a[1]);
  W("\nunimplemented ABI imports, by call count:");
  for (const [k, n] of abi.slice(0, 15)) W("   " + String(n).padStart(8) + "  " + k.slice(4));
  W("   " + String(abi.reduce((s, x) => s + x[1], 0)).padStart(8) + "  TOTAL across " + abi.length + " distinct imports");
}
if (process.env.WORKSET) W(`\nworking set: ${entered.size} of ${runner.meta.fns.length} lifted functions entered (${(100 * entered.size / runner.meta.fns.length).toFixed(1)}%), rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`);
if (logs.size) {
  W("\nguest messages:");
  for (const [k, n] of [...logs].sort((a, b) => b[1] - a[1]).slice(0, 12)) W(`   ${String(n).padStart(5)}  ${k.slice(0, 110)}`);
}
