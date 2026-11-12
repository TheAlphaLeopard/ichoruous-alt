import fs from "node:fs";
import { parsePE, rvaToOff } from "./pe.ts.js";
import { decode } from "./isa.ts.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const buf = fs.readFileSync(`${HERE}/../../upload/Ichorous.exe`);
const img = parsePE(buf);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const offOf = (va2) => rvaToOff(img, va2 - img.imageBase);
const readCStr = (va2) => {
  const o = offOf(va2);
  if (o < 0) return "";
  let s = "";
  for (let i = 0; i < 200; i++) {
    const c = buf[o + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
};
const FN = 5385220592;
const text = img.sections.find((s) => s.name === ".text");
const tVA = img.imageBase + text.va, tEnd = tVA + text.rawSize;
const regs = [];
let lastNameRcx = null, lastNameRdx = null, lastR8 = null, lastR9 = null;
let va = tVA;
let count = 0;
while (va < tEnd) {
  const o = offOf(va);
  if (o < 0) {
    va++;
    continue;
  }
  let ins;
  try {
    ins = decode(buf, dv, va, o, tEnd - va);
  } catch {
    va++;
    continue;
  }
  const [d0, d1] = ins.o;
  try {
    if (ins.op === "lea" && d1?.k === "mem" && d1.m.riprel) {
      const t = va + ins.len + d1.m.disp;
      const str = readCStr(t);
      if (/^[\x20-\x7e]{2,80}$/.test(str)) {
        if (d0.r === 1) lastNameRcx = str;
        else if (d0.r === 2) lastNameRdx = str;
      }
    } else if (ins.op === "xor" && d0.k === "reg" && d1.k === "reg" && d0.r === d1.r) {
      if (d0.r === 8) lastR8 = 0;
      else if (d0.r === 9) lastR9 = 0;
    } else if (ins.op === "mov" && d0.k === "reg" && d1?.k === "imm") {
      if (d0.r === 8) lastR8 = Number(d1.v) | 0;
      else if (d0.r === 9) lastR9 = Number(d1.v) | 0;
    } else if (ins.op === "call" && d0?.k === "imm" && Number(d0.v) === FN) {
      if (lastNameRcx) {
        regs.push({ va, name: lastNameRcx, aux: lastNameRdx ?? "", r8: lastR8, r9: lastR9 });
      }
      lastNameRcx = lastNameRdx = null;
      lastR8 = lastR9 = null;
      if (++count >= 4e3) break;
    }
  } catch {
  }
  va += ins.len;
}
console.log("total registrations (addr order):", regs.length);
const uniq = /* @__PURE__ */ new Map();
for (const r of regs) uniq.set(r.name, (uniq.get(r.name) ?? 0) + 1);
console.log("unique names:", uniq.size);
for (const n of ["draw_sprite", "draw_text", "instance_create_layer", "keyboard_check", "room_goto", "place_meeting", "audio_play_sound", "show_debug_message", "variable_instance_get"]) {
  const hits = regs.filter((r) => r.name === n);
  console.log("  ", n, "-> count:", hits.length, hits.slice(0, 3).map((h) => "idx?").join(""));
}
fs.writeFileSync(`${HERE}/out-fnreg-order.json`, JSON.stringify(regs, null, 0));
console.log("sample:", JSON.stringify(regs.slice(0, 8), null, 1));
