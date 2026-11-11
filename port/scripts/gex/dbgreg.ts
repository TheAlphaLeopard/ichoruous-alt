import fs from "node:fs";
import { parsePE, rvaToOff } from "./pe.ts";
import { decode } from "./isa.ts";
const buf = fs.readFileSync(`${import.meta.dir}/../../upload/Ichorous.exe`);
const img = parsePE(buf);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const offOf = (va: number) => rvaToOff(img, va - img.imageBase);
const pdata = img.sections.find((s) => s.name === ".pdata")!;
const pdOff = pdata.rawOff, pdCount = Math.floor(pdata.rawSize / 12);
// find pdata record containing 0x140ebeee7
const probe = 0x140ebeee7;
for (let i = 0; i < pdCount; i++) {
  const s = img.imageBase + dv.getUint32(pdOff + i * 12, true);
  const e = img.imageBase + dv.getUint32(pdOff + i * 12 + 4, true);
  if (probe >= s && probe < e) {
    console.log("registration fn: 0x" + s.toString(16), ".. 0x" + e.toString(16), "size:", e - s);
    // scan it counting FN calls with graceful error handling
    let va = s, calls = 0, errs = 0, maxReach = s;
    while (va < e) {
      const o = offOf(va);
      if (o < 0) break;
      try {
        const ins = decode(buf, dv, va, o, e - va);
        if (ins.op === "call") { const t = Number((ins.o[0] as any).v); if (t === 0x140fcf1f0) calls++; }
        va += ins.len; maxReach = va;
      } catch (err: any) { errs++; va++; }
    }
    console.log("FN calls found:", calls, "errors skipped:", errs, "reach:", "0x" + maxReach.toString(16));
    break;
  }
}
