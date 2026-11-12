import fs from "node:fs";
import { gzipSync } from "node:zlib";
import { buildRegistry, buildImage, IMAGE_BASE } from "./image.ts.js";
import { Lifter } from "./lift.ts.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = process.env.ICHOROUS_EXE ?? `${HERE}/../../upload/Ichorous.exe`;
const OUTDIR = process.env.GEX_OUT ?? path.join(HERE, "..", "..", "gex");
const LIMIT = process.argv[2] ? parseInt(process.argv[2], 10) : 0;
fs.mkdirSync(OUTDIR, { recursive: true });
console.time("registry");
const reg = buildRegistry(EXE);
console.timeEnd("registry");
console.log("fns:", reg.fns.length, "cells:", reg.cells.length);
console.time("image");
const mem = buildImage(EXE, reg);
console.timeEnd("image");
if (LIMIT > 0) reg.fns = reg.fns.slice(0, LIMIT);
const dv = new DataView(mem.buffer);
console.time("lift");
// Two passes. The wasm index of a lifted function is imports.length + i, and
// imports are created lazily as call targets are seen, so the whole import set
// has to be known before the first body is emitted. Pass one discovers it.
const probe = new Lifter(reg, mem, dv);
probe.liftAll();
const lifter = new Lifter(reg, mem, dv);
const nImports = lifter.precreateImports([...probe.abiCallCounts.keys()]);
const okCount = lifter.liftAll();
console.timeEnd("lift");
console.log("pre-created", nImports, "imports (probe saw", probe.abiCallCounts.size, "abi targets)");
console.log("lifted:", okCount, "/", reg.fns.length, "failed:", lifter.liftedFail);
console.log("internal call sites:", lifter.nInternalCalls ?? 0, " abi call sites:", lifter.nAbiCalls ?? 0, " imports:", lifter.wasm.imports.length);
for (const e of lifter.errors.slice(0, 3)) console.log("  ERR", e.fn, "::", e.msg);
if (lifter.errors.length) {
  lifter._firstStack = lifter.errors[0];
}
const top = [...lifter.opCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log("op histogram:", top.map(([o, n]) => o + ":" + n).join(" "));
console.time("emit");
const bytes = lifter.wasm.toBytes();
console.timeEnd("emit");
console.log("wasm size:", (bytes.length / 1048576).toFixed(2) + "MB");
fs.writeFileSync("/tmp/t.wasm", bytes);
fs.writeFileSync("/tmp/t.wasm", bytes);
console.log("wrote /tmp/t.wasm (" + (bytes.length / 1048576).toFixed(2) + "MB)");
const outDir2 = LIMIT > 0 ? "/tmp/gexsub" : OUTDIR;
if (LIMIT > 0) fs.mkdirSync(outDir2, { recursive: true });
fs.writeFileSync(outDir2 + "/game.wasm", bytes);
fs.writeFileSync(outDir2 + "/image.bin", mem);
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
  abi: [...lifter.abiCallCounts.entries()].map(([va, n]) => ({ va, n })).sort((a, b) => b.n - a.n)
};
fs.writeFileSync(outDir2 + "/meta.json", JSON.stringify(meta));
console.log("wrote", outDir2 + "/game.wasm (.gz), image.bin (.gz), meta.json");
