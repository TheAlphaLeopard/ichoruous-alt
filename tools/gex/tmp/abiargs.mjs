// What do specific unimplemented ABI imports actually receive? Guessing a
// shim's signature from the x86 is unsafe: f140e851f0 compares with comisd yet
// the lifted wasm hands it RValue pointers, not doubles. Log real calls first.
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const WANT = (process.argv[2] ?? "f140e794b0,f140162c50,f140e78db0,f140e98b30,f140e78ec0").split(",");
const PER = Number(process.env.PER ?? 4);
const runner = new GMRunner();
runner.debugFn = () => {};
const mk = runner.makeImports.bind(runner);
const seen = new Map();
const g = () => runner.guest;
const show = (p) => {
  if (!p || p + 16 > g().u8.length) return String(p);
  const t = g().dv.getUint32(p + 12, true) & 0xffffff;
  if (t === 0 || t === 4 || t === 7 || t === 10) return "num:" + g().dv.getFloat64(p, true);
  if (t === 1) return '"' + String(g().readString(Number(g().dv.getBigUint64(p, true)) >>> 0)).slice(0, 24) + '"';
  if (t === 6) return "obj:0x" + (Number(g().dv.getBigUint64(p, true)) >>> 0).toString(16);
  if (t === 5) return "undef";
  return "t" + t + ":0x" + (Number(g().dv.getBigUint64(p, true)) >>> 0).toString(16);
};
runner.makeImports = () => {
  const p = mk();
  return new Proxy(p, { get(t, k) {
    const f = t[k];
    if (typeof f !== "function") return f;
    return (...a) => {
      const n = seen.get(k) ?? 0;
      if (WANT.includes(k) && n < PER && !runner.__in) {
        runner.__in = 1;
        const cell = (v) => (v > 0 && v < runner.meta.cellNames.length ? runner.meta.cellNames[v] : null);
        const parts = a.slice(0, 4).map((v, i) => {
          const x = Number(v);
          const c = cell(x);
          return (i === 0 ? "rcx=" : i === 1 ? "rdx=" : i === 2 ? "r8=" : "r9=") +
            (x > 0x100000 && x < g().u8.length ? show(x) : (c ? "cell:" + c : String(x)));
        });
        seen.set(k, n + 1);
        console.log(k + "  " + parts.join("  "));
        runner.__in = 0;
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
const gi = runner.createInstance(Math.max(0, objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
runner.globalInstPtr = gi.guestPtr;
for (const f of runner.meta.fns.filter((f) => f.n.startsWith("gml_GlobalScript_"))) {
  try { runner.budgetMs = 3000; runner.callGuest(f.n, gi.guestPtr, 0, runner.guest.alloc(16, 16), 0); } catch {} finally { runner.budgetMs = 0; }
}
for (const ri of roomOrder.slice(0, Number(process.env.ROOMS ?? 20))) {
  try { runner.budgetMs = 5000; runner.gotoRoom(ri); } catch {} finally { runner.budgetMs = 0; }
  for (let i = 0; i < Number(process.env.FRAMES ?? 10); i++) { try { runner.stepFrame(); } catch {} }
}
