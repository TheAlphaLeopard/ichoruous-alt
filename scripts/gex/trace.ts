import fs from "node:fs";
import { parsePE, rvaToOff } from "./pe.ts";
import { decode, GPR_NAMES } from "./isa.ts";
const buf = fs.readFileSync(`${import.meta.dir}/../../upload/Ichorous.exe`);
const img = parsePE(buf);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const offOf = (va: number) => rvaToOff(img, va - img.imageBase);
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
} catch (e: any) {
  const o = offOf(va);
  console.log(`ERR @ 0x${va.toString(16)}: ${e.message}`);
  console.log("  bytes:", [...buf.slice(o - 8, o + 12)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
}
