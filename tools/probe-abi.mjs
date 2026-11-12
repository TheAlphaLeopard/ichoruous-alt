#!/usr/bin/env node
// Reverse-engineering aid: run the game and dump what the unimplemented runner
// functions are actually being asked for.
//
//   node --max-old-space-size=2048 tools/probe-abi.mjs [frames] [topN]
//
// For each unimplemented ABI import it prints the raw argument registers, the
// instance that is calling it, and the argument RValues decoded (type + value,
// strings inlined). That is usually enough to recognise the function: a call
// taking ("oPlayer") is an object lookup, one taking a ds_map id and a string is
// ds_map_find_value, and so on.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { GMRunner } from "../js/gex/runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRAMES = Number(process.argv[2] ?? 60);
const TOP = Number(process.argv[3] ?? 14);
const W = (s) => fs.writeSync(1, s + "\n");

const readBin = (p) => {
  try { return gunzipSync(fs.readFileSync(path.join(ROOT, p + ".gz"))); }
  catch { return fs.readFileSync(path.join(ROOT, p)); }
};
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const TYPES = ["double", "string", "array", "ptr", "bool", "undef", "object", "int32"];

const wasmBuf = readBin("gex/game.wasm");
const imageBuf = readBin("gex/image.bin");
const meta = readJson("gex/meta.json");
const builtins = readJson("gex/builtins.json");
const objects = readJson("gex/objects.json");
const rooms = readJson("gex/rooms.json");
const game = readJson("cartridge/game.json");
const roomOrder = readJson("cartridge/room_order.json");

const runner = new GMRunner();
runner.abiProbe = new Map();
runner.debugFn = () => {};
await runner.boot(wasmBuf, imageBuf, meta, builtins);

const g = runner.guest;
const hx = (n) => "0x" + (n >>> 0).toString(16);
function decodeRV(p) {
  if (!p || p < 0 || p + 16 > g.u8.length) return null;
  const v = Number(g.dv.getBigUint64(p, true));
  const t = g.dv.getUint32(p + 12, true) & 0xffffff;
  const flags = g.dv.getUint32(p + 8, true);
  if (t === 1) return `str "${g.readString(v).slice(0, 40)}"`;
  if (t === 0) return `num ${g.dv.getFloat64(p, true).toFixed(4)}`;
  if (t === 7) return `int ${v | 0}`;
  if (t === 4) return `bool ${v !== 0}`;
  if (t === 5) return "undef";
  return `${TYPES[t] ?? "t" + t}(${hx(v)})`;
}
const objName = (p) => {
  try { return objects[runner.instanceByGuestPtr(p).objIndex]?.name ?? hx(p); }
  catch { return hx(p); }
};

const sprites = game.sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames }));
const idx = new Map(rooms.map((r, i) => [r.name, i]));
const order = roomOrder.map((ro) => idx.get(ro.room)).filter((i) => i !== undefined);
runner.loadWorld(sprites, objects, rooms, order, game.sounds.map((s) => s.name));
runner.renderer = { drawSprite: () => {}, clear: () => {}, rect: () => {}, circle: () => {}, line: () => {}, text: () => {} };
runner.audio = { play: () => {}, stop: () => {}, stopAll: () => {} };

const gi = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = gi.guestPtr;
for (const f of runner.meta.fns.filter((f) => f.n.startsWith("gml_GlobalScript_"))) {
  if (f.n === "gml_GlobalScript_world_pos_to_gui") continue;
  try { runner.budgetMs = 3000; runner.callGuest(f.n, gi.guestPtr, 0, runner.guest.alloc(16, 16), 0); }
  catch { /* logged elsewhere */ }
  finally { runner.budgetMs = 0; }
}
runner.budgetMs = 5000;
runner.gotoRoom(order[0]);
runner.budgetMs = 0;
for (let i = 0; i < FRAMES; i++) { try { runner.stepFrame(); } catch { /* keep going */ } }

const counts = runner.unimplementedBuiltins;
const top = [...counts.entries()].filter(([k]) => k.startsWith("abi:")).sort((a, b) => b[1] - a[1]).slice(0, TOP);

W(`unimplemented runner functions: ${top.length} shown of ${[...counts.keys()].filter((k) => k.startsWith("abi:")).length}\n`);
for (const [key, count] of top) {
  const addr = key.slice(4);
  W(`${addr}  —  ${count} calls`);
  const samples = runner.abiProbe.get(addr) ?? [];
  for (const s of samples) {
    W(`   self=${objName(s.rcx)} other=${hx(s.rdx)} result=${hx(s.r8)} argc=${s.r9} rsp=${hx(s.rsp)}`);
    const args = [];
    for (const slot of s.stack) {
      if (slot === -1) continue;
      const rv = decodeRV(slot);
      if (rv) args.push(rv);
    }
    if (s.r9 > 0 && args.length === 0) {
      // args array lives at the 5th stack slot; decode the first few RValues
      const arrPtr = s.stack[1];
      for (let i = 0; i < Math.min(4, s.r9); i++) {
        const rv = decodeRV(arrPtr + i * 16);
        if (rv) args.push(rv);
      }
    }
    W(`   args: ${args.join(", ") || "(none decoded)"}`);
  }
  W("");
}
