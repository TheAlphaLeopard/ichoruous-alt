// Extract world data from data.win: objects with event→gml-fn mappings, rooms with instances.
import fs from "node:fs";

const buf = fs.readFileSync(`${import.meta.dir}/../../upload/data.win`);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let off = 8;
const chunks: Record<string, { off: number; len: number }> = {};
while (off + 8 <= buf.length) {
  const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
  const len = dv.getUint32(off + 4, true);
  chunks[id] = { off: off + 8, len };
  off += 8 + len;
  if (off % 4) off += 4 - (off % 4);
}
const strCount = dv.getUint32(chunks.STRG.off, true);
const strPtrs: number[] = [];
for (let i = 0; i < strCount; i++) strPtrs.push(dv.getUint32(chunks.STRG.off + 4 + 4 * i, true));
const strSet = new Set(strPtrs);
const readStr = (p: number): string => {
  if (!p || !strSet.has(p - 4)) return "";
  const n = Math.min(dv.getUint32(p - 4, true), 4096);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf[p + i]);
  return s;
};

// registry names for event mapping
const meta = JSON.parse(fs.readFileSync(`${import.meta.dir}/../../public/gex/meta.json`, "utf8"));
const fnNames = new Set(meta.fns.map((f) => f.n));

// OBJT: pointer list; entry: name, sprite, visible, solid, depth, persistent, ...events
const OBJT = chunks.OBJT.off;
const objCount = dv.getUint32(OBJT, true);
const objPtrs: number[] = [];
for (let i = 0; i < objCount; i++) objPtrs.push(dv.getUint32(OBJT + 4 + 4 * i, true));
// event list pointer offset in OBJT entry: scan for pointer to list-of-lists after fixed fields
// GM layout: name, spriteId, visible, solid, depth, persistent, textureId?, ..., physics..., eventList ptr at the end.
// We find it: the LAST u32 in the entry that points into OBJT-managed heap (or use known offset).
// UndertaleModLib (2022.3+): SpriteIndex+0, Visible+4, Solid+8, Depth+12, Persistent+16, ParentId+20,
// MaskId+24, Polygon+28, Line+32, UsesPhysics+36, IsSensor+40, CollisionShape+44, Density+48, Restitution+52,
// Group+56, LinearDamping+60, AngularDamping+64, Friction+68, Awake+72, Kinematic+76, IsBullet+80,
// IsSleeping+84, FixedRotation+88, IsEnabled+92, IfVertexCache+96... then 10 zero u32s, then EventList ptr.
// Robust: scan offsets 96..160 for a u32 that points to a list whose count is small and entries are pointers.
interface ObjDef { name: string; sprite: number; visible: boolean; solid: boolean; depth: number; persistent: boolean; events: Record<string, string[]> }
const objects: ObjDef[] = [];
const EVENT_NAMES: Record<string, string> = {
  "0": "Create", "1": "Destroy", "2": "Alarm", "3": "Step", "4": "Collision", "5": "Keyboard", "6": "Mouse",
  "7": "Other", "8": "Draw", "9": "KeyPress", "10": "KeyRelease", "11": "Trigger",
};
for (const op of objPtrs) {
  const name = readStr(dv.getUint32(op, true));
  const sprite = dv.getInt32(op + 4, true);
  const visible = dv.getInt32(op + 8, true) !== 0;
  const solid = dv.getInt32(op + 12, true) !== 0;
  const depth = dv.getInt32(op + 16, true);
  const persistent = dv.getInt32(op + 20, true) !== 0;
  // find event list ptr: scan the entry for a pointer p where [p] is a count <= 20 and [p+4+k*4] are pointers
  let evListPtr = 0;
  for (let o = 88; o <= 200; o += 4) {
    const cand = dv.getUint32(op + o, true);
    if (cand > OBJT && cand < OBJT + chunks.OBJT.len && dv.getUint32(cand, true) <= 16) {
      let ok = true;
      const n = dv.getUint32(cand, true);
      for (let k = 0; k < Math.min(n, 3); k++) {
        const sub = dv.getUint32(cand + 4 + 4 * k, true);
        if (!sub || sub < cand || sub > cand + 4096) { ok = false; break; }
      }
      if (ok && n > 0) { evListPtr = cand; break; }
    }
  }
  const events: Record<string, string[]> = {};
  if (evListPtr) {
    // event list: per event type: {eventType, count, ptr to event list}
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
        // event entry: {... , code ptr} — modern: {flags?, ..., id ptr, ...}; the code entry ptr near end
        // 2022.3+: each event: {LegacyId?, ..., CodeEntry ptr}? scan for a u32 that's a CODE-style entry:
        // we instead match gml_Object_<name>_<Ev>_<num> in the registry directly — no need to parse the entry!
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

// ROOM: layers-based instances (GM 2023+). Parse with UndertaleModLib-ish layout.
const ROOM = chunks.ROOM.off;
const roomCount = dv.getUint32(ROOM, true);
const roomPtrs: number[] = [];
for (let i = 0; i < roomCount; i++) roomPtrs.push(dv.getUint32(ROOM + 4 + 4 * i, true));
interface RoomDef { name: string; w: number; h: number; speed: number; instances: { obj: number; x: number; y: number }[] }
const rooms: RoomDef[] = [];
for (const rp of roomPtrs) {
  const name = readStr(dv.getUint32(rp, true));
  const w = dv.getUint32(rp + 8, true);
  const h = dv.getUint32(rp + 12, true);
  const speed = dv.getUint32(rp + 16, true);
  const instances: { obj: number; x: number; y: number }[] = [];
  // direct GameObjectsOffset list (may be legacy or populated)
  const tryList = (listPtr: number) => {
    if (!listPtr || listPtr < rp || listPtr > rp + 100000) return;
    const n = dv.getUint32(listPtr, true);
    if (n > 10000) return;
    for (let k = 0; k < n; k++) {
      const ip = dv.getUint32(listPtr + 4 + 4 * k, true);
      if (!ip) continue;
      const x = dv.getInt32(ip, true), y = dv.getInt32(ip + 4, true), obj = dv.getInt32(ip + 8, true);
      if (obj >= 0 && obj < objects.length && Math.abs(x) < 100000 && Math.abs(y) < 100000) instances.push({ obj, x, y });
    }
  };
  tryList(dv.getUint32(rp + 48, true)); // GameObjectsOffset candidate
  // layers (LayersOffset candidate at +84): each layer may be instance layer with instances list
  const layPtr = dv.getUint32(rp + 92, true);
  if (layPtr) {
    const nL = dv.getUint32(layPtr, true);
    if (nL > 0 && nL < 200) {
      for (let li = 0; li < nL; li++) {
        const lp = dv.getUint32(layPtr + 4 + 4 * li, true);
        if (!lp) continue;
        const lType = dv.getUint32(lp + 8, true); // name, id, type
        // layer layout: name(4) id(4) type(4) depth(4) x(4) y(4)... for instance layer (type 2): instancesList follows at some offset
        if (lType === 2) {
          // instance layer: ...offset 28?: instancesList ptr — scan 16..48 for a plausible list
          for (let o = 16; o <= 48; o += 4) {
            const cand = dv.getUint32(lp + o, true);
            if (cand > rp && cand < rp + 200000 && dv.getUint32(cand, true) < 5000) {
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
fs.writeFileSync(`${import.meta.dir}/../../public/gex/objects.json`, JSON.stringify(objects));
fs.writeFileSync(`${import.meta.dir}/../../public/gex/rooms.json`, JSON.stringify(rooms));
console.log("wrote objects.json, rooms.json");
