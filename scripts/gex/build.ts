// gex build: exe + data.win → game.wasm + image.bin + meta.json
import fs from "node:fs";
import { gzipSync } from "node:zlib";
import { buildRegistry, buildImage, IMAGE_BASE } from "./image.ts";
import { Lifter } from "./lift.ts";

const EXE = `${import.meta.dir}/../../upload/Ichorous.exe`;
const OUTDIR = `${import.meta.dir}/../../public/gex`;
const LIMIT = process.argv[2] ? parseInt(process.argv[2], 10) : 0; // 0 = all

fs.mkdirSync(OUTDIR, { recursive: true });
console.time("registry");
const reg = buildRegistry(EXE);
console.timeEnd("registry");
console.log("fns:", reg.fns.length, "cells:", reg.cells.length);

console.time("image");
const mem = buildImage(EXE, reg);
console.timeEnd("image");

// subset for testing
if (LIMIT > 0) reg.fns = reg.fns.slice(0, LIMIT);

const dv = new DataView(mem.buffer);
console.time("lift");
const lifter = new Lifter(reg, mem, dv);
const okCount = lifter.liftAll();
console.timeEnd("lift");
console.log("lifted:", okCount, "/", reg.fns.length, "failed:", lifter.liftedFail);
for (const e of lifter.errors.slice(0, 3)) console.log("  ERR", e.fn, "::", e.msg);
if (lifter.errors.length) { (lifter as any)._firstStack = lifter.errors[0]; }

// op histogram sanity
const top = [...lifter.opCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log("op histogram:", top.map(([o, n]) => o + ":" + n).join(" "));

console.time("emit");
const bytes = lifter.wasm.toBytes();
console.timeEnd("emit");
console.log("wasm size:", (bytes.length / 1048576).toFixed(2) + "MB");

fs.writeFileSync("/tmp/t.wasm", bytes);
// validate in a separate node process (bun OOMs compiling 8MB in-process)
fs.writeFileSync("/tmp/t.wasm", bytes);
console.log("wrote /tmp/t.wasm (" + (bytes.length / 1048576).toFixed(2) + "MB)");

const outDir2 = LIMIT > 0 ? "/tmp/gexsub" : OUTDIR;
if (LIMIT > 0) fs.mkdirSync(outDir2, { recursive: true });
fs.writeFileSync(outDir2 + "/game.wasm", bytes);
fs.writeFileSync(outDir2 + "/image.bin", mem);
// gzip the two big artifacts for web delivery (game.wasm exceeds GitHub's 100MB
// file limit raw; the host decompresses with DecompressionStream, falling back
// to the raw file when present)
console.time("gzip");
fs.writeFileSync(outDir2 + "/game.wasm.gz", gzipSync(bytes, { level: 9 }));
fs.writeFileSync(outDir2 + "/image.bin.gz", gzipSync(mem, { level: 9 }));
console.timeEnd("gzip");
const meta = {
  imageBase: IMAGE_BASE,
  fnCount: reg.fns.length,
  cellCount: reg.cells.length,
  cellNames: reg.nameByCellId,
  fns: reg.fns.map((f) => ({ n: f.name, va: f.va, i: f.idx })),
  abi: [...lifter.abiCallCounts.entries()].map(([va, n]) => ({ va, n })).sort((a, b) => b.n - a.n),
};
fs.writeFileSync(outDir2 + "/meta.json", JSON.stringify(meta));
console.log("wrote", outDir2 + "/game.wasm (.gz), image.bin (.gz), meta.json");
