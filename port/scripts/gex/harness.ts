// Node harness: run the guest + shim headlessly to debug quickly.
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "../../src/lib/gex/runtime.ts";
import type { SpriteDef, ObjectDef } from "../../src/lib/gex/runtime.ts";

// prefer the shipped .gz artifacts, fall back to raw local builds
function readBin(path: string): Buffer {
  try {
    const gz = fs.readFileSync(process.env.SUB ? path.replace("public/gex", "/tmp/gexsub") + ".gz" : path + ".gz");
    return gunzipSync(gz);
  } catch { /* raw below */ }
  return fs.readFileSync(process.env.SUB ? path.replace("public/gex", "/tmp/gexsub") : path);
}

const meta = JSON.parse(fs.readFileSync(process.env.SUB ? "/tmp/gexsub/meta.json" : "public/gex/meta.json", "utf8"));
const builtins = JSON.parse(fs.readFileSync("public/gex/builtins.json", "utf8"));
const objects = JSON.parse(fs.readFileSync("public/gex/objects.json", "utf8")) as ObjectDef[];
const rooms = JSON.parse(fs.readFileSync("public/gex/rooms.json", "utf8"));
const cartridge = JSON.parse(fs.readFileSync("public/cartridge/game.json", "utf8"));
const roomOrder = JSON.parse(fs.readFileSync("public/cartridge/room_order.json", "utf8"));
const image = readBin("public/gex/image.bin");
const wasm = readBin("public/gex/game.wasm");

const runner = new GMRunner();
const logs: string[] = [];
runner.debugFn = (m) => logs.push(m);
await runner.boot(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), image, meta, builtins);

const sprites: SpriteDef[] = cartridge.sprites.map((s: { name: string; w: number; h: number; origin: [number, number]; speed: number; speedType: number; frames: number[] }) => ({
  name: s.name, w: s.w, h: s.h, ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0, speed: s.speed, speedType: s.speedType, frames: s.frames,
}));
const roomIdxByName = new Map(rooms.map((r: { name: string }, i: number) => [r.name, i]));
const order = roomOrder.map((ro: { room: string }) => roomIdxByName.get(ro.room)).filter((i: number) => i !== undefined) as number[];
runner.loadWorld(sprites, objects, rooms, order, cartridge.sounds.map((s: { name: string }) => s.name));

const globalInst = runner.createInstance(objects.findIndex((o) => o.name === "__InputUpdateController"), 0, 0);
runner.globalInstPtr = globalInst.guestPtr;
let okGs = 0;
const gsFails = new Map<string, number>();
for (const f of runner.meta.fns) {
  if (!f.n.startsWith("gml_GlobalScript_")) continue;
  try { runner.callGuest(f.n, globalInst.guestPtr, 0, runner.guest.alloc(16, 16), 0); okGs++; }
  catch (e: unknown) {
    const msg = String((e as Error).message).slice(0, 500);
    gsFails.set(msg, (gsFails.get(msg) ?? 0) + 1);
  }
}
console.log("global scripts ok:", okGs, "failed kinds:", [...gsFails.entries()].map(([k, n]) => n + "x " + k).slice(0, 3));

const eventFails = new Map<string, number>();
const origRunEvent = runner.runEvent.bind(runner);
runner.runEvent = (inst: Parameters<typeof runner.runEvent>[0], ev: string) => {
  const before = logs.length;
  origRunEvent(inst, ev);
  for (let i = before; i < logs.length; i++) {
    if (logs[i].includes("threw")) {
      const key = logs[i].split(" threw")[0].replace("event ", "");
      eventFails.set(key, (eventFails.get(key) ?? 0) + 1);
    }
  }
};

runner.gotoRoom(order[0]);
console.log("room entered:", runner.rooms[runner.currentRoom]?.name, "instances:", runner.instanceList.length);
for (let i = 0; i < 30; i++) {
  try { runner.stepFrame(); } catch (e) { console.log("STEP FAIL f" + i + ":", (e as Error).stack?.split("\n").slice(0, 4).join(" | ")); break; }
}
console.log("after 30 frames: instances:", runner.instanceList.length, "drawCalls:", runner.drawCalls);
const fails = [...eventFails.entries()].sort((a, b) => b[1] - a[1]);
console.log("top event failures:", fails.slice(0, 12));
console.log("distinct failing events:", fails.length, "total:", fails.reduce((a, b) => a + b[1], 0));
console.log("unimplemented builtins:", [...runner.unimplementedBuiltins.entries()].filter(([k]) => !k.startsWith("abi:")).slice(0, 15));
const abiUn = [...runner.unimplementedBuiltins.entries()].filter(([k]) => k.startsWith("abi:")).sort((a, b) => b[1] - a[1]);
console.log("top unimplemented ABI:", abiUn.slice(0, 12));

// focused: failing Create events
const failFns = ["gml_Object_oCam_Create_0", "gml_Object_oOfferingManager_Create_0", "gml_Object_oRunManager_Create_0"];
for (const fn of failFns) {
  const f = runner.fnByName.get(fn);
  if (!f) { console.log(fn, "not found"); continue; }
  const inst = runner.instanceList.find((i) => i.objIndex === objects.findIndex((o) => o.name === fn.split("_")[1].replace(/^o/, "o")));
  try {
    const target = runner.instanceList.find((i2) => i2.guestPtr && objects[i2.objIndex]?.events?.Create?.includes(fn));
    runner.callGuest(fn, (target ?? globalInst).guestPtr, 0, runner.guest.alloc(16, 16), 0);
    console.log(fn, "OK standalone");
  } catch (e: unknown) {
    console.log(fn, "FAIL:", (e as Error).message?.slice(0, 100));
  }
}
