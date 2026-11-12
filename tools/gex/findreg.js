import fs from "node:fs";
import { parsePE, rvaToOff } from "./pe.ts.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const buf = fs.readFileSync(`${HERE}/../../upload/Ichorous.exe`);
const img = parsePE(buf);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const offOf = (va) => rvaToOff(img, va - img.imageBase);
const rd = img.sections.find((s) => s.name === ".rdata");
const rdOff = rd.rawOff, rdVA = img.imageBase + rd.va;
const needle = Buffer.from("draw_sprite\0");
let strVA = -1;
for (let i = 0; i < rd.rawSize - needle.length; i++) {
  if (buf[rdOff + i] === needle[0] && buf.compare(needle, 0, needle.length, rdOff + i, rdOff + i + needle.length) === 0) {
    if (buf[rdOff + i - 1] === 0) {
      strVA = rdVA + i;
      break;
    }
  }
}
console.log("draw_sprite string @ 0x" + strVA.toString(16));
const text = img.sections.find((s) => s.name === ".text");
const tOff = text.rawOff, tVA = img.imageBase + text.va;
const hits = [];
for (let i = 0; i < text.rawSize - 8; i++) {
  const b = buf[tOff + i];
  if ((b === 72 || b === 76 || b === 141) && (buf[tOff + i + 1] === 141 || (b === 72 || b === 76) && buf[tOff + i + 1] === 141)) {
    const modrm = buf[tOff + i + 2];
    if (modrm >> 6 === 0 && (modrm & 7) === 5) {
      const disp = dv.getInt32(tOff + i + 3, true);
      const tgt = tVA + i + 7 + disp;
      if (tgt === strVA) hits.push(tVA + i);
    }
  }
}
console.log("code refs to it:", hits.length, hits.slice(0, 5).map((h) => "0x" + h.toString(16)));
