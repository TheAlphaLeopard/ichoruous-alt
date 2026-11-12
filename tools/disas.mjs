#!/usr/bin/env node
// Reverse-engineering aid: disassemble the original exe at a given address.
//
//   node tools/disas.mjs 0x14128ab40 [count]        # disassemble
//   node tools/disas.mjs 0x14128ab40 --xrefs        # who calls it
//
// Needs the original executable at $ICHOROUS_EXE (default /tmp/Ichorous.exe);
// it is not distributed with this repo. Call targets and RIP-relative data are
// annotated with names from gex/meta.json, tools/gex/out-fnreg-order.json and
// tools/gex/out-mining.json, which is what makes the output readable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "./gex/isa.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.env.ICHOROUS_EXE ?? "/tmp/Ichorous.exe";
const W = (s) => fs.writeSync(1, s + "\n");

const [, , vaArg, arg3, arg4] = process.argv;
if (!vaArg) { W("usage: node tools/disas.mjs <va-hex> [count|--xrefs]"); process.exit(1); }
const va = Number(BigInt(vaArg));
const xrefs = arg3 === "--xrefs" || arg4 === "--xrefs";
const count = Number(arg3) || 40;

const mining = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/gex/out-mining.json"), "utf8"));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "gex/meta.json"), "utf8"));
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/gex/out-fnreg-order.json"), "utf8"));
const exe = fs.readFileSync(EXE);
const u8 = new Uint8Array(exe.buffer, exe.byteOffset, exe.byteLength);
const dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);

// va -> {name, end}, for annotating call targets
const names = new Map();
for (const f of mining.fns) names.set(f.va, { name: f.n, end: f.end });
for (const e of reg) if (!names.has(e.va)) names.set(e.va, { name: `builtin:${e.name}` });
for (const e of mining.runnerList) if (!names.has(e.va)) names.set(e.va, { name: `runner:f${e.va.toString(16)}` });
for (const f of meta.fns) if (!names.has(f.va)) names.set(f.va, { name: f.n });

// containing function, for naming callers
const sorted = [...names.values()].map((v) => ({ ...v, va: [...names.entries()].find(([k, x]) => x === v)[0] })).sort((a, b) => a.va - b.va);
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
const cstr = (off, max = 90) => {
  if (off < 0 || off >= u8.length) return null;
  let s = "";
  for (let i = 0; i < max; i++) {
    const c = u8[off + i];
    if (c === 0) break;
    if (c < 32 || c > 126) return i >= 3 ? s : null;
    s += String.fromCharCode(c);
  }
  return s.length >= 3 ? s : null;
};
const opnd = (o) => {
  if (!o) return "";
  if (o.k === "reg") return ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"][o.r] ?? `r${o.r}`;
  if (o.k === "imm") return "0x" + (typeof o.v === "bigint" ? Number(o.v) : o.v >>> 0).toString(16);
  if (o.k === "mem") {
    const m = o.m;
    if (m.riprel) return `[rip+0x${(m.disp >>> 0).toString(16)}]`;
    const b = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"][m.base] ?? `r${m.base}`;
    return `[${b}${m.disp ? (m.disp > 0 ? "+" : "-") + "0x" + Math.abs(m.disp).toString(16) : ""}]`;
  }
  return JSON.stringify(o);
};

function disas(start, n) {
  let cur = start;
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = offOf(cur);
    if (base < 0) { out.push(`  ${cur.toString(16)}  (outside a section)`); break; }
    let ins;
    try { ins = decode(u8, dv, cur, base, 15); } catch { ins = null; }
    if (!ins || !ins.op) { out.push(`  ${cur.toString(16)}  <undecodable>`); break; }
    let line = `  ${cur.toString(16).padStart(9)}  ${ins.op.padEnd(10)} ${ins.o.map(opnd).join(", ")}`;
    // annotate rip-relative loads and call targets
    for (const o of ins.o) {
      if (o.k === "mem" && o.m.riprel) {
        const target = cur + ins.len + o.m.disp;
        const s = cstr(offOf(target));
        if (s) line += `   ; "${s}"`;
      }
      if (o.k === "imm" && ins.op === "call") {
        const t = (typeof o.v === "bigint" ? Number(o.v) : o.v) >>> 0;
        const nm = names.get(t) ?? fnAt(t);
        if (nm) line += `   ; -> ${nm.name}`;
      }
    }
    out.push(line);
    cur += ins.len;
    if (ins.op === "ret" || ins.op === "jmp") break;
  }
  return out;
}

const owner = fnAt(va);
W(`\n=== ${vaArg}  ${owner ? "(inside " + owner.name + ")" : ""} ===`);
if (xrefs) {
  const text = mining.sections.find((s) => s.name === ".text");
  W(`scanning ${(text.rawSize / 1048576).toFixed(1)}MB of .text for call sites...`);
  const hits = new Map();
  for (let off = text.rawOff; off < text.rawOff + text.rawSize - 5; off++) {
    if (u8[off] !== 0xe8) continue;
    const rel = dv.getInt32(off + 1, true);
    const from = text.vaAbs + (off - text.rawOff);
    const target = (from + 5 + rel) >>> 0;
    if (target === va) {
      const f = fnAt(from);
      const key = f ? f.name : "0x" + from.toString(16);
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  }
  W(`call sites: ${[...hits.values()].reduce((a, b) => a + b, 0)} from ${hits.size} function(s)`);
  for (const [k, n] of [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) W(`  ${String(n).padStart(5)}x  ${k}`);
} else {
  for (const l of disas(va, count)) W(l);
}
W("");
