import fs from "node:fs";
import { parsePE, rvaToOff } from "./pe.ts.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_BASE = 5368709120;
const HEAP_BASE = 33554432;
const HEAP_END = 40894464;
const STACK_BASE = 40894464;
const STACK_TOP = 46137344;
const MEM_PAGES = 768;
function buildRegistry(exePath) {
  const buf = fs.readFileSync(exePath);
  const img = parsePE(buf);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const offOf = (va) => rvaToOff(img, va - img.imageBase);
  const pdata = img.sections.find((s) => s.name === ".pdata");
  const pdOff = pdata.rawOff, pdCount = Math.floor(pdata.rawSize / 12);
  const ext = /* @__PURE__ */ new Map();
  for (let i = 0; i < pdCount; i++) ext.set(img.imageBase + dv.getUint32(pdOff + i * 12, true), img.imageBase + dv.getUint32(pdOff + i * 12 + 4, true));
  const csv = fs.readFileSync(`${HERE}/data/ghidra_pass2_scriptmap.csv`, "utf8").trim().split("\n").slice(1);
  const fnRaw = [];
  for (const line of csv) {
    const cols = line.split(",");
    const name = cols[0];
    let va = NaN;
    for (const c of cols.slice(1)) if (/^14[0-9a-f]{7,8}$/.test(c)) {
      va = parseInt(c, 16);
      break;
    }
    if (name && name.startsWith("gml_") && Number.isFinite(va)) fnRaw.push({ name, va });
  }
  fnRaw.sort((a, b) => a.va - b.va);
  const fns = fnRaw.map((f, i) => ({ name: f.name, va: f.va, end: ext.get(f.va) ?? f.va, idx: i }));
  const data = img.sections.find((s) => s.name === ".data");
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
  const cells = [];
  const seenCell = /* @__PURE__ */ new Set();
  for (let i = 0; i <= data.rawSize - 16; i += 8) {
    const q0 = dv.getBigUint64(data.rawOff + i, true);
    if (q0 <= BigInt(IMAGE_BASE) || q0 >= BigInt(IMAGE_BASE + 33554432)) continue;
    const str = readCStr(Number(q0));
    if (!str || !/^[A-Za-z_@][A-Za-z0-9_@]*$/.test(str)) continue;
    const cellVA = img.imageBase + data.va + i + 8;
    const cell = dv.getBigUint64(data.rawOff + i + 8, true);
    if (cell > 0xffffffffn) continue;
    if (seenCell.has(cellVA)) continue;
    seenCell.add(cellVA);
    cells.push({ cellVA, name: str });
  }
  const cellIdByVA = /* @__PURE__ */ new Map();
  const nameByCellId = [];
  cells.forEach((c, i) => {
    cellIdByVA.set(c.cellVA, i);
    nameByCellId[i] = c.name;
  });
  const fnreg = JSON.parse(fs.readFileSync(`${HERE}/out-fnreg-order.json`, "utf8"));
  const builtinFnNames = new Set(fnreg.map((r) => r.name));
  const scriptNames = new Set(fns.map((f) => f.name));
  const fnByVa = new Map(fns.map((f) => [f.va, f]));
  const fnByName = new Map(fns.map((f) => [f.name, f]));
  return { fns, fnByVa, fnByName, cells, cellIdByVA, nameByCellId, builtinFnNames, scriptNames };
}
function buildImage(exePath, reg) {
  const buf = fs.readFileSync(exePath);
  const img = parsePE(buf);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const mem = new Uint8Array(MEM_PAGES * 65536);
  const memDv = new DataView(mem.buffer);
  for (const s of img.sections) {
    if (s.rawSize === 0) continue;
    const dst = s.va;
    mem.set(buf.subarray(s.rawOff, s.rawOff + s.rawSize), dst);
  }
  const reloc = img.sections.find((s) => s.name === ".reloc");
  let relocCount = 0;
  if (reloc) {
    let p = reloc.rawOff;
    const pEnd = reloc.rawOff + reloc.rawSize;
    while (p + 8 <= pEnd) {
      const pageRVA = dv.getUint32(p, true);
      const blockSize = dv.getUint32(p + 4, true);
      if (blockSize === 0) break;
      let e = p + 8;
      const eEnd = p + blockSize;
      while (e + 2 <= eEnd) {
        const word = dv.getUint16(e, true);
        const type = word >> 12, offs = word & 4095;
        if (type === 10) {
          const addr = pageRVA + offs;
          const fo = rvaToOff(img, addr);
          if (fo >= 0) {
            const q = dv.getBigUint64(fo, true);
            if (q >= BigInt(IMAGE_BASE) && q < BigInt(IMAGE_BASE + 33554432)) {
              memDv.setBigUint64(addr, q - BigInt(IMAGE_BASE), true);
              relocCount++;
            }
          }
        }
        e += 2;
      }
      p += blockSize;
      if (blockSize % 4) p += 4 - blockSize % 4;
    }
  }
  console.log("relocated pointers:", relocCount);
  for (const [cellVA, id] of reg.cellIdByVA) {
    memDv.setInt32(cellVA - IMAGE_BASE, id, true);
  }
  return mem;
}
export {
  HEAP_BASE,
  HEAP_END,
  IMAGE_BASE,
  MEM_PAGES,
  STACK_BASE,
  STACK_TOP,
  buildImage,
  buildRegistry
};
