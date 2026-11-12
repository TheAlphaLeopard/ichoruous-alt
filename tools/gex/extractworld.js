import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const buf = fs.readFileSync(`${HERE}/../../upload/data.win`);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let off = 8;
const chunks = {};
while (off + 8 <= buf.length) {
  const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
  const len = dv.getUint32(off + 4, true);
  chunks[id] = { off: off + 8, len };
  off += 8 + len;
  if (off % 4) off += 4 - off % 4;
}
const strCount = dv.getUint32(chunks.STRG.off, true);
const strPtrs = [];
for (let i = 0; i < strCount; i++) strPtrs.push(dv.getUint32(chunks.STRG.off + 4 + 4 * i, true));
const strSet = new Set(strPtrs);
const readStr = (p) => {
  if (!p || !strSet.has(p - 4)) return "";
  const n = Math.min(dv.getUint32(p - 4, true), 4096);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf[p + i]);
  return s;
};
const meta = JSON.parse(fs.readFileSync(`${HERE}/../../public/gex/meta.json`, "utf8"));
const fnNames = new Set(meta.fns.map((f) => f.n));
const OBJT = chunks.OBJT.off;
const objCount = dv.getUint32(OBJT, true);
const objPtrs = [];
for (let i = 0; i < objCount; i++) objPtrs.push(dv.getUint32(OBJT + 4 + 4 * i, true));
const objects = [];
const EVENT_NAMES = {
  "0": "Create",
  "1": "Destroy",
  "2": "Alarm",
  "3": "Step",
  "4": "Collision",
  "5": "Keyboard",
  "6": "Mouse",
  "7": "Other",
  "8": "Draw",
  "9": "KeyPress",
  "10": "KeyRelease",
  "11": "Trigger"
};
for (const op of objPtrs) {
  const name = readStr(dv.getUint32(op, true));
  const sprite = dv.getInt32(op + 4, true);
  const visible = dv.getInt32(op + 8, true) !== 0;
  const solid = dv.getInt32(op + 12, true) !== 0;
  const depth = dv.getInt32(op + 16, true);
  const persistent = dv.getInt32(op + 20, true) !== 0;
  let evListPtr = 0;
  for (let o = 88; o <= 200; o += 4) {
    const cand = dv.getUint32(op + o, true);
    if (cand > OBJT && cand < OBJT + chunks.OBJT.len && dv.getUint32(cand, true) <= 16) {
      let ok = true;
      const n = dv.getUint32(cand, true);
      for (let k = 0; k < Math.min(n, 3); k++) {
        const sub = dv.getUint32(cand + 4 + 4 * k, true);
        if (!sub || sub < cand || sub > cand + 4096) {
          ok = false;
          break;
        }
      }
      if (ok && n > 0) {
        evListPtr = cand;
        break;
      }
    }
  }
  const events = {};
  if (evListPtr) {
    const nTypes = dv.getUint32(evListPtr, true);
    for (let t = 0; t < nTypes; t++) {
      const e = dv.getUint32(evListPtr + 4 + 4 * t, true);
      if (!e) continue;
      const evType = dv.getUint32(e, true);
      const count = dv.getUint32(e + 4, true);
      const listPtr = dv.getUint32(e + 8, true);
      const evName = EVENT_NAMES[String(evType)] ?? "Ev" + evType;
      for (let k = 0; k < count; k++) {
        const ep = dv.getUint32(listPtr + 4 + 4 * k, true);
        if (!ep) continue;
        const fnName = "gml_Object_" + name + "_" + evName + "_" + k;
        if (fnNames.has(fnName)) {
          (events[evName] ??= []).push(fnName);
        }
      }
    }
  }
  objects.push({ name, sprite, visible, solid, depth, persistent, events });
}
console.log("objects:", objects.length);
const withEvents = objects.filter((o) => Object.keys(o.events).length > 0).length;
console.log("objects with mapped events:", withEvents);
const ROOM = chunks.ROOM.off;
const roomCount = dv.getUint32(ROOM, true);
const roomPtrs = [];
for (let i = 0; i < roomCount; i++) roomPtrs.push(dv.getUint32(ROOM + 4 + 4 * i, true));
const rooms = [];
for (const rp of roomPtrs) {
  const name = readStr(dv.getUint32(rp, true));
  const w = dv.getUint32(rp + 8, true);
  const h = dv.getUint32(rp + 12, true);
  const speed = dv.getUint32(rp + 16, true);
  const instances = [];
  const tryList = (listPtr) => {
    if (!listPtr || listPtr < rp || listPtr > rp + 1e5) return;
    const n = dv.getUint32(listPtr, true);
    if (n > 1e4) return;
    for (let k = 0; k < n; k++) {
      const ip = dv.getUint32(listPtr + 4 + 4 * k, true);
      if (!ip) continue;
      const x = dv.getInt32(ip, true), y = dv.getInt32(ip + 4, true), obj = dv.getInt32(ip + 8, true);
      if (obj >= 0 && obj < objects.length && Math.abs(x) < 1e5 && Math.abs(y) < 1e5) instances.push({ obj, x, y });
    }
  };
  tryList(dv.getUint32(rp + 48, true));
  const layPtr = dv.getUint32(rp + 92, true);
  if (layPtr) {
    const nL = dv.getUint32(layPtr, true);
    if (nL > 0 && nL < 200) {
      for (let li = 0; li < nL; li++) {
        const lp = dv.getUint32(layPtr + 4 + 4 * li, true);
        if (!lp) continue;
        const lType = dv.getUint32(lp + 8, true);
        if (lType === 2) {
          for (let o = 16; o <= 48; o += 4) {
            const cand = dv.getUint32(lp + o, true);
            if (cand > rp && cand < rp + 2e5 && dv.getUint32(cand, true) < 5e3) {
              const before = instances.length;
              tryList(cand);
              if (instances.length > before) break;
            }
          }
        }
      }
    }
  }
  rooms.push({ name, w, h, speed, instances });
}
console.log("rooms:", rooms.length);
console.log("room0:", JSON.stringify(rooms[0]).slice(0, 300));
const totalInst = rooms.reduce((a, r) => a + r.instances.length, 0);
console.log("total room instances:", totalInst);
fs.writeFileSync(`${HERE}/../../public/gex/objects.json`, JSON.stringify(objects));
fs.writeFileSync(`${HERE}/../../public/gex/rooms.json`, JSON.stringify(rooms));
console.log("wrote objects.json, rooms.json");
