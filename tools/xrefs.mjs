#!/usr/bin/env node
// Reverse-engineering aid: find every *lifted GML function* that calls a runner
// address, and show the instruction window around each call site.
//
//   node tools/xrefs.mjs 0x140e87930 [before] [after]
//
// Restricting the scan to the 5555 lifted function bodies (from
// tools/gex/out-mining.json) keeps it fast and, more importantly, means every
// hit is a call from game code rather than from more runner code. The
// surrounding instructions show how the arguments are built, which is usually
// enough to identify what the runner function does.
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

const [, , vaArg, bArg, aArg] = process.argv;
if (!vaArg) { W("usage: node tools/xrefs.mjs <va-hex> [before] [after]"); process.exit(1); }
const va = Number(BigInt(vaArg));
const before = Number(bArg) || 6;
const after = Number(aArg) || 3;

const mining = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/gex/out-mining.json"), "utf8"));
const exe = fs.readFileSync(EXE);
const u8 = new Uint8Array(exe.buffer, exe.byteOffset, exe.byteLength);
const dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);

const secOf = (v) => mining.sections.find((s) => v >= s.vaAbs && v < s.vaAbs + Math.max(s.vsize, s.rawSize));
const offOf = (v) => { const s = secOf(v); return s ? s.rawOff + (v - s.vaAbs) : -1; };
const REG = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
const cstr = (v, max = 90) => {
  const o = offOf(v); if (o < 0) return null;
  let s = "";
  for (let i = 0; i < max; i++) { const c = u8[o + i]; if (c === 0) break; if (c < 32 || c > 126) return null; s += String.fromCharCode(c); }
  return s.length >= 2 ? s : null;
};
const opnd = (o) => {
  if (!o) return "";
  if (o.k === "reg") return REG[o.r] ?? `r${o.r}`;
  if (o.k === "imm") return "0x" + (typeof o.v === "bigint" ? Number(o.v) : o.v >>> 0).toString(16);
  if (o.k === "mem") {
    const mm = o.m;
    if (mm.riprel) return `[rip+0x${(mm.disp >>> 0).toString(16)}]`;
    const b = REG[mm.base] ?? `r${mm.base}`;
    return `[${b}${mm.disp ? (mm.disp > 0 ? "+" : "-") + "0x" + Math.abs(mm.disp).toString(16) : ""}]`;
  }
  return JSON.stringify(o);
};
const insAt = (v) => { const b = offOf(v); if (b < 0) return null; try { return decode(u8, dv, v, b, 15); } catch { return null; } };
// Walk backwards `n` instructions from `v`. Decoding x86-64 backwards is not
// possible in general, so we retry forward decodes from every start offset in a
// 48-byte window and keep the first chain that lands exactly on `v`.
function walkBack(v, n) {
  for (let start = v - 48; start < v; start++) {
    const addrs = [];
    let cur = start;
    let ok = true;
    while (cur < v) {
      const ins = insAt(cur);
      if (!ins || !ins.op || cur + ins.len > v) { ok = false; break; }
      addrs.push(cur);
      cur += ins.len;
    }
    if (ok && cur === v) return addrs.slice(-n);
  }
  return [];
}
const fns = mining.fns.slice().sort((a, b) => a.va - b.va);
const fnAt = (v) => {
  let lo = 0, hi = fns.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (fns[mid].va <= v) { best = fns[mid]; lo = mid + 1; } else hi = mid - 1; }
  if (best && best.end && v >= best.end) return null;
  return best;
};

const hits = new Map();
for (const f of fns) {
  const end = f.end ?? f.va + 4096;
  for (let v = f.va; v < end; v++) {
    const ins = insAt(v);
    if (!ins || ins.op !== "call") continue;
    const o = ins.o[0];
    if (!o || o.k !== "imm") continue;
    // A `call rel32` target may decode either as a full VA (>= image base) or
    // as a bare RVA. Note the low 32 bits of a full VA are NOT the RVA - the
    // base itself has non-zero low bits - so subtract, never mask.
    let t = typeof o.v === "bigint" ? Number(o.v) : o.v;
    if (t >= mining.imageBase) t -= mining.imageBase;
    if (t > 0 && t < mining.imageBase) t += mining.imageBase;
    if (t !== va) continue;
    if (!hits.has(f.n)) hits.set(f.n, []);
    hits.get(f.n).push(v);
    v += ins.len - 1;
  }
}
W(`\n=== call sites of ${vaArg} inside lifted GML functions ===`);
W(`${[...hits.values()].reduce((a, b) => a + b.length, 0)} call(s) from ${hits.size} function(s)`);
let shown = 0;
for (const [name, sites] of [...hits.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (shown++ >= 12) break;
  W(`\n--- ${name}  (${sites.length}x) ---`);
  for (const site of sites.slice(0, 3)) {
    for (const a of walkBack(site, before)) {
      const ins = insAt(a);
      let line = `  ${a.toString(16).padStart(9)}  ${ins.op.padEnd(10)} ${ins.o.map(opnd).join(", ")}`;
      for (const o of ins.o) if (o.k === "mem" && o.m.riprel) { const s = cstr(a + ins.len + o.m.disp); if (s) line += `   ; "${s}"`; }
      W(line);
    }
    {
      const ins = insAt(site);
      W(`  ${site.toString(16).padStart(9)}  call       0x${va.toString(16)}   <== TARGET`);
      void ins;
    }
    let cur = site + 5;
    for (let i = 0; i < after; i++) {
      const ins = insAt(cur);
      if (!ins || !ins.op) break;
      let line = `  ${cur.toString(16).padStart(9)}  ${ins.op.padEnd(10)} ${ins.o.map(opnd).join(", ")}`;
      for (const o of ins.o) if (o.k === "mem" && o.m.riprel) { const s = cstr(cur + ins.len + o.m.disp); if (s) line += `   ; "${s}"`; }
      W(line);
      cur += ins.len;
      if (ins.op === "ret" || ins.op === "jmp") break;
    }
    W("  ...");
  }
}
W("");
