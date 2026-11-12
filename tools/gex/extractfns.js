import fs from "node:fs";
import { parsePE, rvaToOff } from "./pe.ts.js";
import { decode } from "./isa.ts.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const buf = fs.readFileSync(`${HERE}/../../upload/Ichorous.exe`);
const img = parsePE(buf);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const offOf = (va) => rvaToOff(img, va - img.imageBase);
const readCStr = (va) => {
  const o = offOf(va);
  if (o < 0) return "";
  let s = "";
  for (let i = 0; i < 200; i++) {
    const c = buf[o + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
};
const FN = 0x140fbf1f0n;
const text = img.sections.find((s) => s.name === ".text");
const pdata = img.sections.find((s) => s.name === ".pdata");
const pdOff = pdata.rawOff, pdCount = Math.floor(pdata.rawSize / 12);
const results = [];
for (let i = 0; i < pdCount; i++) {
  const sVA = img.imageBase + dv.getUint32(pdOff + i * 12, true);
  const eVA = img.imageBase + dv.getUint32(pdOff + i * 12 + 4, true);
  if (eVA - sVA > 4e6) continue;
  let va = sVA;
  let lastName = null, lastName2 = null, lastR8 = null, r9 = 0;
  let calls = 0;
  try {
    while (va < eVA) {
      const o = offOf(va);
      if (o < 0) break;
      const ins = decode(buf, dv, va, o, eVA - va);
      const [d0, d1] = ins.o;
      if (ins.op === "lea" && d1.k === "mem" && d1.m.riprel) {
        const t = va + ins.len + d1.m.disp;
        const str = readCStr(t);
        if (/^[\x20-\x7e]{2,64}$/.test(str)) {
          const dreg = d0.r;
          if (dreg === 2) lastName = str;
          else if (dreg === 1) lastName2 = str;
        }
      } else if (ins.op === "mov" && d0.k === "reg" && d0.r === 8 && d1.k === "imm") {
        lastR8 = Number(d1.v) | 0;
      } else if (ins.op === "lea" && d0.k === "reg" && d0.r === 8 && d0.size === 4 && d1.k === "mem" && d1.m.base === 9 && d1.m.index === void 0) {
        lastR8 = r9 + d1.m.disp | 0;
      } else if (ins.op === "xor" && d0.k === "reg" && d0.r === 9 && d1.k === "reg" && d1.r === 9) {
        r9 = 0;
      } else if (ins.op === "mov" && d0.k === "reg" && d0.r === 9 && d1.k === "imm") {
        r9 = Number(d1.v) | 0;
      } else if (ins.op === "call" && d1 === void 0 && d0.k === "imm" && d0.v === FN) {
        if (lastName !== null && lastR8 !== null) {
          results.push({ id: lastR8, name: lastName, name2: lastName2 ?? "", va });
          calls++;
        }
      }
      va += ins.len;
    }
  } catch {
  }
  void calls;
}
console.log("registrations found:", results.length);
const byId = /* @__PURE__ */ new Map();
for (const r of results) {
  const e = byId.get(r.id);
  if (e) {
    e.n++;
    if (e.name !== r.name) e.name = e.name + "|" + r.name;
  } else byId.set(r.id, { name: r.name, name2: r.name2, n: 1 });
}
console.log("distinct ids:", byId.size);
const arr = [...byId.entries()].sort((a, b) => a[0] - b[0]);
console.log("id range:", arr[0][0], "..", arr[arr.length - 1][0]);
for (const [id, e] of arr) {
  if (["draw_sprite", "instance_create_layer", "keyboard_check", "room_goto", "audio_play_sound", "place_meeting", "draw_text"].includes(e.name)) console.log("  ", id, e.name, "|", e.name2, "x" + e.n);
}
fs.writeFileSync(`${HERE}/out-fnreg.json`, JSON.stringify(arr.map(([id, e]) => ({ id, name: e.name, name2: e.name2 })), null, 0));
console.log("wrote out-fnreg.json");
