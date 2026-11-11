// GameMaker QOI decoder ("fioq"/"qoif", GM2022.5+ texture format) — faithful port of GM's decoder.
// Reference: LibGM libgm/src/wad/elem/texture_page/qoi.rs (GPL-3.0) — opcode semantics re-implemented here.
const QOI_INDEX = 0x00, QOI_RUN_8 = 0x40, QOI_RUN_16 = 0x60;
const QOI_DIFF_8 = 0x80, QOI_DIFF_16 = 0xc0, QOI_DIFF_24 = 0xe0, QOI_COLOR = 0xf0;
const MASK_2 = 0xc0, MASK_3 = 0xe0, MASK_4 = 0xf0;

const signExtend = (v, bits) => {
  const m = 1 << (bits - 1);
  return (v & (m - 1)) > m - 1 ? (v & (m - 1)) - m : v & (m - 1);
};

export function decodeQOI(buf) {
  const magic = buf.toString("latin1", 0, 4);
  let le;
  if (magic === "fioq") le = true;
  else if (magic === "qoif") le = false;
  else throw new Error("not GM-QOI: " + magic);
  const w = le ? buf.readUInt16LE(4) : buf.readUInt16BE(4);
  const h = le ? buf.readUInt16LE(6) : buf.readUInt16BE(6);
  const len = le ? buf.readUInt32LE(8) : buf.readUInt32BE(8);
  const pxEnd = w * h;
  const out = Buffer.alloc(pxEnd * 4);
  // GM init: previous pixel = (0,0,0,255) i.e. opaque black; index = all (0,0,0,0)
  let r = 0, g = 0, b = 0, a = 255;
  let run = 0;
  const index = Buffer.alloc(64 * 4);
  let pos = 12;
  const end = Math.min(12 + len, buf.length);
  let o = 0;
  for (let i = 0; i < pxEnd; i++) {
    if (run > 0) { run--; }
    else if (pos < end) {
      const b1 = buf[pos++];
      if ((b1 & MASK_2) === QOI_INDEX) {
        const ip = (b1 & 0x3f) * 4;
        r = index[ip]; g = index[ip + 1]; b = index[ip + 2]; a = index[ip + 3];
      } else if ((b1 & MASK_3) === QOI_RUN_8) {
        run = b1 & 0x1f;
      } else if ((b1 & MASK_3) === QOI_RUN_16) {
        const b2 = buf[pos++];
        run = (((b1 & 0x1f) << 8) | b2) + 32;
      } else if ((b1 & MASK_2) === QOI_DIFF_8) {
        r = (r + signExtend((b1 >> 4) & 3, 2) + 256) & 255;
        g = (g + signExtend((b1 >> 2) & 3, 2) + 256) & 255;
        b = (b + signExtend(b1 & 3, 2) + 256) & 255;
      } else if ((b1 & MASK_3) === QOI_DIFF_16) {
        const b2 = buf[pos++];
        const merged = (b1 << 8) | b2;
        r = (r + signExtend((merged >> 8) & 0x1f, 5) + 256) & 255;
        g = (g + signExtend((merged >> 4) & 0x0f, 4) + 256) & 255;
        b = (b + signExtend(merged & 0x0f, 4) + 256) & 255;
      } else if ((b1 & MASK_4) === QOI_DIFF_24) {
        const b2 = buf[pos++], b3 = buf[pos++];
        const merged = (b1 << 16) | (b2 << 8) | b3;
        r = (r + signExtend((merged >> 19) & 0x1f, 5) + 256) & 255;
        g = (g + signExtend((merged >> 10) & 0x1f, 5) + 256) & 255;
        b = (b + signExtend((merged >> 5) & 0x1f, 5) + 256) & 255;
        a = (a + signExtend(merged & 0x1f, 5) + 256) & 255;
      } else if ((b1 & MASK_4) === QOI_COLOR) {
        if (b1 & 8) r = buf[pos++];
        if (b1 & 4) g = buf[pos++];
        if (b1 & 2) b = buf[pos++];
        if (b1 & 1) a = buf[pos++];
      } else {
        throw new Error(`invalid GM-QOI opcode 0x${b1.toString(16)} @${pos - 1}`);
      }
      // index is updated after every non-run pixel (px unchanged for run ops)
      const ip = ((r ^ g ^ b ^ a) & 0x3f) * 4;
      index[ip] = r; index[ip + 1] = g; index[ip + 2] = b; index[ip + 3] = a;
    }
    // else: payload exhausted → GM repeats the last pixel
    out[o++] = r; out[o++] = g; out[o++] = b; out[o++] = a;
  }
  return { w, h, data: out, channels: 4 };
}
