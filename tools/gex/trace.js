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
let va = va0;
try {
  while (va < vaEnd) {
    const o = offOf(va);
    const ins = decode(buf, dv, va, o, vaEnd - va);
    const bytes = [...buf.slice(o, o + ins.len)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    console.log(`0x${va.toString(16)} [${ins.len}] ${ins.op.padEnd(10)} ${bytes}`);
    va += ins.len;
  }
} catch (e) {
  const o = offOf(va);
  console.log(`ERR @ 0x${va.toString(16)}: ${e.message}`);
  console.log("  bytes:", [...buf.slice(o - 8, o + 12)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
}
