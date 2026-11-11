// gex image + registry: builds the guest linear-memory image and the unified id tables.
// Guest VA == wasm linear offset - nothing else: VA 0x140000000 maps to offset 0 (folded at build).
import fs from "node:fs";
import { parsePE, rvaToOff } from "./pe.ts";

export const IMAGE_BASE = 0x140000000;
export const HEAP_BASE = 0x02000000; // 32MB: guest heap after the 30.7MB image
export const HEAP_END = 0x02700000; export const STACK_BASE = 0x02700000; // stack below heap end
export const STACK_TOP = 0x02C00000;
export const MEM_PAGES = 0x300; // 48MB total wasm memory

export interface FnEntry { name: string; va: number; end: number; idx: number }

export interface Registry {
  fns: FnEntry[];                 // all lifted game functions
  fnByVa: Map<number, FnEntry>;
  fnByName: Map<string, FnEntry>;
  cells: { cellVA: number; name: string }[];   // static {name, cell} table entries (unique by cellVA)
  cellIdByVA: Map<number, number>;             // cellVA -> our id
  nameByCellId: string[];
  builtinFnNames: Set<string>;
  scriptNames: Set<string>;
}

export function buildRegistry(exePath: string): Registry {
  const buf = fs.readFileSync(exePath);
  const img = parsePE(buf);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const offOf = (va: number) => rvaToOff(img, va - img.imageBase);

  // .pdata extents
  const pdata = img.sections.find((s) => s.name === ".pdata")!;
  const pdOff = pdata.rawOff, pdCount = Math.floor(pdata.rawSize / 12);
  const ext = new Map<number, number>();
  for (let i = 0; i < pdCount; i++) ext.set(img.imageBase + dv.getUint32(pdOff + i * 12, true), img.imageBase + dv.getUint32(pdOff + i * 12 + 4, true));

  // scriptmap
  const csv = fs.readFileSync(`${import.meta.dir}/data/ghidra_pass2_scriptmap.csv`, "utf8").trim().split("\n").slice(1);
  const fnRaw: { name: string; va: number }[] = [];
  for (const line of csv) {
    const cols = line.split(",");
    const name = cols[0];
    let va = NaN;
    for (const c of cols.slice(1)) if (/^14[0-9a-f]{7,8}$/.test(c)) { va = parseInt(c, 16); break; }
    if (name && name.startsWith("gml_") && Number.isFinite(va)) fnRaw.push({ name, va });
  }
  fnRaw.sort((a, b) => a.va - b.va);
  const fns: FnEntry[] = fnRaw.map((f, i) => ({ name: f.name, va: f.va, end: ext.get(f.va) ?? f.va, idx: i }));

  // reference table (cells)
  const data = img.sections.find((s) => s.name === ".data")!;
  const readCStr = (va: number, max = 128): string | null => {
    const o = offOf(va); if (o < 0) return null;
    let s = "";
    for (let i = 0; i < max; i++) { const c = buf[o + i]; if (!c) break; if (c < 0x20 || c > 0x7e) return null; s += String.fromCharCode(c); }
    return s.length >= 1 ? s : null;
  };
  const cells: { cellVA: number; name: string }[] = [];
  const seenCell = new Set<number>();
  for (let i = 0; i <= data.rawSize - 16; i += 8) {
    const q0 = dv.getBigUint64(data.rawOff + i, true);
    if (q0 <= BigInt(IMAGE_BASE) || q0 >= BigInt(IMAGE_BASE + 0x2000000)) continue;
    const str = readCStr(Number(q0));
    if (!str || !/^[A-Za-z_@][A-Za-z0-9_@]*$/.test(str)) continue;
    const cellVA = img.imageBase + data.va + i + 8;
    const cell = dv.getBigUint64(data.rawOff + i + 8, true);
    if (cell > 0xffffffffn) continue;
    if (seenCell.has(cellVA)) continue;
    seenCell.add(cellVA);
    cells.push({ cellVA, name: str });
  }
  const cellIdByVA = new Map<number, number>();
  const nameByCellId: string[] = [];
  cells.forEach((c, i) => { cellIdByVA.set(c.cellVA, i); nameByCellId[i] = c.name; });

  // builtin fn names from boot-order extraction
  const fnreg = JSON.parse(fs.readFileSync(`${import.meta.dir}/out-fnreg-order.json`, "utf8")) as { name: string }[];
  const builtinFnNames = new Set(fnreg.map((r) => r.name));
  const scriptNames = new Set(fns.map((f) => f.name));

  const fnByVa = new Map(fns.map((f) => [f.va, f]));
  const fnByName = new Map(fns.map((f) => [f.name, f]));
  return { fns, fnByVa, fnByName, cells, cellIdByVA, nameByCellId, builtinFnNames, scriptNames };
}

// Build the guest memory image: PE sections at (VA - IMAGE_BASE), id cells pre-filled.
export function buildImage(exePath: string, reg: Registry): Uint8Array {
  const buf = fs.readFileSync(exePath);
  const img = parsePE(buf);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const mem = new Uint8Array(MEM_PAGES * 65536);
  const memDv = new DataView(mem.buffer);
  for (const s of img.sections) {
    if (s.rawSize === 0) continue;
    const dst = s.va; // rva == va - imageBase
    mem.set(buf.subarray(s.rawOff, s.rawOff + s.rawSize), dst);
  }
  // relocate stored pointers: every absolute VA in the image should become (VA - IMAGE_BASE).
  // The .reloc directory tells us exactly which addresses hold base-relative pointers.
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
        const type = word >> 12, offs = word & 0xfff;
        if (type === 10) { // DIR64
          const addr = pageRVA + offs;
          const fo = rvaToOff(img, addr);
          if (fo >= 0) {
            const q = dv.getBigUint64(fo, true);
            if (q >= BigInt(IMAGE_BASE) && q < BigInt(IMAGE_BASE + 0x2000000)) {
              memDv.setBigUint64(addr, q - BigInt(IMAGE_BASE), true);
              relocCount++;
            }
          }
        }
        e += 2;
      }
      p += blockSize;
      if (blockSize % 4) p += 4 - (blockSize % 4);
    }
  }
  console.log("relocated pointers:", relocCount);
  // pre-fill id cells with our ids (i32 at cellVA)
  for (const [cellVA, id] of reg.cellIdByVA) {
    memDv.setInt32(cellVA - IMAGE_BASE, id, true);
  }
  return mem;
}
