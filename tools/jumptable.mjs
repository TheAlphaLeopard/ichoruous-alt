#!/usr/bin/env node
// Reverse-engineering aid: decode the MSVC switch jump tables the runner uses
// for RValue-kind dispatch.
//
//   node tools/jumptable.mjs 0x140e4a740 [entries] [insnPerCase]
//
// Scans the first ~64 instructions of the function for the classic MSVC
// pattern
//
//     lea   r10, [rip+d]      ; r10 := image base
//     mov   rdx, [r10+d2]     ; rdx := table[0] (32-bit relative to base)
//     add   rdx, r10
//     ijmp  rdx
//
// resolves every entry to a target VA and disassembles a few instructions at
// each target so the arms of the switch can be compared side by side.
//
// Needs the original executable at $ICHOROUS_EXE (default
// /home/user/fixtures/Ichorous.exe); it is not distributed with this repo.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "./gex/isa.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.env.ICHOROUS_EXE ?? "/home/user/fixtures/Ichorous.exe";
const W = (s) => fs.writeSync(1, s + "\n");

const [, , vaArg, nArg, insArg] = process.argv;
if (!vaArg) { W("usage: node tools/jumptable.mjs <va-hex> [entries] [insnPerCase]"); process.exit(1); }
const va = Number(BigInt(vaArg));
const entries = Number(nArg) || 16;
const insPerCase = Number(insArg) || 4;

const mining = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/gex/out-mining.json"), "utf8"));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "gex/meta.json"), "utf8"));
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/gex/out-fnreg-order.json"), "utf8"));
const exe = fs.readFileSync(EXE);
const u8 = new Uint8Array(exe.buffer, exe.byteOffset, exe.byteLength);
const dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
const IMAGE_BASE = mining.imageBase ?? 0x140000000;

const names = new Map();
for (const f of mining.fns) names.set(f.va, { name: f.n, end: f.end });
for (const e of reg) if (!names.has(e.va)) names.set(e.va, { name: `builtin:${e.name}` });
for (const e of mining.runnerList) if (!names.has(e.va)) names.set(e.va, { name: `runner:f${e.va.toString(16)}` });
for (const f of meta.fns) if (!names.has(f.va)) names.set(f.va, { name: f.n });
const sorted = [...names.entries()].map(([v, x]) => ({ va: v, ...x })).sort((a, b) => a.va - b.va);
const fnAt = (v) => {
  let lo = 0, hi = sorted.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].va <= v) { best = sorted[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  if (best && best.end && v >= best.end) return null;
  return best;
};

const secOf = (v) => mining.sections.find((s) => v >= s.vaAbs && v < s.vaAbs + Math.max(s.vsize, s.rawSize));
const offOf = (v) => { const s = secOf(v); return s ? s.rawOff + (v - s.vaAbs) : -1; };
const REG = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
const opnd = (o) => {
  if (!o) return "";
  if (o.k === "reg") return REG[o.r] ?? `r${o.r}`;
  if (o.k === "imm") return "0x" + (typeof o.v === "bigint" ? Number(o.v) : o.v >>> 0).toString(16);
  if (o.k === "mem") {
    const m = o.m;
    if (m.riprel) return `[rip+0x${(m.disp >>> 0).toString(16)}]`;
    const b = REG[m.base] ?? `r${m.base}`;
    return `[${b}${m.disp ? (m.disp > 0 ? "+" : "-") + "0x" + Math.abs(m.disp).toString(16) : ""}]`;
  }
  return JSON.stringify(o);
};

function insAt(v) {
  const base = offOf(v);
  if (base < 0) return null;
  try { return decode(u8, dv, v, base, 15); } catch { return null; }
}
function disas(start, n) {
  let cur = start; const out = [];
  for (let i = 0; i < n; i++) {
    const ins = insAt(cur);
    if (!ins || !ins.op) { out.push(`  ${cur.toString(16)}  <undecodable>`); break; }
    out.push(`       ${cur.toString(16).padStart(9)}  ${ins.op.padEnd(10)} ${ins.o.map(opnd).join(", ")}`);
    cur += ins.len;
    if (ins.op === "ret" || ins.op === "jmp" || ins.op === "ijmp") break;
  }
  return out;
}

const KINDS = ["k0","k1","k2","k3","k4","k5","k6","k7","k8","k9","k10","k11","k12","k13","k14","k15","k16","k17","k18","k19","k20","k21","k22","k23"]; const KINDS_UNUSED = [
  "double(0)", "string(1)", "array(2)", "ptr(3)", "bool(4)", "undef(5)", "object(6)", "int32(7)",
  "vec3(8)", "vec4(9)", "matrix(10)", "int64(11)", "accessor(12)", "jsarray(13)", "ref(14)", "null(15)",
];

// ---- locate the table -------------------------------------------------------
let cur = va;
let baseReg = -1, tableVA = -1, indexReg = -1, highCmp = -1;
for (let i = 0; i < 64; i++) {
  const ins = insAt(cur);
  if (!ins || !ins.op) break;
  const [a, b] = ins.o;
  if (ins.op === "cmp" && a?.k === "reg" && b?.k === "imm") highCmp = Number(b.v);
  if (ins.op === "lea" && a?.k === "reg" && b?.k === "mem" && b.m.riprel) {
    if (cur + ins.len + b.m.disp === IMAGE_BASE) baseReg = a.r;
  }
  if (baseReg >= 0 && ins.op === "mov" && a?.k === "reg" && b?.k === "mem" && b.m.base === baseReg) {
    tableVA = IMAGE_BASE + b.m.disp;
    indexReg = a.r;
    break;
  }
  if (ins.op === "ijmp") break;
  cur += ins.len;
}

const owner = fnAt(va);
W(`\n=== ${vaArg}  ${owner ? "(inside " + owner.name + ")" : ""} ===`);
if (tableVA < 0) { W("no MSVC jump table found in the first 64 instructions"); process.exit(1); }
W(`switch bound: ${highCmp}   index reg: ${REG[indexReg]}   table: 0x${tableVA.toString(16)}`);

const seen = new Map();
for (let i = 0; i < entries; i++) {
  const off = offOf(tableVA + i * 4);
  if (off < 0 || off + 4 > u8.length) { W(`  ${i}: <table out of section>`); continue; }
  const rel = dv.getInt32(off, true);
  const target = IMAGE_BASE + rel;
  const nm = names.get(target) ?? fnAt(target);
  W(`  ${String(i).padStart(2)} ${KINDS[i].padEnd(12)} -> 0x${target.toString(16)}${nm ? "  (" + nm.name + ")" : ""}${seen.has(target) ? "   [dup of " + seen.get(target) + "]" : ""}`);
  if (!seen.has(target)) seen.set(target, i);
  else continue;
  for (const l of disas(target, insPerCase)) W(l);
}
W("");
