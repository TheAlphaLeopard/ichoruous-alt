// Minimal PE32+ parser for the gex-gm pipeline (Ichorous.exe)
export interface PESection {
  name: string; va: number; vsize: number; rawOff: number; rawSize: number; chars: number;
}
export interface PEImage {
  imageBase: number; sizeOfImage: number; entry: number;
  sections: PESection[];
  imports: { dll: string; funcs: { name: string; iatVA: number }[] }[];
}
export function parsePE(buf: Uint8Array): PEImage {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(0, false) !== 0x4d5a) throw new Error("not MZ");
  const e_lfanew = dv.getUint32(0x3c, true);
  if (dv.getUint32(e_lfanew, false) !== 0x50450000) throw new Error("not PE");
  const coff = e_lfanew + 4;
  const machine = dv.getUint16(coff, true);
  if (machine !== 0x8664) throw new Error("not x64: " + machine.toString(16));
  const numSections = dv.getUint16(coff + 2, true);
  const optOff = coff + 20;
  const optMagic = dv.getUint16(optOff, true);
  if (optMagic !== 0x20b) throw new Error("not PE32+");
  const entry = dv.getUint32(optOff + 16, true);
  const imageBase = Number(dv.getBigUint64(optOff + 24, true));
  const sizeOfImage = dv.getUint32(optOff + 56, true);
  const dataDirOff = optOff + 112; // PE32+ data directories start
  const importDirRVA = dv.getUint32(dataDirOff + 8, true);
  const sectOff = optOff + dv.getUint16(coff + 16, true); // optional header size
  const sections: PESection[] = [];
  for (let i = 0; i < numSections; i++) {
    const s = sectOff + 40 * i;
    let name = "";
    for (let k = 0; k < 8; k++) { const c = buf[s + k]; if (!c) break; name += String.fromCharCode(c); }
    sections.push({
      name, va: dv.getUint32(s + 12, true), vsize: dv.getUint32(s + 8, true),
      rawOff: dv.getUint32(s + 20, true), rawSize: dv.getUint32(s + 16, true),
      chars: dv.getUint32(s + 36, true),
    });
  }
  // imports (best-effort: not needed for game-code mining)
  const imports: PEImage["imports"] = [];
  try {
  if (importDirRVA) {
    let d = rvaToOff(importDirRVA);
    for (;;) {
      const iltRVA = dv.getUint32(d, true), nameRVA = dv.getUint32(d + 12, true), iatRVA = dv.getUint32(d + 16, true);
      if (!iltRVA && !nameRVA && !iatRVA) break;
      const nOff = rvaToOff(nameRVA);
      let dll = ""; for (let k = nOff; buf[k]; k++) dll += String.fromCharCode(buf[k]);
      const funcs: { name: string; iatVA: number }[] = [];
      let e = rvaToOff(iatRVA);
      for (;;) {
        const thunk = dv.getBigUint64(e, true);
        if (thunk === 0n) break;
        if (thunk & 0x8000000000000000n) { funcs.push({ name: "#ord" + (thunk & 0xffffn).toString(), iatVA: imageBase + iatRVA + funcs.length * 8 }); }
        else {
          const h = rvaToOff(Number(thunk) - imageBase);
          let fn = ""; for (let k = h + 2; buf[k]; k++) fn += String.fromCharCode(buf[k]);
          funcs.push({ name: fn, iatVA: imageBase + iatRVA + funcs.length * 8 });
        }
        e += 8;
      }
      imports.push({ dll, funcs });
      d += 20;
    }
  }
  } catch { /* best-effort */ }
  function rvaToOff(rva: number): number {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) {
        if (s.rawSize === 0) return s.rawOff; // bss-like
        return s.rawOff + (rva - s.va);
      }
    }
    throw new Error("rva not mapped: 0x" + rva.toString(16));
  }
  return { imageBase, sizeOfImage, entry, sections, imports };
}
export function rvaToOff(img: PEImage, rva: number): number {
  for (const s of img.sections) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) {
      if (s.rawSize === 0) return -1;
      return s.rawOff + (rva - s.va);
    }
  }
  return -1;
}
