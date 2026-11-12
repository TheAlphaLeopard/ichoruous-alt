import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "../../js/gex/runtime.js";
function readBin(path) {
  try {
    const gz = fs.readFileSync(process.env.SUB ? path.replace("gex", "/tmp/gexsub") + ".gz" : path + ".gz");
    return gunzipSync(gz);
  } catch {
  }
  return fs.readFileSync(process.env.SUB ? path.replace("gex", "/tmp/gexsub") : path);
}
const meta = JSON.parse(fs.readFileSync(process.env.SUB ? "/tmp/gexsub/meta.json" : "gex/meta.json", "utf8"));
const builtins = JSON.parse(fs.readFileSync("gex/builtins.json", "utf8"));
const objects = JSON.parse(fs.readFileSync("gex/objects.json", "utf8"));
const rooms = JSON.parse(fs.readFileSync("gex/rooms.json", "utf8"));
const cartridge = JSON.parse(fs.readFileSync("cartridge/game.json", "utf8"));
const roomOrder = JSON.parse(fs.readFileSync("cartridge/room_order.json", "utf8"));
const image = readBin("gex/image.bin");
const wasm = readBin("gex/game.wasm");
const runner = new GMRunner();
const logs = [];
runner.debugFn = (m) => logs.push(m);
await runner.boot(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), image, meta, builtins);
const sprites = cartridge.sprites.map((s) => ({
  name: s.name,
  w: s.w,
  h: s.h,
  ox: s.origin?.[0] ?? 0,
  oy: s.origin?.[1] ?? 0,
  speed: s.speed,
  speedType: s.speedType,
  frames: s.frames
}));
const roomIdxByName = new Map(rooms.map((r, i) => [r.name, i]));
const order = roomOrder.map((ro) => roomIdxByName.get(ro.room)).filter((i) => i !== void 0);
runner.loadWorld(sprites, objects, rooms, order, cartridge.sounds.map((s) => s.name));
const globalInst = runner.createInstance(objects.findIndex((o) => o.name === "__InputUpdateController"), 0, 0);
runner.globalInstPtr = globalInst.guestPtr;
let okGs = 0;
const gsFails = /* @__PURE__ */ new Map();
for (const f of runner.meta.fns) {
  if (!f.n.startsWith("gml_GlobalScript_")) continue;
  try {
    runner.callGuest(f.n, globalInst.guestPtr, 0, runner.guest.alloc(16, 16), 0);
    okGs++;
  } catch (e) {
    const msg = String(e.message).slice(0, 500);
    gsFails.set(msg, (gsFails.get(msg) ?? 0) + 1);
  }
}
console.log("global scripts ok:", okGs, "failed kinds:", [...gsFails.entries()].map(([k, n]) => n + "x " + k).slice(0, 3));
const eventFails = /* @__PURE__ */ new Map();
const origRunEvent = runner.runEvent.bind(runner);
runner.runEvent = (inst, ev) => {
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
  try {
    runner.stepFrame();
  } catch (e) {
    console.log("STEP FAIL f" + i + ":", e.stack?.split("\n").slice(0, 4).join(" | "));
    break;
  }
}
console.log("after 30 frames: instances:", runner.instanceList.length, "drawCalls:", runner.drawCalls);
const fails = [...eventFails.entries()].sort((a, b) => b[1] - a[1]);
console.log("top event failures:", fails.slice(0, 12));
console.log("distinct failing events:", fails.length, "total:", fails.reduce((a, b) => a + b[1], 0));
console.log("unimplemented builtins:", [...runner.unimplementedBuiltins.entries()].filter(([k]) => !k.startsWith("abi:")).slice(0, 15));
const abiUn = [...runner.unimplementedBuiltins.entries()].filter(([k]) => k.startsWith("abi:")).sort((a, b) => b[1] - a[1]);
console.log("top unimplemented ABI:", abiUn.slice(0, 12));
const failFns = ["gml_Object_oCam_Create_0", "gml_Object_oOfferingManager_Create_0", "gml_Object_oRunManager_Create_0"];
for (const fn of failFns) {
  const f = runner.fnByName.get(fn);
  if (!f) {
    console.log(fn, "not found");
    continue;
  }
  const inst = runner.instanceList.find((i) => i.objIndex === objects.findIndex((o) => o.name === fn.split("_")[1].replace(/^o/, "o")));
  try {
    const target = runner.instanceList.find((i2) => i2.guestPtr && objects[i2.objIndex]?.events?.Create?.includes(fn));
    runner.callGuest(fn, (target ?? globalInst).guestPtr, 0, runner.guest.alloc(16, 16), 0);
    console.log(fn, "OK standalone");
  } catch (e) {
    console.log(fn, "FAIL:", e.message?.slice(0, 100));
  }
}
