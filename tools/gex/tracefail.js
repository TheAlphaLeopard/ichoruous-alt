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
const va0 = parseInt(process.argv[2], 16);
const vaEnd = parseInt(process.argv[3], 16);
let va = va0, last = null;
try {
  while (va < vaEnd) {
    const o = offOf(va);
    const ins = decode(buf, dv, va, o, vaEnd - va);
    last = { va, ins };
    va += ins.len;
  }
  console.log("decoded to end OK");
} catch (e) {
  console.log("last OK ins @ 0x" + last.va.toString(16), last.ins.op, last.ins.len, "bytes:", [...buf.slice(offOf(last.va), offOf(last.va) + last.ins.len)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
  console.log("ERR @ 0x" + va.toString(16) + ":", e.message);
  const o = offOf(va);
  console.log("  at err:", [...buf.slice(o - 16, o + 16)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
}
