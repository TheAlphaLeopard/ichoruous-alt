// Mine Ichorous.exe v2: exact function extents from .pdata, real x64 decode of game functions,
// exact runner-ABI call surface. Mirrors gex's discovery pass.
import fs from "node:fs";
import { parsePE, rvaToOff } from "./pe.ts";
import { decode, DecodeError, type Ins, type Operand } from "./isa.ts";

const EXE = `${import.meta.dir}/../../upload/Ichorous.exe`;
const MAP = `${import.meta.dir}/data/ghidra_pass2_scriptmap.csv`;
const OUT = `${import.meta.dir}/out-mining.json`;

const buf = fs.readFileSync(EXE);
const img = parsePE(buf);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const offOf = (va: number) => rvaToOff(img, va - img.imageBase);

// --- .pdata: exact function extents ---
const pdata = img.sections.find((s) => s.name === ".pdata")!;
const pdOff = pdata.rawOff;
const pdCount = Math.floor(pdata.rawSize / 12);
interface RF { start: number; end: number }
const extents = new Map<number, RF>();
for (let i = 0; i < pdCount; i++) {
  const s = dv.getUint32(pdOff + i * 12, true);
  const e = dv.getUint32(pdOff + i * 12 + 4, true);
  if (e > s) extents.set(img.imageBase + s, { start: img.imageBase + s, end: img.imageBase + e });
}
console.log(".pdata functions:", extents.size);

// --- registry ---
const csv = fs.readFileSync(MAP, "utf8").trim().split("\n").slice(1);
interface GameFn { name: string; va: number; end: number }
const fns: GameFn[] = [];
for (const line of csv) {
  const cols = line.split(",");
  const name = cols[0];
  let va = NaN;
  for (const c of cols.slice(1)) if (/^14[0-9a-f]{7,8}$/.test(c)) { va = parseInt(c, 16); break; }
  if (name && name.startsWith("gml_") && Number.isFinite(va)) fns.push({ name, va, end: 0 });
}
for (const f of fns) { const rf = extents.get(f.va); f.end = rf ? rf.end : f.va; }
const noExtent = fns.filter((f) => f.end === f.va).length;
console.log("registry functions:", fns.length, " without .pdata extent (leaf fns):", noExtent);

// leaf functions without .pdata: estimate end = next function start
const sortedAll = [...extents.keys()].sort((a, b) => a - b);
const fnSet = new Set(fns.map((f) => f.va));
for (const f of fns) {
  if (f.end !== f.va) continue;
  const next = sortedAll.find((x) => x > f.va);
  // next registry fn start
  const nb = fns.reduce((m, g) => (g.va > f.va && (m === 0 || g.va < m) ? g.va : m), 0);
  f.end = Math.min(next ?? (f.va + 4096), nb || (f.va + 4096));
}
const totalCode = fns.reduce((a, f) => a + (f.end - f.va), 0);
console.log("exact game code bytes:", (totalCode / 1048576).toFixed(2) + "MB");

// --- linear decode each game function ---
const u8 = buf;
interface FnScan { calls: Map<number, number>; icalls: { kind: "vt" | "mem"; disp?: number; ins: Ins }[]; datarefs: Map<number, number>; errors: DecodeError[]; insCount: number; jccs: number }
function scanFn(f: GameFn): FnScan {
  const res: FnScan = { calls: new Map(), icalls: [], datarefs: new Map(), errors: [], insCount: 0, jccs: 0 };
  let va = f.va;
  const end = f.end;
  while (va < end) {
    const off = offOf(va);
    if (off < 0) break;
    let ins: Ins;
    try {
      ins = decode(u8, dv, va, off, end - va);
    } catch (e) {
      if (e instanceof DecodeError) { res.errors.push(e); break; }
      throw e;
    }
    res.insCount++;
    va += ins.len;
    if (ins.op === "call") {
      const t = Number((ins.o[0] as { v: bigint }).v);
      res.calls.set(t, (res.calls.get(t) ?? 0) + 1);
    } else if (ins.op === "icall") {
      const o = ins.o[0];
      if (o.k === "mem" && o.m.riprel) {
        // call [rip+X] — IAT or function pointer table
        const t = va + o.m.disp;
        res.datarefs.set(t, (res.datarefs.get(t) ?? 0) + 1);
        res.icalls.push({ kind: "mem", ins });
      } else if (o.k === "mem" && o.m.base !== undefined && o.m.index === undefined && o.m.scale === 1) {
        res.icalls.push({ kind: "vt", disp: o.m.disp, ins });
      } else {
        res.icalls.push({ kind: "mem", ins });
      }
    } else if (ins.op.startsWith("j") && ins.op !== "jmp") res.jccs++;
    for (const o of ins.o) {
      if (o.k === "mem" && o.m.riprel) {
        const t = (va - ins.len) + ins.len + o.m.disp; // rip after ins
        res.datarefs.set(t, (res.datarefs.get(t) ?? 0) + 1);
      }
    }
  }
  return res;
}

const t0 = Date.now();
const scans: (FnScan | null)[] = [];
let decodeFail = 0;
for (const f of fns) {
  if (f.end <= f.va) { scans.push(null); continue; }
  try {
    scans.push(scanFn(f));
  } catch (e) {
    decodeFail++;
    scans.push(null);
  }
}
console.log("decode pass:", Date.now() - t0, "ms; failures:", decodeFail);

// aggregate
const callTargets = new Map<number, number>();
const vtSlots = new Map<number, number>();
const errorsByMsg = new Map<string, number>();
let insTotal = 0, opHistogram = new Map<string, number>();
for (const s of scans) {
  if (!s) continue;
  insTotal += s.insCount;
  for (const [t, n] of s.calls) callTargets.set(t, (callTargets.get(t) ?? 0) + n);
  for (const ic of s.icalls) if (ic.kind === "vt") vtSlots.set(ic.disp!, (vtSlots.get(ic.disp!) ?? 0) + 1);
  for (const e of s.errors) errorsByMsg.set(e.message.split(" @")[0], (errorsByMsg.get(e.message.split(" @")[0]) ?? 0) + 1);
}
// count ops
for (const s of scans) {
  if (!s) continue;
  let va = 0;
  void va;
}
let internal = 0; const runnerList: { va: number; count: number }[] = [];
for (const [tgt, count] of callTargets) {
  if (fnSet.has(tgt)) internal += count; else runnerList.push({ va: tgt, count });
}
runnerList.sort((a, b) => b.count - a.count);
console.log("\ninsTotal:", insTotal.toLocaleString(), " direct internal calls:", internal, " runner ABI fns:", runnerList.length);
console.log("vtable call slots:", [...vtSlots.entries()].sort((a, b) => b[1] - a[1]));
console.log("\ntop 50 runner ABI fns:");
for (const r of runnerList.slice(0, 50)) console.log("  0x" + r.va.toString(16), r.count);
if (errorsByMsg.size) {
  console.log("\ndecode errors (msg -> count):");
  for (const [m, n] of [...errorsByMsg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log("  ", n, m);
}
fs.writeFileSync(OUT, JSON.stringify({
  imageBase: img.imageBase, sizeOfImage: img.sizeOfImage,
  sections: img.sections.map((s) => ({ ...s, vaAbs: img.imageBase + s.va })),
  fns: fns.map((f) => ({ n: f.name, va: f.va, end: f.end })),
  runnerList,
  vtSlots: [...vtSlots.entries()],
  dataRefs: [...callTargets.keys()].length,
}, null, 1));
console.log("\nwrote", OUT);
