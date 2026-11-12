// Extract ALL game audio to cartridge/sfx/<name>.ogg so the browser
// host can lazy-load every sound by its GameMaker resource name.
//   group 0 -> embedded in data.win (AUDO chunk)
//   group 1 -> audiogroup_music.dat (AUDO chunk)
//   group 2 -> audiogroup_ambiance.dat (AUDO chunk)
// Run: node tools/extract_audio.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const UP = `${HERE}/../upload`;
const OUT = `${HERE}/../cartridge/sfx`;

function parseChunks(buf) {
  const chunks = {};
  let off = 8; // skip FORM + size
  while (off + 8 <= buf.length) {
    const id = buf.toString("latin1", off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    chunks[id] = { off: off + 8, len };
    off += 8 + len;
    if (off % 4) off += 4 - (off % 4);
  }
  return chunks;
}

// STRG-backed string pointer table (GameMaker pointers point at the char data,
// the 4-byte length prefix sits right before it and is registered in STRG)
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
  };
}

// AUDO chunk -> array of {off, len} for each embedded blob
function audoEntries(buf) {
  const chunks = parseChunks(buf);
  if (!chunks.AUDO) return [];
  const n = buf.readUInt32LE(chunks.AUDO.off);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = buf.readUInt32LE(chunks.AUDO.off + 4 + 4 * i);
    out.push({ off: p + 4, len: buf.readUInt32LE(p) });
  }
  return out;
}

const data = readFileSync(`${UP}/data.win`);
const chunks = parseChunks(data);
const R = makeReader(data, chunks);
const groupBufs = {
  0: data,
  1: readFileSync(`${UP}/audiogroup_music.dat`),
  2: readFileSync(`${UP}/audiogroup_ambiance.dat`),
};
const groupAudo = Object.fromEntries(
  Object.entries(groupBufs).map(([g, b]) => [g, audoEntries(b)]),
);

// SOND — entry: [0]=name [4]=flags [20]=volume [28]=groupIdx [32]=audioId
const sndCount = data.readUInt32LE(chunks.SOND.off);
const sndPtrs = [];
for (let i = 0; i < sndCount; i++) sndPtrs.push(data.readUInt32LE(chunks.SOND.off + 4 + 4 * i));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let written = 0, skipped = 0, totalBytes = 0, biggest = null;
const fails = [];
for (let i = 0; i < sndCount; i++) {
  const e = sndPtrs[i];
  const name = R.readStrT(data.readUInt32LE(e));
  const group = data.readInt32LE(e + 28);
  const audioId = data.readInt32LE(e + 32);
  const entries = groupAudo[group];
  if (!name || !entries || audioId < 0 || audioId >= entries.length) { skipped++; fails.push(`${name}: group=${group} id=${audioId}`); continue; }
  const { off, len } = entries[audioId];
  const buf = groupBufs[group];
  const magic = buf.toString("latin1", off, off + 4);
  let ext;
  if (magic === "OggS") ext = ".ogg";
  else if (magic === "RIFF") ext = ".wav"; // browsers decode PCM wav via decodeAudioData
  else { skipped++; fails.push(`${name}: unknown magic ${magic}`); continue; }
  const file = `${OUT}/${name.replace(/[^\w]/g, "_")}${ext}`;
  writeFileSync(file, buf.subarray(off, off + len));
  written++; totalBytes += len;
  if (!biggest || len > biggest.len) biggest = { name, len };
}
console.log(`sounds declared: ${sndCount} | written: ${written} | skipped: ${skipped}`);
console.log(`total audio: ${(totalBytes / 1048576).toFixed(1)} MB | biggest: ${biggest?.name} (${((biggest?.len ?? 0) / 1048576).toFixed(1)} MB)`);
if (fails.length) console.log("skipped details:\n  " + fails.slice(0, 20).join("\n  "));
console.log(`files in ${OUT}: ${readdirSync(OUT).length}`);
