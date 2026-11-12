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
const csv = fs.readFileSync(`${HERE}/data/ghidra_pass2_scriptmap.csv`, "utf8").trim().split("\n").slice(1);
const fns = [];
for (const line of csv) {
  const cols = line.split(",");
  const name = cols[0];
  let va = NaN;
  for (const c of cols.slice(1)) if (/^14[0-9a-f]{7,8}$/.test(c)) {
    va = parseInt(c, 16);
    break;
  }
  if (name && name.startsWith("gml_") && Number.isFinite(va)) fns.push({ name, va, end: 0 });
}
const pdata = img.sections.find((s) => s.name === ".pdata");
const pdOff = pdata.rawOff, pdCount = Math.floor(pdata.rawSize / 12);
for (let i = 0; i < pdCount; i++) {
  const s = dv.getUint32(pdOff + i * 12, true), e = dv.getUint32(pdOff + i * 12 + 4, true);
  const f = fns.find((x) => x.va === img.imageBase + s);
  if (f) f.end = img.imageBase + e;
}
const bad = [];
let ok = 0;
for (const f of fns) {
  if (!f.end) {
    bad.push(f.name + " NOEXTENT");
    continue;
  }
  let va = f.va;
  try {
    while (va < f.end) {
      const o = offOf(va);
      if (o < 0) throw new Error("oob");
      const ins = decode(buf, dv, va, o, f.end - va);
      va += ins.len;
    }
    ok++;
  } catch (e) {
    bad.push(`${f.name} @0x${f.va.toString(16)} err=${e.message.split(" @")[0]} bytes=${[...buf.slice(offOf(f.va), offOf(f.va) + 12)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  }
}
console.log("decoded OK:", ok, " failed:", bad.length);
const byKind = {};
for (const b of bad) {
  const kind = b.includes("anon@") ? "anon" : b.includes("____struct___") ? "struct" : b.includes("gml_Object_") ? "object-event" : b.includes("gml_GlobalScript_") ? "global-script" : b.includes("gml_Script_") ? "script" : b.includes("gml_RoomCC") ? "roomcc" : "other";
  byKind[kind] = (byKind[kind] ?? 0) + 1;
}
console.log("failure kinds:", byKind);
for (const b of bad.slice(0, 25)) console.log(" ", b);
