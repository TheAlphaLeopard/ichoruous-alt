// The lifted wasm for oMeatBlob's Create has 1803 `loop` blocks, so it is
// useless for finding the runaway by inspection. The original x86 is ground
// truth: sweep it, follow direct calls out from a root, and report which
// functions actually contain a backward jump.
import fs from "node:fs";
import { decode } from "/home/user/ichoruous-alt/tools/gex/isa.js";
const EXE = process.env.ICHOROUS_EXE ?? "/home/user/fixtures/Ichorous.exe";
const exe = fs.readFileSync(EXE);
const u8 = new Uint8Array(exe.buffer, exe.byteOffset, exe.byteLength);
const dvAll = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
const mining = JSON.parse(fs.readFileSync("/home/user/ichoruous-alt/tools/gex/out-mining.json", "utf8"));
const secOf = (v) => mining.sections.find((s) => v >= s.vaAbs && v < s.vaAbs + Math.max(s.vsize, s.rawSize));
const offOf = (v) => { const s = secOf(v); return s ? s.rawOff + (v - s.vaAbs) : -1; };
const meta = JSON.parse(fs.readFileSync("/home/user/ichoruous-alt/gex/meta.json", "utf8"));
const fns = [...meta.fns].sort((a, b) => a.va - b.va);
const byVa = new Map(fns.map((f) => [f.va, f]));
const endOf = (i) => (i + 1 < fns.length ? fns[i + 1].va : fns[i].va + 0x2000);
const idxOf = new Map(fns.map((f, i) => [f.va, i]));
// decode() hands back immediate operands as hex *strings*, not numbers.
const asNum = (v) => typeof v === "string"
  ? (v.startsWith("0x") || v.startsWith("-0x") ? Number.parseInt(v, 16) : Number(v))
  : (typeof v === "bigint" ? Number(v) : v);

function analyze(va) {
  const i = idxOf.get(va);
  if (i === undefined) return null;
  const end = endOf(i);
  let cur = va, bwd = 0, ins = 0;
  const calls = new Set();
  while (cur < end) {
    const off = offOf(cur);
    if (off < 0) { cur++; continue; }
    let d = null;
    try { d = decode(u8, dvAll, cur, off, 15); } catch {}
    if (!d || !d.len) { cur++; continue; }
    ins++;
    if (d.op && d.op.startsWith("j")) {
      const o = (d.o ?? []).find((x) => x && x.k === "imm");
      if (o && typeof o.v !== "undefined") {
        const raw = asNum(o.v);
        const t = raw > 0x7fffffffffff ? raw - 0x10000000000000000 : raw;
        if (t < cur && t > 0x140000000) bwd++;
      }
    }
    if (d.op === "call") {
      const o = (d.o ?? []).find((x) => x && x.k === "imm");
      if (o && typeof o.v !== "undefined") {
        const raw = asNum(o.v);
        if (raw > 0x140000000 && raw < 0x141400000) calls.add(raw);
      }
    }
    cur += d.len;
  }
  return { va, name: byVa.get(va)?.n ?? "?", ins, bwd, calls: [...calls] };
}

const rootName = process.argv[2] ?? "gml_Object_oMeatBlob_Create_0";
const root = fns.find((f) => f.n === rootName);
if (!root) { console.log("no such function:", rootName); process.exit(1); }
const MAXF = Number(process.env.MAXF ?? 400);
const seen = new Set(); const queue = [root.va]; const loopers = [];
while (queue.length && seen.size < MAXF) {
  const va = queue.shift();
  if (seen.has(va)) continue;
  seen.add(va);
  const r = analyze(va);
  if (!r) continue;
  if (r.bwd > 0) loopers.push(r);
  for (const c of r.calls) if (!seen.has(c) && idxOf.has(c)) queue.push(c);
}
console.log(`walked ${seen.size} functions reachable from ${rootName}`);
console.log(`\nfunctions containing a backward jump (${loopers.length}):`);
loopers.sort((a, b) => b.bwd - a.bwd);
for (const r of loopers.slice(0, 15)) console.log(`   ${r.bwd} back-jumps, ${String(r.ins).padStart(6)} ins  0x${r.va.toString(16)}  ${r.name.slice(0, 78)}`);
