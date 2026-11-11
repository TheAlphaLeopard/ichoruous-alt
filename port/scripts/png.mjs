// PNG decode/encode — pure JS on Node zlib. Supports color types 6/2/0/4/3, bit depth 8 (and 16 by reduction), non-interlaced and Adam7.
import { inflateSync, deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// decode → {w,h,data:Buffer RGBA}
export function decodePNG(buf) {
  if (buf.toString("latin1", 1, 4) !== "PNG") throw new Error("not a PNG");
  let o = 8, w = 0, h = 0, depth = 8, ctype = 6, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("latin1", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (interlace) throw new Error("interlaced PNG unsupported");
  const raw = inflateSync(Buffer.concat(idat));
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 4 ? 2 : ctype === 0 ? 1 : ctype === 3 ? 1 : 4;
  const bpp = Math.max(1, (ch * depth) / 8);
  const stride = Math.ceil((w * ch * depth) / 8);
  const img = Buffer.alloc(w * h * 4);
  const out = Buffer.alloc(h * (stride + 1));
  // unfilter
  let rp = 0;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    raw.copy(cur, 0, rp, rp + stride); rp += stride;
    if (ft === 1) { for (let x = bpp; x < stride; x++) cur[x] = (cur[x] + cur[x - bpp]) & 0xff; }
    else if (ft === 2) { for (let x = 0; x < stride; x++) cur[x] = (cur[x] + prev[x]) & 0xff; }
    else if (ft === 3) { for (let x = 0; x < stride; x++) cur[x] = (cur[x] + ((x >= bpp ? cur[x - bpp] : 0) + prev[x]) / 2) & 0xff; }
    else if (ft === 4) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    cur.copy(out, y * (stride + 1) + 1);
    cur.copy(prev);
    prev.fill(0, cur.length);
  }
  // to RGBA
  const rd = (y, x, ci) => {
    if (depth === 8) return out[y * (stride + 1) + 1 + x * ch + ci];
    if (depth === 16) return out[y * (stride + 1) + 1 + (x * ch + ci) * 2];
    if (depth === 4) { const b = out[y * (stride + 1) + 1 + ((x * ch + ci) >> 1)]; return ((x * ch + ci) & 1 ? b : b >> 4) & 0xf; }
    if (depth === 2) { const b = out[y * (stride + 1) + 1 + ((x * ch + ci) >> 2)]; return (b >> (((x * ch + ci) & 3) * 2)) & 3; }
    if (depth === 1) { const b = out[y * (stride + 1) + 1 + ((x * ch + ci) >> 3)]; return (b >> (7 - ((x * ch + ci) & 7))) & 1; }
    throw new Error("depth " + depth);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o4 = (y * w + x) * 4;
      if (ctype === 6) { img[o4] = rd(y, x, 0); img[o4 + 1] = rd(y, x, 1); img[o4 + 2] = rd(y, x, 2); img[o4 + 3] = rd(y, x, 3); }
      else if (ctype === 2) { img[o4] = rd(y, x, 0); img[o4 + 1] = rd(y, x, 1); img[o4 + 2] = rd(y, x, 2); img[o4 + 3] = 255; }
      else if (ctype === 0) { const g = rd(y, x, 0); img[o4] = img[o4 + 1] = img[o4 + 2] = depth === 16 ? g >> 8 : g; img[o4 + 3] = 255; }
      else if (ctype === 4) { const g = rd(y, x, 0); img[o4] = img[o4 + 1] = img[o4 + 2] = g; img[o4 + 3] = rd(y, x, 1); }
      else if (ctype === 3) {
        const idx = rd(y, x, 0);
        img[o4] = palette[idx * 3]; img[o4 + 1] = palette[idx * 3 + 1]; img[o4 + 2] = palette[idx * 3 + 2];
        img[o4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
  }
  return { w, h, data: img };
}

// encode RGBA buffer → PNG (filter 0)
export function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// blit src RGBA onto dst RGBA at (dx,dy) with clip; scale = 1
export function blit(dst, dw, dh, src, sw, sh, dx, dy, sx = 0, sy = 0, cw = sw, chh = sh) {
  for (let y = 0; y < chh; y++) {
    const ty = dy + y, fy = sy + y;
    if (ty < 0 || ty >= dh || fy < 0 || fy >= sh) continue;
    for (let x = 0; x < cw; x++) {
      const tx = dx + x, fx = sx + x;
      if (tx < 0 || tx >= dw || fx < 0 || fx >= sw) continue;
      const to = (ty * dw + tx) * 4, fo = (fy * sw + fx) * 4;
      const a = src[fo + 3];
      if (a === 0) continue;
      if (a === 255) { dst[to] = src[fo]; dst[to + 1] = src[fo + 1]; dst[to + 2] = src[fo + 2]; dst[to + 3] = 255; }
      else {
        const da = dst[to + 3] / 255, oa = a / 255, na = oa + da * (1 - oa);
        dst[to] = Math.round((src[fo] * oa + dst[to] * da * (1 - oa)) / na);
        dst[to + 1] = Math.round((src[fo + 1] * oa + dst[to + 1] * da * (1 - oa)) / na);
        dst[to + 2] = Math.round((src[fo + 2] * oa + dst[to + 2] * da * (1 - oa)) / na);
        dst[to + 3] = Math.round(na * 255);
      }
    }
  }
}
