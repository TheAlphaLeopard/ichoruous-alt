import fs from "node:fs";
import { parsePE, rvaToOff } from "./pe.ts";
import { decode } from "./isa.ts";
const buf = fs.readFileSync(`${import.meta.dir}/../../upload/Ichorous.exe`);
const img = parsePE(buf);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const offOf = (va: number) => rvaToOff(img, va - img.imageBase);
// sample: find functions that fail — reuse mine quickly by scanning first 64 bytes
const csv = fs.readFileSync(`${import.meta.dir}/data/ghidra_pass2_scriptmap.csv`, "utf8").trim().split("\n").slice(1);
const fns: { name: string; va: number; end: number }[] = [];
for (const line of csv) {
  const cols = line.split(","); const name = cols[0];
  let va = NaN;
  for (const c of cols.slice(1)) if (/^14[0-9a-f]{7,8}$/.test(c)) { va = parseInt(c, 16); break; }
  if (name && name.startsWith("gml_") && Number.isFinite(va)) fns.push({ name, va, end: 0 });
}
const pdata = img.sections.find((s) => s.name === ".pdata")!;
const pdOff = pdata.rawOff;
const pdCount = Math.floor(pdata.rawSize / 12);
for (let i = 0; i < pdCount; i++) {
  const s = dv.getUint32(pdOff + i * 12, true), e = dv.getUint32(pdOff + i * 12 + 4, true);
  const f = fns.find((x) => x.va === img.imageBase + s);
  if (f) f.end = img.imageBase + e;
}
let shown = 0;
for (const f of fns) {
  if (!f.end) continue;
  const off = offOf(f.va);
  const hex = [...buf.slice(off, off + 24)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  let err: string | null = null;
  let va = f.va, n = 0;
  try { while (va < f.end && n < 64) { const o = offOf(va); const ins = decode(buf, dv, va, o, f.end - va); va += ins.len; n++; } } catch (e: any) { err = e.message; }
  if (err) {
    console.log(f.name);
    console.log("  va=0x" + f.va.toString(16), "bytes:", hex);
    console.log("  err:", err);
    if (++shown >= 12) break;
  }
}
console.log("total fns:", fns.length);
