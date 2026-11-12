import fs from "node:fs";
import { parsePE, rvaToOff } from "./pe.ts.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const buf = fs.readFileSync(`${HERE}/../../upload/Ichorous.exe`);
const img = parsePE(buf);
const offOf = (va) => rvaToOff(img, va - img.imageBase);
const readCStr = (va, max = 128) => {
  const o = offOf(va);
  if (o < 0) return null;
  let s = "";
  for (let i = 0; i < max; i++) {
    const c = buf[o + i];
    if (!c) break;
    if (c < 32 || c > 126) return null;
    s += String.fromCharCode(c);
  }
  return s.length >= 1 ? s : null;
};
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const data = img.sections.find((s) => s.name === ".data");
const entries = [];
const seenCell = /* @__PURE__ */ new Set();
for (let i = 0; i <= data.rawSize - 16; i += 8) {
  const q0 = dv.getBigUint64(data.rawOff + i, true);
  if (q0 <= 0x140000000n || q0 >= 0x142000000n) continue;
  const str = readCStr(Number(q0));
  if (!str || !/^[A-Za-z_@][A-Za-z0-9_@]*$/.test(str)) continue;
  const entryVA = img.imageBase + data.va + i;
  const cellVA = entryVA + 8;
  const cell = dv.getBigUint64(data.rawOff + i + 8, true);
  if (cell > 0xffffn) continue;
  if (seenCell.has(cellVA)) continue;
  seenCell.add(cellVA);
  entries.push({ name: str, cellVA, flags: Number(cell), strVA: Number(q0) });
}
console.log("entries:", entries.length);
const uniqNames = new Set(entries.map((e) => e.name));
console.log("unique names:", uniqNames.size);
const scriptmap = new Set(fs.readFileSync(`${HERE}/data/ghidra_pass2_scriptmap.csv`, "utf8").split("\n").slice(1).map((l) => l.split(",")[0]));
const fnreg = JSON.parse(fs.readFileSync(`${HERE}/out-fnreg-order.json`, "utf8"));
const builtinFns = new Set(fnreg.map((r) => r.name));
let fn = 0, script = 0, variable = 0;
const unknownNames = [];
for (const e of entries) {
  if (builtinFns.has(e.name)) fn++;
  else if (scriptmap.has(e.name) || scriptmap.has("gml_Script_" + e.name) || e.name.startsWith("gml_")) script++;
  else {
    variable++;
    if (unknownNames.length < 30) unknownNames.push(e.name);
  }
}
console.log("classified: builtin-fn refs:", fn, " script refs:", script, " variable/other refs:", variable);
console.log("sample variables:", unknownNames.join(", "));
const vas = entries.map((e) => e.cellVA);
console.log("table span: 0x" + Math.min(...vas).toString(16), ".. 0x" + Math.max(...vas).toString(16));
fs.writeFileSync(`${HERE}/out-reftable.json`, JSON.stringify(entries));
console.log("wrote out-reftable.json");
