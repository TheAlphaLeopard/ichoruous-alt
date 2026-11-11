// Full GameMaker data.win + audio groups + YYC exe extractor → JSON + PNGs for the web PoC.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { decodePNG, encodePNG, blit } from "./png.mjs";
import { decodeQOI } from "./qoi.mjs";

// "2zoq" block = magic(4) + w(u16LE) + h(u16LE) + qoiLen(u32LE) + bzip2(QOI stream)
function decode2zoq(block) {
  if (block.toString("latin1", 0, 4) !== "2zoq") throw new Error("not 2zoq: " + block.toString("latin1", 0, 4));
  const w = block.readUInt16LE(4), h = block.readUInt16LE(6);
  const qoiLen = block.readUInt32LE(8);
  const bz = block.subarray(12); // bzip2 CLI ignores trailing zero padding
  const tmp = `/tmp/tex_${w}x${h}_${Date.now()}.bz2`;
  writeFileSync(tmp, bz);
  const res = spawnSync("bzip2", ["-dc", tmp], { maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) throw new Error("bzip2 failed: " + res.stderr.toString());
  const qoi = res.stdout;
  const img = decodeQOI(qoi);
  if (img.w !== w || img.h !== h) throw new Error(`dims mismatch: ${img.w}x${img.h} vs ${w}x${h}`);
  if (qoi.length !== qoiLen) console.warn(`qoiLen warn: ${qoi.length} vs ${qoiLen}`);
  // normalize to RGBA for composition
  if (img.channels === 3) {
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++) { rgba[j++] = img.data[3 * i]; rgba[j++] = img.data[3 * i + 1]; rgba[j++] = img.data[3 * i + 2]; rgba[j++] = 255; }
    return { w, h, data: rgba };
  }
  return { w, h, data: img.data };
}

const UP = `${import.meta.dir}/../upload`;
const OUT = `${import.meta.dir}/out/ichorous`;
mkdirSync(OUT, { recursive: true });
mkdirSync(`${OUT}/sprites`, { recursive: true });
mkdirSync(`${OUT}/sfx`, { recursive: true });
mkdirSync(`${OUT}/pages`, { recursive: true });

// ---------- core parser ----------
function parseChunks(buf) {
  const chunks = {};
  let off = 8;
  while (off + 8 <= buf.length) {
    const id = buf.toString("latin1", off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    chunks[id] = { off: off + 8, len };
    off += 8 + len;
    if (off % 4) off += 4 - (off % 4);
  }
  return chunks;
}
function makeReader(buf, chunks) {
  const strCount = buf.readUInt32LE(chunks.STRG.off);
  const strSet4 = new Set();
  for (let i = 0; i < strCount; i++) strSet4.add(buf.readUInt32LE(chunks.STRG.off + 4 + 4 * i));
  return {
    readStrT(p) {
      if (!strSet4.has(p - 4)) return null;
      const n = Math.min(buf.readUInt32LE(p - 4), 8192);
      return buf.toString("utf8", p, p + n);
    },
    strCount,
    allStrings() {
      const arr = [];
      for (let i = 0; i < strCount; i++) {
        const p = buf.readUInt32LE(chunks.STRG.off + 4 + 4 * i);
        const n = Math.min(buf.readUInt32LE(p), 8192);
        arr.push(buf.toString("utf8", p + 4, p + 4 + n));
      }
      return arr;
    },
  };
}

const data = readFileSync(`${UP}/data.win`);
const chunks = parseChunks(data);
const R = makeReader(data, chunks);
const game = { meta: {}, textures: [], tpag: [], sprites: [], objects: [], rooms: [], sounds: [], fonts: [], scripts: [], strings: [] };

// GEN8
{
  const g = chunks.GEN8.off;
  game.meta.bytecodeVersion = data[g + 1];
  game.meta.fileName = R.readStrT(data.readUInt32LE(g + 4));
  game.meta.displayName = R.readStrT(data.readUInt32LE(g + 40));
  game.meta.window = [data.readUInt32LE(g + 60), data.readUInt32LE(g + 60 + 4)];
  game.meta.hasCodeChunk = !!chunks.CODE; // YYC builds omit CODE/VARI/FUNC
  game.meta.chunks = Object.keys(chunks);
}

// TXTR — "2zoq" (bzip2+QOI) texture blocks → re-encode as PNG pages
{
  const n = data.readUInt32LE(chunks.TXTR.off);
  for (let i = 0; i < n; i++) {
    const e = data.readUInt32LE(chunks.TXTR.off + 4 + 4 * i);
    const blockLen = data.readUInt32LE(e + 8);
    const w = data.readUInt32LE(e + 12), h = data.readUInt32LE(e + 16);
    const ptr = data.readUInt32LE(e + 24);
    const block = data.subarray(ptr, ptr + blockLen);
    const img = decode2zoq(block);
    if (img.w !== w || img.h !== h) console.warn(`page${i} dims: hdr ${w}x${h} vs data ${img.w}x${img.h}`);
    writeFileSync(`${OUT}/pages/page${i}.png`, encodePNG(img.w, img.h, img.data));
    game.textures.push({ w: img.w, h: img.h, file: `pages/page${i}.png` });
    console.log(`page${i}: ${img.w}x${img.h} (${(block.length / 1024).toFixed(0)}KB block)`);
  }
}

// TPAG — 22-byte entries: [srcX,srcY,srcW,srcH,tgtX,tgtY,tgtW,tgtH,boundW,boundH,tex]
const tPtrs = [];
{
  const n = data.readUInt32LE(chunks.TPAG.off);
  for (let i = 0; i < n; i++) tPtrs.push(data.readUInt32LE(chunks.TPAG.off + 4 + 4 * i));
  const tIndex = new Map(tPtrs.map((p, i) => [p, i]));
  for (let i = 0; i < n; i++) {
    const e = tPtrs[i];
    const u = Array.from({ length: 11 }, (_, k) => data.readUInt16LE(e + 2 * k));
    game.tpag.push({ sx: u[0], sy: u[1], sw: u[2], sh: u[3], tx: u[4], ty: u[5], tw: u[6], th: u[7], bw: u[8], bh: u[9], tex: u[10] });
  }
  // SPRT — entries via next-pointer strides
  const scount = data.readUInt32LE(chunks.SPRT.off);
  const sPtrs = [];
  for (let i = 0; i < scount; i++) sPtrs.push(data.readUInt32LE(chunks.SPRT.off + 4 + 4 * i));
  for (let i = 0; i < scount; i++) {
    const e = sPtrs[i];
    const texCount = data.readUInt32LE(e + 84);
    const frames = [];
    for (let k = 0; k < texCount; k++) {
      const ref = data.readUInt32LE(e + 88 + 4 * k);
      frames.push(tIndex.get(ref) ?? -1);
    }
    game.sprites.push({
      name: R.readStrT(data.readUInt32LE(e)),
      w: data.readInt32LE(e + 4), h: data.readInt32LE(e + 8),
      origin: [data.readInt32LE(e + 48), data.readInt32LE(e + 52)],
      speed: +data.readFloatLE(e + 68).toFixed(2),
      speedType: data.readInt32LE(e + 72),
      frames,
    });
  }
  // OBJT
  const ocount = data.readUInt32LE(chunks.OBJT.off);
  const oPtrs = [];
  for (let i = 0; i < ocount; i++) oPtrs.push(data.readUInt32LE(chunks.OBJT.off + 4 + 4 * i));
  for (let i = 0; i < ocount; i++) {
    const o = oPtrs[i];
    game.objects.push({
      name: R.readStrT(data.readUInt32LE(o)),
      sprite: data.readInt32LE(o + 4),
      visible: data.readInt32LE(o + 8),
      solid: data.readInt32LE(o + 12),
      depth: data.readInt32LE(o + 16),
      persistent: data.readInt32LE(o + 20),
    });
  }
  // ROOM
  const rcount = data.readUInt32LE(chunks.ROOM.off);
  const rPtrs = [];
  for (let i = 0; i < rcount; i++) rPtrs.push(data.readUInt32LE(chunks.ROOM.off + 4 + 4 * i));
  for (let i = 0; i < rcount; i++) {
    const p = rPtrs[i];
    const instPtr = data.readUInt32LE(p + 40), layPtr = data.readUInt32LE(p + 44);
    game.rooms.push({
      name: R.readStrT(data.readUInt32LE(p)),
      w: data.readUInt32LE(p + 8), h: data.readUInt32LE(p + 12),
      speed: data.readUInt32LE(p + 16),
      instCount: data.readUInt32LE(instPtr),
      layerCount: data.readUInt32LE(layPtr),
    });
  }
  // SOND — entry: [0]=name [4]=flags [20]=volume [28]=groupIdx [32]=audioId [36]=pitch
  const sndCount = data.readUInt32LE(chunks.SOND.off);
  const sndPtrs = [];
  for (let i = 0; i < sndCount; i++) sndPtrs.push(data.readUInt32LE(chunks.SOND.off + 4 + 4 * i));
  const audoCount = data.readUInt32LE(chunks.AUDO.off);
  const aPtrs = [];
  for (let i = 0; i < audoCount; i++) aPtrs.push(data.readUInt32LE(chunks.AUDO.off + 4 + 4 * i));
  for (let i = 0; i < sndCount; i++) {
    const e = sndPtrs[i];
    const flags = data.readInt32LE(e + 4);
    const audioId = data.readInt32LE(e + 32);
    const group = data.readInt32LE(e + 28);
    let oggSize = 0;
    if (group === 0 && audioId >= 0 && audioId < audoCount) oggSize = data.readUInt32LE(aPtrs[audioId]);
    game.sounds.push({
      name: R.readStrT(data.readUInt32LE(e)),
      audioId,
      group,
      volume: +data.readFloatLE(e + 20).toFixed(2),
      embedded: (flags & 0x40) !== 0,
      oggSize,
    });
  }
  // FONT count + names
  const fcount = data.readUInt32LE(chunks.FONT.off);
  for (let i = 0; i < fcount; i++) {
    const f = data.readUInt32LE(chunks.FONT.off + 4 + 4 * i);
    game.fonts.push(R.readStrT(data.readUInt32LE(f)));
  }
  // SCPT names (stride 8: name ptr + id)
  const scpCount = data.readUInt32LE(chunks.SCPT.off);
  for (let i = 0; i < scpCount; i++) {
    const e = data.readUInt32LE(chunks.SCPT.off + 4 + 4 * i);
    game.scripts.push(R.readStrT(data.readUInt32LE(e)));
  }
  game.strings = R.allStrings();
}

// ---------- compose sprite PNGs for a curated demo set ----------
const pageImgs = game.textures.map((t, i) => decodePNG(readFileSync(`${OUT}/pages/page${i}.png`)));
function composeFrame(frameIdx) {
  const f = game.tpag[frameIdx];
  const src = pageImgs[f.tex];
  const out = Buffer.alloc(f.tw * f.th * 4);
  blit(out, f.tw, f.th, src.data, src.w, src.h, f.tx, f.ty, f.sx, f.sy, f.sw, f.sh);
  return { w: f.tw, h: f.th, data: out };
}
const CURATED = /warlock|patron|salesman|raven|title|logo|cursor|sword|slash|blood|hud/i;
const composed = [];
for (const s of game.sprites) {
  if (!CURATED.test(s.name)) continue;
  if (s.frames.length === 0 || s.frames[0] < 0) continue;
  if (composed.length >= 48) break;
  const f0 = composeFrame(s.frames[0]);
  const file = `sprites/${s.name.replace(/[^\w]/g, "_")}.png`;
  writeFileSync(`${OUT}/${file}`, encodePNG(f0.w, f0.h, f0.data));
  composed.push({ name: s.name, w: s.w, h: s.h, frames: s.frames.length, file, frame0: s.frames[0] });
}
console.log(`composed ${composed.length}:`, composed.slice(0, 12).map((c) => `${c.name}(${c.w}x${c.h} f${c.frames})`).join(", "));

// ---------- audio group .dat files (external music/ambiance): raw AUDO blobs ----------
function parseAudioGroup(path) {
  const buf = readFileSync(path);
  const chunks = parseChunks(buf);
  if (!chunks.AUDO) return { audioCount: 0, entries: [] };
  const ac = buf.readUInt32LE(chunks.AUDO.off);
  const entries = [];
  for (let i = 0; i < ac; i++) {
    const p = buf.readUInt32LE(chunks.AUDO.off + 4 + 4 * i);
    entries.push({ size: buf.readUInt32LE(p), ogg: buf.toString("latin1", p + 4, p + 8) === "OggS" });
  }
  return { audioCount: ac, entries };
}
const music = parseAudioGroup(`${UP}/audiogroup_music.dat`);
const ambiance = parseAudioGroup(`${UP}/audiogroup_ambiance.dat`);
game.audioGroups = { music: music.audioCount, ambiance: ambiance.audioCount };

// export a couple of real OGG sfx for the web demo (small ones)
const audoPtrs = [];
{
  const ac = data.readUInt32LE(chunks.AUDO.off);
  for (let i = 0; i < ac; i++) audoPtrs.push(data.readUInt32LE(chunks.AUDO.off + 4 + 4 * i));
}
const exportSfx = ["dash", "sword", "swing", "slash", "hit", "hurt", "jump", "death", "pickup", "coin", "stun", "blood", "attack", "parry"];
let exported = 0;
for (const s of game.sounds) {
  if (s.group !== 0 || s.audioId < 0 || s.audioId >= audoPtrs.length) continue;
  const p = audoPtrs[s.audioId];
  const len = data.readUInt32LE(p);
  if (data.toString("latin1", p + 4, p + 8) !== "OggS") continue;
  const nm = (s.name || "").toLowerCase();
  if (exportSfx.some((k) => nm.includes(k)) && len < 400000 && exported < 10) {
    writeFileSync(`${OUT}/sfx/${s.name.replace(/[^\w]/g, "_")}.ogg`, data.subarray(p + 4, p + 4 + len));
    exported++;
  }
}
console.log(`exported ${exported} sfx oggs`);
// export 2 smallish music tracks for the demo
let musExported = 0;
for (const s of game.sounds) {
  if (s.group !== 1 || s.audioId < 0) continue;
  const grp = music;
  if (s.audioId >= grp.entries.length || !grp.entries[s.audioId].ogg) continue;
  const bufM = readFileSync(`${UP}/audiogroup_music.dat`);
  // recompute pointer
  const chM = parseChunks(bufM);
  const p = bufM.readUInt32LE(chM.AUDO.off + 4 + 4 * s.audioId);
  const len = bufM.readUInt32LE(p);
  if (len > 2000000) continue;
  writeFileSync(`${OUT}/sfx/music_${s.name.replace(/[^\w]/g, "_")}.ogg`, bufM.subarray(p + 4, p + 4 + len));
  if (++musExported >= 2) break;
}
console.log(`exported ${musExported} music tracks`);

// ---------- YYC exe recon: gml_* symbol inventory ----------
const exe = readFileSync(`${UP}/Ichorous.exe`);
const exeTxt = exe.toString("latin1");
const symSet = new Set();
let re = /gml_(GlobalScript|Script|Object|RoomCC)_[\w@$.<>!]{1,200}/g;
let m;
while ((m = re.exec(exeTxt)) !== null) {
  let s = m[0];
  if (s.endsWith("@@") || s.endsWith("@")) s = s.replace(/@+$/, "");
  symSet.add(s);
}
const symbols = [...symSet].sort();
const symByClass = {};
for (const s of symbols) {
  const cls = s.split("_").slice(0, 2).join("_");
  (symByClass[cls] = symByClass[cls] || []).push(s);
}
console.log(`\nexe symbols: ${symbols.length} unique; classes:`, Object.fromEntries(Object.entries(symByClass).map(([k, v]) => [k, v.length])));
// game version string near GameMaker marker
const gmVer = (exeTxt.match(/GameMaker(?:\s*[Ss]tudio)?[\x20-\x7e]{0,60}?(2\d{3}\.\d{1,2}(\.\d+)?)/) || [])[1] || null;
game.meta.exe = { size: exe.length, symbols: symbols.length, gmVersion: gmVer };
console.log("gm version guess:", gmVer);

// ---------- write outputs ----------
writeFileSync(`${OUT}/game.json`, JSON.stringify({
  meta: game.meta,
  textures: game.textures,
  sprites: game.sprites,
  objects: game.objects,
  rooms: game.rooms,
  sounds: game.sounds,
  fonts: game.fonts,
  audioGroups: game.audioGroups,
}, null, 1));
writeFileSync(`${OUT}/tpag.json`, JSON.stringify(game.tpag));
writeFileSync(`${OUT}/strings.json`, JSON.stringify(game.strings));
writeFileSync(`${OUT}/scripts.json`, JSON.stringify(game.scripts));
writeFileSync(`${OUT}/exe-symbols.json`, JSON.stringify(symByClass, null, 0));

console.log(`\nDONE → ${OUT}`);
console.log(`sprites=${game.sprites.length} objects=${game.objects.length} rooms=${game.rooms.length} sounds=${game.sounds.length} tpag=${game.tpag.length} strings=${game.strings.length} scripts=${game.scripts.length}`);
console.log(`external audio: music=${music.audioCount} tracks, ambiance=${ambiance.audioCount}`);
