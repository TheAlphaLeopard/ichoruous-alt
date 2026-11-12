#!/usr/bin/env node
// Headless smoke test: boots the guest and runs frames without a browser.
//
//   node --max-old-space-size=2048 tools/smoke.mjs [frames]
//
// It mirrors what js/gex/boot.js does in the page, minus the DOM: same
// artifacts, same boot scripts (skipping the ones known to hang), same step
// loop. It fails loudly if the guest hangs, throws every frame, or leaks the
// guest heap — i.e. the failure modes that froze the old build.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { GMRunner } from "../js/gex/runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRAMES = Number(process.argv[2] ?? process.env.FRAMES ?? 300);
const W = (s) => fs.writeSync(1, s + "\n");

// Boot scripts that spin inside a wasm frame with no host calls. Nothing can
// interrupt them, so the worker watchdog skips them; so do we.
const KNOWN_HANGING = ["gml_GlobalScript_world_pos_to_gui"];

const readBin = (p) => {
  try { return gunzipSync(fs.readFileSync(path.join(ROOT, p + ".gz"))); }
  catch { return fs.readFileSync(path.join(ROOT, p)); }
};
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const now = () => Number(process.hrtime.bigint() / 1000000n);
const mb = (n) => (n / 1048576).toFixed(1) + "MB";

let failures = 0;
const check = (ok, label, detail = "") => {
  W(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

let t0 = now();
const wasmBuf = readBin("gex/game.wasm");
const imageBuf = readBin("gex/image.bin");
const meta = readJson("gex/meta.json");
const builtins = readJson("gex/builtins.json");
const objects = readJson("gex/objects.json");
const rooms = readJson("gex/rooms.json");
const game = readJson("cartridge/game.json");
const roomOrder = readJson("cartridge/room_order.json");
W(`artifacts loaded in ${(now() - t0).toFixed(0)}ms (wasm ${mb(wasmBuf.length)}, image ${mb(imageBuf.length)})`);

const runner = new GMRunner();
let logs = 0;
const logKinds = new Map();
runner.debugFn = (m) => { logs++; const k = m.slice(0, 90); logKinds.set(k, (logKinds.get(k) ?? 0) + 1); };

t0 = now();
await runner.boot(wasmBuf, imageBuf, meta, builtins);
const bootMs = now() - t0;
W(`instantiated in ${bootMs.toFixed(0)}ms — guest memory ${mb(runner.guest.u8.length)}, ${meta.fns.length} functions`);

const sprites = game.sprites.map((s) => ({
  name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0,
  speed: s.speed, speedType: s.speedType, frames: s.frames,
}));
const idx = new Map(rooms.map((r, i) => [r.name, i]));
const order = roomOrder.map((ro) => idx.get(ro.room)).filter((i) => i !== undefined);
runner.loadWorld(sprites, objects, rooms, order, game.sounds.map((s) => s.name));
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };

const globalInst = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = globalInst.guestPtr;

t0 = now();
const scripts = runner.meta.fns.filter((f) => f.n.startsWith("gml_GlobalScript_"));
let okScripts = 0, timedOut = 0, threw = 0, skipped = 0;
for (const f of scripts) {
  if (KNOWN_HANGING.includes(f.n)) { skipped++; continue; }
  try {
    runner.budgetMs = 3000;
    runner.callGuest(f.n, globalInst.guestPtr, 0, runner.guest.alloc(16, 16), 0);
    okScripts++;
  } catch (e) {
    if (String(e.message).includes("guest timeout")) timedOut++; else threw++;
  } finally { runner.budgetMs = 0; }
}
W(`boot scripts: ${okScripts} ok, ${threw} threw, ${timedOut} timed out, ${skipped} skipped (${(now() - t0).toFixed(0)}ms)`);

t0 = now();
runner.budgetMs = 5000;
runner.gotoRoom(order[0]);
runner.budgetMs = 0;
W(`entered room "${runner.rooms[runner.currentRoom]?.name}" — ${runner.instanceList.length} instances (${(now() - t0).toFixed(0)}ms)`);

const heapStart = runner.guest.heapPtr;
const times = [];
let threwFrames = 0;
const frameErrors = new Map();
for (let i = 0; i < FRAMES; i++) {
  const a = now();
  try { runner.stepFrame(); }
  catch (e) { threwFrames++; const k = String(e.message).slice(0, 120); frameErrors.set(k, (frameErrors.get(k) ?? 0) + 1); }
  times.push(now() - a);
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor(FRAMES * p))].toFixed(1);
const heapEnd = runner.guest.heapPtr;

W(`\n${FRAMES} frames: p50 ${pct(0.5)}ms  p95 ${pct(0.95)}ms  max ${times[FRAMES - 1].toFixed(1)}ms`);
W(`guest heap ${mb(heapStart)} -> ${mb(heapEnd)} (+${((heapEnd - heapStart) / 1048576).toFixed(2)}MB, ${((heapEnd - heapStart) / FRAMES / 1024).toFixed(1)}KB/frame)`);
W(`instances ${runner.instanceList.length}, draws/frame ~${Math.round(runner.drawCalls)}, guest messages ${logs}, timeouts ${runner.timeouts}, events disabled ${runner.disabledFns.size}`);

if (frameErrors.size) {
  W("\nframe errors:");
  for (const [k, n] of [...frameErrors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) W(`  ${n}x ${k}`);
}
if (logKinds.size) {
  W("\nguest messages:");
  for (const [k, n] of [...logKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) W(`  ${n}x ${k}`);
}

W("");
check(bootMs < 30000, "instantiate completes", bootMs.toFixed(0) + "ms");
check(okScripts + threw > 400, "boot scripts run", `${okScripts} ok`);
check(timedOut === 0, "no boot script hangs");
check(runner.instanceList.length > 0, "first room populated", runner.instanceList.length + " instances");
check(threwFrames === 0, "no frame throws", threwFrames + "/" + FRAMES);
check(times[FRAMES - 1] < 500, "slowest frame under 500ms", times[FRAMES - 1].toFixed(1) + "ms");
check(Number(pct(0.5)) < 34, "median frame under 34ms (>=30fps)", pct(0.5) + "ms");
check(heapEnd - heapStart < 4 * 1048576, "guest heap stable", "+" + ((heapEnd - heapStart) / 1048576).toFixed(2) + "MB over " + FRAMES + " frames");
check(failures === 0, "smoke test passed");
process.exit(failures === 0 ? 0 : 1);
