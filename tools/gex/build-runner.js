#!/usr/bin/env node
// Build a game.wasm that has the runner functions lifted into it too.
//
//   ICHOROUS_EXE=... node --max-old-space-size=6144 tools/gex/build-runner.js [iters] [outDir]
//
// tools/gex/build.js feeds the lifter only the functions named gml_* in
// data/ghidra_pass2_scriptmap.csv. Every other call target leaves the module as
// an `abi.f<va>` import, which is why there are hundreds of runner functions
// that have to be hand-written in js/gex/runtime.js.
//
// lift.js only falls back to an ABI import when a target is *not* in reg.fns,
// so adding a runner address to reg.fns turns those calls into ordinary
// internal wasm calls and the hand-written shim stops being needed. .pdata has
// extents for every function in the executable, not just the GML ones, so the
// addresses can be added wholesale.
//
// Lifting a runner function can pull in more addresses, so this walks to a
// fixed point: lift, look at what new ABI imports appeared, add any of those
// that are real code inside .text, repeat.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { buildRegistry, buildImage, IMAGE_BASE } from "./image.ts.js";
import { Lifter } from "./lift.ts.js";
import { parsePE } from "./pe.ts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = process.env.ICHOROUS_EXE ?? `${HERE}/../../upload/Ichorous.exe`;
const ROOT = path.join(HERE, "..", "..");
const ITERS = Number(process.argv[2] ?? 4);
const OUTDIR = process.argv[3] ?? "/tmp/gexrunner";

console.time("registry");
const reg = buildRegistry(EXE);
console.timeEnd("registry");
console.log("gml fns:", reg.fns.length, "cells:", reg.cells.length);

// --- function extents for the whole executable ------------------------------
const buf = fs.readFileSync(EXE);
const img = parsePE(buf);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const text = img.sections.find((s) => s.name === ".text");
const pdata = img.sections.find((s) => s.name === ".pdata");
const pdCount = Math.floor(pdata.rawSize / 12);
const ext = new Map();
for (let i = 0; i < pdCount; i++) {
  const s = img.imageBase + dv.getUint32(pdata.rawOff + i * 12, true);
  const e = img.imageBase + dv.getUint32(pdata.rawOff + i * 12 + 4, true);
  if (e - s > 4e6) continue;
  ext.set(s, e);
}
const textStart = img.imageBase + text.va;
const inText = (va) => va >= textStart && va < textStart + Math.max(text.vsize, text.rawSize);
console.log(".pdata extents:", ext.size, " .text: 0x" + textStart.toString(16), "+0x" + text.vsize.toString(16));

console.time("image");
const mem = buildImage(EXE, reg);
console.timeEnd("image");

// Seed with every ABI import the plain build produces.
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "gex/meta.json"), "utf8")).abi.map((e) => e.va);
// Addresses that already have a hand-written shim. Those keep their shim: the
// shim knows this port's object model, whereas lifted runner code expects the
// real runner's CInstance/struct layout, which we do not have.
const shimmed = new Set();
for (const m of fs.readFileSync(path.join(ROOT, "js/gex/runtime.js"), "utf8").matchAll(/impl\.f([0-9a-f]{6,16})/g)) {
  shimmed.add(parseInt(m[1], 16));
}
console.log("hand-written shims:", shimmed.size);

const mkLift = (r, abiVas) => {
  const l = new Lifter(r, mem, new DataView(mem.buffer));
  if (abiVas) l.precreateImports(abiVas);
  l.callEdges = new Map();
  const ok = l.liftAll();
  return { lifter: l, ok };
};
const mkReg = (vas) => {
  const r = { ...reg, fns: reg.fns.slice() };
  for (const va of vas) {
    const end = ext.get(va);
    if (end === undefined) continue;
    r.fns.push({ name: "f" + va.toString(16), va, end, idx: r.fns.length });
  }
  return r;
};
const liftWith = (r) => {
  const l = new Lifter(r, mem, new DataView(mem.buffer));
  l.callEdges = new Map();
  const ok = l.liftAll();
  return { lifter: l, ok };
};

// --- pass 1: walk to a fixed point to find every liftable address -----------
let candidates = new Set(seed.filter((va) => inText(va) && ext.has(va)));
let failures = new Set();
let lastAbi = null;
for (let i = 0; i < Math.max(1, ITERS); i++) {
  console.time(`pass ${i}`);
  const { lifter: l } = mkLift(mkReg([...candidates]));
  console.timeEnd(`pass ${i}`);
  failures = new Set(l.errors.map((e) => e.fn.replace(/^f/, "")).map((h) => parseInt(h, 16)).filter((v) => Number.isFinite(v)));
  lastAbi = [...l.abiCallCounts.keys()];
  const grow = lastAbi.filter((va) => !candidates.has(va) && inText(va) && ext.has(va));
  console.log(`pass ${i}: candidates ${candidates.size}, lifted ${l.liftedOk}, failed ${l.liftedFail}, abi ${lastAbi.length}, liftable new ${grow.length}`);
  if (!grow.length) break;
  for (const va of grow) candidates.add(va);
}

// --- pass 2: keep only what lifts cleanly and has no shim -------------------
const keep = [...candidates].filter((va) => !failures.has(va) && !shimmed.has(va));
console.log(`\nkeeping ${keep.length} of ${candidates.size} (${failures.size} failed to lift, ${[...candidates].filter((v) => shimmed.has(v)).length} already shimmed)`);

reg.fns.push(...mkReg(keep).fns.slice(reg.fns.length));
// Adding a function can pull in another that does not lift, so drop failures
// and go again until nothing fails. A failing lift emits an `unreachable`
// stub, and a call to that traps - strictly worse than leaving the address as
// an ABI import.
let lifter = null;
// Every address the discovery passes ever reached through the ABI has to be an
// import before the final emit, so the call indices come out right.
const abiVas = new Set(lastAbi ?? []);
for (let round = 0; round < 5; round++) {
  console.time(`lift final ${round}`);
  const r = mkLift(reg, abiVas);
  console.timeEnd(`lift final ${round}`);
  lifter = r.lifter;
  if (!lifter.errors.length) break;
  const bad = new Set(lifter.errors.map((e) => parseInt(e.fn.replace(/^f/, ""), 16)).filter(Number.isFinite));
  console.log(`  round ${round}: dropping ${bad.size} functions that do not lift`);
  reg.fns = reg.fns.filter((f) => !bad.has(f.va));
}

// Size accounting: V8 has to compile the whole module, and a single enormous
// lifted body is what pushes instantiation over the memory limit.
{
  const sizes = lifter.wasm.funcs.map((f, i) => [i, f.body.length, f.export ?? ""]);
  sizes.sort((a, b) => b[1] - a[1]);
  const total = sizes.reduce((s, x) => s + x[1], 0);
  console.log("\nlifted bodies:", sizes.length, "total", (total / 1048576).toFixed(2) + "MB");
  for (const [i, n, nm] of sizes.slice(0, 12)) console.log("   " + (n / 1024).toFixed(0).padStart(7) + "KB  " + nm);
  const over = sizes.filter((x) => x[1] > 262144);
  console.log("bodies over 256KB:", over.length, "totalling", (over.reduce((s, x) => s + x[1], 0) / 1048576).toFixed(2) + "MB");
}
fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(path.join(OUTDIR, "call-edges.json"), JSON.stringify(
  [...lifter.callEdges ?? []].map(([va, to]) => [va, [...to]])));

const abiFinal = [...lifter.abiCallCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log("internal call sites:", lifter.nInternalCalls ?? 0, " abi call sites:", lifter.nAbiCalls ?? 0);
console.log("\nfns:", reg.fns.length, " lifted:", lifter.liftedOk, " failed:", lifter.liftedFail);
console.log("remaining ABI imports:", abiFinal.length, "(was 422)");
for (const [va, n] of abiFinal.slice(0, 15)) console.log("  0x" + va.toString(16) + "  " + n + (shimmed.has(va) ? "   [shimmed]" : ""));

console.time("emit");
let bytes;
bytes = lifter.wasm.toBytes();
console.timeEnd("emit");
console.log("wasm size:", (bytes.length / 1048576).toFixed(2) + "MB");

fs.mkdirSync(OUTDIR, { recursive: true });
const meta = {
  imageBase: IMAGE_BASE,
  fnCount: reg.fns.length,
  cellCount: reg.cells.length,
  cellNames: reg.nameByCellId,
  fns: reg.fns.map((f) => ({ n: f.name, va: f.va, i: f.idx })),
  abi: abiFinal.map(([va, n]) => ({ va, n }))
};
console.time("gzip");
fs.writeFileSync(path.join(OUTDIR, "game.wasm"), bytes);
fs.writeFileSync(path.join(OUTDIR, "image.bin"), mem);
fs.writeFileSync(path.join(OUTDIR, "game.wasm.gz"), gzipSync(bytes, { level: 9 }));
fs.writeFileSync(path.join(OUTDIR, "image.bin.gz"), gzipSync(mem, { level: 9 }));
console.timeEnd("gzip");
fs.writeFileSync(path.join(OUTDIR, "meta.json"), JSON.stringify(meta));
console.log("wrote", OUTDIR + "/game.wasm(.gz), image.bin(.gz), meta.json");
